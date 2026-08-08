/**
 * GET/POST /api/v1/cron/gateway-inbound-drain
 *
 * A rede de baixo do ACK-primeiro.
 *
 * A rota de recebimento responde `202` assim que a entrega vira linha em
 * `webhook_events_log`, e dispara a ingestão em segundo plano. O disparo é o que
 * sustenta o alvo de ≤5s; **este dreno é o que garante que nada fica para trás**
 * quando o processo cai entre o ACK e o fim da ingestão — deploy, reinício, OOM.
 *
 * Um só dos dois não fecha os dois critérios da spec: só o dreno teria latência
 * de minutos e mataria a sensação de tempo real do inbox; só o disparo perderia
 * tudo que estivesse em voo num restart.
 *
 * ## O que ele recolhe, e o que deixa quieto
 *
 * Só linha `received` **parada há mais que a carência** — linha recém-criada
 * está sendo processada pelo disparo em segundo plano neste exato momento, e
 * recolhê-la seria processar a mesma entrega duas vezes. A carência é o que
 * separa "em voo" de "abandonada".
 *
 * Também recolhe `error`, até o teto de tentativas. Passou do teto, vira `dead`
 * e **abre aviso** — entrega que morreu em silêncio é o pior desfecho possível,
 * e é exatamente o que o `log.Warn` do encaminhamento antigo fazia.
 *
 * A reingestão é segura porque é idempotente: `unique (organization_id,
 * external_id)` derruba a segunda cópia da mensagem.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (ou `INTERNAL_SECRET`),
 * ou `X-Cron-Secret` — mesmo padrão dos demais crons.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { avisarEntregaDescartada } from "@/lib/gateway/aviso-de-descarte";
import { parseEnvelope } from "@/lib/gateway/envelope";
import { ingerirEnvelope } from "@/lib/gateway/ingest";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Quanto tempo uma linha `received` pode ficar sem ser processada antes de contar como abandonada. */
const CARENCIA_SEGUNDOS = 60;
/** Quantas linhas por tique. Teto baixo de propósito: o dreno roda a cada minuto. */
const LOTE = 50;
/** Depois disto a entrega vira `dead` e abre aviso, em vez de ser retentada para sempre. */
const MAX_TENTATIVAS = 5;

interface LinhaPendente {
  id: string;
  organization_id: string | null;
  channel_session_id: string | null;
  payload_parsed: unknown;
  attempts: number;
  status: string;
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

  const admin = createAdminClient();
  const corte = new Date(Date.now() - CARENCIA_SEGUNDOS * 1000).toISOString();

  const { data, error } = await admin
    .from("webhook_events_log")
    .select("id, organization_id, channel_session_id, payload_parsed, attempts, status")
    .eq("provider", "gateway")
    .in("status", ["received", "error"])
    .lt("received_at", corte)
    .order("received_at", { ascending: true })
    .limit(LOTE);

  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const linhas = (data ?? []) as LinhaPendente[];
  let processadas = 0;
  let mortas = 0;
  let falhas = 0;

  for (const linha of linhas) {
    if (linha.attempts >= MAX_TENTATIVAS) {
      await marcarMorta(admin, linha, "max_tentativas_excedido", requestId);
      mortas += 1;
      continue;
    }

    if (!linha.organization_id || !linha.channel_session_id) {
      // Sem dono não há o que ingerir, e a linha não pode ficar rodando para
      // sempre. Vira `dead` com motivo, para alguém ver.
      await marcarMorta(admin, linha, "linha_sem_conexao_ou_organizacao", requestId);
      mortas += 1;
      continue;
    }

    const parse = parseEnvelope(linha.payload_parsed);
    if (!parse.ok) {
      // Envelope que não parseia não melhora com retentativa.
      await marcarMorta(admin, linha, `envelope_invalido:${parse.motivo}`, requestId);
      mortas += 1;
      continue;
    }

    const r = await ingerirEnvelope(
      admin,
      { id: linha.channel_session_id, organization_id: linha.organization_id },
      parse.envelope,
      requestId,
    );

    if (r.ok) {
      await admin
        .from("webhook_events_log")
        .update({ status: "processed", processed_at: new Date().toISOString() })
        .eq("id", linha.id);
      processadas += 1;
    } else {
      await admin
        .from("webhook_events_log")
        .update({
          status: "error",
          error_message: r.motivo,
          attempts: linha.attempts + 1,
        })
        .eq("id", linha.id);
      falhas += 1;
    }
  }

  if (mortas > 0) {
    logger.warn("[gateway.drain] entregas descartadas", { requestId, mortas });
  }

  return ok(
    { examined: linhas.length, processed: processadas, dead: mortas, failed: falhas },
    { requestId },
  );
}

async function marcarMorta(
  admin: ReturnType<typeof createAdminClient>,
  linha: LinhaPendente,
  motivo: string,
  requestId: string,
): Promise<void> {
  await admin
    .from("webhook_events_log")
    .update({ status: "dead", error_message: motivo, processed_at: new Date().toISOString() })
    .eq("id", linha.id);

  if (!linha.organization_id) return;

  // Descarte VISÍVEL, em DUAS superfícies, e nenhuma das duas é decoração:
  //
  //   - o item na Central é o que uma PESSOA vê. Sem ele, a mensagem perdida só
  //     existe num log de servidor que ninguém abre, e o corretor descobre pela
  //     reclamação do cliente;
  //   - o `event_log` é o que outras peças consomem e o que sobra para o
  //     diagnóstico depois. Sozinho ele era evento sem consumidor — o
  //     anti-pattern nº 3 — e por isso não bastava.
  await avisarEntregaDescartada(admin, {
    organizationId: linha.organization_id,
    channelSessionId: linha.channel_session_id,
    motivo,
    requestId,
  });

  const { error } = await admin.rpc("emit_event" as never, {
    p_event_type: "gateway.entrega_descartada",
    p_entity_kind: "channel_session",
    p_entity_id: linha.channel_session_id,
    p_payload: { motivo, tentativas: linha.attempts, webhook_events_log_id: linha.id },
    p_metadata: { severity: "error" },
    p_organization_id: linha.organization_id,
  } as never);

  if (error) {
    logger.error("[gateway.drain] descarte E aviso falharam", {
      linha: linha.id,
      motivo,
      erro: error.message,
    });
  }
}

export const GET = handle;
export const POST = handle;
