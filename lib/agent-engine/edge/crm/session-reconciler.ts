/**
 * Watchdog de sessão (Fase 4A-2) — o pedaço do Vendaval que ficou de fora do
 * porte e cuja falta causou o incidente real das mensagens presas: o webhook
 * session.status se perde num restart e o espelho `channel_sessions` diverge do
 * WAHA real; como o envio exige WORKING no espelho, respostas ficam `queued`
 * para sempre.
 *
 * Dois deveres, um tick:
 *   1. RECONCILIADOR: lê o status REAL das sessões na API do WAHA e corrige o
 *      espelho quando divergir (a fonte da verdade do status é o WAHA) — só das
 *      sessões DESSE canal, ver abaixo;
 *   2. REDRIVE: mensagens `sent_via='ai'` presas em `queued` cuja sessão está
 *      WORKING são reenviadas **pelo canal da própria sessão** (com espaçamento
 *      anti-rajada) e marcadas `sent` — nunca dropadas, nunca duplicadas (só
 *      linhas ainda `queued`).
 *
 * Regra dura nº 4 respeitada: message-plane nunca fala com o WAHA — este módulo
 * é o WATCHDOG (admin-plane), o único lugar do engine autorizado a falar com a
 * API de SESSÃO do WAHA diretamente (o envio normal segue via sendMessageHandler).
 *
 * ─── O redrive falava um dialeto só (spec 004, FR-020 / T035) ────────────────
 *
 * Até 2026-08-08 o redrive montava `POST /api/sendText` do WAHA na mão, com
 * `waha_session_name` e um `chatId` construído aqui. Num canal migrado para o
 * gateway essas duas coisas são NULAS — a sessão se identifica por
 * `gateway_connection_id` —, então o watchdog mandava para o WAHA um envio com
 * `session: null` e marcava a mensagem `sent`. Lugar errado, ou lugar nenhum, e
 * em silêncio: exatamente a falha que o watchdog existe para consertar,
 * recriada por ele.
 *
 * Agora o redrive pede o adapter do provider da sessão (`lib/channels/`) — o
 * MESMO seam do envio normal. Provider sem adapter, canal não configurado ou
 * sessão sem endereço: a mensagem **fica `queued`** e o tick reclama. Nunca
 * `sent` sem ter saído — é o que separa "ainda vai" de "já foi" na tela.
 */
import type pg from 'pg';

import { getAdapter } from '@/lib/channels';
import { resolveSessionRef, type ChannelSessionRef } from '@/lib/channels/session-ref';
import type { ChannelProvider } from '@/lib/channels/types';

import type { Logger } from '../../obs/logger';

export interface WatchdogConfig {
  wahaBaseUrl: string;
  wahaApiKey: string;
  /** intervalo do tick (knob WATCHDOG_INTERVAL_MS) */
  intervalMs: number;
  /** idade mínima de uma queued para redrive — evita corrida com o insert do handler */
  redriveMinAgeMs: number;
  /** teto de redrives por tick (anti-rajada) */
  redriveBatchSize: number;
  /** espaçamento entre redrives (base + jitter) */
  redriveSpacingMs: number;
}

interface WahaSession {
  name: string;
  status: string;
}

async function fetchWahaSessions(cfg: WatchdogConfig): Promise<WahaSession[] | null> {
  try {
    const res = await fetch(`${cfg.wahaBaseUrl}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': cfg.wahaApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as WahaSession[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null; // WAHA fora: tick pula (transiente) — nunca derruba o worker
  }
}

/** Corrige o espelho channel_sessions para o status REAL do WAHA. */
export async function reconcileSessions(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  const sessions = await fetchWahaSessions(cfg);
  if (sessions === null) {
    log.warn('watchdog: WAHA indisponível — tick de reconciliação pulado', {});
    return 0;
  }
  let fixed = 0;
  for (const s of sessions) {
    // `provider = 'waha'` no WHERE, e não só o nome: `waha_session_name` é
    // apagado na migração de canal, mas uma linha que ficasse com o nome antigo
    // preenchido teria o status ditado por um canal que já não é o dela.
    const { rows } = await pool.query<{ id: string; status: string }>(
      `update channel_sessions
       set status = $2, updated_at = now()
       where waha_session_name = $1 and provider = 'waha' and status is distinct from $2
       returning id, status`,
      [s.name, s.status],
    );
    for (const row of rows) {
      fixed += 1;
      log.warn('watchdog: espelho de sessão reconciliado com o WAHA real', {
        channel_session_id: row.id,
        waha_session: s.name,
        status: s.status,
      });
    }
  }
  return fixed;
}

interface QueuedRow {
  id: string;
  organization_id: string;
  body: string | null;
  provider: ChannelProvider;
  waha_session_name: string | null;
  meta_phone_number_id: string | null;
  gateway_connection_id: string | null;
  wa_identity: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

/** Reenvia mensagens AI presas em queued com sessão WORKING, pelo canal DELA. */
export async function redriveQueued(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
): Promise<number> {
  // As três colunas de referência viajam juntas porque quem decide qual delas
  // vale é `resolveSessionRef` — perguntar aqui seria o `if (provider === ...)`
  // que a doutrina de restrição de canal proíbe.
  const { rows } = await pool.query<QueuedRow>(
    `select m.id, m.organization_id, m.body,
            s.provider, s.waha_session_name, s.meta_phone_number_id, s.gateway_connection_id,
            c.wa_identity, c.phone_number, v.is_group, v.group_chat_id
     from messages m
     join channel_sessions s on s.id = m.channel_session_id
     join conversations v on v.id = m.conversation_id
     join contacts c on c.id = m.contact_id
     where m.sent_via = 'ai' and m.status = 'queued'
       and s.status = 'WORKING'
       and c.is_blocked = false
       and m.created_at < now() - make_interval(secs => $1 / 1000.0)
     order by m.created_at
     limit $2`,
    [cfg.redriveMinAgeMs, cfg.redriveBatchSize],
  );

  let sent = 0;
  for (const m of rows) {
    // `getAdapter` é fail-closed e LANÇA para provider sem envio. Aqui isso não
    // pode derrubar o tick nem, pior, cair no WAHA por default: a mensagem fica
    // queued e o aviso nomeia o canal.
    let adapter;
    try {
      adapter = getAdapter(m.provider);
    } catch {
      log.warn('watchdog: canal sem envio — queued mantida (nunca redirecionada a outro canal)', {
        message_id: m.id,
        provider: m.provider,
      });
      continue;
    }

    const chatId = adapter.resolveRecipient({
      isGroup: m.is_group,
      groupChatId: m.group_chat_id,
      phoneNumber: m.phone_number,
      waIdentity: m.wa_identity,
    });
    if (chatId === null || m.body === null) {
      log.warn('watchdog: queued sem destino/corpo — pulada', { message_id: m.id });
      continue;
    }
    if (!adapter.isConfigured()) {
      // NOOP de canal não configurado devolve `externalId: null` sem ter
      // enviado nada — marcar `sent` aqui trocaria "ainda vai" por "já foi" na
      // tela, que é a mentira mais cara deste módulo.
      log.warn('watchdog: canal não configurado — queued mantida para o próximo tick', {
        message_id: m.id,
        provider: m.provider,
      });
      continue;
    }

    try {
      const { externalId } = await adapter.send({
        sessionRef: resolveSessionRef({
          provider: m.provider,
          waha_session_name: m.waha_session_name,
          meta_phone_number_id: m.meta_phone_number_id,
          gateway_connection_id: m.gateway_connection_id,
        } as unknown as ChannelSessionRef),
        to: chatId,
        kind: 'text',
        body: m.body,
      });
      await pool.query(
        `update messages
         set status = 'sent', ack = 0,
             external_id = coalesce($2, external_id),
             metadata = metadata || '{"redrive":"watchdog"}'::jsonb
         where id = $1 and status = 'queued'`,
        [m.id, externalId],
      );
      sent += 1;
      log.info('watchdog: mensagem presa reenviada', { message_id: m.id, has_external_id: externalId !== null });
    } catch (err) {
      log.warn('watchdog: redrive com erro transiente — mantida queued', {
        message_id: m.id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
    // espaçamento anti-rajada entre reenvios
    await new Promise((r) => setTimeout(r, cfg.redriveSpacingMs + Math.random() * cfg.redriveSpacingMs));
  }
  return sent;
}

/** Loop do watchdog — reconcilia e redrive a cada tick; erro nunca derruba o worker. */
export async function runSessionWatchdogLoop(
  pool: pg.Pool,
  cfg: WatchdogConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const fixed = await reconcileSessions(pool, cfg, log);
      const redriven = await redriveQueued(pool, cfg, log);
      if (fixed + redriven > 0) {
        log.info('watchdog: tick com ação', { reconciled: fixed, redriven });
      }
    } catch (err) {
      log.error('watchdog: tick falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cfg.intervalMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
