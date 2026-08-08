/**
 * GET/POST /api/v1/cron/gateway-reconciliation — a ponta que PUXA, no relógio
 * (spec 004, T050 / FR-013a, Princípio XIV).
 *
 * ## Por que um cron próprio, e não junto do dreno
 *
 * O dreno roda a cada minuto porque o trabalho dele é latência: mensagem parada
 * ali é mensagem que o corretor ainda não viu. A reconciliação é o oposto — ela
 * varre uma janela de uma hora contra um sistema externo, e rodá-la a cada minuto
 * gastaria 60 varreduras para achar o que uma acha. Ritmos diferentes, donos
 * diferentes; pendurá-la no dreno acoplaria o barato ao caro.
 *
 * ## O que ela NÃO faz
 *
 * Não conserta o defeito que perdeu a mensagem — só o torna visível e recupera o
 * que dá. Por isso toda recuperação vira alerta: uma reconciliação que trabalha
 * todo dia em silêncio é um defeito de produção que ninguém está investigando.
 *
 * Agendada no serviço `scheduler` do `docker-compose.prod.yml`, como os demais.
 * Auth: mesmo contrato dos outros crons (Bearer, fail-closed).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { provisionamentoConfigurado } from "@/lib/gateway/provisionamento";
import {
  alarmarDivergencia,
  JANELA_MS,
  reconciliarConexao,
} from "@/lib/gateway/reconciliacao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Teto de conexões por tique. A rodada seguinte pega o resto. */
const LOTE = 50;

interface Conexao {
  id: string;
  organization_id: string;
  gateway_connection_id: string;
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const headerSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  const provided = bearer || headerSecret;
  const aceitos = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean) as string[];
  if (aceitos.length === 0 || !provided || !aceitos.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  // Sem credencial de provisionamento não há como perguntar ao gateway. Responde
  // ok com o motivo em vez de erro: numa instalação que ainda não virou a chave,
  // isto é o estado NORMAL, e um 5xx a cada tique treinaria a ignorar o alarme.
  if (!provisionamentoConfigurado()) {
    return ok({ skipped: "gateway_nao_configurado" }, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, gateway_connection_id")
    .not("gateway_connection_id", "is", null)
    .is("archived_at", null)
    .limit(LOTE);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const conexoes = (data ?? []) as Conexao[];
  const until = new Date();
  const since = new Date(until.getTime() - JANELA_MS);

  let faltantes = 0;
  let recuperadas = 0;
  let irrecuperaveis = 0;
  // Por ORGANIZAÇÃO: o aviso é sobre "chegou mensagem atrasada no seu
  // histórico", e o corretor não distingue por qual conexão ela veio.
  const recuperadasPorOrg = new Map<string, number>();

  for (const c of conexoes) {
    const r = await reconciliarConexao(
      admin,
      {
        channelSessionId: c.id,
        organizationId: c.organization_id,
        gatewayConnectionId: c.gateway_connection_id,
      },
      { since, until, requestId },
    );
    faltantes += r.faltantes;
    recuperadas += r.recuperadas;
    irrecuperaveis += r.irrecuperaveis;
    if (r.recuperadas > 0) {
      recuperadasPorOrg.set(
        c.organization_id,
        (recuperadasPorOrg.get(c.organization_id) ?? 0) + r.recuperadas,
      );
    }
  }

  let avisos = 0;
  for (const [org, quantas] of recuperadasPorOrg) {
    if (await alarmarDivergencia(admin, org, quantas, requestId)) avisos += 1;
  }

  if (faltantes > 0 && recuperadas === 0) {
    // Achou buraco e não conseguiu tapar: pior que a divergência normal, porque
    // a mensagem continua sem existir aqui. Sai como erro mesmo sem aviso na
    // Central — não há o que o corretor faça, mas há o que NÓS temos de olhar.
    logger.error("[gateway.reconciliacao] divergência sem recuperação", {
      requestId,
      faltantes,
      irrecuperaveis,
    });
  }

  return ok(
    {
      connections: conexoes.length,
      window_from: since.toISOString(),
      missing: faltantes,
      recovered: recuperadas,
      unrecoverable: irrecuperaveis,
      notices: avisos,
    },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
