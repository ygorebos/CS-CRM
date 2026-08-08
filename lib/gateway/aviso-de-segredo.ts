/**
 * O aviso que impede uma conexão não curada de virar silêncio (T017e da spec 001).
 *
 * ## O defeito que este arquivo existe para tornar visível
 *
 * A entrega do gateway é fail-closed sem válvula: sem segredo forte, a rota
 * recusa **100%** das entregas daquela conexão. Isso é o comportamento certo —
 * aceitar entrega não verificada é o buraco que já foi explorado neste produto.
 * O problema é o que o operador VÊ quando isso acontece: nada. As mensagens
 * simplesmente param de chegar, o inbox fica vazio, e não há onde olhar.
 *
 * A cura das linhas antigas roda no `install.sh`/`update.sh`, fora do SQL,
 * porque a chave de cifra só existe depois do baseline. Um clone que atualize
 * pela metade — ou que rode o baseline sem o script — fica exatamente neste
 * estado. O Princípio II proíbe que falta de funcionamento vire silêncio, e é
 * por isso que a recusa abre aviso onde o humano olha.
 *
 * ## Por que UM aviso por conexão, e não um por entrega
 *
 * Uma conexão quebrada recusa toda entrega que chega. Sem deduplicação, um
 * número movimentado encheria a Central com centenas de avisos idênticos em
 * minutos — e uma Central inundada é tão ilegível quanto uma vazia. Enquanto
 * houver aviso `open` para aquela conexão, não se abre outro; resolver o aviso
 * sem curar o segredo faz o próximo aviso nascer, que é o comportamento certo:
 * o aviso descreve um estado, e o estado continua lá.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { logger } from "@/lib/logger";

/**
 * Vocabulário de `agent_inbox_items.kind` (migration 0120).
 *
 * Tipado como `InboxKind` — e o import é só de TIPO, que some no build — para
 * que um kind escrito à mão aqui e ausente da constraint vire erro de
 * compilação. O par `InboxKind` × constraint do banco é cobrado por
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts`, e sem o tipo aqui
 * esta constante ficaria fora dessa vigia: o INSERT é fire-and-forget, então a
 * divergência apareceria como um `23514` que nunca chega à tela de ninguém.
 */
export const KIND_SEGREDO_AUSENTE: InboxKind = "channel_secret_missing";

export interface EntradaDoAviso {
  organizationId: string;
  channelSessionId: string;
  requestId: string;
}

/**
 * Abre o aviso se ainda não houver um aberto para esta conexão.
 *
 * Devolve `true` quando abriu agora. Nunca lança: esta função roda no caminho de
 * uma recusa, e falhar aqui não pode transformar uma recusa correta em `500`
 * — o `500` faria o gateway retentar para sempre uma entrega que nunca passa.
 */
export async function avisarSegredoNaoProvisionado(
  admin: SupabaseClient,
  e: EntradaDoAviso,
): Promise<boolean> {
  try {
    const { data: jaAberto, error: buscaErr } = await admin
      .from("agent_inbox_items")
      .select("id")
      .eq("organization_id", e.organizationId)
      .eq("kind", KIND_SEGREDO_AUSENTE)
      .eq("ref_id", e.channelSessionId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();

    if (buscaErr) {
      logger.warn("[gateway.aviso] busca de aviso aberto falhou", {
        requestId: e.requestId,
        erro: buscaErr.message,
      });
      // Segue e tenta abrir: um aviso duplicado é muito melhor que nenhum.
    }

    if (jaAberto) return false;

    const { error: insErr } = await admin.from("agent_inbox_items").insert({
      organization_id: e.organizationId,
      kind: KIND_SEGREDO_AUSENTE,
      severity: "critical",
      title: "Uma conexão não está recebendo mensagens",
      body:
        "A chave de verificação desta conexão não foi gerada, então toda mensagem " +
        "que chega por ela está sendo recusada — nenhuma some, mas nenhuma entra. " +
        "Isso acontece quando a instalação foi atualizada sem o passo que gera as " +
        "chaves. Rode o atualizador novamente (update.sh) ou recrie a conexão; " +
        "assim que a chave existir, as mensagens voltam a entrar sozinhas.",
      ref_kind: "channel_session",
      ref_id: e.channelSessionId,
    });

    if (insErr) {
      logger.error("[gateway.aviso] abrir aviso de segredo ausente falhou", {
        requestId: e.requestId,
        organization_id: e.organizationId,
        erro: insErr.message,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.error("[gateway.aviso] exceção ao avisar segredo ausente", {
      requestId: e.requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
