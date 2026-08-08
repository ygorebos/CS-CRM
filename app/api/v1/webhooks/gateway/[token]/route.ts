/**
 * POST /api/v1/webhooks/gateway/[token]
 *
 * A porta única de entrada do tráfego de canal. O gateway recebe de todos os
 * canais que suporta, normaliza para UM envelope e entrega aqui; o CRM persiste
 * no próprio banco. Nenhum payload de provedor atravessa esta rota.
 *
 * ## O que esta rota faz, e o que ela deliberadamente NÃO faz
 *
 * Ela **verifica e enfileira**, e responde `202`. A ingestão — contato,
 * conversa, mensagem, turno do agente, follow-up, auditoria, `event_log` — roda
 * FORA do ciclo da resposta.
 *
 * Isso é ACK-primeiro, e é dívida que esta feature paga junto: a rota do webhook
 * legado espera o `dispatch` inteiro antes de responder. Com um emissor que não
 * retenta agressivamente, passa despercebido; com um que retenta em 20 segundos,
 * cada processamento lento vira mensagem duplicada no inbox. Responder antes de
 * processar é o que fecha isso.
 *
 * A durabilidade vem da fila: `webhook_events_log` já tinha `status` com
 * `received/processed/error/dead`, `attempts` e `processed_at` — era uma fila
 * que ninguém usava como fila. O disparo imediato em segundo plano é o que
 * sustenta o alvo de ≤5s; o dreno periódico é o que garante que nada fica para
 * trás se o processo cair no meio. Um só dos dois não fecha os dois critérios.
 *
 * ## Isolamento
 *
 * A organização vem da linha de `channel_sessions` encontrada pelo token do
 * caminho — fonte confiável — e **nunca** do corpo. Corpo que traga
 * `organization_id` é ignorado; o token vence sempre.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { env } from "@/lib/env";
import { autenticarEntregaDoGateway } from "@/lib/gateway/auth";
import { parseEnvelope } from "@/lib/gateway/envelope";
import { ingerirEnvelope } from "@/lib/gateway/ingest";
import { checarTetoDaConexao } from "@/lib/gateway/rate-limit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!env.GATEWAY_INBOUND_ENABLED) {
    // Rota desligada responde 404, não 503: uma porta que anuncia "existo mas
    // estou fechada" convida a insistir e a enumerar tokens.
    return fail("not_found", "gateway inbound disabled", 404, { requestId });
  }

  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  // Teto ANTES de tocar no banco: um teto que só protege depois da consulta não
  // protege o banco, que é o recurso escasso aqui.
  const teto = await checarTetoDaConexao(token);
  if (!teto.permitido) {
    return fail("rate_limited", "too many deliveries for this connection", 429, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const corpoCru = await req.text();
  if (corpoCru.length > env.GATEWAY_MAX_BODY_BYTES) {
    return fail("invalid_request", "body_too_large", 413, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const admin = createAdminClient();

  // Canal ARQUIVADO não ingere: o usuário mandou excluí-lo. O que ainda pode
  // chegar é evento em voo, e aceitá-lo ressuscitaria o canal no inbox com o
  // operador sem conseguir responder.
  const base = () =>
    admin
      .from("channel_sessions")
      .select(
        "id, organization_id, webhook_secret_encrypted, ingest_path, gateway_connection_id",
      )
      .eq("webhook_path_token", token);
  const { data: sessao, error: sessErr } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).maybeSingle(),
    () => base().maybeSingle(),
  );

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, {
      requestId,
      headers: teto.cabecalhos,
    });
  }
  if (!sessao) {
    // Token desconhecido não tem organização a que pertencer. Não se grava linha
    // sem dono num log isolado por tenant: ela nasceria invisível para todo
    // mundo, e adivinhar tenant é a pior falha possível aqui (FR-017a).
    logger.warn("[gateway.webhook] token desconhecido", { requestId });
    return fail("not_found", "unknown webhook token", 404, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const organizationId = sessao.organization_id as string;

  // Conexão que não foi migrada recusa pelo caminho novo. Aceitar aqui e também
  // no caminho legado duplicaria o trabalho e confundiria o diagnóstico — a
  // chave de corte existe para que exista UM dono por conexão a cada momento.
  if (sessao.ingest_path !== "gateway") {
    await audit({
      action: "webhook.gateway_rejected",
      organizationId,
      metadata: { reason: "ingest_path_legacy", channel_session_id: sessao.id },
    });
    return fail("invalid_request", "connection_not_migrated", 409, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const segredo = await decryptWebhookSecret(
    admin,
    (sessao.webhook_secret_encrypted as string) ?? "",
  );

  const auth = autenticarEntregaDoGateway({
    corpoCru,
    assinatura:
      req.headers.get("x-gateway-signature") ?? req.headers.get("X-Gateway-Signature"),
    timestamp:
      req.headers.get("x-gateway-timestamp") ?? req.headers.get("X-Gateway-Timestamp"),
    segredo,
  });

  if (!auth.ok) {
    // Motivo próprio, nunca 401 genérico: `segredo_nao_provisionado` é defeito de
    // configuração desta conexão e precisa virar aviso na Central, não silêncio
    // que o operador vai caçar do lado errado.
    await audit({
      action: "webhook.gateway_rejected",
      organizationId,
      metadata: {
        reason: auth.motivo,
        channel_session_id: sessao.id,
        delivery_id: req.headers.get("x-gateway-delivery-id"),
      },
    });
    return fail("unauthenticated", auth.motivo, 401, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  let bruto: unknown;
  try {
    bruto = JSON.parse(corpoCru);
  } catch {
    return fail("invalid_request", "invalid_json", 400, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const parse = parseEnvelope(bruto);
  if (!parse.ok) {
    // `event_kind_desconhecido` é recusa NOMEADA: o gateway não deve retentar um
    // evento que este CRM não trata. Retentar seria ruído infinito.
    await registrarRecebimento(admin, {
      organizationId,
      channelSessionId: sessao.id as string,
      token,
      corpoCru,
      status: "error",
      motivo: parse.motivo,
      detalhe: parse.detalhe ?? null,
    });
    return fail("invalid_request", parse.motivo, 400, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const envelope = parse.envelope;

  // A partir daqui a entrega é DURÁVEL. A linha é o ACK: se o processo cair no
  // próximo milissegundo, o dreno recolhe.
  const { data: linha, error: logErr } = await registrarRecebimento(admin, {
    organizationId,
    channelSessionId: sessao.id as string,
    token,
    corpoCru,
    status: "received",
    eventType: envelope.eventKind,
    externalId: envelope.message?.externalId ?? null,
    payload: bruto as Record<string, unknown>,
  });

  if (logErr) {
    // Falhar aqui é o único caso em que se pede retentativa ao gateway: sem a
    // linha não há durabilidade, e responder 202 seria mentir.
    return fail("internal_error", "delivery_not_persisted", 500, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const duplicada = envelope.message
    ? await jaIngerida(admin, organizationId, envelope.message.externalId)
    : false;

  // Disparo em segundo plano: é o que sustenta o alvo de ≤5s. O dreno periódico
  // é a rede de baixo, para o caso de o processo cair entre o ACK e o fim disto.
  // Um só dos dois não fecha os dois critérios da spec.
  const idDaLinha = linha?.id as string | undefined;
  void ingerirEnvelope(admin, { id: sessao.id as string, organization_id: organizationId }, envelope, requestId)
    .then(async (r) => {
      if (!idDaLinha) return;
      await admin
        .from("webhook_events_log")
        .update(
          r.ok
            ? { status: "processed", processed_at: new Date().toISOString() }
            : { status: "error", error_message: r.motivo, attempts: 1 },
        )
        .eq("id", idDaLinha);
    })
    .catch(async (err: unknown) => {
      // Exceção aqui NÃO pode sumir: a entrega já foi confirmada ao gateway, que
      // não vai reentregar. Quem recolhe é o dreno, e ele precisa da linha em
      // `error` para saber que há algo a recolher.
      logger.error("[gateway.webhook] ingestão em segundo plano falhou", {
        requestId,
        erro: err instanceof Error ? err.message : String(err),
      });
      if (!idDaLinha) return;
      await admin
        .from("webhook_events_log")
        .update({
          status: "error",
          error_message: err instanceof Error ? err.message : String(err),
          attempts: 1,
        })
        .eq("id", idDaLinha);
    });

  // Reentrega responde SUCESSO. Responder erro faria o gateway retentar para
  // sempre algo já processado.
  return ok(
    { accepted: true, duplicate: duplicada, delivery_log_id: idDaLinha ?? null },
    { status: 202, requestId, headers: teto.cabecalhos },
  );
}

async function jaIngerida(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  externalId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("messages")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("external_id", externalId)
    .maybeSingle();
  return Boolean(data);
}

async function registrarRecebimento(
  admin: ReturnType<typeof createAdminClient>,
  e: {
    organizationId: string;
    channelSessionId: string;
    token: string;
    corpoCru: string;
    status: "received" | "error";
    eventType?: string;
    externalId?: string | null;
    payload?: Record<string, unknown>;
    motivo?: string;
    detalhe?: string | null;
  },
) {
  return admin
    .from("webhook_events_log")
    .insert({
      organization_id: e.organizationId,
      channel_session_id: e.channelSessionId,
      provider: "gateway",
      webhook_path_token: e.token,
      http_method: "POST",
      raw_body: e.corpoCru,
      payload_parsed: e.payload ?? null,
      // A assinatura já foi verificada antes de chegar aqui — se não tivesse
      // sido, não haveria linha. Registrar `true` é a verdade, ao contrário do
      // que o caminho legado fazia com evento não verificado.
      valid_signature: true,
      event_type: e.eventType ?? e.motivo ?? "unknown",
      external_id: e.externalId ?? null,
      status: e.status,
      attempts: 0,
      error_message: e.detalhe ?? e.motivo ?? null,
    })
    .select("id")
    .maybeSingle();
}
