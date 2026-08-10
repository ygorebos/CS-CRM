/**
 * GET/POST /api/v1/cron/catalog-reindexer — spec 002 (RAG por operadora), T135.
 *
 * O gatilho do worker de T057 (`workers/catalog-reindexer.ts`). Neste repositório cron é
 * **rota HTTP batida por `curl`** a partir do serviço `scheduler` do
 * `docker-compose.prod.yml` — não há `vercel.json`, o produto é self-host.
 *
 * Esta rota existe porque worker sem gatilho é evento sem consumidor (anti-pattern nº 3
 * do CLAUDE.md) e viola o Princípio II (nada é ilha). O modo de falha desse descuido já
 * aconteceu neste repositório e passou meses: `risk-watcher`, `routing-worker` e
 * `attendant-heartbeat` existiam, com teste e com doc, e ninguém os agendava — e **não
 * dava erro**, a feature só nunca acontecia sozinha. `tests/unit/cron-routes-scheduled.ts`
 * é a cerca mecânica que hoje reprova esse caso no CI; a linha no `crond` do `scheduler`
 * é a outra metade desta tarefa.
 *
 * Auth: mesmo contrato dos demais crons — Bearer `INTERNAL_CRON_SECRET` ou
 * `INTERNAL_SECRET`, fail-closed (sem segredo configurado, ninguém entra).
 *
 * Não há `organization_id` em lugar nenhum aqui, e isso é deliberado: o catálogo é a
 * partição curada, compartilhada pela instalação (Princípio X, trava 2). A única
 * organização que o worker toca é a destinatária do aviso na Central, e ela é
 * **consultada** em `knowledge_scopes` — nunca aceita do body nem da query.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOTE_POR_RODADA, reindexarCatalogo, type ResultadoDaReindexacao } from "@/workers/catalog-reindexer";

export const dynamic = "force-dynamic";

/**
 * A query é input externo — a rota é pública por natureza, e o guardião é o segredo, não
 * a obscuridade da URL. `limit` existe para o operador conseguir drenar um acervo grande
 * mais rápido numa janela controlada, sem editar o crontab.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(LOTE_POR_RODADA),
});

/**
 * O código vive no union canônico de `lib/audit/actions.ts`. A anotação é o que segura
 * isso: inventar um código inexistente reprova o `typecheck` em vez de gravar uma trilha
 * que ninguém consegue consultar depois.
 *
 * (Nasceu com `as AuditAction` porque o union estava fora do conjunto de escrita do agente
 * que escreveu esta rota — arquivo compartilhado é do orquestrador. O cast durou uma
 * integração.)
 */
const ACAO_REINDEXACAO: AuditAction = "catalog.reindex_run";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  let resultado: ResultadoDaReindexacao;
  try {
    resultado = await reindexarCatalogo(createAdminClient(), {
      lote: parsed.data.limit,
      requestId,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[catalog-reindexer] rodada falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to reindex catalog.", 500, { requestId });
  }

  // Rodada que não escreveu nada é varredura, não mutação, e não ocupa linha de auditoria
  // (mesmo critério do `recover-stuck-messages`, do snooze-watcher e do
  // followup-flow-worker). Rodada que regravou trecho, abriu ou fechou aviso, sim: é o
  // registro de que o acervo do fabricante mudou de estado, e é isso que alguém vai
  // procurar quando perguntar "desde quando a busca voltou a funcionar?".
  const mutou =
    resultado.reembeddados > 0 || resultado.avisos_abertos > 0 || resultado.avisos_resolvidos > 0;
  if (mutou) {
    void audit({
      action: ACAO_REINDEXACAO,
      // NULO de propósito: o catálogo não é de tenant nenhum (trava 2), e carimbar uma
      // organização aqui faria a auditoria mentir sobre a quem o conteúdo pertence.
      organizationId: null,
      resourceType: "catalog_chunks",
      bypassedRls: true,
      metadata: resultado as unknown as Record<string, unknown>,
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
