/**
 * O padrão que reconhece "nome de provider" para o invariante 1 da doutrina de
 * restrição de canal (`docs/doctrine/restricao-de-canal.md`).
 *
 * Mora num módulo separado de `lint-channels.ts` por um motivo só: o script é
 * uma casca que varre o disco e chama `process.exit` no topo do módulo, então
 * importá-lo de um teste RODARIA o lint. Sem separar, o mecanismo do
 * reconhecimento fica sem como ser vigiado — e foi exatamente o que deixou o
 * furo abaixo viver.
 *
 * ─── O furo (issue #118) ────────────────────────────────────────────────────
 *
 * A primeira versão era `/\b(waha|WAHA|meta_cloud|graph\.facebook\.com)\b/`.
 * `_` é *word character* em regex, então `\b` NÃO fecha entre `WAHA` e `_`:
 * `WAHA_API_KEY` e `waha_session_name` — os nomes de provider mais comuns do
 * código — passavam invisíveis pela catraca, que está no `gov:verify` e é
 * catraca de merge. Uma catraca com furo é pior que catraca nenhuma: o verde
 * afirma que a doutrina está sendo respeitada.
 *
 * ─── Por que DUAS fronteiras, e não uma ─────────────────────────────────────
 *
 * Um provider vira identificador em TypeScript de dois jeitos, e cada um pede
 * uma fronteira diferente. Uma regex só não expressa os dois sem virar ilegível
 * ou frouxa:
 *
 *   `waha_session_name`, `WAHA_API_KEY`, `@/lib/waha/x`  → separador não-alfanumérico
 *   `WahaClient`, `createWahaSession`                    → transição de caixa
 *
 * Consertar só a primeira deixaria a segunda como álibi para o próximo caso —
 * é o mesmo furo (uma grafia do provider que a catraca não vê), na outra
 * dimensão. Medido na main de 2026-08-05: a regra PascalCase custa **zero**
 * arquivo ofensor a mais (hoje todo arquivo que a tem também importa de
 * `lib/waha/`), então fechar a classe inteira aqui não cria dívida nova.
 */

/**
 * Grafia separada por não-alfanumérico: `waha`, `WAHA_API_KEY`,
 * `waha_session_name`, `lib/waha/client`, `meta_cloud`, `graph.facebook.com`.
 *
 * A fronteira é "não colado em alfanumérico" — deixa `_`, `/`, `.` e `-` serem
 * separadores de verdade (que `\b` não deixava) e continua ignorando `wahax` /
 * `xwaha`, onde `waha` é pedaço de outra palavra e não menção ao provider.
 */
const SEPARADO = /(?<![a-zA-Z0-9])(waha|meta_cloud|graph\.facebook\.com)(?![a-zA-Z0-9])/i;

/**
 * Grafia PascalCase dentro de identificador: `WahaClient`,
 * `WahaChannelAdapter`, `createWahaSession`.
 *
 * Case-SENSITIVE de propósito: é a transição de caixa que marca a fronteira do
 * segmento. Não seguido de minúscula/dígito exclui `Wahalla` — onde `Waha` é
 * começo de outra palavra, não segmento próprio.
 */
const PASCAL = /Waha(?![a-z0-9])/;

/** Um trecho de código/prosa nomeia um provider de canal? */
export function nomeiaProvider(texto: string): boolean {
  return SEPARADO.test(texto) || PASCAL.test(texto);
}

/** Exportadas para o teste de fronteira poder vigiar cada uma isoladamente. */
export const PADROES = { SEPARADO, PASCAL } as const;

/**
 * ─── Invariante 2: FORMA de payload de provedor (spec 004, T052 / FR-042) ───
 *
 * O invariante 1 pega o NOME do provider. Não pega o que é pior de achar depois:
 * código lendo a FORMA crua da resposta dele sem citar o nome. `data.key.id`,
 * `msg._serialized`, `resp.messageid` — nada ali diz "WAHA" ou "uazapi", e a
 * catraca antiga passava batido.
 *
 * A doutrina (anti-pattern 15) proíbe código novo do CRM ler payload cru: só
 * envelope na entrada, só o contrato do `ChannelAdapter` na saída. O caminho de
 * RECEBIMENTO já tinha vigia — o envelope é obrigatório e há invariante para
 * isso. O de ENVIO não tinha, e é justamente onde a forma crua reaparece: quem
 * escrever um envio novo vai receber a resposta do canal e ficar tentado a
 * cavar o id dela na mão, em vez de pedir ao adapter.
 *
 * ─── Por que a lista é CURTA, e por que isso é a decisão ────────────────────
 *
 * A primeira versão desta regra incluía `fromMe`, `chatId`, `pushName` e
 * `participant`. Medido na main: 8 arquivos ofensores, e **nenhum deles lia
 * payload cru** — `chatId` é o nome que o handler de envio dá ao destinatário
 * resolvido PELO adapter, e `pushName` aparece em coluna e em prosa. Uma regra
 * que reprova o código correto ensina a contorná-la, e vira a catraca com furo
 * que a issue #118 já custou caro.
 *
 * Ficaram só as formas que NÃO têm outro dono possível: `_serialized` e
 * `key.id` são estrutura do Baileys/WEBJS, `messageid` e `remoteJid` são campos
 * da resposta do provedor. Nenhuma delas tem razão de existir fora de
 * `lib/channels/`, `lib/waha/` e `lib/gateway/` — que são o transporte.
 */
const FORMA_CRUA = /(?<![a-zA-Z0-9_])(_serialized|messageid|remoteJid|jsonMessage|key\.id)(?![a-zA-Z0-9])/;

/** Um trecho lê a FORMA crua de um payload de provedor? */
export function leFormaCruaDeProvedor(texto: string): boolean {
  return FORMA_CRUA.test(texto);
}
