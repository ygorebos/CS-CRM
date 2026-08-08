/**
 * GET   /api/v1/contacts/[id] — fetch single (handler em ../_handler.ts)
 * PATCH /api/v1/contacts/[id] — update (handler em ../_handler.ts)
 *
 * Thin wrapper: auth + Zod + ok/fail. Decrypt CPF + LGPD irreversibility no handler.
 *
 * ## O caminho "cadastro" do vínculo cliente↔operadora (spec 002, FR-017 · T089)
 *
 * FR-017 dá **duas** origens ao vínculo: a ficha do contato e a resposta do cliente na
 * conversa. Quando as duas existem e divergem, **o cadastro vence** — e a precedência é
 * verificável numa coluna (`contacts.knowledge_scope_source`), não convencionada no
 * código. Esta rota é a origem "cadastro": grava sempre `'cadastro'`.
 *
 * A outra metade da regra **não mora aqui, de propósito**: quem recusa rebaixar o
 * cadastro é `gravarEscopoDaConversa` (`lib/agent-engine/agent/escopo-do-contato.ts`),
 * com a condição no `where` do UPDATE. Repetir a comparação nesta rota criaria uma
 * terceira cópia da mesma regra — que é onde a divergência nasce quando alguém muda uma
 * e esquece as outras. O contrato entre os dois lados é exatamente o valor gravado
 * abaixo, e o teste desta rota o exercita chamando a função do outro lado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import type { OrigemDoEscopo as OrigemDoVinculo } from "@/lib/agent-engine/agent/escopo-do-contato";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { contactPatchSchema, validateBody, type ContactPatch } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import type { Contact } from "@/lib/types/contacts";

import { getContactHandler, patchContactHandler, type GetContactResult } from "../_handler";

export const dynamic = "force-dynamic";

type Db = Awaited<ReturnType<typeof createClient>>;

/**
 * O valor que o CHECK `contacts_knowledge_scope_source_check` (migration 0118) aceita
 * deste lado. A anotação de tipo é o que segura o vocabulário: trocar por um valor que
 * a origem do vínculo não conhece reprova o `typecheck` aqui, em vez de virar `23514`
 * na cara de quem só queria editar uma ficha.
 */
const ORIGEM_CADASTRO: OrigemDoVinculo = "cadastro";

/**
 * O campo do cadastro, validado à parte de `contactPatchSchema`.
 *
 * Schema próprio (e não uma chave a mais no compartilhado) porque `lib/schemas/contacts.ts`
 * está fora do conjunto de escrita desta tarefa; o efeito é o mesmo — nada entra sem passar
 * por Zod. Objeto NÃO-estrito de propósito: o mesmo corpo passa pelos dois schemas, e cada
 * metade tem de ignorar as chaves da outra.
 *
 * `null` é valor de primeira classe: "este cliente não tem operadora" é uma decisão de
 * cadastro, e ela também tem de vencer a conversa.
 */
const escopoDoCadastroSchema = z.object({
  knowledge_scope_id: z.string().uuid().nullable().optional(),
});

interface AlvoDaEscrita {
  orgId: string;
  contactId: string;
  requestId: string;
}

async function lerCorpoJson(req: NextRequest, requestId: string): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "body_malformed", undefined, requestId, "Body must be valid JSON");
  }
}

/**
 * O contato existe NESTA organização e aceita edição?
 *
 * As mesmas duas guardas do `patchContactHandler`, exercidas antes de qualquer escrita:
 * quando o corpo traz só o escopo, aquele handler não roda, e sem isto a rota gravaria
 * em contato anonimizado (LGPD) ou de outra organização.
 */
async function exigirContatoEditavel(supabase: Db, alvo: AlvoDaEscrita): Promise<void> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, is_anonymized")
    .eq("id", alvo.contactId)
    .eq("organization_id", alvo.orgId)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, alvo.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(404, "not_found", undefined, alvo.requestId, "Contato não encontrado.");
  }
  if ((data as { is_anonymized: boolean }).is_anonymized) {
    throw new ApiError(
      403,
      "lgpd_anonymization_irreversible",
      undefined,
      alvo.requestId,
      "Contato anonimizado — edição bloqueada (LGPD).",
    );
  }
}

/**
 * A operadora apontada é desta organização?
 *
 * `organization_id` sai da sessão validada (`requireRole`), **nunca** do corpo. Escopo de
 * outra organização e escopo inexistente devolvem o MESMO 404: distinguir os dois contaria
 * a quem pergunta que aquele id existe em algum lugar da instância.
 */
async function exigirEscopoDaOrganizacao(
  supabase: Db,
  alvo: AlvoDaEscrita,
  scopeId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("knowledge_scopes")
    .select("id")
    .eq("id", scopeId)
    .eq("organization_id", alvo.orgId)
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, alvo.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      alvo.requestId,
      "Operadora não encontrada nesta organização.",
    );
  }
}

/**
 * Grava o vínculo declarado no cadastro (FR-017).
 *
 * `knowledge_scope_source = 'cadastro'` sai **inclusive quando o escopo vai a `null`**:
 * "sem operadora" registrado na ficha é decisão, não lacuna a preencher, e sem a origem
 * gravada a próxima conversa preencheria por cima.
 *
 * O `audit` é próprio, e não uma linha a mais no do `patchContactHandler`: um PATCH que
 * mexe nas duas coisas produz duas entradas com o mesmo `request_id`, cada uma dizendo
 * quais campos mudou. Uma entrada só, que omitisse metade da mutação, seria trilha que
 * mente — e a trilha do vínculo é o que torna a precedência auditável.
 */
async function gravarEscopoDoCadastro(
  supabase: Db,
  alvo: AlvoDaEscrita,
  scopeId: string | null,
  actorUserId: string,
): Promise<void> {
  const agora = new Date().toISOString();

  const { data, error } = await supabase
    .from("contacts")
    .update({
      knowledge_scope_id: scopeId,
      knowledge_scope_source: ORIGEM_CADASTRO,
      knowledge_scope_confirmed_at: agora,
      updated_at: agora,
    })
    .eq("id", alvo.contactId)
    .eq("organization_id", alvo.orgId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new ApiError(500, "internal_error", undefined, alvo.requestId, error.message);
  }
  if (!data) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      alvo.requestId,
      "Contato não encontrado após update.",
    );
  }

  await audit({
    action: "contact.updated",
    actorUserId,
    organizationId: alvo.orgId,
    resourceType: "contact",
    resourceId: alvo.contactId,
    requestId: alvo.requestId,
    metadata: {
      actor_type: "user",
      fields: ["knowledge_scope_id", "knowledge_scope_source"],
      knowledge_scope_id: scopeId,
      knowledge_scope_source: ORIGEM_CADASTRO,
    },
  });
}

/**
 * A resposta do PATCH é o contato — sem o que só o GET acrescenta (`cpf_*`).
 *
 * Reusar `getContactHandler` no caminho "só escopo" é o que evita repetir a lista de
 * colunas do contato nesta rota (DIRC: Referenciar, não Duplicar); o preço é podar aqui
 * os três campos que ele soma, para o corpo do PATCH não mudar de forma conforme o que
 * o cliente mandou.
 */
function semExtrasDoGet(completo: GetContactResult): Contact {
  const podado: Record<string, unknown> = { ...completo };
  delete podado.cpf_available;
  delete podado.cpf_decrypted;
  delete podado.cpf_decrypt_denied;
  return podado as unknown as Contact;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }

  const authUser = await loadAuthUser();
  const activeOrg = authUser ? await resolveActiveOrg(authUser) : null;
  if (!activeOrg) {
    return fail("no_active_org", "No active organization.", 403, { requestId });
  }

  const decryptPurpose = req.headers.get("x-decrypt-purpose");

  try {
    const result = await getContactHandler(
      supabase,
      {
        organization_id: activeOrg.orgId,
        actor: { type: "user", id: user.id },
        requestId,
      },
      { contactId: id, decryptPurpose },
    );
    return ok(result, { requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const supabase = await createClient();
  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const activeOrg = authz.org;

  let input: ContactPatch;
  let escopoPedido: z.infer<typeof escopoDoCadastroSchema>;
  try {
    // O corpo é lido UMA vez: `req.json()` consome o stream, e validar duas vezes a
    // partir do request devolveria "body unusable" no segundo schema.
    const corpo = await lerCorpoJson(req, requestId);
    input = validateBody(contactPatchSchema, corpo);
    escopoPedido = validateBody(escopoDoCadastroSchema, corpo);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const escopoNoCorpo = escopoPedido.knowledge_scope_id !== undefined;
  const escopoAlvo = escopoPedido.knowledge_scope_id ?? null;
  const alvo: AlvoDaEscrita = { orgId: activeOrg.orgId, contactId: id, requestId };
  const handlerCtx: HandlerCtx = {
    organization_id: activeOrg.orgId,
    actor: { type: "user", id: user.id },
    requestId,
  };

  try {
    if (escopoNoCorpo) {
      // Tudo é validado ANTES da primeira escrita: operadora de outra organização não
      // pode deixar o contato meio atualizado.
      await exigirContatoEditavel(supabase, alvo);
      if (escopoAlvo !== null) {
        await exigirEscopoDaOrganizacao(supabase, alvo, escopoAlvo);
      }
      await gravarEscopoDoCadastro(supabase, alvo, escopoAlvo, user.id);
    }

    // `patchContactHandler` segue dono de tudo que já era dele — inclusive do 400 de
    // PATCH vazio, que sumiria se a rota desviasse para a leitura sempre que o corpo
    // não trouxesse mais nada.
    const temOutrosCampos = Object.keys(input).length > 0;
    const contact =
      temOutrosCampos || !escopoNoCorpo
        ? await patchContactHandler(supabase, handlerCtx, id, input)
        : semExtrasDoGet(await getContactHandler(supabase, handlerCtx, { contactId: id }));

    return ok(
      escopoNoCorpo
        ? {
            ...contact,
            knowledge_scope_id: escopoAlvo,
            knowledge_scope_source: ORIGEM_CADASTRO,
          }
        : contact,
      { requestId },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
