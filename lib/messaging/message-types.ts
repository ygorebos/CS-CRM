/**
 * O vocabulário de tipo de mensagem — UMA fonte, para os dois lados.
 *
 * Até aqui havia duas listas escritas à mão que ninguém obrigava a concordar:
 * `TIPOS_CONHECIDOS` em `lib/gateway/envelope.ts` (o que ENTRA) e
 * `messageTypeSchema` em `lib/schemas/messaging.ts` (o que SAI) — e uma terceira,
 * a de verdade, no CHECK `messages_type_check` do Postgres. Três listas, zero
 * gates: o modo de falha é `23514` num INSERT de caminho pouco exercitado, que
 * passa por typecheck, lint e unitário e só aparece em produção.
 *
 * Aqui o union é a declaração, e o array vem dele com guarda de compilação nos
 * DOIS sentidos (`satisfies Record<MessageType, true>` reprova chave que falta e
 * chave que sobra). Do lado do banco, quem cobra é o par em
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que lê ESTE arquivo
 * e o CHECK, e reprova a divergência que o compilador não enxerga.
 *
 * ⚠️ Acrescentar valor aqui sem a migration (ou o contrário) quebra o portão de
 * propósito. Os três artefatos da doutrina de migrations andam junto com esta
 * linha.
 */

/**
 * Tudo que `messages.type` aceita — a UNIÃO de entrada e saída, espelhando
 * `messages_type_check` valor a valor.
 *
 * ⚠️ Este é o símbolo que o invariante de vocabulário lê, e ele precisa continuar
 * sendo uma união de literais escrita à mão. Trocá-la por uma derivação do array
 * faria o extrator devolver lista vazia e o par passaria por vacuidade.
 *
 * ⚠️ E não escreva a forma da declaração dentro de um comentário deste arquivo:
 * o extrator casa por regex no texto inteiro, sem tirar comentário antes, então a
 * primeira ocorrência vence. Medido: uma frase de documentação com a assinatura
 * literal foi capturada no lugar do código, rendeu zero literais, e o invariante
 * acusou "falha do INSTRUMENTO" — que era exatamente o que estava acontecendo.
 */
export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "location"
  | "contact"
  | "reaction"
  | "system"
  | "template"
  | "menu"
  | "cta_url"
  | "location_request";

/**
 * A guarda. `satisfies` reprova chave a mais; `Record<MessageType, true>` reprova
 * chave a menos. Nenhum dos dois lados pode crescer sozinho.
 */
const CATALOGO = {
  text: true,
  image: true,
  video: true,
  audio: true,
  document: true,
  sticker: true,
  location: true,
  contact: true,
  reaction: true,
  system: true,
  template: true,
  menu: true,
  cta_url: true,
  location_request: true,
} satisfies Record<MessageType, true>;

/** O union em forma de array, para quem precisa iterar ou validar em runtime. */
export const MESSAGE_TYPES = Object.keys(CATALOGO) as readonly MessageType[];

/**
 * O que pode CHEGAR pelo envelope.
 *
 * `template` entra: o canal oficial devolve o eco do próprio disparo com esse
 * rótulo, e mapeá-lo para `system` apagaria justamente a coluna que carrega
 * custo e conformidade de janela.
 *
 * O que fica de fora não é lista: é tudo que não está aqui, e o envelope o
 * preserva como `system` + `metadata.original_type` (canal novo sem código novo).
 */
export const INBOUND_MESSAGE_TYPES = MESSAGE_TYPES;

export type InboundMessageType = MessageType;

/**
 * O que o CRM pode ENVIAR.
 *
 * `reaction` e `system` ficam de fora por natureza, não por esquecimento:
 * reagir não é operação de conversa comum na porta de tráfego (spec 006,
 * FR-022), e `system` é rótulo de evento, não mensagem que alguém compõe.
 */
const NAO_ENVIAVEIS = ["reaction", "system"] as const;

type NaoEnviavel = (typeof NAO_ENVIAVEIS)[number];

export type OutboundMessageType = Exclude<MessageType, NaoEnviavel>;

export const OUTBOUND_MESSAGE_TYPES = MESSAGE_TYPES.filter(
  (t): t is OutboundMessageType => !(NAO_ENVIAVEIS as readonly string[]).includes(t),
);

/** `true` se o valor é um tipo que o banco aceita. Usado no parse do envelope. */
export function isMessageType(valor: string): valor is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(valor);
}
