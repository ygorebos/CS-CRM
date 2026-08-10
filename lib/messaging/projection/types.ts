/**
 * As formas que a leitura da conversa devolve — nenhuma delas é tabela.
 *
 * Citação, reação e apagamento são a MESMA coisa no banco: um evento que aponta
 * para uma mensagem, pelo campo `metadata.reply_to_external_id`. O que muda é o
 * papel que ele cumpre na tela. Por isso as três saem de uma consulta só, e por
 * isso vivem juntas neste arquivo.
 */

/** Quem produziu o evento, do ponto de vista da conversa. */
export type ActorKind = "inbound" | "outbound";

/** O trecho citado, resolvido a partir da mensagem-alvo. */
export interface MessageQuote {
  /** `null` quando o alvo não existe no CRM (ver `isUnavailable`). */
  messageId: string | null;
  authorKind: ActorKind;
  /** Tipo do alvo — é o que faz a citação de um anexo dizer o que é. */
  type: string;
  /** Recorte do corpo do alvo. Vazio é legítimo (anexo sem legenda). */
  preview: string;
  /** O alvo carrega marca de apagado. */
  isDeleted: boolean;
  /**
   * O alvo não existe aqui — mensagem anterior à conexão do canal, ou perdida.
   * A citação continua aparecendo; o que ela diz é que o original não está.
   */
  isUnavailable: boolean;
}

/**
 * Uma reação presa à mensagem.
 *
 * É ESTADO, não histórico: vale no máximo uma por `actorKind`, a mais recente.
 * Reação removida (emoji vazio) não vira entrada — some.
 */
export interface MessageReaction {
  emoji: string;
  actorKind: ActorKind;
  reactedAt: string;
}

/**
 * A marca de que a mensagem foi apagada no canal.
 *
 * NÃO esconde o corpo (FR-005): o conteúdo continua na resposta e na tela, sob a
 * marca. O corretor precisa da evidência do que foi dito antes de o cliente
 * voltar atrás; o que a marca acrescenta é que o cliente já não vê aquilo.
 */
export interface MessageDeletion {
  deletedAt: string;
  deletedByKind: ActorKind;
}

/** O rótulo que substitui a bolha vazia quando esta versão não sabe exibir. */
export interface UnsupportedMessage {
  /** O tipo cru que o canal mandou, quando ele veio (`metadata.original_type`). */
  originalType: string | null;
  label: string;
}

/**
 * O que acompanha CADA mensagem na leitura.
 *
 * Sempre presente, com chaves internas nulas quando não se aplica: opcionalidade
 * no objeto inteiro obrigaria toda leitura da tela a testar duas coisas.
 */
export interface MessageProjection {
  quote: MessageQuote | null;
  reactions: MessageReaction[];
  deletion: MessageDeletion | null;
  unsupported: UnsupportedMessage | null;
}

export const PROJECAO_VAZIA: MessageProjection = {
  quote: null,
  reactions: [],
  deletion: null,
  unsupported: null,
};
