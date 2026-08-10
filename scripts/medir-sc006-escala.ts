/**
 * SC-006 — a busca de lastro não fica 25% mais lenta com 20 operadoras (T071 + T124).
 *
 * ═══ POR QUE O CRITÉRIO DE T071 PRECISOU SER REDEFINIDO ═══
 *
 * T071 mandava registrar a linha de base "ANTES da semeadura do catálogo", entre T052 e
 * T053. Essa janela FECHOU: o catálogo foi semeado, e não há como voltar a um estado em que
 * ele não existe sem desfazer trabalho entregue. Um critério que só pode ser cumprido no
 * passado não é critério — é dívida.
 *
 * A redefinição preserva o que SC-006 realmente mede: **a diferença** entre 1 escopo e 20,
 * não um número absoluto. Em vez de depender da ordem histórica, a linha de base passa a ser
 * reproduzível a qualquer momento — o que é mais forte que a original.
 *
 * ═══ POR QUE AS DUAS CONDIÇÕES VIVEM EM ORGANIZAÇÕES DIFERENTES, MEDIDAS INTERCALADAS ═══
 *
 * A primeira versão media em sequência: 1 escopo, depois acrescentava 19 e media de novo.
 * **Ela não decidia nada.** Três execuções seguidas, sem mudar uma linha do produto,
 * deram -26,9%, -6,1% e +70,1% — a consulta custa ~5 ms e a máquina é compartilhada, então
 * o p95 mede o escalonador do host, não o número de operadoras. Declarar "passa" na
 * execução que calhou de sair negativa seria o verde falso mais caro desta spec.
 *
 * A correção é temporal: as duas condições existem AO MESMO TEMPO, em organizações
 * separadas (A com 1 operadora, B com 20), e o laço alterna A, B, A, B… Qualquer ruído do
 * host — outro contêiner, checkpoint do Postgres, GC — cai sobre as duas medições na mesma
 * proporção, e a diferença volta a ser sobre o que SC-006 pergunta.
 *
 * ═══ POR QUE O CRONÔMETRO NÃO PARTICIPA DO LAÇO ═══
 *
 * `CLAUDE.md`, regra 4: medir latência com `Date.now()` em volta do laço mistura a espera
 * com a duração da chamada anterior. Aqui cada chamada é cronometrada individualmente com
 * `process.hrtime.bigint()`, e o p95 sai da lista ordenada — o tempo de montar a próxima
 * pergunta não entra em medição nenhuma.
 *
 * ═══ O QUE ESTE SCRIPT MEDE, E O QUE NÃO ═══
 *
 * Mede `fn_buscar_lastro`, que é onde os 20 escopos pesam: mais linhas de catálogo, mais
 * espelhos, mais candidatos ao desempate. NÃO mede o turno inteiro do agente (modelo,
 * rede, WhatsApp) — esse tempo é dominado pelo provedor e não muda com o número de
 * operadoras, que é justamente a variável que SC-006 isola.
 *
 * Uso:
 *   pnpm exec tsx --env-file=.env.e2e scripts/medir-sc006-escala.ts
 */
import pg from "pg";

const DIM = 1536;
/** Vetor unitário determinístico — o que se mede é a REGRA, não a qualidade do embedding. */
const vetor = (i: number): string =>
  `[${Array.from({ length: DIM }, (_, k) => (k === i % DIM ? 1 : 0)).join(",")}]`;

/** A com UMA operadora; B com vinte. As duas existem ao mesmo tempo, de propósito. */
const ORG_A = "5c060000-0000-4000-8000-000000000001";
const ORG_B = "5c060000-0000-4000-8000-000000000002";
const PREFIXO = "sc006-";
/** 20 perguntas — a "bateria" de SC-006. Vetores distintos, mesmo alvo. */
const PERGUNTAS = 20;
/** Repetições por pergunta: p95 sobre 20 amostras seria decidido por uma única cauda. */
const REPETICOES = 25;

/** Mediana — o par com o p95 mostra se a cauda é o que manda ou se a distribuição andou. */
function mediana(amostras: number[]): number {
  const o = [...amostras].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 === 0 ? (o[m - 1]! + o[m]!) / 2 : o[m]!;
}

function p95(amostras: number[]): number {
  const ordenado = [...amostras].sort((a, b) => a - b);
  // Índice do percentil 95 pelo método "nearest rank", que é o que se explica sem ressalva.
  const i = Math.ceil(0.95 * ordenado.length) - 1;
  return ordenado[Math.max(0, i)]!;
}

async function main(): Promise<void> {
  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — rode com --env-file=.env.e2e");
  const pool = new pg.Pool({ connectionString: conn, max: 4 });

  const limpar = async (): Promise<void> => {
    await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
    await pool.query("delete from catalog_materials where slug like $1", [`${PREFIXO}%`]);
    await pool.query("delete from catalog_scopes where slug like $1", [`${PREFIXO}%`]);
  };
  await limpar();

  /** Monta uma organização e devolve o agente dela. */
  const montarOrg = async (id: string, slug: string): Promise<string> => {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Escala LTDA', 'Escala')`,
      [id, slug],
    );
    const agente = (
      await pool.query<{ id: string }>(
        "insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'p') returning id",
        [id, `agente-${slug}`],
      )
    ).rows[0]!.id;
    const kbv = (
      await pool.query<{ id: string }>(
        "insert into ai_knowledge_versions (organization_id, agent_id, version_number) values ($1, $2, 1) returning id",
        [id, agente],
      )
    ).rows[0]!.id;
    await pool.query("update ai_agents set active_kb_version_id = $1 where id = $2", [kbv, agente]);
    return agente;
  };

  const agenteA = await montarOrg(ORG_A, "sc006-uma");
  const agenteB = await montarOrg(ORG_B, "sc006-vinte");

  /** Cria um escopo curado com 25 trechos. O espelho é ligado nas orgs pedidas. */
  const escopoCurado = async (n: number, orgs: readonly string[]): Promise<Map<string, string>> => {
    const cs = (
      await pool.query<{ id: string }>(
        "insert into catalog_scopes (slug, display_name) values ($1, $2) returning id",
        [`${PREFIXO}${n}`, `Operadora SC006 ${n}`],
      )
    ).rows[0]!.id;
    const mat = (
      await pool.query<{ id: string }>(
        `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body)
         values ($1, false, $2, 1, $3, 'corpo') returning id`,
        [cs, `${PREFIXO}mat-${n}`, `Manual da SC006 ${n}`],
      )
    ).rows[0]!.id;
    // 25 trechos por operadora: com 20 operadoras são 500 candidatos, que é o que faz a
    // medição significar alguma coisa. Um trecho por operadora mediria o overhead da
    // chamada, não a escala.
    for (let t = 0; t < 25; t += 1) {
      await pool.query(
        `insert into catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
         values ($1, $2, $3, md5($3), 10, $4::vector, 'medicao')`,
        [mat, t, `sc006 operadora ${n} trecho ${t}`, vetor(t)],
      );
    }
    const espelhos = new Map<string, string>();
    for (const org of orgs) {
      await pool.query("select fn_sincronizar_escopos_do_catalogo($1)", [org]);
      const espelho = (
        await pool.query<{ id: string }>(
          "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
          [org, cs],
        )
      ).rows[0]!.id;
      await pool.query("update knowledge_scopes set is_active = true where id = $1", [espelho]);
      espelhos.set(org, espelho);
    }
    return espelhos;
  };

  // A operadora 1 vale para as DUAS orgs — é sobre ela que as duas baterias perguntam, para
  // a diferença ser só o número de VIZINHAS, e não o conteúdo consultado.
  const primeira = await escopoCurado(1, [ORG_A, ORG_B]);
  const escopoA = primeira.get(ORG_A)!;
  const escopoB = primeira.get(ORG_B)!;
  // As outras 19 existem só na B.
  for (let n = 2; n <= 20; n += 1) await escopoCurado(n, [ORG_B]);

  const buscar = async (agente: string, escopo: string, q: number): Promise<number> => {
    const antes = process.hrtime.bigint();
    await pool.query(
      "select * from public.fn_buscar_lastro($1, $2, $3::vector, 5, 0.40, false)",
      [agente, escopo, vetor(q)],
    );
    return Number(process.hrtime.bigint() - antes) / 1e6;
  };

  // Aquecimento descartado: a primeira chamada paga o plano da query e o cache frio.
  for (let q = 0; q < PERGUNTAS; q += 1) {
    await buscar(agenteA, escopoA, q);
    await buscar(agenteB, escopoB, q);
  }

  // ── o laço INTERCALADO ────────────────────────────────────────────────────
  const amostrasA: number[] = [];
  const amostrasB: number[] = [];
  for (let r = 0; r < REPETICOES; r += 1) {
    for (let q = 0; q < PERGUNTAS; q += 1) {
      // A ordem alterna a cada repetição para nenhuma das duas condições ficar sempre
      // atrás da outra na fila do Postgres.
      if (r % 2 === 0) {
        amostrasA.push(await buscar(agenteA, escopoA, q));
        amostrasB.push(await buscar(agenteB, escopoB, q));
      } else {
        amostrasB.push(await buscar(agenteB, escopoB, q));
        amostrasA.push(await buscar(agenteA, escopoA, q));
      }
    }
  }

  const contar = async (agente: string, escopo: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      "select count(*)::text n from public.fn_buscar_lastro($1, $2, $3::vector, 5, 0.40, false)",
      [agente, escopo, vetor(0)],
    );
    return Number(rows[0]!.n);
  };
  const respondidasA = await contar(agenteA, escopoA);
  const respondidasB = await contar(agenteB, escopoB);

  const p95A = p95(amostrasA);
  const p95B = p95(amostrasB);
  const crescimento = ((p95B - p95A) / p95A) * 100;

  const linhas = [
    `amostras por condição: ${amostrasA.length} (${PERGUNTAS} perguntas x ${REPETICOES} repetições, intercaladas)`,
    `p95 com  1 operadora (org A): ${p95A.toFixed(2)} ms`,
    `p95 com 20 operadoras (org B): ${p95B.toFixed(2)} ms`,
    `mediana  1 / 20: ${mediana(amostrasA).toFixed(2)} ms / ${mediana(amostrasB).toFixed(2)} ms`,
    `crescimento do p95: ${crescimento >= 0 ? "+" : ""}${crescimento.toFixed(1)}%  (teto de SC-006: +25%)`,
    `âncoras devolvidas com 1: ${respondidasA} · com 20: ${respondidasB}`,
    `veredito: ${crescimento <= 25 && respondidasB >= respondidasA ? "PASSA" : "REPROVA"}`,
  ];
  for (const l of linhas) console.info(l);

  await limpar();
  await pool.end();

  if (crescimento > 25 || respondidasB < respondidasA) process.exitCode = 1;
}

void main();
