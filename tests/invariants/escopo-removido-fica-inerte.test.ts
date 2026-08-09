import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Remover a operadora torna o material dela inerte **imediatamente** — T099, FR-008.
 *
 * ═══ POR QUE ISTO NÃO PODE SER PROVADO NO TESTE DA ROTA ═══
 *
 * `app/api/v1/knowledge-scopes/[id]/route.test.ts` dubla o supabase-js: ele mede que a rota
 * arquiva antes de marcar, que recusa espelho e que audita. Nenhuma dessas asserções toca a
 * `fn_buscar_lastro` — e "inerte" é uma afirmação sobre a BUSCA, não sobre a rota. Dublê
 * responde no formato que quem escreveu o teste inventou; inércia só se sabe perguntando ao
 * Postgres.
 *
 * ═══ A DESCOBERTA QUE MUDOU O DESENHO ═══
 *
 * A primeira implementação era um `delete` de verdade. Ela **não roda**: a FK de
 * `ai_knowledge_sources.scope_id` é `on delete set null` e a constraint
 * `ai_knowledge_sources_scope_xor_all` (0118) exige balde OU "vale para todos" — apagar o
 * escopo deixaria a fonte sem nenhum dos dois. O caso "`delete` de verdade é IMPOSSÍVEL"
 * congela essa medição: é onde a razão da remoção lógica (0134) fica escrita, e é o que
 * ficará vermelho no dia em que a constraint mudar e a decisão puder ser revista.
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO EXISTE PARA PEGAR ═══
 *
 * A saída "óbvia" para a constraint seria soltar o ponteiro com `applies_to_all = true`. Aí
 * o material da operadora **removida** passa a responder a todo mundo, sobre tudo — o
 * oposto exato de FR-008, e sem aparecer em tela nenhuma: some da lista e volta na resposta.
 * Por isso o caso "não é promovido ao balde 'todos'" existe, e por isso ele vem com o par
 * de CONTROLE — antes da remoção o material ancorava de fato.
 *
 * A segunda armadilha é a trava única. `deleted_at` sozinho bastaria para a busca ignorar o
 * escopo — mas `is_active` é escrito pelo PATCH da mesma rota, e com uma trava só um
 * `update ... set is_active = true` devolveria à vida o material que o corretor removeu.
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

const DIM = 1536;
const Q = `[${Array.from({ length: DIM }, (_, k) => (k === 1 ? 1 : 0)).join(",")}]`;

const ORG = "1de70000-0000-4000-8000-000000000001";
const CONTACT = "1de72222-0000-4000-8000-000000000001";
const CONV = "1de73333-0000-4000-8000-000000000001";
const SESSION = "1de74444-0000-4000-8000-000000000001";
const MSG = "1de75555-0000-4000-8000-000000000001";

let agente = "";
let kbv = "";
let escopoProprio = "";
let fonte = "";
let trecho = "";

interface Linha {
  chunk_id: string;
  layer: "tenant" | "catalog";
  content: string;
}

async function buscar(scope: string | null): Promise<Linha[]> {
  const { rows } = await pool.query<Linha>(
    "select chunk_id, layer, content from public.fn_buscar_lastro($1, $2, $3::vector, 20, 0.40, false)",
    [agente, scope, Q],
  );
  return rows;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'inerte-a', 'Inerte LTDA', 'Inerte') on conflict (id) do nothing`,
    [ORG],
  );
  agente = (
    await pool.query<{ id: string }>(
      "insert into ai_agents (organization_id, name, system_prompt) values ($1, 'agente-inerte', 'p') returning id",
      [ORG],
    )
  ).rows[0]!.id;
  kbv = (
    await pool.query<{ id: string }>(
      "insert into ai_knowledge_versions (organization_id, agent_id, version_number) values ($1, $2, 1) returning id",
      [ORG, agente],
    )
  ).rows[0]!.id;
  await pool.query("update ai_agents set active_kb_version_id = $1 where id = $2", [kbv, agente]);

  // Escopo PRÓPRIO (`catalog_scope_id` nulo) — é o único que a rota deixa remover.
  escopoProprio = (
    await pool.query<{ id: string }>(
      `insert into knowledge_scopes (organization_id, display_name, is_active)
       values ($1, 'Operadora que o corretor criou', true) returning id`,
      [ORG],
    )
  ).rows[0]!.id;

  fonte = (
    await pool.query<{ id: string }>(
      `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all)
       values ($1, $2, 'policy', 'Manual da operadora do corretor', $3, false) returning id`,
      [ORG, agente, escopoProprio],
    )
  ).rows[0]!.id;
  trecho = (
    await pool.query<{ id: string }>(
      `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
       values ($1, $2, $3, 0, $4, md5($4), 10, $5::vector) returning id`,
      [ORG, fonte, kbv, "a rede credenciada desta operadora atende no centro", Q],
    )
  ).rows[0]!.id;

  // Uma resposta já dada, ancorada nesse material — é o que FR-008 manda preservar.
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Cliente', '+5585999990002') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'sessao-inerte', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'outbound', 'delivered', 'resposta ancorada', 'ai', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `insert into message_groundings (organization_id, message_id, layer, chunk_id, source_ref, similarity)
     values ($1, $2, 'tenant', $3, $4::jsonb, 0.88)`,
    [
      ORG,
      MSG,
      trecho,
      JSON.stringify({
        layer: "tenant",
        title: "Manual da operadora do corretor",
        scope: "Operadora que o corretor criou",
      }),
    ],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("escopo removido — inerte na busca, íntegro no histórico", () => {
  it("CONTROLE: antes de remover, o material ancora no escopo dele", async () => {
    const r = await buscar(escopoProprio);
    expect(r.some((l) => l.chunk_id === trecho)).toBe(true);
  });

  it("CONTROLE: e não ancora no balde 'todos' — ele nunca valeu para todos", async () => {
    const r = await buscar(null);
    expect(r.some((l) => l.chunk_id === trecho)).toBe(false);
  });

  it("`delete` de verdade é IMPOSSÍVEL — e é por isso que a remoção é lógica", async () => {
    // Este caso não descreve o comportamento da rota: descreve por que ela não pode ser um
    // `delete`. A FK é `on delete set null` e a constraint da 0118 exige balde ou "vale
    // para todos"; apagar deixaria a fonte sem nenhum dos dois. Se alguém "simplificar" a
    // rota para um `delete`, é aqui que a razão está escrita — e o dia em que este caso
    // parar de erguer a violação é o dia em que a decisão pode ser revista.
    await expect(
      pool.query("delete from knowledge_scopes where id = $1", [escopoProprio]),
    ).rejects.toThrow(/ai_knowledge_sources_scope_xor_all/);
  });

  it("removido o escopo, o material para de ancorar naquele balde", async () => {
    // A sequência da rota, na mesma ordem: arquiva o acervo e SÓ ENTÃO marca o escopo.
    await pool.query(
      "update ai_knowledge_sources set is_active = false, status = 'archived' where organization_id = $1 and scope_id = $2",
      [ORG, escopoProprio],
    );
    await pool.query(
      "update knowledge_scopes set deleted_at = now(), is_active = false where id = $1 and organization_id = $2",
      [escopoProprio, ORG],
    );

    const r = await buscar(escopoProprio);
    expect(r.some((l) => l.chunk_id === trecho)).toBe(false);
  });

  it("reativar por fora NÃO ressuscita: `deleted_at` é a segunda trava", async () => {
    // O UPDATE que este caso simula existe de verdade — é o PATCH da própria rota. Com uma
    // trava só (`is_active`), ele devolveria à vida o material que o corretor removeu.
    await pool.query("update knowledge_scopes set is_active = true where id = $1", [
      escopoProprio,
    ]);
    const r = await buscar(escopoProprio);
    expect(r.some((l) => l.chunk_id === trecho)).toBe(false);
    await pool.query("update knowledge_scopes set is_active = false where id = $1", [
      escopoProprio,
    ]);
  });

  it("e NÃO é promovido ao balde 'todos' — inerte é inerte", async () => {
    // O caso que dá nome a este arquivo. `scope_id` virou nulo por `on delete set null`;
    // se o filtro da busca tratar nulo como "vale para todos", o material da operadora
    // removida passa a responder a todo mundo, sobre tudo.
    const r = await buscar(null);
    expect(r.some((l) => l.chunk_id === trecho)).toBe(false);
    expect(r.filter((l) => l.layer === "tenant")).toHaveLength(0);
  });

  it("o trecho continua no banco — inércia não é apagar o acervo", async () => {
    // Apagar seria destrutivo e irreversível, e FR-008 não pede isso: pede inerte para
    // respostas NOVAS. O material fica arquivado, e é o que permite desfazer o engano.
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text n from ai_chunks where id = $1",
      [trecho],
    );
    expect(rows[0]!.n).toBe("1");
    const fonteArquivada = await pool.query<{ status: string; is_active: boolean }>(
      "select status, is_active from ai_knowledge_sources where id = $1",
      [fonte],
    );
    expect(fonteArquivada.rows[0]).toEqual({ status: "archived", is_active: false });
    // O ponteiro CONTINUA válido — e é por isso que a constraint segue satisfeita. A
    // inércia não vem de soltar o ponteiro; vem de o balde ter deixado de resolver.
    const aindaAponta = await pool.query<{ scope_id: string | null }>(
      "select scope_id from ai_chunks where id = $1",
      [trecho],
    );
    expect(aindaAponta.rows[0]!.scope_id).toBe(escopoProprio);
  });

  it("a resposta já dada continua explicável (a outra exigência de FR-008)", async () => {
    const { rows } = await pool.query<{ source_ref: Record<string, unknown>; chunk_id: string }>(
      "select source_ref, chunk_id from message_groundings where message_id = $1",
      [MSG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chunk_id).toBe(trecho);
    // O nome da operadora sobrevive na cópia congelada, mesmo sem a linha de escopo.
    expect(rows[0]!.source_ref.scope).toBe("Operadora que o corretor criou");
  });
});
