/**
 * O mesmo cliente, com as duas grafias do número, cai num contato só (T027a, FR-020).
 *
 * ## O defeito, medido contra a WABA real
 *
 * A mesma pessoa chega com identificadores diferentes conforme a direção: o envio
 * funciona com 13 dígitos (`5531998966398`) e o `wa_id` do recebimento vem com 12
 * (`553198966398`). É o nono dígito brasileiro, omitido para celulares registrados
 * antes da mudança.
 *
 * O banco **não** desfaz isso sozinho, e este arquivo prova: `contacts.wa_identity`
 * é `'phone:' || phone_number` literal, então as duas grafias produzem duas
 * identidades distintas e o índice único não vê conflito nenhum. Quem recebe uma
 * mensagem e quem responde viram DOIS cadastros — conversa partida, histórico do
 * lead fragmentado, e silencioso: ninguém percebe até ver dois contatos com o
 * mesmo nome.
 *
 * ## Por que este invariante existe SEPARADO do teste do módulo puro
 *
 * `tests/unit/gateway-identidade-canonica.test.ts` cobre a regra como função —
 * rápido, e é lá que os casos de fixo e de número estrangeiro vivem. Aqui o que se
 * prova é outra coisa: que a regra, aplicada contra o **schema que o clone recebe**,
 * de fato colapsa as duas grafias num contato e numa conversa. As duas partes
 * podem estar certas isoladamente e erradas juntas — se `fn_upsert_wa_contact`
 * passasse a chavear por outra coisa, o módulo puro continuaria verde.
 *
 * A busca roda pela MESMA função que o ingest usa (`numeroCanonicoParaUpsert`), com
 * o acesso a dados injetado. Reescrever a regra aqui provaria uma cópia, e cópia
 * não vigia nada: o dia em que o ingest mudasse, este arquivo continuaria verde.
 */
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { numeroCanonicoParaUpsert } from "@/lib/channels/identidade-canonica";

const PORTA = process.env.TEST_DB_PORT ?? "54329";
const CONN =
  process.env.TEST_DB_URL ?? `postgres://postgres:postgres@127.0.0.1:${PORTA}/postgres`;

const ORG = "00000000-0000-4000-8000-00000000c027";
const SESSAO = "00000000-0000-4000-8000-00000000c028";

/** Como chega o mesmo celular pelas duas pontas. */
const COM_NONO = "+5531998966398";
const SEM_NONO = "+553198966398";

let pool: Pool;

/** O acesso a dados que o ingest faz com supabase-js, aqui feito com SQL puro. */
async function buscarPorVariantes(variantes: string[]): Promise<string | null> {
  const { rows } = await pool.query<{ phone_number: string }>(
    `select phone_number from contacts
      where organization_id = $1 and phone_number = any($2::text[])
      limit 1`,
    [ORG, variantes],
  );
  return rows[0]?.phone_number ?? null;
}

/** A sequência do ingest, com a regra de canonicalização no lugar certo. */
async function ingerirDe(numeroRecebido: string, nomeDoPerfil: string): Promise<string> {
  const numero = await numeroCanonicoParaUpsert(numeroRecebido, buscarPorVariantes);
  const { rows } = await pool.query<{ fn_upsert_wa_contact: string }>(
    `select fn_upsert_wa_contact($1, 'phone', $2, null, $3, $4)`,
    [ORG, numero, `${numero.replace("+", "")}@c.us`, nomeDoPerfil],
  );
  return rows[0]!.fn_upsert_wa_contact;
}

async function conversaDe(contactId: string): Promise<string> {
  const { rows } = await pool.query<{ fn_upsert_wa_conversation: string }>(
    `select fn_upsert_wa_conversation($1, $2, $3)`,
    [ORG, contactId, SESSAO],
  );
  return rows[0]!.fn_upsert_wa_conversation;
}

describe("identidade canônica na entrada do gateway", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: CONN });
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, 'inv-c027', 'Org do invariante T027a', 'Org do invariante T027a')
       on conflict (id) do nothing`,
      [ORG],
    );
    await pool.query(
      `insert into channel_sessions
         (id, organization_id, webhook_secret_encrypted, provider, ingest_path,
          gateway_connection_id, webhook_path_token)
       values ($1, $2, '\\x00'::bytea, 'whatsapp_uazapi', 'gateway', 'conn_c027', 'tok_c027')
       on conflict (id) do nothing`,
      [SESSAO, ORG],
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("o número que chega SEM o nono dígito reencontra o contato cadastrado COM ele", async () => {
    const primeiro = await ingerirDe(COM_NONO, "Cliente do envio");
    const segundo = await ingerirDe(SEM_NONO, "Cliente da resposta");

    // Um contato, não dois. É a diferença entre um histórico e dois cadastros
    // órfãos com o mesmo nome.
    expect(segundo).toBe(primeiro);

    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from contacts
        where organization_id = $1 and phone_number = any($2::text[])`,
      [ORG, [COM_NONO, SEM_NONO]],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("e as duas grafias caem numa ÚNICA conversa", async () => {
    const a = await conversaDe(await ingerirDe(COM_NONO, "x"));
    const b = await conversaDe(await ingerirDe(SEM_NONO, "y"));

    // A conversa é chaveada por contato + conexão. Contato único ⇒ conversa
    // única — que é o que o corretor vê como "a conversa dele".
    expect(b).toBe(a);
  });

  it("o número gravado NÃO é reescrito pela grafia que chegou depois", async () => {
    const id = await ingerirDe(SEM_NONO, "z");
    const { rows } = await pool.query<{ phone_number: string }>(
      `select phone_number from contacts where id = $1`,
      [id],
    );
    // Reescrever o número gravado mudaria o dado de quem já estava lá para
    // acomodar uma variante de entrada — e a fusão de dois contatos não tem volta.
    // A regra AMPLIA a busca; ela nunca reinterpreta o que está gravado.
    expect(rows[0]!.phone_number).toBe(COM_NONO);
  });

  it("o BANCO sozinho não unifica — é por isso que a regra precisa existir", async () => {
    // Sem passar pela regra, o upsert vê duas identidades distintas
    // (`phone:+5531998966398` × `phone:+553198966398`) e o índice único não
    // reclama. Este caso é o que impede alguém de concluir que a canonicalização
    // é redundante e removê-la.
    const outroFone = "+5541988887777";
    const outroSemNono = "+554188887777";
    await pool.query(`select fn_upsert_wa_contact($1, 'phone', $2, null, $3, $4)`, [
      ORG,
      outroFone,
      `${outroFone.replace("+", "")}@c.us`,
      "sem regra 1",
    ]);
    await pool.query(`select fn_upsert_wa_contact($1, 'phone', $2, null, $3, $4)`, [
      ORG,
      outroSemNono,
      `${outroSemNono.replace("+", "")}@c.us`,
      "sem regra 2",
    ]);

    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from contacts
        where organization_id = $1 and phone_number = any($2::text[])`,
      [ORG, [outroFone, outroSemNono]],
    );
    expect(rows[0]!.n).toBe("2");
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Fazer `numeroCanonicoParaUpsert` devolver sempre o número recebido
 *     → "reencontra o contato cadastrado" e "única conversa" caem.
 *  2. Fazer a regra REESCREVER o contato para a grafia nova
 *     → "o número gravado NÃO é reescrito" cai.
 */
