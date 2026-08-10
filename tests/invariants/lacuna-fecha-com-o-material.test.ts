import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A lacuna se fecha quando o material chega — T110, SC-013.
 *
 * ═══ POR QUE ESTE INVARIANTE, E NÃO SÓ UM TESTE DE UNIDADE ═══
 *
 * O fechamento é um `update` com QUATRO filtros — organização, kind, escopo e status — e o
 * defeito perigoso é um deles faltar. Um dublê de supabase-js aceita qualquer encadeamento
 * e devolve o que o teste mandou devolver: `eq("knowledge_scope_id", …)` esquecido passaria
 * verde, e em produção fecharia a lacuna de TODAS as operadoras assim que qualquer material
 * entrasse. É a diferença entre "a query foi montada" e "a query separou o que devia".
 *
 * ═══ OS DOIS CASOS QUE NÃO PODEM FECHAR ═══
 *
 * 1. **Lacuna sem operadora** (`knowledge_scope_id` nulo) — o agente não identificou a
 *    operadora. Não há material que se saiba cobri-la, e fechá-la junto esconderia a
 *    pergunta que mais precisa de gente olhando.
 * 2. **Lacuna de OUTRA organização** — óbvio de dizer e o mais fácil de perder, porque o
 *    `update` sem filtro de tenant funciona perfeitamente em banco de teste com um tenant só.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG_A = "1ac00000-0000-4000-8000-000000000001";
const ORG_B = "1ac00000-0000-4000-8000-000000000002";

let escopoX = "";
let escopoY = "";
let escopoB = "";
let contatoA = "";
let contatoB = "";

/** Ids dos avisos, por apelido, para as asserções falarem de linhas e não de contagens. */
const aviso: Record<string, string> = {};

async function statusDe(id: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    "select status from agent_inbox_items where id = $1",
    [id],
  );
  return rows[0]!.status;
}

/**
 * O fechamento, escrito como o `lib/ai/knowledge/fechar-lacuna.ts` o faz: os QUATRO
 * filtros. Copiar a query aqui é deliberado — é o contrato que este arquivo vigia, e
 * importar o módulo traria o supabase-js e o cliente admin para dentro do invariante.
 */
async function fechar(org: string, scopeId: string | null, trechos: number): Promise<number> {
  if (scopeId === null || trechos <= 0) return 0;
  const { rowCount } = await pool.query(
    `update agent_inbox_items
        set status = 'resolved'
      where organization_id = $1
        and kind = 'assistance_without_grounding'
        and knowledge_scope_id = $2
        and status = 'open'`,
    [org, scopeId],
  );
  return rowCount ?? 0;
}

beforeAll(async () => {
  for (const [org, slug] of [
    [ORG_A, "lacuna-a"],
    [ORG_B, "lacuna-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Lacuna LTDA', 'Lacuna') on conflict (id) do nothing`,
      [org, slug],
    );
  }

  const escopo = async (org: string, nome: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into knowledge_scopes (organization_id, display_name, is_active)
         values ($1, $2, true) returning id`,
        [org, nome],
      )
    ).rows[0]!.id;

  escopoX = await escopo(ORG_A, "Operadora X da lacuna");
  escopoY = await escopo(ORG_A, "Operadora Y da lacuna");
  escopoB = await escopo(ORG_B, "Operadora da vizinha");

  const contato = async (org: string, tel: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into contacts (organization_id, name, phone_number)
         values ($1, 'Cliente da lacuna', $2) returning id`,
        [org, tel],
      )
    ).rows[0]!.id;
  contatoA = await contato(ORG_A, "+5585999991101");
  contatoB = await contato(ORG_B, "+5585999991102");

  const criarAviso = async (
    apelido: string,
    org: string,
    ref: string,
    scopeId: string | null,
  ): Promise<void> => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into agent_inbox_items
         (organization_id, kind, severity, title, body, ref_kind, ref_id, knowledge_scope_id, status)
       values ($1, 'assistance_without_grounding', 'warn', 'Pergunta sem material', 'corpo',
               'contact', $2, $3, 'open') returning id`,
      [org, ref, scopeId],
    );
    aviso[apelido] = rows[0]!.id;
  };

  await criarAviso("x", ORG_A, contatoA, escopoX);
  await criarAviso("y", ORG_A, contatoA, escopoY);
  await criarAviso("sem-escopo", ORG_A, contatoA, null);
  await criarAviso("vizinha", ORG_B, contatoB, escopoB);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("SC-013 — o material que chega fecha a lacuna daquela operadora", () => {
  it("CONTROLE: os quatro avisos nascem abertos", async () => {
    for (const k of ["x", "y", "sem-escopo", "vizinha"]) {
      expect(await statusDe(aviso[k]!), `aviso ${k}`).toBe("open");
    }
  });

  it("material sem trecho não fecha nada — indexar vazio não é resolver", async () => {
    expect(await fechar(ORG_A, escopoX, 0)).toBe(0);
    expect(await statusDe(aviso.x!)).toBe("open");
  });

  it("material sem operadora não fecha nada — 'vale para todos' não cobre lacuna de escopo", async () => {
    expect(await fechar(ORG_A, null, 12)).toBe(0);
    expect(await statusDe(aviso.x!)).toBe("open");
  });

  it("material da X fecha SÓ a lacuna da X", async () => {
    expect(await fechar(ORG_A, escopoX, 7)).toBe(1);
    expect(await statusDe(aviso.x!)).toBe("resolved");
    // Os três pares que impedem o `update` frouxo de passar:
    expect(await statusDe(aviso.y!), "a lacuna da Y foi fechada junto").toBe("open");
    expect(await statusDe(aviso["sem-escopo"]!), "a lacuna sem operadora foi fechada").toBe("open");
    expect(await statusDe(aviso.vizinha!), "a lacuna da OUTRA organização foi fechada").toBe(
      "open",
    );
  });

  it("rodar de novo não muda nada — o filtro de status torna a operação idempotente", async () => {
    expect(await fechar(ORG_A, escopoX, 7)).toBe(0);
    expect(await statusDe(aviso.x!)).toBe("resolved");
  });

  it("o aviso resolvido CONTINUA existindo — fechar não é apagar", async () => {
    // É ele que responde "por que esta operadora tinha lacuna semana passada?". Trocar a
    // lista suja por memória vazia seria perder a única fonte dessa resposta.
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text n from agent_inbox_items where id = $1",
      [aviso.x!],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("escopo removido não arrasta o histórico junto (`on delete set null`)", async () => {
    // A FK da 0136 é `set null`: apagar a linha de escopo não pode apagar o registro de que
    // a pergunta ficou sem resposta. O aviso perde a capacidade de ser fechado
    // automaticamente, e continua legível pelo corpo.
    await pool.query("delete from knowledge_scopes where id = $1", [escopoY]);
    expect(await statusDe(aviso.y!)).toBe("open");
    const { rows } = await pool.query<{ knowledge_scope_id: string | null }>(
      "select knowledge_scope_id from agent_inbox_items where id = $1",
      [aviso.y!],
    );
    expect(rows[0]!.knowledge_scope_id).toBeNull();
  });
});
