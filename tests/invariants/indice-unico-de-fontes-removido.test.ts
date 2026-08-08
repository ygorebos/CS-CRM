import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * O índice que tornava a SEGUNDA operadora impossível não pode voltar (migration 0118).
 *
 * `ai_knowledge_sources_unique_per_agent` é `unique (agent_id, source_type) where
 * is_active`: um agente tem no máximo UMA fonte ativa de cada tipo. O corretor que
 * carregasse o manual da segunda operadora recebia violação de unicidade — a feature
 * inteira era impossível por índice, não por código.
 *
 * ═══ POR QUE ESTE ARQUIVO EXISTE (brecha 10) ═══
 *
 * O `drop index` precisa estar em DOIS lugares: na migration (para quem atualiza) e no
 * apêndice do `baseline.sql` (para quem instala). O snapshot do baseline **recria** o
 * índice, e o apêndice roda depois dele. Com o drop só na migration, instalação fresca
 * nasceria COM o índice e clone atualizado SEM — duas realidades saindo do mesmo arquivo,
 * e a pior delas é a do usuário novo, que é justamente quem o produto precisa conquistar.
 *
 * O container do `pnpm test:db` aplica o baseline em modo install E em modo update antes
 * desta suíte, então este teste cobre os dois estados de uma vez.
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

const ORG = "1d1ce000-0000-4000-8000-000000000001";

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("a segunda operadora é possível", () => {
  it("o índice ai_knowledge_sources_unique_per_agent não existe", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where indexname = 'ai_knowledge_sources_unique_per_agent'",
    );
    expect(rows).toHaveLength(0);
  });

  it("duas fontes ativas do MESMO tipo convivem no mesmo agente — medido pelo efeito", async () => {
    // Ausência de índice é a causa; o que importa é a consequência. Um teste que só
    // olhasse `pg_indexes` continuaria verde se alguém recriasse a mesma restrição com
    // outro nome, ou como constraint.
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, 'indice-unico-org', 'Indice LTDA', 'Indice') on conflict (id) do nothing`,
      [ORG],
    );
    const agente = (
      await pool.query<{ id: string }>(
        "insert into ai_agents (organization_id, name, system_prompt) values ($1, 'agente', 'p') returning id",
        [ORG],
      )
    ).rows[0]!.id;

    const criarFonte = async (nome: string): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, is_active, applies_to_all)
           values ($1, $2, 'policy', $3, true, true) returning id`,
          [ORG, agente, nome],
        )
      ).rows[0]!.id;

    const primeira = await criarFonte("Manual da operadora A");
    const segunda = await criarFonte("Manual da operadora B");

    expect(primeira).not.toBe(segunda);

    const { rows } = await pool.query<{ n: string }>(
      "select count(*) n from ai_knowledge_sources where agent_id = $1 and source_type = 'policy' and is_active",
      [agente],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});
