import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { GUARDRAILS_DO_AGENTE_PADRAO } from "@/lib/ai/agents/guardrails-padrao";
import { resolverExigenciaDeLastro } from "@/lib/agent-engine/guardrails/assistance-grounding";

/**
 * Agente nasce com o guarda de lastro LIGADO — spec 002, FR-014 + FR-030 (migration 0129).
 *
 * ═══ O DEFEITO QUE ESTE ARQUIVO VIGIA ═══
 *
 * `ai_agents.guardrails` era `jsonb not null default '[]'`, e lista vazia é lista sem
 * `rag_must_hit` — então `resolverExigenciaDeLastro` devolvia `enforce: false` e o gate
 * `assistance_grounding` nascia desarmado. Só o onboarding escrevia o guardrail à mão.
 * Agente criado pela API, duplicado ou semeado por script afirmava procedimento, cobertura,
 * carência ou rede sem material nenhum — o defeito que a spec 002 inteira existe para matar,
 * entrando por uma porta que nenhuma tarefa cobria, com a suíte verde.
 *
 * ═══ POR QUE AQUI, E NÃO NUM TESTE DE UNIDADE ═══
 *
 * O que garante o comportamento é o DEFAULT DA COLUNA, e default de coluna não existe em
 * mock: um teste com fake de supabase-js provaria que a rota não manda `guardrails`, que é o
 * contrário do que se quer provar. Só um Postgres de verdade responde "o que a linha REALMENTE
 * tem depois do insert".
 *
 * ═══ AS PONTAS, E POR QUE CADA UMA ═══
 *
 * 1. **Comportamento**: `insert` com o mínimo obrigatório e a linha volta armada. Fica
 *    vermelha se alguém voltar o default para `'[]'`.
 * 2. **Acordo banco × TypeScript**: o default é cópia declarada de
 *    `GUARDRAILS_DO_AGENTE_PADRAO`. Sem esta ponta, mudar o texto ou o `min_citations` no
 *    TypeScript deixaria o banco parado numa versão antiga e nada reprovaria — a constante
 *    viraria enfeite, que é a mesma classe de defeito da origem. A comparação é ESTRUTURAL:
 *    o Postgres normaliza a ordem das chaves do `jsonb`, então comparar texto seria um teste
 *    sobre representação, quebrando ao trocar uma vírgula de lugar sem nada de real mudar.
 * 3. **Desligar continua possível**: default é comportamento de fábrica, não tranca.
 * 4. **O backfill**: o default só vale para linha nova; quem já existia depende do `update`
 *    do apêndice. Ele é reexecutado aqui contra um agente montado de propósito — é a única
 *    forma de medi-lo, já que num banco fresco a tabela está vazia quando o baseline roda.
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

const ORG = "1a570000-0000-4000-8000-000000000129";

/**
 * O `update` do apêndice do baseline, copiado VERBATIM da migration 0129.
 *
 * Copiar dói, e a alternativa dói mais: extrair para uma função no banco só para o teste
 * poder chamá-la coloca no schema de produção uma peça que só existe por causa do teste. O
 * que segura a cópia honesta é o caso 2 — se o conteúdo do guardrail mudar, ele reprova antes
 * que esta string desatualizada engane alguém.
 */
const BACKFILL = `
update public.ai_agents
   set guardrails = case
         when jsonb_typeof(guardrails) = 'array'
           then guardrails || '{"kind": "rag_must_hit", "min_citations": 1, "reason": "não afirmar procedimento, cobertura, carência ou rede sem material carregado que sustente"}'::jsonb
         else '[{"kind": "rag_must_hit", "min_citations": 1, "reason": "não afirmar procedimento, cobertura, carência ou rede sem material carregado que sustente"}]'::jsonb
       end
 where (jsonb_typeof(guardrails) is distinct from 'array'
    or not (guardrails @> '[{"kind": "rag_must_hit"}]'::jsonb))
   and id = $1`;

const REGEX_DO_ADMIN = {
  kind: "regex_output_block",
  pattern: "cpf",
  flags: "i",
  reason: "configurado pelo admin, tem de sobreviver ao backfill",
};

afterAll(async () => {
  await pool.end();
});

async function org(): Promise<void> {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'lastro-de-fabrica', 'Fabrica LTDA', 'Fabrica') on conflict (id) do nothing`,
    [ORG],
  );
}

/**
 * Insere um agente. `guardrails` undefined = coluna OMITIDA, que é o caso sob teste.
 *
 * `nome` é parâmetro porque `ai_agents_name_unique (organization_id, name)` existe: nome fixo
 * faria o segundo caso morrer de 23505 em vez de medir o que veio medir.
 */
async function agenteNovo(
  nome: string,
  guardrails?: unknown,
): Promise<{ id: string; guardrails: unknown }> {
  await org();
  const { rows } =
    guardrails === undefined
      ? await pool.query<{ id: string; guardrails: unknown }>(
          "insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt do agente') returning id, guardrails",
          [ORG, nome],
        )
      : await pool.query<{ id: string; guardrails: unknown }>(
          "insert into ai_agents (organization_id, name, system_prompt, guardrails) values ($1, $2, 'prompt do agente', $3::jsonb) returning id, guardrails",
          [ORG, nome, JSON.stringify(guardrails)],
        );
  return rows[0]!;
}

describe("ai_agents.guardrails — lastro exigido é comportamento de fábrica", () => {
  it("agente inserido sem guardrails nasce EXIGINDO lastro", async () => {
    const { guardrails } = await agenteNovo("nasce-armado");

    // A asserção é sobre o EFEITO, medido pela mesma função que o runtime usa. Assertar a
    // forma do jsonb provaria que a coluna guarda um texto; o que importa é que o gate arma.
    const { enforce, minCitations } = resolverExigenciaDeLastro(guardrails);
    expect(enforce, "agente nasce com assistance_grounding DESARMADO — FR-014 furado").toBe(true);
    expect(minCitations).toBeGreaterThanOrEqual(1);
  });

  it("o default do banco é a MESMA coisa que GUARDRAILS_DO_AGENTE_PADRAO", async () => {
    const { guardrails } = await agenteNovo("acordo-com-o-typescript");
    expect(guardrails).toEqual(GUARDRAILS_DO_AGENTE_PADRAO);
  });

  it("lista vazia explícita continua desarmando — desligar é decisão de quem administra", async () => {
    // O default é o comportamento de fábrica, não uma trava. Quem apaga os guardrails na tela
    // decidiu por escrito, e o banco não pode desfazer a decisão dele no insert seguinte. Sem
    // este caso, "arma sempre" passaria por "arma por padrão".
    const { guardrails } = await agenteNovo("desligado-de-proposito", []);
    expect(resolverExigenciaDeLastro(guardrails).enforce).toBe(false);
  });

  it("o backfill acrescenta sem apagar o que o admin configurou, e não duplica ao repetir", async () => {
    const { id } = await agenteNovo("backfill", [REGEX_DO_ADMIN]);

    await pool.query(BACKFILL, [id]);
    await pool.query(BACKFILL, [id]); // o baseline é reaplicado a cada deploy

    const { rows } = await pool.query<{ guardrails: unknown[] }>(
      "select guardrails from ai_agents where id = $1",
      [id],
    );
    const depois = rows[0]!.guardrails;

    expect(resolverExigenciaDeLastro(depois).enforce).toBe(true);
    // Substituir em vez de acrescentar apagaria configuração de segurança do admin — silencioso
    // e irreversível, porque ninguém guarda o que havia antes.
    expect(depois).toContainEqual(REGEX_DO_ADMIN);
    // Duas passadas do apêndice não podem virar dois `rag_must_hit`: o resolvedor sobrevive,
    // mas a tela mostraria o guardrail em duplicata e o admin apagaria um achando que resolveu.
    expect(depois.filter((g) => (g as { kind?: string }).kind === "rag_must_hit")).toHaveLength(1);
  });
});
