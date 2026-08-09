/**
 * A queda do gateway vira alerta E aviso (spec 004, T037 / FR-023, Princípio XIV).
 *
 * ## Por que isto existe
 *
 * O Princípio XIV declara o gateway como **SPOF**: instância única, compartilhada,
 * sem réplica. Ele não pede que a queda seja impossível — pede que ela seja
 * **audível**: "queda vira alerta pra nós E aviso na Central pro usuário".
 *
 * A metade da operação é fácil e já existe em qualquer log de erro. A que falta
 * é a do usuário, e é a que decide o desfecho: com o gateway fora, nada entra e
 * nada sai, e a tela do corretor fica **idêntica a um dia devagar**. Ele não
 * abre chamado porque não tem o que reportar — só para de acreditar no produto.
 *
 * ## Por que no dreno, e não num cron novo
 *
 * Mesma razão de [`avisarRecebimentoDesligado`](./aviso-de-recebimento-desligado.ts):
 * o dreno já roda a cada minuto, já tem o cliente de serviço na mão e já é o
 * dono declarado do caminho do gateway. Um cron a mais é uma peça a mais para
 * agendar, monitorar e esquecer.
 *
 * ## O aviso FECHA sozinho, e isso não é enfeite
 *
 * Queda de processo é quase sempre transitória. Um aviso crítico que continua
 * aberto depois de o serviço voltar treina exatamente o hábito que a Central não
 * pode criar — o de ignorar o que está lá. Por isso o tique que encontra o
 * gateway de pé **resolve** os avisos que ele mesmo abriu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

/** Vocabulário de `agent_inbox_items.kind` (migration 0129). */
export const KIND_GATEWAY_FORA: InboxKind = "gateway_unreachable";

/**
 * Teto da sondagem. Curto de propósito: o dreno tem um minuto inteiro, mas ficar
 * pendurado numa conexão morta atrasaria o recolhimento das mensagens — que é o
 * trabalho principal dele.
 */
const TIMEOUT_MS = 3000;

export interface DesfechoDaSondagem {
  /** `null` quando não havia por que sondar (ninguém depende do gateway). */
  alcancavel: boolean | null;
  avisosAbertos: number;
  avisosResolvidos: number;
}

/**
 * Organizações que DEPENDEM do gateway hoje — as únicas que devem ser avisadas.
 *
 * Duas dependências, uma pergunta: conexão que recebe pela rota nova
 * (`ingest_path='gateway'`) e conexão que envia pelo gateway (tem
 * `gateway_connection_id`). Basta uma para a queda doer.
 *
 * Avisar quem não depende seria alarme falso em toda instalação que ainda não
 * virou a chave — e alarme falso é o que ensina a ignorar a Central.
 */
async function organizacoesQueDependemDoGateway(
  admin: SupabaseClient,
  requestId: string,
): Promise<string[] | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("organization_id, ingest_path, gateway_connection_id")
    .is("archived_at", null)
    .limit(500);

  if (error) {
    logger.warn("[gateway.fora] busca de conexões falhou", { requestId, erro: error.message });
    return null;
  }

  const linhas = (data ?? []) as {
    organization_id: string;
    ingest_path: string | null;
    gateway_connection_id: string | null;
  }[];

  return [
    ...new Set(
      linhas
        .filter((l) => l.ingest_path === "gateway" || l.gateway_connection_id !== null)
        .map((l) => l.organization_id),
    ),
  ];
}

/** O gateway responde? `false` cobre rede fora, tempo esgotado e resposta de erro. */
async function gatewayResponde(): Promise<boolean> {
  const base = env.GATEWAY_BASE_URL.trim().replace(/\/+$/, "");
  if (base === "") return false;
  try {
    const res = await fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // Rede fora, DNS, TLS, timeout: para quem depende do gateway o efeito é o
    // mesmo, e distinguir aqui não muda o conserto.
    return false;
  }
}

/**
 * Sonda o gateway e mantém o aviso da Central coerente com o que encontrou.
 *
 * Nunca lança: roda dentro do dreno, e explodir aqui pararia o recolhimento das
 * mensagens que ainda dá para salvar.
 */
export async function avisarGatewayForaDoAr(
  admin: SupabaseClient,
  opts: { requestId: string },
): Promise<DesfechoDaSondagem> {
  const vazio: DesfechoDaSondagem = { alcancavel: null, avisosAbertos: 0, avisosResolvidos: 0 };

  try {
    const orgs = await organizacoesQueDependemDoGateway(admin, opts.requestId);
    if (orgs === null || orgs.length === 0) return vazio;

    const alcancavel = await gatewayResponde();

    if (alcancavel) {
      // Voltou: fecha o que esta função abriu. `status='open'` no filtro para não
      // reabrir discussão sobre item que alguém já tratou à mão.
      const { data, error } = await admin
        .from("agent_inbox_items")
        .update({ status: "resolved" })
        .eq("kind", KIND_GATEWAY_FORA)
        .eq("status", "open")
        .in("organization_id", orgs)
        .select("id");

      if (error) {
        logger.warn("[gateway.fora] fechar avisos falhou", {
          requestId: opts.requestId,
          erro: error.message,
        });
        return { alcancavel: true, avisosAbertos: 0, avisosResolvidos: 0 };
      }
      return {
        alcancavel: true,
        avisosAbertos: 0,
        avisosResolvidos: ((data ?? []) as { id: string }[]).length,
      };
    }

    // A metade da OPERAÇÃO (Princípio XIV). `error` e não `warn`: é o que vira
    // alerta no Sentry, e a queda do SPOF não é ruído de fundo.
    logger.error("[gateway.fora] o gateway não respondeu à sondagem", {
      requestId: opts.requestId,
      organizacoes_afetadas: orgs.length,
    });

    let abertos = 0;
    for (const org of orgs) {
      const { data: jaAberto } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", org)
        .eq("kind", KIND_GATEWAY_FORA)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();

      if (jaAberto) continue;

      const { error: insErr } = await admin.from("agent_inbox_items").insert({
        organization_id: org,
        kind: KIND_GATEWAY_FORA,
        severity: "critical",
        title: "As mensagens estão paradas: o serviço de conexão não responde",
        body:
          "O serviço que leva e traz as mensagens do WhatsApp está fora do ar. " +
          "Enquanto isso, nada chega aqui e nada sai daqui — inclusive o que você " +
          "mandar agora vai ficar aguardando. Nada se perde: as mensagens voltam a " +
          "aparecer quando o serviço voltar. Já fomos avisados e estamos cuidando. " +
          "Se for urgente, responda pelo aparelho para não deixar ninguém esperando.",
        ref_kind: "organization",
        ref_id: org,
      });

      if (insErr) {
        logger.error("[gateway.fora] abrir aviso falhou", {
          requestId: opts.requestId,
          organization_id: org,
          erro: insErr.message,
        });
        continue;
      }
      abertos += 1;
    }

    return { alcancavel: false, avisosAbertos: abertos, avisosResolvidos: 0 };
  } catch (err) {
    logger.error("[gateway.fora] exceção ao sondar", {
      requestId: opts.requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return vazio;
  }
}
