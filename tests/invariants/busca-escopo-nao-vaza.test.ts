import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * `fn_buscar_lastro` (migration 0123) — o que ela NUNCA pode devolver.
 *
 * Spec 002 (RAG por operadora), fatia F2. Cobre SC-005 (não-vazamento entre escopos),
 * SC-007 (isolamento entre corretores), FR-016, FR-017, FR-026 e a precedência de camada
 * de research D7.
 *
 * ═══ POR QUE VETOR DETERMINÍSTICO, E NÃO EMBEDDING REAL ═══
 *
 * `v(i)` é 1 na posição `i` e 0 no resto. Cosseno entre `v(1)` e `v(1)` é 1; entre `v(1)`
 * e `v(2)` é 0. Com limiar 0.40 isso separa "ancora" de "não ancora" sem chave de IA e
 * sem variação de modelo. O que este arquivo mede é a REGRA — quem decide o que entra no
 * conjunto —, não a qualidade do embedding. Misturar as duas coisas produziria um teste
 * que fica vermelho quando a OpenAI muda de modelo.
 *
 * ═══ DUAS ASSERÇÕES QUE SÓ EXISTEM POR CAUSA DE UMA SABOTAGEM ═══
 *
 * Medido em 2026-08-08, e é o achado mais útil deste arquivo: **a precedência de camada
 * esconde vazamento**. Quando o corretor tem material próprio num balde, os trechos de
 * catálogo daquele balde saem do conjunto — inclusive os que só estavam ali porque o
 * filtro de escopo (ou o corte de validade) estava quebrado. Sabotando o filtro de escopo
 * do catálogo, a asserção óbvia continuou VERDE; sabotando o corte de validade, idem.
 *
 * Por isso existem os casos "sem material próprio no balde" e o material vencido
 * duplicado no balde 'todos'. Um teste de vazamento escrito só com o tenant abastecido é
 * um teste que não vigia nada.
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
/** Vetor unitário na posição `i`. */
const v = (i: number): string =>
  `[${Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;
/** A "pergunta". Tudo que deve ancorar usa este mesmo vetor. */
const Q = v(1);

const ORG_A = "1a570000-0000-4000-8000-000000000001";
const ORG_B = "1a570000-0000-4000-8000-000000000002";

interface Tenant {
  org: string;
  agent: string;
  kbv: string;
}

interface Ancora {
  chunk_id: string;
  layer: "tenant" | "catalog";
  material_id: string;
  content: string;
  similarity: number;
  source_ref: { layer: string; title: string; scope: string | null };
}

const tenants: Record<"a" | "b", Tenant> = {
  a: { org: ORG_A, agent: "", kbv: "" },
  b: { org: ORG_B, agent: "", kbv: "" },
};

let csX = "";
let csY = "";
let escopoAX = "";
let escopoAY = "";
let escopoBY = "";
let chunkCatalogoX = "";
let chunkCatalogoTodos = "";
let chunkDoCorretorB = "";

async function buscar(agent: string, scope: string | null): Promise<Ancora[]> {
  const { rows } = await pool.query<Ancora>(
    "select * from public.fn_buscar_lastro($1, $2, $3::vector, 10, 0.40)",
    [agent, scope, Q],
  );
  return rows;
}

beforeAll(async () => {
  for (const [nome, t] of Object.entries(tenants) as ["a" | "b", Tenant][]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Lastro LTDA', 'Lastro') on conflict (id) do nothing`,
      [t.org, `lastro-escopo-${nome}`],
    );
    t.agent = (
      await pool.query<{ id: string }>(
        "insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'p') returning id",
        [t.org, `agente-${nome}`],
      )
    ).rows[0]!.id;
    t.kbv = (
      await pool.query<{ id: string }>(
        "insert into ai_knowledge_versions (organization_id, agent_id, version_number) values ($1, $2, 1) returning id",
        [t.org, t.agent],
      )
    ).rows[0]!.id;
    await pool.query("update ai_agents set active_kb_version_id = $1 where id = $2", [t.kbv, t.agent]);
  }

  // ── catálogo curado: dois escopos e um material que vale para todos ──────
  const escopo = async (slug: string, nome: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        "insert into catalog_scopes (slug, display_name) values ($1, $2) returning id",
        [slug, nome],
      )
    ).rows[0]!.id;

  csX = await escopo("lastro-x", "Operadora X");
  csY = await escopo("lastro-y", "Operadora Y");

  const material = async (
    scopeId: string | null,
    todos: boolean,
    slug: string,
    titulo: string,
    validade: string | null,
  ): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body, valid_until)
         values ($1, $2, $3, 1, $4, 'corpo', $5) returning id`,
        [scopeId, todos, slug, titulo, validade],
      )
    ).rows[0]!.id;

  const trecho = async (materialId: string, conteudo: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
         values ($1, 0, $2, md5($2), 10, $3::vector, 'teste') returning id`,
        [materialId, conteudo, Q],
      )
    ).rows[0]!.id;

  chunkCatalogoX = await trecho(await material(csX, false, "lastro-mat-x", "Boleto da X", null), "catalogo escopo X");
  await trecho(await material(csY, false, "lastro-mat-y", "Boleto da Y", null), "catalogo escopo Y");
  chunkCatalogoTodos = await trecho(
    await material(null, true, "lastro-mat-todos", "Regra geral", null),
    "catalogo vale para todos",
  );
  await trecho(
    await material(csX, false, "lastro-mat-vencido", "Tabela velha da X", "2020-01-01"),
    "catalogo vencido escopo",
  );
  // O vencido PRECISA existir também no balde 'todos' — ver o cabeçalho.
  await trecho(
    await material(null, true, "lastro-mat-vencido-todos", "Regra geral velha", "2020-01-01"),
    "catalogo vencido todos",
  );

  // ── espelhos nos dois tenants ───────────────────────────────────────────
  for (const t of Object.values(tenants)) {
    await pool.query("select fn_sincronizar_escopos_do_catalogo($1)", [t.org]);
  }
  const espelho = async (org: string, catalogScopeId: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
        [org, catalogScopeId],
      )
    ).rows[0]!.id;

  escopoAX = await espelho(ORG_A, csX);
  escopoAY = await espelho(ORG_A, csY);
  escopoBY = await espelho(ORG_B, csY);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  // Ordem importa, e a FK é `on delete restrict` DE PROPÓSITO: material curado não some
  // por tabela de escopo apagada. Os trechos vão por cascade a partir do material.
  await pool.query("delete from catalog_materials where slug like 'lastro-mat-%'");
  await pool.query("delete from catalog_scopes where slug like 'lastro-%'");
  await pool.end();
});

describe("fn_buscar_lastro — o escopo é fronteira, não sugestão", () => {
  it("escopo desligado não devolve material de escopo (trava 4, FR-008)", async () => {
    // Os espelhos nascem desligados (A-20). Antes de qualquer clique, uma busca no escopo
    // X não pode trazer nada DE escopo — só o que vale para todos.
    const r = await buscar(tenants.a.agent, escopoAX);
    expect(r.every((a) => a.source_ref.scope === null)).toBe(true);
  });

  it("depois de ligar, o catálogo daquele escopo ancora — e nada do vizinho entra", async () => {
    await pool.query("update knowledge_scopes set is_active = true where id = any($1)", [
      [escopoAX, escopoAY, escopoBY],
    ]);

    // O corretor A ligou Y e não carregou NADA de Y: é o caso "a instalação nasce
    // sabendo". Também é o único arranjo capaz de ver vazamento de escopo, porque não há
    // material do tenant naquele balde para a precedência remover junto.
    const r = await buscar(tenants.a.agent, escopoAY);
    expect(r.some((a) => a.layer === "catalog" && a.content === "catalogo escopo Y")).toBe(true);
    expect(r.some((a) => a.source_ref.scope === "Operadora X")).toBe(false);
  });

  it("material do corretor B nunca sai para o agente de A, no mesmo escopo", async () => {
    const fonte = (
      await pool.query<{ id: string }>(
        `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all)
         values ($1, $2, 'policy', 'Manual da Y do corretor B', $3, false) returning id`,
        [ORG_B, tenants.b.agent, escopoBY],
      )
    ).rows[0]!.id;
    chunkDoCorretorB = (
      await pool.query<{ id: string }>(
        `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
         values ($1, $2, $3, 0, 'tenant B escopo Y', md5('tenant B escopo Y'), 10, $4::vector) returning id`,
        [ORG_B, fonte, tenants.b.kbv, Q],
      )
    ).rows[0]!.id;

    const r = await buscar(tenants.a.agent, escopoAY);
    expect(r.some((a) => a.chunk_id === chunkDoCorretorB)).toBe(false);

    // CONTROLE — sem isto o teste passaria com a tabela vazia, que é a forma mais comum
    // de um teste de isolamento não vigiar nada.
    const { rows } = await pool.query<{ n: string }>("select count(*) n from ai_chunks where id = $1", [
      chunkDoCorretorB,
    ]);
    expect(Number(rows[0]!.n)).toBe(1);
    // E a busca do próprio B encontra o material dele — a linha existe E é alcançável.
    const rb = await buscar(tenants.b.agent, escopoBY);
    expect(rb.some((a) => a.chunk_id === chunkDoCorretorB)).toBe(true);
  });

  it("escopo desconhecido devolve só 'vale para todos' — nunca busca ampla (FR-017)", async () => {
    const r = await buscar(tenants.a.agent, null);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((a) => a.source_ref.scope === null)).toBe(true);
  });

  it("escopo de OUTRO tenant não resolve — cai em 'vale para todos', sem erro e sem vazar", async () => {
    const r = await buscar(tenants.a.agent, escopoBY);
    expect(r.every((a) => a.source_ref.scope === null)).toBe(true);
  });

  it("material vencido não ancora (FR-026), inclusive no balde 'todos'", async () => {
    const r = await buscar(tenants.a.agent, escopoAX);
    expect(r.some((a) => a.content.includes("vencido"))).toBe(false);
  });

  it("a precedência de camada vale DENTRO do balde, não no conjunto (research D7)", async () => {
    const fonte = (
      await pool.query<{ id: string }>(
        `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all)
         values ($1, $2, 'policy', 'Manual da X do corretor A', $3, false) returning id`,
        [ORG_A, tenants.a.agent, escopoAX],
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
       values ($1, $2, $3, 0, 'tenant A escopo X', md5('tenant A escopo X'), 10, $4::vector)`,
      [ORG_A, fonte, tenants.a.kbv, Q],
    );

    const r = await buscar(tenants.a.agent, escopoAX);
    // O material do corretor no balde 'escopo' tira o catálogo DAQUELE balde...
    expect(r.some((a) => a.chunk_id === chunkCatalogoX)).toBe(false);
    // ...e o 'vale para todos' do catálogo SOBREVIVE. Sem esta segunda metade, um texto
    // do corretor sobre o horário de atendimento dele apagaria o procedimento de boleto
    // da operadora — que estava certo e era o que o cliente perguntou.
    expect(r.some((a) => a.chunk_id === chunkCatalogoTodos)).toBe(true);
  });

  it("não é alcançável por public, anon nem authenticated", async () => {
    // ⚠️ A ASSINATURA AQUI TEM DE SER A VIGENTE — a de SEIS argumentos.
    // `has_function_privilege` resolve o nome literalmente e **ignora defaults**: escrita
    // com os cinco de antes, ela ergue "function does not exist" e este teste reprova o
    // job inteiro — não por privilégio aberto, mas por texto desatualizado. A migration
    // 0125 dropou a de cinco ao acrescentar `p_incluir_preteridos` (FR-035), justamente
    // para não deixar duas funções alcançáveis por uma chamada de cinco argumentos.
    for (const papel of ["public", "anon", "authenticated"]) {
      const { rows } = await pool.query<{ p: boolean }>(
        "select has_function_privilege($1, 'public.fn_buscar_lastro(uuid,uuid,public.vector,integer,real,boolean)', 'execute') p",
        [papel],
      );
      expect(rows[0]!.p, `fn_buscar_lastro executável por ${papel}`).toBe(false);
    }
  });

  it("a assinatura de CINCO argumentos não existe mais", async () => {
    // O `drop` da 0125 é o que impede duas funções alcançáveis pela mesma chamada de cinco
    // argumentos — qual delas responderia seria detalhe de resolução de overload, que não
    // aparece em teste e aparece em produção. Se alguém recriar a antiga "para
    // compatibilidade", é aqui que fica vermelho.
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text n
         from pg_proc p
         join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'public' and p.proname = 'fn_buscar_lastro'`,
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("forward-fix: retrieve_top_k_chunks deixou de ser alcançável por authenticated", async () => {
    // Ela continua existindo para os caminhos vivos — todos com credencial de serviço.
    const { rows } = await pool.query<{ p: boolean }>(
      "select has_function_privilege('authenticated', 'public.retrieve_top_k_chunks(uuid,uuid,public.vector,integer,real)', 'execute') p",
    );
    expect(rows[0]!.p).toBe(false);
  });
});
