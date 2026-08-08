import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * A semeadura acrescenta e nunca apaga — e a edição local vence (SC-018, FR-037).
 *
 * Spec 002 (RAG por operadora), fatias F2/F3, migrations 0117 e 0120.
 *
 * ═══ POR QUE ESTE ARQUIVO MEDE A RESPOSTA, E NÃO SÓ AS LINHAS ═══
 *
 * A versão anterior de SC-018 dizia "zero edições sobrescritas" e era medível contando
 * linhas. Só que duas afirmações verdadeiras do desenho, juntas, produziam o oposto do
 * requisito:
 *
 *   · a semeadura só ACRESCENTA versão (trava 6)
 *   · o desempate é por recência (FR-035)
 *
 * A versão que chega por release é sempre a mais recente. Ela venceria a correção local
 * **no comportamento**, com o banco intacto — e o teste de linhas passaria com folga
 * enquanto o corretor recebia de volta o texto que o administrador tinha corrigido.
 *
 * Por isso cada bloco aqui tem duas metades: o que ficou GRAVADO e o que a busca
 * RESPONDE. Um teste que só olhasse a primeira metade é precisamente o teste que estava
 * escrito quando o defeito existia.
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

const ORG = "5eed0000-0000-4000-8000-000000000001";
const SLUG = "semeadura-carencia";
let agente = "";
let escopoTenant = "";
let catalogScope = "";

interface Ancora {
  layer: string;
  content: string;
  source_ref: { version: number; title: string };
}

/**
 * O que a semeadura do `baseline.sql` faz: `on conflict (slug, version) do nothing`.
 * NUNCA `do update` — é a diferença entre "atualizar acrescenta" e "atualizar apaga".
 */
async function semear(version: number, titulo: string, conteudo: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body, origin)
     values ($1, false, $2, $3, $4, 'corpo', 'seed')
     on conflict (slug, version) do nothing
     returning id`,
    [catalogScope, SLUG, version, titulo],
  );
  // Sem linha nova, não há trecho novo: re-semear é no-op de verdade, não um insert que
  // "não faz nada" e mesmo assim duplica chunk.
  if (rows[0]) await inserirTrecho(rows[0].id, conteudo);
}

async function inserirTrecho(materialId: string, conteudo: string): Promise<void> {
  await pool.query(
    `insert into catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
     values ($1, 0, $2, md5($2), 10, $3::vector, 'teste')`,
    [materialId, conteudo, Q],
  );
}

async function buscar(): Promise<Ancora[]> {
  const { rows } = await pool.query<Ancora>(
    "select * from fn_buscar_lastro($1, $2, $3::vector, 10, 0.40)",
    [agente, escopoTenant, Q],
  );
  return rows;
}

async function estado(): Promise<{ versoes: number; inertes: number; trechos: number }> {
  const { rows } = await pool.query<{ versoes: string; inertes: string; trechos: string }>(
    `select
       (select count(*) from catalog_materials where slug = $1)                              versoes,
       (select count(*) from catalog_materials where slug = $1 and inert)                    inertes,
       (select count(*) from catalog_chunks cc join catalog_materials cm on cm.id = cc.catalog_material_id
         where cm.slug = $1)                                                                 trechos`,
    [SLUG],
  );
  return {
    versoes: Number(rows[0]!.versoes),
    inertes: Number(rows[0]!.inertes),
    trechos: Number(rows[0]!.trechos),
  };
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'semeadura-org', 'Semeadura LTDA', 'Semeadura') on conflict (id) do nothing`,
    [ORG],
  );
  agente = (
    await pool.query<{ id: string }>(
      "insert into ai_agents (organization_id, name, system_prompt) values ($1, 'agente', 'p') returning id",
      [ORG],
    )
  ).rows[0]!.id;

  catalogScope = (
    await pool.query<{ id: string }>(
      "insert into catalog_scopes (slug, display_name) values ('semeadura-op', 'Operadora Semeada') returning id",
      [],
    )
  ).rows[0]!.id;

  await pool.query("select fn_sincronizar_escopos_do_catalogo($1)", [ORG]);
  escopoTenant = (
    await pool.query<{ id: string }>(
      "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
      [ORG, catalogScope],
    )
  ).rows[0]!.id;
  // O espelho nasce desligado (A-20); este arquivo mede semeadura, não ativação.
  await pool.query("update knowledge_scopes set is_active = true where id = $1", [escopoTenant]);
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.query("delete from catalog_materials where slug = $1", [SLUG]);
  await pool.query("delete from catalog_scopes where slug = 'semeadura-op'");
  await pool.end();
});

describe("install → editar → update → update de novo", () => {
  it("install: a versão semeada ancora", async () => {
    await semear(1, "Carência — texto do fabricante", "carencia versao semeada 1");
    expect(await estado()).toEqual({ versoes: 1, inertes: 0, trechos: 1 });

    const r = await buscar();
    expect(r.map((a) => a.content)).toEqual(["carencia versao semeada 1"]);
  });

  it("o administrador corrige: nasce uma versão local, e a semeada CONTINUA gravada", async () => {
    const local = (
      await pool.query<{ id: string }>(
        `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body, origin, adopted_at)
         values ($1, false, $2, 2, 'Carência — corrigida aqui', 'corpo', 'local', now())
         returning id`,
        [catalogScope, SLUG],
      )
    ).rows[0]!.id;
    await inserirTrecho(local, "carencia corrigida localmente");

    // GRAVADO: nada foi sobrescrito — a v1 semeada segue lá.
    const e = await estado();
    expect(e.versoes).toBe(2);
    expect(e.inertes).toBe(0);

    // RESPONDIDO: e só a corrigida ancora. Sem esta metade, um catálogo que respondesse
    // as DUAS versões — uma delas dizendo o que o administrador acabou de corrigir —
    // passaria no teste.
    const r = await buscar();
    expect(r.map((a) => a.content)).toEqual(["carencia corrigida localmente"]);
  });

  it("update: re-semear a MESMA versão é no-op — sem duplicata, sem sobrescrita", async () => {
    const antes = await estado();
    await semear(1, "Carência — texto do fabricante", "carencia versao semeada 1");
    expect(await estado()).toEqual(antes);

    const r = await buscar();
    expect(r.map((a) => a.content)).toEqual(["carencia corrigida localmente"]);
  });

  it("release: a versão semeada NOVA chega inerte e não rouba a resposta (FR-037)", async () => {
    await semear(3, "Carência — revisão do fabricante", "carencia versao semeada 3");

    // GRAVADO: ela existe, e está visível para ser aceita.
    const e = await estado();
    expect(e.versoes).toBe(3);
    expect(e.inertes).toBe(1);

    // RESPONDIDO: continua sendo a correção local. É AQUI que a versão anterior de SC-018
    // passava e o requisito falhava — a v3 é a mais recente, e por recência venceria.
    const r = await buscar();
    expect(r.map((a) => a.content)).toEqual(["carencia corrigida localmente"]);
  });

  it("update de novo: o estado depois de duas reaplicações é idêntico ao de uma", async () => {
    const antes = await estado();
    const respostaAntes = (await buscar()).map((a) => a.content);

    await semear(1, "Carência — texto do fabricante", "carencia versao semeada 1");
    await semear(3, "Carência — revisão do fabricante", "carencia versao semeada 3");

    expect(await estado()).toEqual(antes);
    expect((await buscar()).map((a) => a.content)).toEqual(respostaAntes);
  });

  it("aceitar a versão nova é um UPDATE, e aí ela passa a responder", async () => {
    // O outro lado da inércia: ela não é uma lápide. O administrador aceita, e o catálogo
    // volta a mandar. Sem este caminho, `inert` seria um jeito elegante de perder release.
    await pool.query("update catalog_materials set inert = false where slug = $1 and version = 3", [SLUG]);

    const r = await buscar();
    expect(r.map((a) => a.content)).toEqual(["carencia versao semeada 3"]);
  });
});
