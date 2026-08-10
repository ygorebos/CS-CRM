/**
 * GET/POST /api/v1/cron/validade-de-material — spec 002 (RAG por operadora), T136.
 *
 * O gatilho do worker de T120 (`workers/validade-de-material.ts`). Neste repositório cron
 * é **rota HTTP batida por `curl`** a partir do serviço `scheduler` do
 * `docker-compose.prod.yml` — não há `vercel.json`.
 *
 * Esta rota existe porque worker sem gatilho é evento sem consumidor (anti-pattern nº 3 do
 * `CLAUDE.md`). O modo de falha desse descuido já aconteceu aqui e passou meses:
 * `risk-watcher`, `routing-worker` e `attendant-heartbeat` existiam, com teste e com doc, e
 * ninguém os agendava — e **não dava erro**, a feature só nunca acontecia sozinha.
 * `tests/unit/cron-routes-scheduled.test.ts` é a cerca mecânica que reprova esse caso no
 * CI; a linha no `crond` do `scheduler` é a outra metade desta tarefa.
 *
 * ═══ POR QUE UMA VEZ POR DIA ═══
 *
 * A grandeza medida é uma data, não um evento: nada muda entre 09:00 e 09:15. Rodar de
 * minuto em minuto pagaria a varredura do catálogo 1440 vezes para descobrir a mesma
 * coisa. E o worker é idempotente por (material, data de validade), então uma segunda
 * rodada no mesmo dia não abre aviso repetido — a diária é economia, não a trava.
 *
 * ═══ AUSÊNCIA DE AUDITORIA, DECLARADA ═══
 *
 * Sem `audit()`: `lib/audit/actions.ts` é um union fechado, não tem código para esta
 * família, e o arquivo está fora do conjunto de escrita desta tarefa (inventar a string
 * reprovaria no `typecheck`, que é o comportamento certo do union). O registro durável do
 * que a rodada fez é o item na Central de avisos — e esse, ao contrário do
 * `api_audit_log`, é lido por quem precisa agir.
 *
 * Auth: mesmo contrato dos demais crons — Bearer `INTERNAL_CRON_SECRET` ou
 * `INTERNAL_SECRET`, fail-closed (sem segredo configurado, ninguém entra).
 *
 * Nenhuma `organization_id` entra por aqui — nem query, nem body. As organizações
 * avisadas são **descobertas** pelo worker no banco (dono da linha do acervo, ou espelho
 * ativo do escopo curado), nunca aceitas do chamador.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DIAS_DE_ANTECEDENCIA,
  avisarValidadeDeMaterial,
  type ResultadoDaVarredura,
} from "@/workers/validade-de-material";

export const dynamic = "force-dynamic";

/**
 * A query é input externo — a rota é pública por natureza, e o guardião é o segredo, não a
 * obscuridade da URL. `dias` existe para o operador conseguir varrer uma janela maior numa
 * rodada manual (ex.: depois de importar um acervo inteiro) sem editar o crontab.
 */
const querySchema = z.object({
  dias: z.coerce.number().int().min(1).max(365).default(DIAS_DE_ANTECEDENCIA),
});

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

  let resultado: ResultadoDaVarredura;
  try {
    resultado = await avisarValidadeDeMaterial(createAdminClient(), {
      diasDeAntecedencia: parsed.data.dias,
      requestId,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("[validade-de-material] rodada falhou", { error: detail, requestId });
    return fail("internal_error", "Failed to scan material validity.", 500, { requestId });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
