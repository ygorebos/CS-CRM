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
import { avisarSegredoNaoProvisionado } from "@/lib/gateway/aviso-de-segredo";
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
    // T043/SC-012: a recusa vira LINHA, não só auditoria. Quem for reconstruir
    // o caso precisa conseguir fazê-lo pelo banco — um incidente investigado
    // pelo log de aplicação depende de o log ainda existir, e num self-host ele
    // não sobrevive a um `docker compose up`.
    await registrarRecebimento(admin, {
      organizationId,
      channelSessionId: sessao.id as string,
      token,
      corpoCru,
      status: "error",
      motivo: "connection_not_migrated",
      assinaturaValida: false,
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
    await audit({
      action: "webhook.gateway_rejected",
      organizationId,
      metadata: {
        reason: auth.motivo,
        channel_session_id: sessao.id,
        delivery_id: req.headers.get("x-gateway-delivery-id"),
      },
    });

    // A recusa vira LINHA com o motivo, e `valid_signature: false`. É o que
    // permite responder "quantas entregas forjadas chegaram nesta conexão, e
    // quando" sem depender de log de aplicação (SC-012). O caminho legado
    // gravava `true` em evento não verificado, o que fazia a coluna mentir
    // exatamente no momento em que alguém iria auditá-la.
    await registrarRecebimento(admin, {
      organizationId,
      channelSessionId: sessao.id as string,
      token,
      corpoCru,
      status: "error",
      motivo: auth.motivo,
      assinaturaValida: false,
    });

    // Segredo não provisionado tem RAMO PRÓPRIO, e não o 401 genérico.
    //
    // Duas coisas mudam, e as duas importam. O código nomeia o defeito como
    // sendo DESTE lado — um `unauthenticated` mandaria o operador conferir a
    // configuração do emissor, que está certa. E o status é 503, não 401: pelo
    // contrato, o gateway descarta 401 e retenta 5xx, e esta recusa é curável —
    // com 503, as entregas do período quebrado entram sozinhas assim que a
    // chave existir, em vez de virarem buraco permanente no histórico.
    //
    // O aviso é o que impede a recusa de virar silêncio (Princípio II): sem ele
    // o sintoma é "as mensagens pararam", sem lugar nenhum para olhar.
    if (auth.motivo === "segredo_nao_provisionado") {
      await avisarSegredoNaoProvisionado(admin, {
        organizationId,
        channelSessionId: sessao.id as string,
        requestId,
      });
      return fail("gateway_secret_not_provisioned", auth.motivo, 503, {
        requestId,
        headers: { ...teto.cabecalhos, "Retry-After": "300" },
      });
    }

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
      // A assinatura passou; o que reprovou foi o formato do envelope.
      assinaturaValida: true,
    });
    return fail("invalid_request", parse.motivo, 400, {
      requestId,
      headers: teto.cabecalhos,
    });
  }

  const envelope = parse.envelope;

  // T042 — o corpo NUNCA decide organização, e a tentativa não some.
  //
  // A organização já veio da linha de `channel_sessions` achada pelo token, e o
  // que o corpo trouxe é dado inerte em `metadata.extra_*`. Mas ignorar em
  // silêncio perderia o único sinal de que alguém está tentando escrever no CRM
  // de outra pessoa — e é exatamente esse ataque que a versão fail-open da rota
  // antiga permitiu. Registrado como auditoria porque é evento de SEGURANÇA, não
  // erro de formato: a entrega segue, com o campo ignorado.
  if (parse.tenantForcado.length > 0) {
    logger.warn("[gateway.webhook] corpo tentou decidir organização", {
      requestId,
      chaves: parse.tenantForcado,
    });
    await audit({
      action: "webhook.gateway_rejected",
      organizationId,
      metadata: {
        reason: "tenant_no_corpo_ignorado",
        channel_session_id: sessao.id,
        chaves: parse.tenantForcado,
        delivery_id: req.headers.get("x-gateway-delivery-id"),
      },
    });
  }

  // A partir daqui a entrega é DURÁVEL. A linha é o ACK: se o processo cair no
  // próximo milissegundo, o dreno recolhe.
  const { data: linha, error: logErr } = await registrarRecebimento(admin, {
    organizationId,
    channelSessionId: sessao.id as string,
    token,
    corpoCru,
    status: "received",
    assinaturaValida: true,
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
    /**
     * Só é `true` depois de a assinatura ter sido conferida e passado. O caminho
     * legado gravava `true` em evento NÃO verificado, o que transformava a
     * coluna num campo decorativo — quem fosse auditar um incidente leria
     * "assinatura válida" em toda linha, inclusive nas forjadas.
     */
    assinaturaValida: boolean;
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
      valid_signature: e.assinaturaValida,
      event_type: e.eventType ?? e.motivo ?? "unknown",
      external_id: e.externalId ?? null,
      status: e.status,
      attempts: 0,
      error_message: e.detalhe ?? e.motivo ?? null,
    })
    .select("id")
    .maybeSingle();
}
