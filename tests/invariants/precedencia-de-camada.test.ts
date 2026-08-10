import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { divergenciasDe, registrarDivergencias } from "@/lib/agent-engine/agent/divergencia";

/**
 * A precedência de camada, e a metade de FR-035 que ninguém vê — spec 002, T075.
 *
 * Cobre SC-019 (o material do corretor manda no que vale para ele), FR-035 nas DUAS
 * metades, e SC-016 (a divergência chega ao corretor).
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE SE `busca-escopo-nao-vaza` JÁ TOCA NA PRECEDÊNCIA ═══
 *
 * Lá a precedência aparece como efeito colateral de um teste de vazamento: uma asserção,
 * num sentido só. Aqui ela é o objeto. A diferença que importa é o **balde**: a regra não
 * é "tenant vence catálogo", é "tenant vence catálogo NO MESMO balde". Um teste escrito
 * só com o balde 'escopo' fica verde com a regra trocada por "tenant vence sempre" — e
 * essa versão apaga o procedimento de boleto da operadora porque o corretor subiu um PDF
 * com o horário de atendimento dele. Por isso todo caso aqui tem par: o que é preterido e
 * o que sobrevive.
 *
 * ═══ A SEGUNDA METADE DE FR-035 ═══
 *
 * O desempate escolhe um texto e silencia o outro. Os dois falam do mesmo assunto e um
 * deles está errado — e o corretor, que é quem pode corrigir, é justamente quem não fica
 * sabendo. `p_incluir_preteridos` existe para isso: devolve o que foi rejeitado, marcado,
 * SEM que essas linhas ancorem resposta nenhuma. Este arquivo prova as duas coisas ao
 * mesmo tempo, porque separá-las deixaria passar a versão que "registra" devolvendo o
 * preterido junto com as âncoras — que é o defeito com consequência real.
 *
 * ═══ POR QUE CHAMA O CÓDIGO DE PRODUÇÃO, E NÃO UM INSERT DE TESTE ═══
 *
 * `divergenciasDe` e `registrarDivergencias` são importados de `lib/`. Um teste que
 * montasse o `insert` à mão provaria que o Postgres sabe inserir, não que o caminho que
 * roda em produção transforma o resultado da busca em linha de divergência. O dedupe e a
 * escolha do assunto vivem lá; medi-los aqui é o que faz este invariante vigiar.
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
/** Vetor unitário na posição `i` — cosseno 1 consigo, 0 com qualquer outro. */
const v = (i: number): string =>
  `[${Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0)).join(",")}]`;
/** A "pergunta". Tudo que deve ancorar usa este mesmo vetor. */
const Q = v(1);

const ORG_A = "9ecd0000-0000-4000-8000-000000000001";
const ORG_B = "9ecd0000-0000-4000-8000-000000000002";

interface Linha {
  chunk_id: string;
  layer: "tenant" | "catalog";
  material_id: string | null;
  content: string;
  similarity: number;
  source_ref: { layer: string; title: string; scope: string | null };
  preterido: boolean;
  preterido_por_material: string | null;
}

interface Tenant {
  org: string;
  agent: string;
  kbv: string;
}

const tenants: Record<"a" | "b", Tenant> = {
  a: { org: ORG_A, agent: "", kbv: "" },
  b: { org: ORG_B, agent: "", kbv: "" },
};

let csX = "";
let escopoAX = "";
let escopoBX = "";
/** Trecho curado no balde 'escopo' — o que o material do corretor deve preterir. */
let catalogoEscopoX = "";
/** Material curado do balde 'escopo' — é ele que vira `loser_material_id`. */
let materialCatalogoX = "";
/** Trecho curado no balde 'todos' — o que NÃO pode ser preterido pelo balde 'escopo'. */
let catalogoTodos = "";
let materialCatalogoTodos = "";
/** A fonte própria do corretor A no balde 'escopo' — vira `winner_source_id`. */
let fonteDoTenantEscopo = "";
/** A fonte própria do corretor A no balde 'todos'. */
let fonteDoTenantTodos = "";

async function buscar(
  agent: string,
  scope: string | null,
  incluirPreteridos = false,
): Promise<Linha[]> {
  const { rows } = await pool.query<Linha>(
    "select * from public.fn_buscar_lastro($1, $2, $3::vector, 20, 0.40, $4)",
    [agent, scope, Q, incluirPreteridos],
  );
  return rows;
}

/** Divergências abertas da organização, como a rota de evolução as lê. */
async function divergenciasDaOrg(org: string): Promise<
  Array<{
    winner_source_id: string;
    loser_material_id: string;
    scope_id: string | null;
    subject: string;
    occurrences: number;
    last_seen_at: string;
  }>
> {
  const { rows } = await pool.query(
    `select winner_source_id, loser_material_id, scope_id, subject, occurrences, last_seen_at
       from public.knowledge_divergences
      where organization_id = $1
      order by last_seen_at desc`,
    [org],
  );
  return rows;
}

beforeAll(async () => {
  for (const [nome, t] of Object.entries(tenants) as ["a" | "b", Tenant][]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Precedencia LTDA', 'Precedencia') on conflict (id) do nothing`,
      [t.org, `precedencia-${nome}`],
    );
    t.agent = (
      await pool.query<{ id: string }>(
        "insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'p') returning id",
        [t.org, `agente-precedencia-${nome}`],
      )
    ).rows[0]!.id;
    t.kbv = (
      await pool.query<{ id: string }>(
        "insert into ai_knowledge_versions (organization_id, agent_id, version_number) values ($1, $2, 1) returning id",
        [t.org, t.agent],
      )
    ).rows[0]!.id;
    await pool.query("update ai_agents set active_kb_version_id = $1 where id = $2", [
      t.kbv,
      t.agent,
    ]);
  }

  // ── catálogo curado: um escopo e um material que vale para todos ──────────
  csX = (
    await pool.query<{ id: string }>(
      "insert into catalog_scopes (slug, display_name) values ($1, $2) returning id",
      ["prec-x", "Operadora X"],
    )
  ).rows[0]!.id;

  const material = async (
    scopeId: string | null,
    todos: boolean,
    slug: string,
    titulo: string,
  ): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body)
         values ($1, $2, $3, 1, $4, 'corpo') returning id`,
        [scopeId, todos, slug, titulo],
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

  // Os textos falam de BOLETO nos dois lados de propósito: é o que faz o léxico de
  // assistência achar assunto em comum, e é assim que a divergência nasce com `subject`
  // preenchido em vez de ''. Assunto vazio é legítimo, mas provaria menos.
  materialCatalogoX = await material(csX, false, "prec-mat-x", "Segunda via de boleto da X");
  catalogoEscopoX = await trecho(
    materialCatalogoX,
    "para tirar a segunda via do boleto, acesse o portal da operadora",
  );
  materialCatalogoTodos = await material(null, true, "prec-mat-todos", "Regra geral de boleto");
  catalogoTodos = await trecho(
    materialCatalogoTodos,
    "o boleto vence todo dia 10 e a segunda via sai pelo aplicativo",
  );

  for (const t of Object.values(tenants)) {
    await pool.query("select fn_sincronizar_escopos_do_catalogo($1)", [t.org]);
  }
  escopoAX = (
    await pool.query<{ id: string }>(
      "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
      [ORG_A, csX],
    )
  ).rows[0]!.id;
  escopoBX = (
    await pool.query<{ id: string }>(
      "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
      [ORG_B, csX],
    )
  ).rows[0]!.id;
  // Os espelhos nascem desligados (A-20) — ligar é o primeiro gesto do corretor.
  await pool.query("update knowledge_scopes set is_active = true where id = any($1)", [
    [escopoAX, escopoBX],
  ]);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.query("delete from catalog_materials where slug like 'prec-mat-%'");
  await pool.query("delete from catalog_scopes where slug like 'prec-%'");
  await pool.end();
});

describe("precedência de camada — dentro do balde, e só dentro dele", () => {
  it("CONTROLE: sem material do corretor, o catálogo dos DOIS baldes ancora", async () => {
    // Sem este caso, tudo abaixo passaria com o catálogo simplesmente ausente da busca —
    // a forma mais silenciosa de um teste de precedência não medir precedência nenhuma.
    const r = await buscar(tenants.a.agent, escopoAX);
    expect(r.some((l) => l.chunk_id === catalogoEscopoX)).toBe(true);
    expect(r.some((l) => l.chunk_id === catalogoTodos)).toBe(true);
    expect(r.every((l) => l.preterido === false)).toBe(true);
  });

  it("material do corretor no balde 'escopo' vence o catálogo DAQUELE balde (SC-019)", async () => {
    fonteDoTenantEscopo = (
      await pool.query<{ id: string }>(
        `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all)
         values ($1, $2, 'policy', 'Manual da X do corretor A', $3, false) returning id`,
        [ORG_A, tenants.a.agent, escopoAX],
      )
    ).rows[0]!.id;
    await pool.query(
      // `scope_id` e `applies_to_all` NÃO vão no insert de propósito: o trigger
      // `trg_ai_chunks_escopo` os copia da fonte, e passá-los aqui sugeriria que o
      // chamador manda no balde — ele não manda, e um teste que finge o contrário
      // continuaria verde no dia em que o trigger sumisse.
      `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
       values ($1, $2, $3, 0, $4, md5($4), 10, $5::vector)`,
      [
        ORG_A,
        fonteDoTenantEscopo,
        tenants.a.kbv,
        "a segunda via do boleto eu mesmo mando por WhatsApp, nao precisa portal",
        Q,
      ],
    );

    const r = await buscar(tenants.a.agent, escopoAX);
    expect(r.some((l) => l.chunk_id === catalogoEscopoX)).toBe(false);
    // O par que impede a regra de virar "tenant vence sempre": o balde 'todos' segue de pé.
    expect(r.some((l) => l.chunk_id === catalogoTodos)).toBe(true);
  });

  it("e não vence no balde do vizinho — o do corretor B continua intacto", async () => {
    // Mesma operadora, outro tenant. Se a precedência olhasse o balde sem olhar a
    // organização, o material de A calaria o catálogo de B — um corretor apagando o
    // lastro do outro, que é o pior defeito que esta regra pode produzir.
    const r = await buscar(tenants.b.agent, escopoBX);
    expect(r.some((l) => l.chunk_id === catalogoEscopoX)).toBe(true);
    expect(r.every((l) => l.preterido === false)).toBe(true);
  });

  it("material do corretor no balde 'todos' vence o catálogo 'todos', e só ele", async () => {
    fonteDoTenantTodos = (
      await pool.query<{ id: string }>(
        `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all)
         values ($1, $2, 'policy', 'Regras gerais do corretor A', null, true) returning id`,
        [ORG_A, tenants.a.agent],
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
       values ($1, $2, $3, 0, $4, md5($4), 10, $5::vector)`,
      [
        ORG_A,
        fonteDoTenantTodos,
        tenants.a.kbv,
        "meu boleto padrao vence dia 5 e a segunda via eu envio na hora",
        Q,
      ],
    );

    // Escopo desconhecido: só o balde 'todos' entra, e ali o do corretor manda.
    const semEscopo = await buscar(tenants.a.agent, null);
    expect(semEscopo.some((l) => l.chunk_id === catalogoTodos)).toBe(false);
    expect(semEscopo.some((l) => l.layer === "tenant")).toBe(true);
  });
});

describe("FR-035, segunda metade — o desempate deixa rastro", () => {
  it("com p_incluir_preteridos=false, nada marcado sai — nem por engano", async () => {
    const r = await buscar(tenants.a.agent, escopoAX, false);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((l) => l.preterido === false)).toBe(true);
    expect(r.every((l) => l.preterido_por_material === null)).toBe(true);
  });

  it("com true, o preterido volta marcado e apontando quem o venceu", async () => {
    const r = await buscar(tenants.a.agent, escopoAX, true);
    const preteridos = r.filter((l) => l.preterido);
    expect(preteridos.length).toBeGreaterThan(0);

    const doCatalogoX = preteridos.find((l) => l.chunk_id === catalogoEscopoX);
    expect(doCatalogoX, "o trecho curado preterido não voltou").toBeDefined();
    expect(doCatalogoX!.layer).toBe("catalog");
    expect(doCatalogoX!.material_id).toBe(materialCatalogoX);
    expect(doCatalogoX!.preterido_por_material).toBe(fonteDoTenantEscopo);

    // O que sobreviveu ao desempate continua NÃO marcado no mesmo resultado: sem esta
    // asserção, marcar tudo como preterido passaria verde.
    expect(r.some((l) => !l.preterido && l.layer === "tenant")).toBe(true);
  });

  it("o caminho de produção transforma isso em linha de divergência (SC-016)", async () => {
    const r = await buscar(tenants.a.agent, escopoAX, true);
    const registros = divergenciasDe({
      scopeId: escopoAX,
      preteridas: r.filter((l) => l.preterido),
      vencedoras: r.filter((l) => !l.preterido),
    });
    expect(registros.length).toBeGreaterThan(0);

    await registrarDivergencias(pool, ORG_A, registros);

    const linhas = await divergenciasDaOrg(ORG_A);
    const alvo = linhas.find(
      (d) =>
        d.winner_source_id === fonteDoTenantEscopo && d.loser_material_id === materialCatalogoX,
    );
    expect(alvo, "a divergência do balde 'escopo' não chegou à lista").toBeDefined();
    expect(alvo!.scope_id).toBe(escopoAX);
    // O assunto vem do léxico fechado, nunca do texto da pergunta (contrato de PII da 0086).
    expect(alvo!.subject).toBe("cobranca");
    expect(alvo!.occurrences).toBe(1);
  });

  it("a mesma disputa de novo soma ocorrência — não duplica linha", async () => {
    const antes = await divergenciasDaOrg(ORG_A);
    const r = await buscar(tenants.a.agent, escopoAX, true);
    await registrarDivergencias(
      pool,
      ORG_A,
      divergenciasDe({
        scopeId: escopoAX,
        preteridas: r.filter((l) => l.preterido),
        vencedoras: r.filter((l) => !l.preterido),
      }),
    );
    const depois = await divergenciasDaOrg(ORG_A);

    expect(depois.length).toBe(antes.length);
    const alvo = depois.find((d) => d.loser_material_id === materialCatalogoX)!;
    expect(alvo.occurrences).toBe(2);
  });

  it("a divergência é do tenant que a viveu — a org vizinha não tem nenhuma", async () => {
    // O corretor B tem o MESMO catálogo ligado e nenhum material próprio: não houve
    // desempate na conta dele, e a lista dele tem de estar vazia. Uma divergência que
    // vazasse aqui mandaria B conferir um material que não é dele.
    expect(await divergenciasDaOrg(ORG_B)).toHaveLength(0);
  });

  it("sem preterido não há divergência — o registro não inventa disputa", async () => {
    const r = await buscar(tenants.b.agent, escopoBX, true);
    expect(r.every((l) => !l.preterido)).toBe(true);
    expect(
      divergenciasDe({
        scopeId: escopoBX,
        preteridas: r.filter((l) => l.preterido),
        vencedoras: r.filter((l) => !l.preterido),
      }),
    ).toHaveLength(0);
  });

  it("linha preterida NUNCA ancora resposta: quem ancora é só o não-marcado", async () => {
    // O consumidor real (`search-knowledge.ts`) monta o lastro a partir das linhas não
    // marcadas. Esta asserção fixa a propriedade de que depende: o conjunto de âncoras
    // com p_incluir_preteridos=true, filtrado por !preterido, é IGUAL ao de false.
    const comTudo = (await buscar(tenants.a.agent, escopoAX, true))
      .filter((l) => !l.preterido)
      .map((l) => l.chunk_id)
      .sort();
    const soAncoras = (await buscar(tenants.a.agent, escopoAX, false))
      .map((l) => l.chunk_id)
      .sort();
    expect(comTudo).toEqual(soAncoras);
  });
});
