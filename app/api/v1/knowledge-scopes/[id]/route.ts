/**
 * PATCH /api/v1/knowledge-scopes/{id} — renomear e, sobretudo, LIGAR/DESLIGAR um escopo.
 *
 * Spec 002 (RAG por operadora), T067/T087. Contrato em
 * `specs/002-rag-por-operadora/contracts/rotas-http.md`.
 *
 * ## Esta rota É a trava 4 (FR-008)
 *
 * `knowledge_scopes.is_active` é lido ao vivo pela CTE `escopo_ativo` de
 * `fn_buscar_lastro` (migrations 0123/0124). Não há cache, índice de busca nem job entre o
 * UPDATE daqui e o comportamento do agente: desligar um escopo torna o material dele
 * inerte para ESTE tenant na próxima pergunta, e não toca no catálogo nem em nenhuma outra
 * organização. É o "imediatamente" que FR-008 exige, e o motivo de a trava viver numa
 * coluna em vez de numa convenção.
 *
 * ## Um passo, uma chamada (SC-011)
 *
 * O espelho do catálogo nasce desligado (A-20), então ligar é o primeiro gesto de todo
 * corretor numa instalação fresca — e SC-011 cronometra esse gesto dentro do teto de 10
 * minutos. Por isso o interruptor da tela faz UM `PATCH { "is_active": true }` e recebe de
 * volta o escopo inteiro, já projetado e com as contagens: nada de "salvar" depois, nada de
 * um GET para reidratar a linha. Toda ida a mais aqui é tempo somado naquela medição.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import {
  ACAO_ATIVADO,
  ACAO_ATUALIZADO,
  ACAO_DESATIVADO,
  COLUNAS_DO_ESCOPO,
  acharColisaoDeNome,
  atualizarEscopoSchema,
  camposBloqueadosNoEspelho,
  contarMateriais,
  descreverCampos,
  projetarEscopo,
  rotuloDoTenant,
  type LinhaDeEscopo,
} from "../_escopos";

export const dynamic = "force-dynamic";

// Forma de UUID, sem exigir a versão: o objetivo é só não mandar lixo ao Postgres, e
// cravar "v4" aqui recusaria um id legítimo gerado por outro caminho — uma validação que
// inventa um 404 é pior que a que ela substitui.
const FORMA_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Rota {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Rota): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "knowledge_scopes" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const { id } = await params;
  // Id fora do formato não nomeia recurso nenhum — e mandá-lo ao Postgres viraria um
  // 22P02 traduzido como 500, que faria um erro do cliente parecer defeito do servidor.
  if (!FORMA_DE_UUID.test(id)) {
    return fail("not_found", "Escopo de conhecimento não encontrado.", 404, { requestId });
  }

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, { requestId });
  }

  const parsed = atualizarEscopoSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const mudancas = parsed.data;
  const camposPedidos = Object.keys(mudancas);

  const supabase = await createClient();

  // Estado ANTES: é o que decide o 403 do espelho, o 409 de nome e o que a auditoria
  // registra como "de → para". Sem ele o audit diria o valor novo duas vezes.
  const { data: atualBruto, error: erroDeLeitura } = await supabase
    .from("knowledge_scopes")
    .select(COLUNAS_DO_ESCOPO)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroDeLeitura) {
    return fail("internal_error", "Erro ao carregar o escopo de conhecimento.", 500, { requestId });
  }
  if (!atualBruto) {
    return fail("not_found", "Escopo de conhecimento não encontrado.", 404, { requestId });
  }
  const antes = atualBruto as unknown as LinhaDeEscopo;
  const eEspelho = antes.catalog_scope_id !== null;

  // ── o que um espelho do catálogo aceita ───────────────────────────────────
  if (eEspelho) {
    const bloqueados = camposBloqueadosNoEspelho(camposPedidos);
    if (bloqueados.length > 0) {
      const rotulo = await rotuloDoTenant(supabase, org.orgId);
      return fail(
        "escopo_do_catalogo_nao_editavel",
        `${rotulo.singular} "${antes.display_name}" vem do catálogo desta instalação. Aqui dá para ligar, desligar e renomear; ${descreverCampos(bloqueados)} é mantido por quem cura o catálogo.`,
        403,
        { requestId, details: { fields: bloqueados } },
      );
    }
  }

  // ── 409 de nome, também no rename ─────────────────────────────────────────
  // Sem isto, o corretor contornaria o 409 do POST em dois passos: cria "Amil 2", depois
  // renomeia para "Amil". Duas linhas com o mesmo nome e acervos separados é o estado que
  // ninguém diagnostica olhando a tela.
  if (mudancas.display_name !== undefined) {
    const { data: existentes, error: erroDosNomes } = await supabase
      .from("knowledge_scopes")
      .select("id, display_name, catalog_scope_id")
      .eq("organization_id", org.orgId)
      .neq("id", id);
    if (erroDosNomes) {
      return fail("internal_error", "Erro ao verificar os escopos existentes.", 500, { requestId });
    }
    const colisao = acharColisaoDeNome(
      (existentes ?? []) as { id: string; display_name: string }[],
      mudancas.display_name,
    );
    if (colisao) {
      const rotulo = await rotuloDoTenant(supabase, org.orgId);
      return fail(
        "escopo_ja_existe",
        `${rotulo.singular} "${colisao.display_name}" já existe nesta conta. Escolha outro nome.`,
        409,
        { requestId, details: { existing_id: colisao.id } },
      );
    }
  }

  // ── o UPDATE ──────────────────────────────────────────────────────────────
  // Só os campos que vieram. `updated_at` não entra: o trigger
  // `knowledge_scopes_updated_at` já carimba, e escrevê-lo aqui criaria uma segunda fonte
  // para o mesmo dado — a que diverge no dia em que alguém atualizar pelo banco.
  const patch: Record<string, unknown> = {};
  if (mudancas.display_name !== undefined) patch.display_name = mudancas.display_name;
  if (mudancas.official_code !== undefined) patch.official_code = mudancas.official_code ?? null;
  if (mudancas.is_active !== undefined) patch.is_active = mudancas.is_active;

  const { data: depoisBruto, error: erroDeUpdate } = await supabase
    .from("knowledge_scopes")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(COLUNAS_DO_ESCOPO)
    .maybeSingle();
  if (erroDeUpdate) {
    return fail("internal_error", "Erro ao atualizar o escopo de conhecimento.", 500, { requestId });
  }
  // `maybeSingle` + checagem: um UPDATE barrado pela RLS afeta zero linhas sem erro, e
  // devolver 200 ali gravaria uma auditoria de mutação que não aconteceu.
  if (!depoisBruto) {
    return fail("not_found", "Escopo de conhecimento não encontrado.", 404, { requestId });
  }
  const depois = depoisBruto as unknown as LinhaDeEscopo;

  // ── auditoria: UMA linha, e ela diz o que mudou ───────────────────────────
  // O liga/desliga ganha ação PRÓPRIA porque é a operação com consequência de
  // comportamento — quem for investigar "por que o agente parou de falar da Unimed"
  // procura por isso, não por um `updated` genérico com um campo escondido no metadata.
  const ligou = mudancas.is_active !== undefined && antes.is_active !== depois.is_active;
  const acao = ligou ? (depois.is_active ? ACAO_ATIVADO : ACAO_DESATIVADO) : ACAO_ATUALIZADO;

  void audit({
    action: acao,
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "knowledge_scope",
    resourceId: depois.id,
    requestId,
    metadata: {
      fields: camposPedidos,
      origin: eEspelho ? "catalogo" : "proprio",
      display_name: depois.display_name,
      is_active_before: antes.is_active,
      is_active_after: depois.is_active,
    },
  });

  const contagens = await contarMateriais(supabase, org.orgId, [depois]);
  return ok(projetarEscopo(depois, contagens.get(depois.id)), { requestId });
}
