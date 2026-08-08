import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O bloco de semeadura REAL do `baseline.sql`, aplicado como o self-hoster o aplica.
 *
 * Spec 002, F3. Tarefa T072 e passos 3 e 4 do contrato `semeadura-do-catalogo.md` — os dois
 * que o contrato registra como "o teste que falta hoje".
 *
 * ═══ O QUE ESTE ARQUIVO PROVA QUE `test:db` SOZINHO NÃO PROVA ═══
 *
 * O harness já aplica o `baseline.sql` duas vezes (install e update) antes desta suíte, o
 * que prova IDEMPOTÊNCIA. Idempotência não é não-destrutividade: um bloco com
 * `on conflict do update` reaplicado é perfeitamente idempotente — e apaga a correção que o
 * dono da instalação fez. É a diferença entre "o estado final é o mesmo" e "nada de
 * ninguém se perdeu", e só a segunda é a trava 6.
 *
 * Por isso aqui há uma terceira aplicação, com **edição local no meio**: é o único arranjo
 * em que a diferença aparece.
 *
 * ═══ POR QUE O TESTE LÊ O BLOCO DO ARQUIVO, E NÃO UMA CÓPIA ═══
 *
 * O SQL exercitado é extraído do `supabase/baseline.sql` em tempo de execução. Uma cópia do
 * bloco dentro do teste provaria a cópia — e no dia em que o gerador mudasse, o teste
 * seguiria verde sobre um SQL que não existe mais em lugar nenhum.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

const MARCADOR = "-- ---- catálogo curado de exemplo (semeadura, spec 002 F3) ----";

function psql(script: string): string {
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
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const n = (s: string): number => Number(s.split("\n").pop());

let blocoDeSemeadura = "";

beforeAll(() => {
  const baseline = fs.readFileSync(
    path.join(process.cwd(), "supabase", "baseline.sql"),
    "utf8",
  );
  const i = baseline.indexOf(MARCADOR);
  if (i === -1) {
    throw new Error(`bloco de semeadura não encontrado em baseline.sql (marcador: ${MARCADOR})`);
  }
  blocoDeSemeadura = baseline.slice(i);
});

describe("a semeadura acrescenta, e o update não apaga nada de ninguém", () => {
  it("depois de install + update, o catálogo de exemplo está lá UMA vez (sem duplicata)", () => {
    // O harness já aplicou o baseline duas vezes. Se o bloco duplicasse, apareceria aqui.
    expect(n(psql("select count(*) from catalog_scopes where slug like 'operadora-exemplo-%';"))).toBe(2);
    expect(n(psql("select count(*) from catalog_materials where origin = 'seed' and slug like 'exemplo-%';"))).toBe(5);
    expect(
      n(
        psql(`select count(*) from catalog_chunks c
                join catalog_materials m on m.id = c.catalog_material_id
               where m.slug like 'exemplo-%';`),
      ),
    ).toBe(5);
  });

  it("os embeddings viajaram prontos — a instalação fresca é buscável SEM chave de IA", () => {
    // O ponto inteiro de embutir literal `vector(1536)` no arquivo. Um trecho com embedding
    // nulo, ou com dimensão errada, faria a instalação nova precisar de um worker e de uma
    // chave antes de responder qualquer coisa — que é o oposto de "nasce sabendo".
    expect(
      n(
        psql(`select count(*) from catalog_chunks c
                join catalog_materials m on m.id = c.catalog_material_id
               where m.slug like 'exemplo-%'
                 and c.embedding is not null
                 and vector_dims(c.embedding) = 1536;`),
      ),
    ).toBe(5);
    // E o modelo fica registrado — é o que permite re-embeddar só quando ele muda.
    expect(n(psql("select count(distinct embedding_model) from catalog_chunks;"))).toBe(1);
  });

  it("cada material de exemplo se declara exemplo no PRÓPRIO corpo (A-19)", () => {
    // No corpo, não num comentário do SQL: se o corretor publicar o agente sem trocar nada,
    // o pior que acontece é o cliente ler que aquilo é demonstração.
    const semAviso = psql(
      `select count(*) from catalog_materials
        where origin = 'seed' and slug like 'exemplo-%' and body not ilike '%EXEMPLO%';`,
    );
    expect(n(semAviso)).toBe(0);
  });

  it("o escopo curado chega DESLIGADO a quem já existia (A-20), e chega", () => {
    // Simula o clone de seis meses: a organização já existe quando a semeadura roda.
    psql(`
      insert into organizations (id, slug, legal_name, display_name)
        values ('5eed1111-0000-4000-8000-000000000001', 'clone-antigo', 'Clone LTDA', 'Clone')
        on conflict (id) do nothing;
    `);
    psql(blocoDeSemeadura);

    // A contagem é ESCOPADA aos escopos de exemplo, e não global, porque este Postgres é
    // compartilhado por toda a suíte de invariantes: outros arquivos criam os seus próprios
    // `catalog_scopes`, e `fn_sincronizar_escopos_do_catalogo` espelha TODOS os ativos.
    // Contar global aqui passava rodando o arquivo sozinho e quebrava no `pnpm test:db`
    // inteiro — o pior par possível, porque o verde local antecede o vermelho do CI.
    const espelhosDoExemplo = (filtro: string) =>
      n(
        psql(`select count(*) from knowledge_scopes ks
                join catalog_scopes cs on cs.id = ks.catalog_scope_id
               where ks.organization_id = '5eed1111-0000-4000-8000-000000000001'
                 and cs.slug like 'operadora-exemplo-%' ${filtro};`),
      );

    expect(espelhosDoExemplo("")).toBe(2);
    expect(espelhosDoExemplo("and ks.is_active")).toBe(0);
  });

  it("terceira aplicação COM edição local: zero perdas, zero sobrescritas, zero duplicatas", () => {
    // A edição do dono da instalação: uma versão local sobre um slug semeado.
    psql(`
      insert into catalog_materials
        (catalog_scope_id, applies_to_all, slug, version, title, body, origin, adopted_at)
      select null, true, 'exemplo-o-que-e-carencia', 2,
             'O que é carência — corrigido nesta instalação',
             'Texto corrigido pelo dono desta instalação.', 'local', now()
      where not exists (
        select 1 from catalog_materials where slug = 'exemplo-o-que-e-carencia' and version = 2
      );
    `);
    // E uma alteração DIRETA numa linha semeada — o caso que um `do update` destruiria.
    psql(`update catalog_materials set title = 'MEXIDO PELO DONO'
           where slug = 'exemplo-segunda-via-de-boleto' and version = 1;`);

    const antes = psql("select count(*) from catalog_materials where slug like 'exemplo-%';");

    psql(blocoDeSemeadura);

    // (1) zero perdas — a edição local continua lá
    expect(
      n(psql("select count(*) from catalog_materials where slug = 'exemplo-o-que-e-carencia' and origin = 'local';")),
    ).toBe(1);
    // (2) zero sobrescritas — a linha semeada que o dono mexeu continua mexida
    expect(
      psql("select title from catalog_materials where slug = 'exemplo-segunda-via-de-boleto' and version = 1;"),
    ).toBe("MEXIDO PELO DONO");
    // (3) zero duplicatas
    expect(psql("select count(*) from catalog_materials where slug like 'exemplo-%';")).toBe(antes);
    expect(
      n(
        psql(`select count(*) from catalog_chunks c
                join catalog_materials m on m.id = c.catalog_material_id
               where m.slug like 'exemplo-%';`),
      ),
    ).toBe(5);
  });

  it("update de novo: o estado depois de duas reaplicações é idêntico ao de uma", () => {
    // Escopado ao que ESTE arquivo semeou, pela mesma razão do caso anterior.
    const estado = () =>
      psql(`select
              (select count(*) from catalog_scopes where slug like 'operadora-exemplo-%')::text || '|' ||
              (select count(*) from catalog_materials where slug like 'exemplo-%')::text || '|' ||
              (select count(*) from catalog_chunks c
                 join catalog_materials m on m.id = c.catalog_material_id
                where m.slug like 'exemplo-%')::text || '|' ||
              (select count(*) from knowledge_scopes ks
                 join catalog_scopes cs on cs.id = ks.catalog_scope_id
                where cs.slug like 'operadora-exemplo-%')::text;`);

    const antes = estado();
    psql(blocoDeSemeadura);
    expect(estado()).toBe(antes);
  });
});
