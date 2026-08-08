/**
 * O aviso que impede uma entrega descartada de virar silêncio (T037 da spec 001).
 *
 * ## Por que este arquivo existe separado do aviso de segredo
 *
 * Os dois tornam visível um problema de recebimento, mas o DESFECHO é oposto, e
 * é o desfecho que decide o que a pessoa faz:
 *
 *   - `channel_secret_missing`: nenhuma mensagem se perde. O gateway trata a
 *     recusa como `5xx` e retenta; assim que a chave existir, o período inteiro
 *     entra sozinho. A ação é consertar e esperar.
 *   - `gateway_delivery_dead` (aqui): a entrega **acabou**. As tentativas se
 *     esgotaram, ou a linha chegou sem dono, ou o envelope não parseia — não vai
 *     haver outra tentativa. A ação é ir atrás do cliente.
 *
 * Um kind só para os dois daria a mesma frase para dois problemas de gravidade
 * diferente, e a pessoa que lê "houve um problema de recebimento" não tem como
 * saber se precisa agir hoje.
 *
 * ## Por que UM aviso por conexão, e não um por descarte
 *
 * Quando o destino está quebrado, ele está quebrado para todo mundo: um lote do
 * dreno pode matar dezenas de linhas da mesma conexão de uma vez. Sem
 * deduplicação, a Central viraria uma parede de avisos idênticos exatamente no
 * dia em que ela mais precisa ser lida. Enquanto houver aviso `open` para aquela
 * conexão, não se abre outro — e resolver o aviso com o defeito de pé faz o
 * próximo nascer, que é o certo: o aviso descreve um estado.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { logger } from "@/lib/logger";

/**
 * Vocabulário de `agent_inbox_items.kind` (migration 0121).
 *
 * Tipado como `InboxKind` — import só de TIPO, que some no build — para que um
 * kind escrito à mão aqui e ausente da constraint vire erro de compilação. O par
 * `InboxKind` × constraint é cobrado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`; sem o tipo aqui, a
 * divergência apareceria como um `23514` fire-and-forget que nunca chega à tela.
 */
export const KIND_ENTREGA_DESCARTADA: InboxKind = "gateway_delivery_dead";

export interface EntradaDoAvisoDeDescarte {
  organizationId: string;
  channelSessionId: string | null;
  motivo: string;
  requestId: string;
}

/**
 * Abre o aviso se ainda não houver um aberto para esta conexão.
 *
 * Devolve `true` quando abriu agora. Nunca lança: roda dentro do laço do dreno,
 * e explodir aqui abortaria o recolhimento das outras linhas — trocar um aviso
 * perdido por um lote inteiro parado é péssimo negócio.
 */
export async function avisarEntregaDescartada(
  admin: SupabaseClient,
  e: EntradaDoAvisoDeDescarte,
): Promise<boolean> {
  try {
    let busca = admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", e.organizationId)
      .eq("kind", KIND_ENTREGA_DESCARTADA)
      .eq("status", "open");

    // Linha sem conexão também precisa de aviso — é o caso em que o dreno nem
    // sabe de onde a entrega veio. Deduplica por organização, então.
    busca = e.channelSessionId ? busca.eq("ref_id", e.channelSessionId) : busca.is("ref_id", null);

    const { data: jaAberto, error: buscaErr } = await busca.limit(1).maybeSingle();

    if (buscaErr) {
      logger.warn("[gateway.descarte] busca de aviso aberto falhou", {
        requestId: e.requestId,
        erro: buscaErr.message,
      });
      // Segue e tenta abrir: aviso duplicado é muito melhor que nenhum.
    }

    if (jaAberto) return false;

    const { error: insErr } = await admin.from("agent_inbox_items").insert({
      organization_id: e.organizationId,
      kind: KIND_ENTREGA_DESCARTADA,
      severity: "critical",
      title: "Mensagens de clientes não chegaram e não virão",
      body:
        "Uma ou mais mensagens recebidas não conseguiram entrar no sistema e as " +
        "tentativas se esgotaram — elas não vão aparecer no inbox. Abra a conversa " +
        "no aparelho para ver o que foi dito e responder por lá; depois verifique a " +
        `conexão deste canal. Motivo técnico registrado: ${e.motivo}.`,
      ref_kind: "channel_session",
      ref_id: e.channelSessionId,
    });

    if (insErr) {
      logger.error("[gateway.descarte] abrir aviso de descarte falhou", {
        requestId: e.requestId,
        organization_id: e.organizationId,
        erro: insErr.message,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.error("[gateway.descarte] exceção ao avisar descarte", {
      requestId: e.requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
