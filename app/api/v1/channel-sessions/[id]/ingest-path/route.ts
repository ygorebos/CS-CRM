/**
 * PATCH /api/v1/channel-sessions/[id]/ingest-path — virar a chave de UM canal,
 * nos dois sentidos (spec 004, T051/T053 / FR-041, FR-043).
 *
 * ## Por que existe uma rota, e não uma variável
 *
 * `channel_sessions.ingest_path` já era **por conexão** — a coluna existe desde a
 * migration 0119 justamente para a virada ser gradual. O que faltava era o jeito
 * de virá-la sem `UPDATE` na mão: e mudança de canal aplicada direto no banco não
 * deixa autoria, não deixa data e não aparece para ninguém. Num banco único
 * compartilhado, isso é a diferença entre "o Fulano migrou a conexão às 14h" e
 * "as mensagens pararam e ninguém sabe por quê".
 *
 * ## Reversibilidade de verdade (FR-041)
 *
 * Voltar para o caminho antigo é **uma chamada**, e só mexe nesta conexão: as
 * outras da mesma organização continuam onde estavam. É o que torna a migração
 * um passo reversível em vez de um salto.
 *
 * **Mensagem em voo não se perde na virada**, e isso foi medido: a rota de
 * recebimento recusa a entrega de uma conexão não migrada com 409 — mas ANTES de
 * recusar ela grava a linha em `webhook_events_log` com `status='error'`
 * (`webhooks/gateway/[token]/route.ts:137`). O dreno recolhe linhas `error` e
 * reingere, e a ingestão não pergunta `ingest_path`. Ou seja: a entrega que
 * chegou no instante exato da reversão entra pelo dreno no minuto seguinte, em
 * vez de sumir.
 *
 * ## O que esta rota NÃO faz
 *
 * Não provisiona, não pareia e não apaga nada. Ela só diz por onde as mensagens
 * DESTA conexão entram. Misturar as duas coisas faria uma reversão de caminho
 * derrubar a sessão do corretor no celular.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Vocabulário da coluna `channel_sessions.ingest_path` (migration 0119). */
const corpoSchema = z.object({ path: z.enum(["gateway", "legacy"]) });

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  // Mesma exigência das demais mudanças de canal (T045/FR-035): por onde as
  // mensagens entram é decisão de quem responde pela organização.
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = corpoSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", "Informe `path`: \"gateway\" ou \"legacy\".", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const destino = parsed.data.path;

  const supabase = await createClient();
  const buscar = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", org.orgId)
      .eq("id", id)
      .maybeSingle();
  const { data: linhaRaw } = await queryTolerantToMissingArchived(
    () => buscar(`id, ingest_path, gateway_connection_id, ${ARCHIVED_AT}`),
    () => buscar("id, ingest_path, gateway_connection_id"),
  );
  const linha = linhaRaw as {
    id: string;
    ingest_path: string;
    gateway_connection_id: string | null;
    archived_at?: string | null;
  } | null;
  if (!linha) return fail("not_found", "Canal não encontrado.", 404, { requestId });
  if (linha.archived_at) {
    return fail(
      "channel_archived",
      "Este número foi excluído da Central de Conexões — não há caminho de entrada para mudar.",
      409,
      { requestId },
    );
  }

  // Migrar uma conexão que não tem endereço no gateway a deixaria MUDA: a rota
  // de recebimento não teria como reconhecê-la, e nenhuma mensagem entraria por
  // caminho nenhum. Recusar aqui é a diferença entre um erro legível e um canal
  // que para de receber sem ninguém entender.
  if (destino === "gateway" && !linha.gateway_connection_id) {
    return fail(
      "channel_without_gateway_connection",
      "Este canal não tem conexão no serviço de entrada, então não há para onde migrá-lo. " +
        "Conecte um número novo pela Central de Conexões.",
      422,
      { requestId },
    );
  }

  const anterior = linha.ingest_path;
  // Já está lá: responde sucesso sem escrever nem auditar. Auditar uma mudança
  // que não houve encheria a trilha de linhas idênticas — e é justamente a
  // trilha que alguém vai ler para descobrir QUANDO a virada aconteceu.
  if (anterior === destino) {
    return ok({ id, ingest_path: destino, changed: false }, { requestId });
  }

  const { error } = await supabase
    .from("channel_sessions")
    .update({ ingest_path: destino })
    .eq("organization_id", org.orgId)
    .eq("id", id);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: destino === "gateway" ? "channel.migrated" : "channel.reverted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    // O ANTES viaja junto: sem ele a trilha diz para onde foi, mas não de onde —
    // e a pergunta que se faz num incidente é sempre "o que mudou?".
    metadata: { de: anterior, para: destino },
  });

  return ok({ id, ingest_path: destino, changed: true }, { requestId });
}
