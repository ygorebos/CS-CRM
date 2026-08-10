import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * TRAVA 3 do Princípio X — a consulta que cruza as DUAS camadas não devolve linha de
 * outra organização.
 *
 * Spec 002 (RAG por operadora), tarefa T036. Cobre SC-007 (isolamento entre corretores)
 * e a exigência da emenda 2.0.0 da constituição: "consulta que cruza as duas camadas
 * devolvendo zero linhas de outra organização" é uma das três travas sem as quais a
 * exceção ao Princípio I não pode ser considerada implementada.
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE, SE JÁ HÁ TESTE DE RLS ═══
 *
 * `rls-isolation.test.ts` prova o isolamento de tabelas que TÊM `organization_id`. Aqui a
 * junção tem metade sem essa coluna: `catalog_scopes` / `catalog_materials` /
 * `catalog_chunks` são a partição curada, compartilhada pela instalação, legível por
 * qualquer sessão autenticada (migration 0117). Não existe `where organization_id = ...`
 * possível desse lado — o único filtro é a RLS do lado do tenant, e é ela que este
 * arquivo mede.
 *
 * O caso perigoso é o espelho: `knowledge_scopes` de A e de B apontam para o **mesmo**
 * `catalog_scope_id` (migration 0118). Uma junção escrita pelo elo natural — o escopo do
 * catálogo — costura os dois tenants sem que ninguém tenha escrito nada errado de
 * propósito. Por isso as consultas abaixo NÃO filtram organização em lugar nenhum: se
 * elas trouxessem o `where` que o próprio teste escreveu, mediriam o teste, não a policy.
 *
 * ═══ COMO A POLICY É EXERCITADA DE VERDADE ═══
 *
 * `set role authenticated` + `set_config('request.jwt.claims', ...)` dentro de UMA sessão
 * `psql` no container — o mesmo caminho `auth.uid()` → `fn_user_org_ids()` que o
 * PostgREST usa em produção. Conectar como `postgres` e confiar no `where` seria medir
 * outra coisa: `postgres` é dono das tabelas e passa por cima da RLS.
 *
 * ═══ SÃO TRÊS TRAVESSIAS, E A TERCEIRA SÓ EXISTE POR CAUSA DE UMA SABOTAGEM ═══
 *
 * A junção acontece de três formas, e elas não são redundantes — cada uma cai numa policy
 * diferente. Do acervo para o catálogo e do catálogo para o acervo passam ambas pelo
 * espelho, então a RLS de `knowledge_scopes` as segura sozinha. Medido em 2026-08-08:
 * afrouxando SÓ a de `ai_chunks`, as duas continuaram verdes. O balde "vale para todos"
 * não passa por espelho nenhum — as camadas se unem sem escopo — e é a única travessia em
 * que a policy de `ai_chunks` é a última linha. Sem ela, este arquivo vigiaria uma policy
 * das duas que a trava 3 depende.
 *
 * ═══ O CONTROLE NÃO É DECORAÇÃO ═══
 *
 * "Não vazou" e "a tabela estava vazia" são indistinguíveis sem controle — é a falha mais
 * comum de teste de isolamento. Então o primeiro caso roda a MESMA consulta cruzada sem
 * RLS (papel `postgres`) e cobra que ela devolva linhas das DUAS organizações; e há um
 * caso provando que o usuário de B enxerga o material de B. Só depois disso o zero na
 * sessão de A quer dizer alguma coisa.
 *
 * ═══ O QUE ESTE ARQUIVO NÃO COBRE ═══
 *
 * - **Escrita no catálogo** (trava 1) — é `catalogo-escrita-so-plataforma.test.ts` (T034).
 *   Aqui só se prova que o catálogo é LEGÍVEL pelos dois, porque um teste que barrasse
 *   isso estaria testando o produto errado: compartilhar é o ponto da partição curada.
 * - **Ausência de dado pessoal no catálogo** (trava 2) — é
 *   `catalogo-sem-dado-de-ninguem.test.ts` (T035).
 * - **Ranking, limiar, validade e precedência de camada** — é
 *   `busca-escopo-nao-vaza.test.ts`, sobre `fn_buscar_lastro`. Este arquivo mede a
 *   fronteira de linhas, não a qualidade do conjunto recuperado.
 * - **`service_role` e o admin client**, que passam por cima da RLS por contrato. Handler
 *   que usa service role tem de filtrar `organization_id` na mão (Princípio I), e isso é
 *   portão de código, não de banco.
 * - **A tela e a API.** Aqui é SQL. A prova pela tela é o Princípio IV.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

/**
 * Roda um script SQL em UMA sessão psql dentro do container; devolve stdout sem alinhamento.
 *
 * `-q` não é enfeite: sem ele o psql imprime o rótulo de cada comando (`SET`, `DO`,
 * `INSERT 0 1`) misturado com as tuplas, e o parser abaixo leria "SET" como se fosse uma
 * linha de resultado.
 */
function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Linhas de um SELECT rodado como `postgres` — dono das tabelas, portanto SEM RLS. */
function semRls(query: string): string[][] {
  const saida = sql(query);
  return saida === "" ? [] : saida.split("\n").map((linha) => linha.split("|"));
}

/**
 * Linhas de um SELECT rodado como o Supabase roda: papel `authenticated` e o `sub` do JWT
 * no `request.jwt.claims`. O `set_config` vai dentro de um bloco `do` de propósito — assim
 * ele não imprime nada e a saída é só a da consulta.
 */
function comoUsuario(userId: string, query: string): string[][] {
  const saida = sql(`
    set role authenticated;
    do $claims$ begin perform set_config('request.jwt.claims', '{"sub":"${userId}"}', false); end $claims$;
    ${query}
  `);
  return saida === "" ? [] : saida.split("\n").map((linha) => linha.split("|"));
}

const ORG_A = "c1a10000-0000-4000-8000-00000000000a";
const ORG_B = "c1a10000-0000-4000-8000-00000000000b";
const USER_A = "c1a11111-0000-4000-8000-00000000000a";
const USER_B = "c1a11111-0000-4000-8000-00000000000b";

/** O escopo curado que os DOIS tenants espelham. É daqui que sai o caso perigoso. */
const CATALOGO_ESCOPO_X = "c1a12222-0000-4000-8000-000000000001";
const CATALOGO_MATERIAL_X = "c1a13333-0000-4000-8000-000000000001";
const CATALOGO_MATERIAL_TODOS = "c1a13333-0000-4000-8000-000000000002";

const TRECHO_CATALOGO_X = "iso-cat trecho curado do escopo X";
const TRECHO_CATALOGO_TODOS = "iso-cat trecho curado que vale para todos";
const TRECHO_ACERVO_A = "iso-cat acervo proprio do corretor A";
const TRECHO_ACERVO_B = "iso-cat acervo proprio do corretor B";
const TRECHO_TODOS_A = "iso-cat acervo que vale para todos do corretor A";
const TRECHO_TODOS_B = "iso-cat acervo que vale para todos do corretor B";

/** Vetor construído em SQL: 1536 posições sem string gigante no arquivo de teste. */
const EMBEDDING = "('[1' || repeat(',0', 1535) || ']')::public.vector";

interface Tenant {
  org: string;
  user: string;
  tag: string;
  trecho: string;
  trechoTodos: string;
  agente: string;
  versao: string;
  fonte: string;
  chunk: string;
  fonteTodos: string;
  chunkTodos: string;
}

const tenants: Record<"a" | "b", Tenant> = {
  a: {
    org: ORG_A,
    user: USER_A,
    tag: "a",
    trecho: TRECHO_ACERVO_A,
    trechoTodos: TRECHO_TODOS_A,
    agente: "c1a14444-0000-4000-8000-00000000000a",
    versao: "c1a15555-0000-4000-8000-00000000000a",
    fonte: "c1a16666-0000-4000-8000-00000000000a",
    chunk: "c1a17777-0000-4000-8000-00000000000a",
    fonteTodos: "c1a18888-0000-4000-8000-00000000000a",
    chunkTodos: "c1a19999-0000-4000-8000-00000000000a",
  },
  b: {
    org: ORG_B,
    user: USER_B,
    tag: "b",
    trecho: TRECHO_ACERVO_B,
    trechoTodos: TRECHO_TODOS_B,
    agente: "c1a14444-0000-4000-8000-00000000000b",
    versao: "c1a15555-0000-4000-8000-00000000000b",
    fonte: "c1a16666-0000-4000-8000-00000000000b",
    chunk: "c1a17777-0000-4000-8000-00000000000b",
    fonteTodos: "c1a18888-0000-4000-8000-00000000000b",
    chunkTodos: "c1a19999-0000-4000-8000-00000000000b",
  },
};

/** Espelho de `catalog_scopes.id = CATALOGO_ESCOPO_X` em cada tenant. Descoberto no seed. */
const espelho: Record<"a" | "b", string> = { a: "", b: "" };

/**
 * A CONSULTA CRUZADA, do acervo do tenant para o catálogo.
 *
 * `left join` no acervo de propósito: com `join` puro, um espelho de OUTRA organização que
 * vazasse sairia do resultado por falta de trecho visível, e o vazamento passaria
 * despercebido. Nenhum `where` sobre organização, aqui nem no gêmeo abaixo.
 */
const CRUZADA_DO_ACERVO = `
  select ks.organization_id::text,
         coalesce(ac.organization_id::text, '-'),
         coalesce(ac.content, '-'),
         cc.content
    from public.knowledge_scopes ks
    join public.catalog_chunks cc on cc.catalog_scope_id = ks.catalog_scope_id
    left join public.ai_chunks ac on ac.scope_id = ks.id
   where cc.content = '${TRECHO_CATALOGO_X}'
   order by 1, 2;
`;

/**
 * A MESMA travessia, escrita na direção tentadora: parte do catálogo e desce até o acervo
 * pelo elo natural, que é o escopo curado — o mesmo nos dois tenants. É a forma que alguém
 * escreve sem nenhuma má intenção ao perguntar "quais trechos existem para esta operadora".
 */
const CRUZADA_DO_CATALOGO = `
  select ks.organization_id::text,
         ac.organization_id::text,
         ac.content
    from public.catalog_chunks cc
    join public.knowledge_scopes ks on ks.catalog_scope_id = cc.catalog_scope_id
    join public.ai_chunks ac on ac.scope_id = ks.id
   where cc.content = '${TRECHO_CATALOGO_X}'
   order by 1, 2;
`;

/**
 * A TERCEIRA travessia, e a mais frágil: o balde "vale para todos".
 *
 * Medido na sabotagem de 2026-08-08, e é o motivo de esta consulta existir. As duas de
 * cima passam pelo espelho (`ac.scope_id = ks.id`), então a RLS de `knowledge_scopes` já
 * as segura sozinha: afrouxar só a de `ai_chunks` deixava as duas VERDES. Aqui não há
 * escopo nenhum para costurar — as duas camadas se juntam por união, e a única coisa entre
 * o acervo de um corretor e o de outro é a policy de `ai_chunks`.
 *
 * O `in (...)` nomeia o conteúdo dos DOIS tenants de propósito: a consulta pede a linha de
 * B pelo nome e ainda assim não pode recebê-la.
 */
const CRUZADA_BALDE_TODOS = `
  select 'acervo', ac.organization_id::text, ac.content
    from public.ai_chunks ac
   where ac.applies_to_all
     and ac.content in ('${TRECHO_TODOS_A}', '${TRECHO_TODOS_B}')
  union all
  select 'catalogo', '-', cc.content
    from public.catalog_chunks cc
   where cc.applies_to_all and cc.content = '${TRECHO_CATALOGO_TODOS}'
  order by 1, 3;
`;

beforeAll(() => {
  // ── catálogo curado ANTES das organizações: o espelho materializa a partir dele ──
  sql(`
    insert into public.catalog_scopes (id, slug, display_name, official_code)
      values ('${CATALOGO_ESCOPO_X}', 'iso-cat-operadora-x', 'Operadora X do isolamento', 'ISO-X')
      on conflict (id) do nothing;

    insert into public.catalog_materials (id, catalog_scope_id, applies_to_all, slug, version, title, body)
      values ('${CATALOGO_MATERIAL_X}', '${CATALOGO_ESCOPO_X}', false, 'iso-cat-mat-x', 1,
              'Boleto da Operadora X', 'procedimento de boleto')
      on conflict (id) do nothing;

    insert into public.catalog_materials (id, catalog_scope_id, applies_to_all, slug, version, title, body)
      values ('${CATALOGO_MATERIAL_TODOS}', null, true, 'iso-cat-mat-todos', 1,
              'Regra que vale para todos', 'procedimento geral')
      on conflict (id) do nothing;

    insert into public.catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
      select '${CATALOGO_MATERIAL_X}', 0, '${TRECHO_CATALOGO_X}', md5('${TRECHO_CATALOGO_X}'), 10, ${EMBEDDING}, 'teste'
       where not exists (select 1 from public.catalog_chunks where content = '${TRECHO_CATALOGO_X}');

    insert into public.catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
      select '${CATALOGO_MATERIAL_TODOS}', 0, '${TRECHO_CATALOGO_TODOS}', md5('${TRECHO_CATALOGO_TODOS}'), 10, ${EMBEDDING}, 'teste'
       where not exists (select 1 from public.catalog_chunks where content = '${TRECHO_CATALOGO_TODOS}');
  `);

  // ── as duas organizações, com um usuário `agent` cada ────────────────────────────
  for (const t of Object.values(tenants)) {
    sql(`
      insert into auth.users (id, email)
        values ('${t.user}', 'iso-cat-${t.tag}@invariant.test') on conflict (id) do nothing;

      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${t.org}', 'iso-cat-${t.tag}', 'Isolamento Catalogo ${t.tag}', 'Iso ${t.tag}')
        on conflict (id) do nothing;

      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${t.user}', '${t.org}', 'agent', now()) on conflict do nothing;

      -- Espelha o catálogo neste tenant. Idempotente por contrato (migration 0118).
      select public.fn_sincronizar_escopos_do_catalogo('${t.org}');

      insert into public.ai_agents (id, organization_id, name, system_prompt)
        values ('${t.agente}', '${t.org}', 'Agente iso ${t.tag}', 'prompt') on conflict (id) do nothing;

      insert into public.ai_knowledge_versions (id, organization_id, agent_id, version_number)
        values ('${t.versao}', '${t.org}', '${t.agente}', 1) on conflict (id) do nothing;

      update public.ai_agents set active_kb_version_id = '${t.versao}' where id = '${t.agente}';
    `);
  }

  // O espelho de CADA tenant para o MESMO escopo curado — o eixo do caso perigoso.
  for (const chave of ["a", "b"] as const) {
    const linhas = semRls(
      `select id::text from public.knowledge_scopes
        where organization_id = '${tenants[chave].org}' and catalog_scope_id = '${CATALOGO_ESCOPO_X}';`,
    );
    const id = linhas[0]?.[0];
    if (!id) {
      throw new Error(`espelho do catálogo não materializou para a org ${chave} — seed inválido`);
    }
    espelho[chave] = id;
  }

  // ── acervo PRÓPRIO de cada corretor, pendurado no espelho dele ───────────────────
  for (const chave of ["a", "b"] as const) {
    const t = tenants[chave];
    sql(`
      insert into public.ai_knowledge_sources (id, organization_id, agent_id, source_type, name, scope_id, applies_to_all)
        values ('${t.fonte}', '${t.org}', '${t.agente}', 'policy', 'Manual da X do corretor ${t.tag}',
                '${espelho[chave]}', false)
        on conflict (id) do nothing;

      -- scope_id do trecho NÃO é informado: o trigger trg_ai_chunks_escopo o copia da fonte.
      insert into public.ai_chunks (id, organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
        values ('${t.chunk}', '${t.org}', '${t.fonte}', '${t.versao}', 0, '${t.trecho}',
                md5('${t.trecho}'), 10, ${EMBEDDING})
        on conflict (id) do nothing;

      -- E o material sem escopo, que vale para qualquer cliente daquele corretor. É o
      -- balde onde não há espelho para segurar a junção.
      insert into public.ai_knowledge_sources (id, organization_id, agent_id, source_type, name, scope_id, applies_to_all)
        values ('${t.fonteTodos}', '${t.org}', '${t.agente}', 'policy', 'Regras gerais do corretor ${t.tag}',
                null, true)
        on conflict (id) do nothing;

      insert into public.ai_chunks (id, organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
        values ('${t.chunkTodos}', '${t.org}', '${t.fonteTodos}', '${t.versao}', 0, '${t.trechoTodos}',
                md5('${t.trechoTodos}'), 10, ${EMBEDDING})
        on conflict (id) do nothing;
    `);
  }
});

afterAll(() => {
  // Organizações primeiro (cascade leva escopos, fontes e trechos do tenant).
  sql(`delete from public.organizations where id in ('${ORG_A}', '${ORG_B}');`);
  // Depois o catálogo, e nesta ordem: `catalog_materials.catalog_scope_id` é
  // `on delete restrict` DE PROPÓSITO — material curado não some por tabela de escopo
  // apagada. Os trechos vão por cascade a partir do material.
  sql(`
    delete from public.catalog_materials where id in ('${CATALOGO_MATERIAL_X}', '${CATALOGO_MATERIAL_TODOS}');
    delete from public.catalog_scopes where id = '${CATALOGO_ESCOPO_X}';
    delete from auth.users where id in ('${USER_A}', '${USER_B}');
  `);
});

describe("trava 3 — cruzar acervo do tenant com catálogo curado não atravessa organização", () => {
  it("CONTROLE: sem RLS, a consulta cruzada devolve linhas das DUAS organizações", () => {
    // Sem este caso, todo zero abaixo é ambíguo: pode ser isolamento funcionando, pode ser
    // seed que não escreveu nada. Aqui se prova que há o que vazar.
    const linhas = semRls(CRUZADA_DO_ACERVO);
    const orgsDoEscopo = new Set(linhas.map((l) => l[0]));
    const conteudos = linhas.map((l) => l[2]);

    expect(orgsDoEscopo.has(ORG_A)).toBe(true);
    expect(orgsDoEscopo.has(ORG_B)).toBe(true);
    expect(conteudos).toContain(TRECHO_ACERVO_A);
    expect(conteudos).toContain(TRECHO_ACERVO_B);
  });

  it("CONTROLE: as linhas de B existem nas duas pontas da junção", () => {
    const [espelhos] = semRls(
      `select count(*)::text from public.knowledge_scopes
        where organization_id = '${ORG_B}' and catalog_scope_id = '${CATALOGO_ESCOPO_X}';`,
    );
    expect(Number(espelhos?.[0])).toBe(1);

    const [trechos] = semRls(
      `select count(*)::text from public.ai_chunks
        where organization_id = '${ORG_B}'
          and content in ('${TRECHO_ACERVO_B}', '${TRECHO_TODOS_B}');`,
    );
    expect(Number(trechos?.[0])).toBe(2);

    // E o balde "vale para todos" sem RLS traz os dois corretores — é o que torna
    // significativo o zero que a sessão de A vai ver adiante.
    const conteudos = semRls(CRUZADA_BALDE_TODOS).map((l) => l[2]);
    expect(conteudos).toContain(TRECHO_TODOS_A);
    expect(conteudos).toContain(TRECHO_TODOS_B);
  });

  it("do acervo para o catálogo: a sessão de A não devolve NENHUMA linha de B", () => {
    const linhas = comoUsuario(USER_A, CRUZADA_DO_ACERVO);

    // Não-vacuidade: a consulta tem de estar devolvendo algo, senão o zero é trivial.
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.map((l) => l[2])).toContain(TRECHO_ACERVO_A);

    // O escopo espelhado de B tem o MESMO catalog_scope_id — é por ele que a junção
    // costuraria os dois tenants se a RLS de knowledge_scopes afrouxasse.
    expect(linhas.every((l) => l[0] === ORG_A)).toBe(true);
    // E o trecho recuperado, quando existe, é sempre do próprio tenant.
    expect(linhas.every((l) => l[1] === ORG_A || l[1] === "-")).toBe(true);
    expect(linhas.map((l) => l[2])).not.toContain(TRECHO_ACERVO_B);
  });

  it("do catálogo para o acervo (o caminho tentador): idem, zero linha de B", () => {
    const linhas = comoUsuario(USER_A, CRUZADA_DO_CATALOGO);

    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.every((l) => l[0] === ORG_A)).toBe(true);
    expect(linhas.every((l) => l[1] === ORG_A)).toBe(true);
    expect(linhas.map((l) => l[2])).toEqual([TRECHO_ACERVO_A]);
  });

  it("o balde 'vale para todos' não tem escopo para costurar — e mesmo assim não atravessa", () => {
    const linhas = comoUsuario(USER_A, CRUZADA_BALDE_TODOS);
    const conteudos = linhas.map((l) => l[2]);

    // As duas camadas aparecem: o balde é a união delas, não uma ou outra.
    expect(conteudos).toContain(TRECHO_TODOS_A);
    expect(conteudos).toContain(TRECHO_CATALOGO_TODOS);
    // E o do vizinho não, ainda que a consulta o tenha pedido pelo nome.
    expect(conteudos).not.toContain(TRECHO_TODOS_B);
    expect(linhas.every((l) => l[1] === ORG_A || l[1] === "-")).toBe(true);

    // O simétrico, pelo mesmo motivo do CONTRA-PROVA abaixo: "ninguém vê nada" não é
    // isolamento.
    const deB = comoUsuario(USER_B, CRUZADA_BALDE_TODOS).map((l) => l[2]);
    expect(deB).toContain(TRECHO_TODOS_B);
    expect(deB).toContain(TRECHO_CATALOGO_TODOS);
    expect(deB).not.toContain(TRECHO_TODOS_A);
  });

  it("CONTRA-PROVA: a sessão de B enxerga o material de B pela MESMA consulta", () => {
    // O espelho da imagem acima. Se este caso ficasse verde com o de cima, o teste estaria
    // provando "ninguém vê nada", que não é isolamento — é feature quebrada.
    const linhas = comoUsuario(USER_B, CRUZADA_DO_CATALOGO);

    expect(linhas.map((l) => l[2])).toEqual([TRECHO_ACERVO_B]);
    expect(linhas.every((l) => l[0] === ORG_B && l[1] === ORG_B)).toBe(true);
  });

  it("knowledge_scopes: mesmo catalog_scope_id nos dois, só o espelho de A aparece para A", () => {
    // O caso perigoso isolado. A tentação é filtrar o espelho por `catalog_scope_id` — que
    // é IGUAL nos dois tenants — e concluir que se achou "o escopo". São dois.
    const linhas = comoUsuario(
      USER_A,
      `select organization_id::text, id::text from public.knowledge_scopes
        where catalog_scope_id = '${CATALOGO_ESCOPO_X}';`,
    );

    expect(linhas.length).toBe(1);
    expect(linhas[0]?.[0]).toBe(ORG_A);
    expect(linhas[0]?.[1]).toBe(espelho.a);
    expect(linhas[0]?.[1]).not.toBe(espelho.b);
  });

  it("pedir as linhas de B explicitamente não muda nada (SC-007: tentativa deliberada)", () => {
    // "Inclusive quando alguém tenta deliberadamente consultar se identificando como a
    // outra organização" — o `where` do atacante não é o que decide; a policy é.
    const alvos: Array<[string, string]> = [
      ["knowledge_scopes", `select count(*)::text from public.knowledge_scopes where organization_id = '${ORG_B}';`],
      ["ai_chunks", `select count(*)::text from public.ai_chunks where organization_id = '${ORG_B}';`],
      [
        "ai_knowledge_sources",
        `select count(*)::text from public.ai_knowledge_sources where organization_id = '${ORG_B}';`,
      ],
      [
        "cruzada por id de espelho de B",
        `select count(*)::text from public.knowledge_scopes ks
           join public.catalog_chunks cc on cc.catalog_scope_id = ks.catalog_scope_id
           join public.ai_chunks ac on ac.scope_id = ks.id
          where ks.id = '${espelho.b}';`,
      ],
    ];

    for (const [nome, consulta] of alvos) {
      const [linha] = comoUsuario(USER_A, consulta);
      expect(Number(linha?.[0]), `A enxergou linha de B em ${nome}`).toBe(0);
    }
  });

  it("o catálogo curado é visível para os DOIS — compartilhar é o ponto da partição", () => {
    // Um teste que barrasse esta leitura estaria testando o produto errado: a camada curada
    // existe para que a instalação nova já saiba assistir (Princípio VIII).
    for (const usuario of [USER_A, USER_B]) {
      const trechos = comoUsuario(
        usuario,
        `select content from public.catalog_chunks
          where content in ('${TRECHO_CATALOGO_X}', '${TRECHO_CATALOGO_TODOS}') order by 1;`,
      ).map((l) => l[0]);
      expect(trechos).toEqual([TRECHO_CATALOGO_X, TRECHO_CATALOGO_TODOS].sort());

      const [escopos] = comoUsuario(
        usuario,
        `select count(*)::text from public.catalog_scopes where id = '${CATALOGO_ESCOPO_X}';`,
      );
      expect(Number(escopos?.[0])).toBe(1);

      const [materiais] = comoUsuario(
        usuario,
        `select count(*)::text from public.catalog_materials
          where id in ('${CATALOGO_MATERIAL_X}', '${CATALOGO_MATERIAL_TODOS}');`,
      );
      expect(Number(materiais?.[0])).toBe(2);
    }
  });
});
