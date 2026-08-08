/**
 * A ponta que PUXA (spec 004, T050 / FR-013a, Princípio XIV).
 *
 * ## Por que duas pontas, e por que uma só é descumprimento
 *
 * O gateway guarda em disco o que não conseguiu entregar e retenta. Isso protege
 * contra **o CRM** estar fora do ar — e só. Não protege contra o gateway perder a
 * própria fila, contra a escrita aceita cuja transação morreu depois, nem contra
 * defeito no empurrador. O que essas três têm em comum é o desfecho: a mensagem
 * **nunca chegou a existir** deste lado, e um CRM que só espera ser empurrado não
 * tem como saber disso. Por isso o Princípio XIV chama uma ponta só de
 * descumprimento, não de escolha de custo.
 *
 * ## Duas fases, e a razão é o caso comum
 *
 * 1. `GET .../reconciliation?since&until` → `external_id` + direção + instante.
 *    Barato, e é o que responde "falta alguma coisa?".
 * 2. `POST .../reconciliation/fetch` com os ids que faltam → **envelopes**.
 *
 * Uma fase só, que já devolvesse tudo, pagaria o preço do caso raro em todo
 * tique: a janela quase sempre está completa, e trazer corpo, mídia e contato de
 * cada mensagem de uma hora de conversa seria desperdício por desenho.
 *
 * Como a fase 2 devolve **envelope** — o mesmo formato da entrega normal — a
 * reingestão usa `ingerirEnvelope`, o caminho idempotente de sempre. Não há
 * código de exceção para "mensagem que entrou pela reconciliação", e é isso que
 * impede que ela grave diferente do caminho principal.
 *
 * ## Divergência vira ALERTA — reconciliar em silêncio é proibido
 *
 * Se toda rodada recupera mensagens e ninguém fica sabendo, a reconciliação
 * deixa de ser rede de segurança e vira **tapa-buraco permanente**: o defeito que
 * a produz continua lá, agora invisível porque alguém o conserta a cada minuto.
 * Por isso recuperação > 0 escreve `logger.error` e abre aviso na Central.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { env } from "@/lib/env";
import { parseEnvelope } from "@/lib/gateway/envelope";
import { ingerirEnvelope } from "@/lib/gateway/ingest";
import { ErroDoGateway } from "@/lib/gateway/provisionamento";
import { logger } from "@/lib/logger";

/** Vocabulário de `agent_inbox_items.kind` (migration 0129). */
export const KIND_DIVERGENCIA: InboxKind = "gateway_reconciliation_gap";

/**
 * Janela de varredura por rodada.
 *
 * Uma hora: cobre com folga a fila em disco do gateway mais um reinício nosso, e
 * é curta o bastante para a varredura ser barata a cada tique. Janela maior não
 * acha mais nada — o que ficou para trás já foi recuperado na rodada anterior —
 * e faz o teto de paginação do gateway truncar.
 */
export const JANELA_MS = 60 * 60 * 1000;

/**
 * Quanto do passado IMEDIATO a janela ignora (spec 004, T061 — medido).
 *
 * Medido em 2026-08-08 contra o provedor real: mensagem enviada pela API **não
 * aparece** no `/message/find` um minuto depois — nem entre as 200 mais
 * recentes. Vinte e cinco minutos depois, aparece. É **latência de indexação**,
 * não ponto cego.
 *
 * A consequência é de desenho, e é esta constante: reconciliar até `agora`
 * declararia faltante toda mensagem recém-enviada, em toda rodada, e o alarme de
 * divergência viraria ruído constante — que é como se ensina a ignorá-lo.
 *
 * Trinta minutos: acima da latência observada, com folga, e bem dentro da janela
 * de uma hora, então nada deixa de ser varrido — só é varrido mais tarde.
 */
export const CARENCIA_DE_INDEXACAO_MS = 30 * 60 * 1000;

/** Teto de ids por chamada de conteúdo — o mesmo do outro lado. */
const TETO_DE_IDS = 200;

export interface ResultadoDaReconciliacao {
  conexoesVarridas: number;
  /** Mensagens que o gateway afirma terem existido e o CRM não tinha. */
  faltantes: number;
  /** Das faltantes, quantas entraram agora. */
  recuperadas: number;
  /** Ids que o provedor já não tem — não há o que gravar, e insistir seria laço. */
  irrecuperaveis: number;
}

interface ItemDaJanela {
  external_id: string;
  direction: string;
  timestamp: string;
}

async function chamarGateway(
  caminho: string,
  init: { method: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const base = env.GATEWAY_BASE_URL.trim().replace(/\/+$/, "");
  const resposta = await fetch(`${base}${caminho}`, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GATEWAY_ADMIN_TOKEN}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resposta.ok) {
    throw new ErroDoGateway(resposta.status, "erro_do_gateway", `gateway respondeu ${resposta.status}`);
  }
  return (await resposta.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Reconcilia UMA conexão numa janela. Nunca lança: roda em cron, e explodir numa
 * conexão pararia as outras.
 */
export async function reconciliarConexao(
  admin: SupabaseClient,
  conexao: { channelSessionId: string; organizationId: string; gatewayConnectionId: string },
  opts: { since: Date; until: Date; requestId: string },
): Promise<ResultadoDaReconciliacao> {
  const vazio: ResultadoDaReconciliacao = {
    conexoesVarridas: 1,
    faltantes: 0,
    recuperadas: 0,
    irrecuperaveis: 0,
  };

  let janela: Record<string, unknown>;
  try {
    janela = await chamarGateway(
      `/v1/connections/${encodeURIComponent(conexao.gatewayConnectionId)}/reconciliation` +
        `?since=${encodeURIComponent(opts.since.toISOString())}` +
        `&until=${encodeURIComponent(opts.until.toISOString())}`,
      { method: "GET" },
    );
  } catch (err) {
    // Gateway fora é problema conhecido e já alarmado pela sondagem do dreno
    // (T037). Aqui basta não fingir que a janela estava limpa.
    logger.warn("[gateway.reconciliacao] varredura da janela falhou", {
      requestId: opts.requestId,
      channel_session_id: conexao.channelSessionId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return vazio;
  }

  const itens = (Array.isArray(janela.messages) ? janela.messages : []) as ItemDaJanela[];
  if (janela.truncated === true) {
    // O gateway declara truncamento em vez de cortar em silêncio; ignorar isso
    // faria a rodada "confirmar" uma janela que ela não olhou inteira.
    logger.warn("[gateway.reconciliacao] janela truncada pelo gateway — estreite o intervalo", {
      requestId: opts.requestId,
      channel_session_id: conexao.channelSessionId,
    });
  }
  if (itens.length === 0) return vazio;

  const ids = itens.map((i) => i.external_id).filter(Boolean);
  if (ids.length === 0) return vazio;

  // Quais destes o CRM JÁ tem. A pergunta é por `external_id` dentro da
  // organização — a mesma chave do `unique (organization_id, external_id)` que
  // torna a reingestão idempotente.
  const { data: existentes, error } = await admin
    .from("messages")
    .select("external_id")
    .eq("organization_id", conexao.organizationId)
    .in("external_id", ids.slice(0, 1000));
  if (error) {
    logger.warn("[gateway.reconciliacao] consulta de existentes falhou", {
      requestId: opts.requestId,
      erro: error.message,
    });
    return vazio;
  }

  const tem = new Set(((existentes ?? []) as { external_id: string }[]).map((m) => m.external_id));
  const faltando = ids.filter((id) => !tem.has(id));
  if (faltando.length === 0) return vazio;

  let recuperadas = 0;
  let irrecuperaveis = 0;

  for (let i = 0; i < faltando.length; i += TETO_DE_IDS) {
    const lote = faltando.slice(i, i + TETO_DE_IDS);
    let conteudo: Record<string, unknown>;
    try {
      conteudo = await chamarGateway(
        `/v1/connections/${encodeURIComponent(conexao.gatewayConnectionId)}/reconciliation/fetch`,
        { method: "POST", body: { ids: lote } },
      );
    } catch (err) {
      logger.warn("[gateway.reconciliacao] busca de conteúdo falhou — o próximo tique tenta", {
        requestId: opts.requestId,
        erro: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const envelopes = Array.isArray(conteudo.envelopes) ? conteudo.envelopes : [];
    irrecuperaveis += Array.isArray(conteudo.nao_encontrados) ? conteudo.nao_encontrados.length : 0;

    for (const cru of envelopes) {
      const parse = parseEnvelope(cru);
      if (!parse.ok) {
        logger.warn("[gateway.reconciliacao] envelope ilegível veio da reconciliação", {
          requestId: opts.requestId,
          motivo: parse.motivo,
        });
        continue;
      }
      // MESMO caminho da entrega normal. Um atalho aqui gravaria diferente do
      // principal, e a diferença só apareceria no dia do incidente.
      const r = await ingerirEnvelope(
        admin,
        { id: conexao.channelSessionId, organization_id: conexao.organizationId },
        parse.envelope,
        opts.requestId,
      );
      if (r.ok) recuperadas += 1;
    }
  }

  return {
    conexoesVarridas: 1,
    faltantes: faltando.length,
    recuperadas,
    irrecuperaveis,
  };
}

/**
 * Abre o aviso da divergência — uma vez por organização enquanto houver um
 * aberto.
 *
 * Chamado só quando algo FOI recuperado: recuperar em silêncio transformaria a
 * rede de segurança em tapa-buraco permanente, com o defeito de origem intacto e
 * agora invisível.
 */
export async function alarmarDivergencia(
  admin: SupabaseClient,
  organizationId: string,
  quantas: number,
  requestId: string,
): Promise<boolean> {
  // A metade da OPERAÇÃO: `error` é o que vira alerta no Sentry.
  logger.error("[gateway.reconciliacao] mensagens recuperadas — houve perda no caminho normal", {
    requestId,
    organization_id: organizationId,
    recuperadas: quantas,
  });

  const { data: jaAberto } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", KIND_DIVERGENCIA)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (jaAberto) return false;

  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: KIND_DIVERGENCIA,
    severity: "warn",
    title:
      quantas === 1
        ? "Uma mensagem chegou atrasada ao histórico"
        : `${quantas} mensagens chegaram atrasadas ao histórico`,
    body:
      "Encontramos mensagens que existiam no WhatsApp e ainda não apareciam aqui, e já as " +
      "trouxemos — elas estão no lugar certo, na conversa certa. Vale conferir se alguém ficou " +
      "sem resposta enquanto elas não apareciam. Já estamos investigando por que demoraram.",
    ref_kind: "organization",
    ref_id: organizationId,
  });
  if (error) {
    logger.error("[gateway.reconciliacao] abrir aviso de divergência falhou", {
      requestId,
      organization_id: organizationId,
      erro: error.message,
    });
    return false;
  }
  return true;
}
