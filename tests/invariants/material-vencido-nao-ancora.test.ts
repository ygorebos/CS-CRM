import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Material vencido não ancora resposta — SC-009, FR-025, FR-026 (spec 002, fatia F6).
 *
 * O corte já existe dentro de `fn_buscar_lastro` (migration 0123, versão vigente na
 * 0125): `where valid_until is null or valid_until >= current_date`, nas DUAS camadas.
 * Este arquivo é a prova — T116, T117 e T119.
 *
 * ═══ POR QUE VETOR DETERMINÍSTICO, E UM POR CASO ═══
 *
 * `v(i)` é 1 na posição `i` e 0 no resto. Cosseno entre `v(i)` e `v(j)` é 1 se `i = j` e 0
 * caso contrário; com limiar 0.40 isso separa "ancora" de "não ancora" sem chave de IA e
 * sem variação de modelo — o que se mede aqui é a REGRA, não a qualidade do embedding.
 *
 * Cada caso usa um índice PRÓPRIO, e por dois motivos independentes:
 *
 *   1. A suíte inteira bate no MESMO Postgres efêmero, com estado global compartilhado
 *      entre arquivos (`fileParallelism: false` em `vitest.db.config.ts`). Os vizinhos
 *      usam `v(1)` e semeiam material que vale para TODOS os escopos — ele entraria em
 *      qualquer conjunto medido aqui, e a asserção mais importante deste arquivo é uma
 *      contagem ZERO.
 *   2. A precedência de camada opera dentro do balde sobre o conjunto que passou do
 *      limiar. Vetor por caso é o que mantém cada cenário isolado dos outros sem precisar
 *      de um escopo por cenário.
 *
 * ═══ O CASO QUE UMA IMPLEMENTAÇÃO INGÊNUA ERRA (T119) ═══
 *
 * Duas armadilhas, e nenhuma das duas dá erro:
 *
 *   · **"então deixa passar".** Quando o vencido é o ÚNICO material que responderia, é
 *     tentador devolvê-lo mesmo assim — melhor algo que nada. É o oposto: um preço do ano
 *     passado dito com segurança ao cliente é pior que "vou confirmar e te retorno". Zero
 *     linhas é a resposta certa, e o portão de lastro converte isso em escalação.
 *   · **vencido que CALA o vizinho.** Se o corte de validade rodasse DEPOIS da regra de
 *     precedência, um material vencido do corretor continuaria preterindo o material do
 *     catálogo no mesmo balde — e o resultado seria zero linhas onde havia uma resposta
 *     boa. Vencido tem de se comportar como AUSENTE, não como "presente e inválido".
 *
 * Cada bloco carrega o seu CONTROLE (empurra a validade para o futuro e confere que a
 * linha volta). Sem ele, "zero linhas" seria indistinguível de "a linha nunca existiu" —
 * a forma mais comum de um teste de corte não vigiar nada.
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

/** Uma "pergunta" por cenário — ver o cabeçalho. */
const Q_SOZINHO = v(41); // o vencido é o único que responderia
const Q_SEM_DATA = v(42); // catálogo sem validade declarada
const Q_BORDA = v(43); // vence hoje × venceu ontem
const Q_SILENCIO = v(44); // vencido do corretor não pode calar o catálogo
const Q_TENANT_SEM_DATA = v(45); // acervo do corretor sem validade declarada

const ORG = "0a1d0000-0000-4000-8000-000000000001";

let agente = "";
let kbv = "";
let catalogScope = "";
let escopoTenant = "";
let matSozinho = "";
let fonteVencidaDoCorretor = "";

interface Ancora {
  chunk_id: string;
  layer: "tenant" | "catalog";
  content: string;
}

async function buscar(embedding: string): Promise<Ancora[]> {
  // Colunas explícitas, não `select *`: a assinatura ganhou duas colunas na 0125
  // (`preterido`, `preterido_por_material`) e pode ganhar outras. O que este arquivo mede
  // não muda por isso. Os 5 argumentos resolvem para a função de 6 com o default
  // `p_incluir_preteridos = false` — o conjunto que ancora resposta de verdade.
  const { rows } = await pool.query<Ancora>(
    "select chunk_id, layer, content from public.fn_buscar_lastro($1, $2, $3::vector, 10, 0.40)",
    [agente, escopoTenant, embedding],
  );
  return rows;
}

const conteudos = (r: Ancora[]): string[] => r.map((a) => a.content).sort();

/** Material curado + um trecho. `validade` é SQL (`current_date - 1`, `null`, …). */
async function materialCurado(
  slug: string,
  titulo: string,
  validadeSql: string,
  conteudo: string,
  embedding: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body, valid_until)
     values ($1, false, $2, 1, $3, 'corpo', ${validadeSql}) returning id`,
    [catalogScope, slug, titulo],
  );
  const id = rows[0]!.id;
  await pool.query(
    `insert into catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
     values ($1, 0, $2, md5($2), 10, $3::vector, 'teste')`,
    [id, conteudo, embedding],
  );
  return id;
}

/** Material do acervo do corretor + um trecho (o escopo do trecho vem por trigger). */
async function materialDoCorretor(
  nome: string,
  validadeSql: string,
  conteudo: string,
  embedding: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all, valid_until)
     values ($1, $2, 'policy', $3, $4, false, ${validadeSql}) returning id`,
    [ORG, agente, nome, escopoTenant],
  );
  const id = rows[0]!.id;
  await pool.query(
    `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
     values ($1, $2, $3, 0, $4, md5($4), 10, $5::vector)`,
    [ORG, id, kbv, conteudo, embedding],
  );
  return id;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'validade-org', 'Validade LTDA', 'Validade') on conflict (id) do nothing`,
    [ORG],
  );
  agente = (
    await pool.query<{ id: string }>(
      "insert into ai_agents (organization_id, name, system_prompt) values ($1, 'agente-validade', 'p') returning id",
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

  catalogScope = (
    await pool.query<{ id: string }>(
      "insert into catalog_scopes (slug, display_name) values ('validade-op', 'Operadora Validade') returning id",
    )
  ).rows[0]!.id;

  await pool.query("select fn_sincronizar_escopos_do_catalogo($1)", [ORG]);
  escopoTenant = (
    await pool.query<{ id: string }>(
      "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
      [ORG, catalogScope],
    )
  ).rows[0]!.id;
  // O espelho nasce DESLIGADO (A-20). Este arquivo mede validade, não ativação — o
  // não-vazamento de escopo desligado é vigiado por `busca-escopo-nao-vaza.test.ts`.
  await pool.query("update knowledge_scopes set is_active = true where id = $1", [escopoTenant]);

  matSozinho = await materialCurado(
    "validade-sozinho",
    "Tabela de preços 2020",
    "date '2020-01-01'",
    "so o vencido responderia",
    Q_SOZINHO,
  );
  await materialCurado(
    "validade-sem-data",
    "Regulamento sem prazo",
    "null",
    "catalogo sem validade declarada",
    Q_SEM_DATA,
  );
  await materialCurado(
    "validade-hoje",
    "Tabela que vence hoje",
    "current_date",
    "catalogo vence hoje",
    Q_BORDA,
  );
  await materialCurado(
    "validade-ontem",
    "Tabela que venceu ontem",
    "current_date - 1",
    "catalogo venceu ontem",
    Q_BORDA,
  );
  await materialCurado(
    "validade-silencio",
    "Carência da operadora",
    "null",
    "catalogo que o vencido do corretor nao pode calar",
    Q_SILENCIO,
  );

  await materialDoCorretor(
    "Manual do corretor sem prazo",
    "null",
    "acervo sem validade declarada",
    Q_TENANT_SEM_DATA,
  );
  fonteVencidaDoCorretor = await materialDoCorretor(
    "Tabela velha do corretor",
    "date '2020-01-01'",
    "acervo vencido do corretor",
    Q_SILENCIO,
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  // Ordem importa: a FK de `catalog_materials` para `catalog_scopes` é `on delete
  // restrict` DE PROPÓSITO (material curado não some por tabela de escopo apagada). Os
  // trechos vão por cascade a partir do material.
  await pool.query("delete from catalog_materials where slug like 'validade-%'");
  await pool.query("delete from catalog_scopes where slug = 'validade-op'");
  await pool.end();
});

describe("fn_buscar_lastro — material vencido se comporta como material ausente", () => {
  it("T116/T119 · vencido devolve ZERO linhas mesmo sendo o único que responderia (SC-009, FR-026)", async () => {
    expect(await buscar(Q_SOZINHO)).toEqual([]);

    // CONTROLE — a linha existe e é alcançável; o que a tira do conjunto é a data, e nada
    // mais. Sem isto, "zero" seria indistinguível de "nunca foi indexado".
    await pool.query("update catalog_materials set valid_until = current_date + 30 where id = $1", [
      matSozinho,
    ]);
    const comValidade = await buscar(Q_SOZINHO);
    expect(conteudos(comValidade)).toEqual(["so o vencido responderia"]);
    expect(comValidade[0]!.layer).toBe("catalog");

    // E volta a sumir quando vence de novo — o corte é da data, não de um estado herdado.
    await pool.query("update catalog_materials set valid_until = date '2020-01-01' where id = $1", [
      matSozinho,
    ]);
    expect(await buscar(Q_SOZINHO)).toEqual([]);
  });

  it("T117 · material do CATÁLOGO sem validade declarada ancora normalmente (FR-025)", async () => {
    expect(conteudos(await buscar(Q_SEM_DATA))).toEqual(["catalogo sem validade declarada"]);
  });

  it("T117 · material do ACERVO DO CORRETOR sem validade declarada ancora normalmente (FR-025)", async () => {
    // Datar é opcional. O corretor apressado sobe o documento e volta a vender; travar
    // isso transformaria uma cortesia (avisar antes de vencer) em burocracia de entrada.
    const r = await buscar(Q_TENANT_SEM_DATA);
    expect(conteudos(r)).toEqual(["acervo sem validade declarada"]);
    expect(r[0]!.layer).toBe("tenant");
  });

  it("a borda é o DIA: vence hoje ainda ancora, venceu ontem não", async () => {
    // `>= current_date`. Um `>` aqui apagaria o material no último dia em que ele ainda
    // vale — e o aviso do worker de validade, que diz "vence hoje", viraria mentira.
    expect(conteudos(await buscar(Q_BORDA))).toEqual(["catalogo vence hoje"]);
  });

  it("T119 · vencido do corretor NÃO cala o material do catálogo no mesmo balde", async () => {
    // Se o corte de validade rodasse depois da precedência de camada, o material vencido
    // do corretor continuaria preterindo o do catálogo — e o conjunto sairia VAZIO, com o
    // catálogo tendo a resposta certa em mãos.
    const r = await buscar(Q_SILENCIO);
    expect(conteudos(r)).toEqual(["catalogo que o vencido do corretor nao pode calar"]);
    expect(r.some((a) => a.content === "acervo vencido do corretor")).toBe(false);

    // CONTROLE — a precedência ESTÁ ativa neste balde: basta o material do corretor voltar
    // a valer para ele calar o do catálogo. Sem esta metade, a asserção acima passaria
    // igual num mundo onde a precedência nunca funcionou.
    await pool.query("update ai_knowledge_sources set valid_until = current_date + 30 where id = $1", [
      fonteVencidaDoCorretor,
    ]);
    expect(conteudos(await buscar(Q_SILENCIO))).toEqual(["acervo vencido do corretor"]);

    await pool.query("update ai_knowledge_sources set valid_until = date '2020-01-01' where id = $1", [
      fonteVencidaDoCorretor,
    ]);
    expect(conteudos(await buscar(Q_SILENCIO))).toEqual([
      "catalogo que o vencido do corretor nao pode calar",
    ]);
  });

  it("controle de aparato: os trechos vencidos EXISTEM no banco", async () => {
    // A prova de que os blocos acima não passaram por vacuidade — nenhum `insert` do
    // `beforeAll` foi silenciosamente engolido.
    const { rows } = await pool.query<{ curados: string; do_corretor: string }>(
      `select
         (select count(*) from catalog_chunks cc
            join catalog_materials cm on cm.id = cc.catalog_material_id
           where cm.slug like 'validade-%')                                        curados,
         (select count(*) from ai_chunks where organization_id = $1)               do_corretor`,
      [ORG],
    );
    expect(Number(rows[0]!.curados)).toBe(5);
    expect(Number(rows[0]!.do_corretor)).toBe(2);
  });
});
