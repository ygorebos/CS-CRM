/**
 * Qual número usar no upsert quando o mesmo cliente chega com duas grafias (FR-020).
 *
 * ## O defeito
 *
 * A mesma pessoa chega com identificadores diferentes conforme a direção: o envio
 * funciona com 13 dígitos (`5531998966398`) e o `wa_id` do recebimento vem com 12
 * (`553198966398`) — é o nono dígito brasileiro, omitido para celulares
 * registrados antes da mudança.
 *
 * O banco não desfaz isso: `contacts.wa_identity` é `'phone:' || phone_number`
 * literal, então as duas grafias são duas identidades e o índice único não vê
 * conflito. Quem recebe uma mensagem e quem responde viram DOIS cadastros —
 * conversa partida, histórico do lead fragmentado, e silencioso: ninguém percebe
 * até ver dois contatos com o mesmo nome.
 *
 * ## Por que esta função existe em vez de a regra estar solta no ingest
 *
 * A regra já existia — dentro de `lib/channels/meta/ingest.ts`, aplicada só ali.
 * O ingest do gateway nasceria sem ela, e o defeito voltaria por um caminho novo.
 * Extrair é o que impede a terceira cópia: qualquer canal que resolva contato por
 * telefone passa por aqui.
 *
 * ## Por que a busca é INJETADA
 *
 * O ingest fala com o banco por supabase-js; o invariante fala por SQL puro contra
 * o Postgres descartável que nasce do `baseline.sql`. Com o acesso a dados
 * injetado, os dois exercitam a MESMA regra — se ela fosse reescrita no teste, o
 * teste provaria uma cópia, e cópia não vigia nada: o dia em que o ingest mudasse,
 * o invariante continuaria verde.
 *
 * ## O que esta função deliberadamente NÃO faz
 *
 * Não reescreve o número gravado. Normalizar na escrita (todo 12 vira 13)
 * uniformizaria o dado e poderia **fundir dois contatos reais** — um fixo legítimo
 * de 12 dígitos viraria um celular inexistente, e fusão não tem volta. A regra
 * só AMPLIA a busca; errar custa no máximo um `select` a mais.
 */
import { phoneLookupVariants } from "@/lib/channels/phone-variants";

/**
 * Devolve o número já cadastrado sob qualquer variante; na ausência, o recebido
 * em E.164.
 *
 * `buscar` recebe as variantes e devolve o `phone_number` de um contato existente
 * (ou `null`). Cabe a quem chama filtrar por organização — misturar tenants aqui
 * seria vazamento, e a organização não é assunto desta regra.
 */
export async function numeroCanonicoParaUpsert(
  numeroRecebido: string,
  buscar: (variantes: string[]) => Promise<string | null>,
): Promise<string> {
  const variantes = phoneLookupVariants(numeroRecebido);
  // Sem variante nenhuma não há o que buscar — e devolver o recebido mantém o
  // comportamento anterior em vez de inventar um número.
  if (variantes.length === 0) return numeroRecebido;

  const original = variantes[0]!;
  // Uma variante só significa que o número não tem contraparte possível (fixo,
  // número curto, qualquer país que não o Brasil). Buscar seria um `select` que
  // nunca muda a resposta.
  if (variantes.length === 1) return original;

  const existente = await buscar(variantes);
  return existente ?? original;
}
