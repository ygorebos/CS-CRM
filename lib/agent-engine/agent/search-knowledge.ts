/**
 * A busca que FUNDAMENTA a resposta — spec 002 (RAG por operadora), fatia F2, T059.
 *
 * ═══ O QUE MUDOU, E POR QUE NÃO ERA COSMÉTICO ═══
 *
 * Até aqui isto chamava `retrieve_top_k_chunks(p_organization_id, p_kb_version_id, …)`:
 * a organização era **afirmada pelo chamador**. Passa a chamar `fn_buscar_lastro`
 * (migrations 0123 + 0124), que recebe `p_agent_id` e **consulta** a organização e o
 * acervo ativo a partir dele. É o que FR-019 exige — o isolamento deixa de depender de
 * o chamador informar corretamente o próprio tenant.
 *
 * `organizationId` continua aqui, e continua sendo o da ROW do job (fonte confiável), mas
 * só para duas coisas que não são a busca: o orçamento do `embedText` e a linha de
 * telemetria. **Ele nunca entra na chamada da função de busca** — se um dia alguém o
 * acrescentar ali, terá reaberto a porta que a migration 0123 fechou.
 *
 * ═══ O ESCOPO (OPERADORA), E POR QUE UMA BUSCA POR ESCOPO ═══
 *
 * FR-018: pergunta que cruza duas operadoras é respondida **por operadora**, cada parte
 * com sua própria âncora. O modo de falha que uma implementação ingênua produz sozinha é
 * chamar a busca UMA vez com os dois escopos e devolver um monte único de trechos — que o
 * modelo funde numa afirmação só, atribuindo a uma operadora o procedimento da outra.
 *
 * Por isso a assinatura recebe `scopeIds` (plural) e faz **uma chamada por escopo**, com
 * os resultados segregados na volta. Fundir é impossível por construção, não por
 * disciplina de quem lê.
 *
 * `scopeIds: [null]` (escopo desconhecido) NÃO é busca ampla: a própria `fn_buscar_lastro`
 * devolve só material "vale para todos" quando `p_scope_id` não resolve (FR-017). O
 * chamador não contorna isso, e não existe caminho aqui que o contorne.
 *
 * ═══ POR QUE O LIMIAR AGORA VAI AO BANCO (e o que isso custou) ═══
 *
 * A versão anterior pedia ao banco SEM limiar (piso -1) e cortava aqui, para poder gravar
 * o `top_score` — a similaridade do melhor candidato mesmo quando ela não passa, que é o
 * que separa "a base não tem isso" de "a base tem e o corte está apertado demais".
 *
 * Com `fn_buscar_lastro` esse truque vira defeito silencioso: a regra 7 dela ("se algum
 * trecho do tenant do balde passa o limiar, os do catálogo daquele balde saem") depende do
 * limiar. Com piso -1 TODO trecho do tenant passa, e o catálogo inteiro desaparece do
 * conjunto — a instalação que "nasce sabendo" pararia de saber, e nenhum teste de linha
 * veria diferença. O limiar real vai ao banco, e o `top_score` é recuperado por uma
 * segunda consulta que só acontece **quando a primeira não trouxe nada** — exatamente o
 * caso em que o diagnóstico de FR-029 importa, e o mais barato de todos.
 */
import type pg from 'pg';

import { embedText } from '@/lib/ai/embed';
import type { Citation } from '@/lib/ai/citations/types';
import {
  divergenciasDe,
  registrarDivergencias,
  type DivergenciaARegistrar,
} from './divergencia';
import type { Logger } from '../obs/logger';

export type CamadaDeLastro = 'tenant' | 'catalog';

export interface KnowledgeHit {
  chunk_id: string;
  /** De qual camada o trecho veio (FR-039). O catálogo é do fabricante; o tenant, do corretor. */
  layer: CamadaDeLastro;
  /** `ai_knowledge_sources.id` na camada do tenant; `catalog_materials.id` na do catálogo. */
  material_id: string | null;
  content: string;
  similarity: number;
  /** Título, operadora e data de atualização — a cópia histórica que a tela mostra (FR-023). */
  source_ref: Record<string, unknown> | null;
}

/** Um balde de resultados: os trechos de UM escopo, nunca misturados com os de outro. */
export interface BuscaPorEscopo {
  /** `null` = escopo desconhecido; o balde só traz material "vale para todos". */
  readonly scopeId: string | null;
  /** Nome como o tenant o vê. `null` quando o escopo é desconhecido. */
  readonly scopeName: string | null;
  readonly results: KnowledgeHit[];
}

export type SearchKnowledgeResult =
  | {
      ok: true;
      /** Um balde por escopo pedido, na mesma ordem. Segregados de propósito (FR-018). */
      porEscopo: BuscaPorEscopo[];
      /**
       * O vetor da pergunta, na forma que o Postgres aceita.
       *
       * Devolvido para que o caminho da RECUSA (FR-042) possa perguntar "existe operadora
       * no catálogo que cobriria isto e está desligada para este corretor?" sem pagar um
       * segundo `embed` — a chamada de modelo mais cara desta função.
       */
      embedding: string;
    }
  | { ok: false; error: { code: string; message: string } };

export interface SearchKnowledgeArgs {
  /** ROW do job. Orçamento do embed e telemetria — **nunca** a busca (FR-019). */
  organizationId: string;
  /** De onde a função de busca tira o tenant e o acervo ativo. */
  agentId: string;
  /** Só telemetria (`knowledge_searches.kb_version_id`). A busca resolve o dela sozinha. */
  kbVersionId: string | null;
  /** Um balde por escopo. Vazio = trata como `[null]` (escopo desconhecido). */
  scopeIds: readonly (string | null)[];
  /** Nome de cada escopo, para o balde e para o que volta ao modelo. */
  scopeNames?: Readonly<Record<string, string>>;
  query: string;
  topK: number;
  threshold: number;
  /** Só para telemetria — opcional, os chamadores de hoje seguem válidos. */
  jobId?: string | null;
}

/**
 * Quanto o limiar é rebaixado na consulta de diagnóstico.
 *
 * É a MESMA margem que `app/api/v1/catalog/gaps/route.ts` e `lib/ai/evolution/aggregate.ts`
 * chamam de "quase acertou". Duas definições do mesmo termo fariam o painel do corretor e
 * o do curador discordarem sobre o mesmo banco.
 */
const MARGEM_DE_QUASE_ACERTO = 0.1;

/**
 * `$6 = true` liga as linhas que o desempate rejeitou (migration 0125).
 *
 * ⚠️ Elas vêm no MESMO conjunto, marcadas com `preterido`. O contrato da função é explícito:
 * linha preterida **nunca** ancora resposta — é justamente o texto que a precedência
 * rejeitou. Por isso a separação acontece na linha seguinte à do `query`, sem nada entre as
 * duas: qualquer código que se instale no meio herda um array em que o trecho errado ainda
 * está presente.
 */
const SQL_BUSCA = `select chunk_id, layer, material_id, content, similarity, source_ref,
          preterido, preterido_por_material
   from fn_buscar_lastro($1, $2, $3::vector, $4, $5, $6)`;

interface LinhaDeLastro extends KnowledgeHit {
  preterido: boolean;
  preterido_por_material: string | null;
}

export async function searchKnowledge(
  pool: pg.Pool,
  args: SearchKnowledgeArgs,
  deps?: { embed?: typeof embedText; log?: Logger },
): Promise<SearchKnowledgeResult> {
  const embed = deps?.embed ?? embedText;
  // Lista vazia vira o balde do escopo desconhecido. Devolver `porEscopo: []` faria o
  // chamador ler "nenhuma busca aconteceu" como "a busca não achou nada" — dois estados
  // com consertos opostos, colapsados num só.
  const escopos = args.scopeIds.length > 0 ? [...args.scopeIds] : [null];

  try {
    const { embedding } = await embed(args.query, { organizationId: args.organizationId });
    const vec = `[${embedding.join(',')}]`;

    const porEscopo: BuscaPorEscopo[] = [];
    const divergencias: DivergenciaARegistrar[] = [];
    for (const scopeId of escopos) {
      // UMA chamada por escopo. O `p_agent_id` é o mesmo; o `p_scope_id` é o que muda —
      // e é o que impede o trecho de uma operadora de ancorar afirmação sobre outra.
      const { rows } = await pool.query<LinhaDeLastro>(SQL_BUSCA, [
        args.agentId,
        scopeId,
        vec,
        args.topK,
        args.threshold,
        true,
      ]);
      // Separação imediata — ver o comentário de `SQL_BUSCA`. `results` daqui para baixo
      // não contém nenhuma linha rejeitada pelo desempate.
      const results = rows.filter((r) => !r.preterido);
      const preteridas = rows.filter((r) => r.preterido);

      porEscopo.push({
        scopeId,
        scopeName: scopeId !== null ? (args.scopeNames?.[scopeId] ?? null) : null,
        results,
      });
      divergencias.push(...divergenciasDe({ scopeId, preteridas, vencedoras: results }));
    }

    const achados = porEscopo.reduce((n, b) => n + b.results.length, 0);
    const topScore =
      achados > 0
        ? maiorSimilaridade(porEscopo.flatMap((b) => b.results))
        : await diagnosticoDeQuaseAcerto(pool, args, escopos, vec, deps?.log);

    // Fire-and-forget: perder telemetria é infinitamente melhor que perder a
    // resposta ao cliente. O `threshold` gravado é o do CHAMADOR — é ele que a
    // leitura de lacunas compara com o `top_score`.
    try {
      await pool.query(
        `insert into knowledge_searches
           (organization_id, job_id, kb_version_id, hits, top_score, threshold)
         values ($1, $2, $3, $4, $5, $6)`,
        [args.organizationId, args.jobId ?? null, args.kbVersionId, achados, topScore, args.threshold],
      );
    } catch (err) {
      // Engolido de propósito — o `catch` externo transformaria isto em
      // `knowledge_unavailable` e o modelo diria ao cliente que a base caiu, por
      // causa de uma linha de telemetria. Mas NÃO mudo (molde do irmão
      // `ai_router_decisions` em inbound-turn): se o insert falhar sempre, o
      // painel mostra zero buscas, que é indistinguível de "ninguém buscou".
      deps?.log?.warn('busca de conhecimento não registrada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }

    // FR-035, segunda metade. Derivado do que a busca JÁ trouxe — nenhuma consulta
    // vetorial a mais —, e engolido em caso de falha pelo mesmo motivo da telemetria
    // acima: registro de diagnóstico não derruba resposta ao cliente.
    await registrarDivergencias(pool, args.organizationId, divergencias, deps?.log);

    return { ok: true, porEscopo, embedding: vec };
  } catch {
    // FR-013 (spec 002): indisponibilidade da busca é **ausência de lastro**, não licença
    // para improvisar. A mensagem anterior aqui mandava o agente "responder com o que já
    // sabe" — exatamente a instrução que produz procedimento de operadora inventado, e
    // ela saía justamente no momento em que o sistema tinha MENOS como conferir.
    //
    // O veto de verdade é do gate `assistance_grounding`: sem âncora a afirmação não sai,
    // e a busca que falhou não devolve âncora nenhuma. Esta mensagem é o ensino que volta
    // ao modelo, para que ele escolha o desfecho certo antes de tentar.
    return {
      ok: false,
      error: {
        code: 'knowledge_unavailable',
        message:
          'não foi possível consultar o material do corretor agora. Trate isto como ausência de material: ' +
          'não afirme nada sobre procedimento, cobertura, carência, rede ou prazos da operadora. ' +
          'Diga ao cliente, em linguagem simples, que a informação será confirmada por uma pessoa.',
      },
    };
  }
}

/**
 * O melhor candidato quando NENHUM passou o limiar (FR-029).
 *
 * Só roda no caso vazio, e por isso não é custo do caminho feliz. O `filter` descarta o
 * NaN que o pgvector devolve para chunk de embedding zerado — ele contaminaria o
 * `Math.max` e cegaria o painel para toda busca daquela base.
 *
 * Falhar aqui devolve `null`, nunca derruba a busca: perder o diagnóstico é perder uma
 * coluna de painel; derrubar é perder a resposta ao cliente.
 */
async function diagnosticoDeQuaseAcerto(
  pool: pg.Pool,
  args: SearchKnowledgeArgs,
  escopos: readonly (string | null)[],
  vec: string,
  log?: Logger,
): Promise<number | null> {
  const piso = Math.max(0, args.threshold - MARGEM_DE_QUASE_ACERTO);
  try {
    const similaridades: number[] = [];
    for (const scopeId of escopos) {
      // `false`: aqui só interessa a distância do melhor candidato. Trazer as preteridas
      // inflaria o `top_score` com o texto que o desempate rejeitou, e o painel de lacunas
      // passaria a dizer "quase acertou" sobre um trecho que nunca vai responder.
      const { rows } = await pool.query<{ similarity: number }>(SQL_BUSCA, [
        args.agentId,
        scopeId,
        vec,
        args.topK,
        piso,
        false,
      ]);
      similaridades.push(...rows.map((r) => r.similarity));
    }
    return maiorSimilaridade(similaridades.map((similarity) => ({ similarity })));
  } catch (err) {
    log?.warn('diagnóstico de quase-acerto não pôde ser medido', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return null;
  }
}

function maiorSimilaridade(hits: readonly { similarity: number }[]): number | null {
  const maior = Math.max(...hits.map((h) => h.similarity).filter(Number.isFinite));
  // `Math.max()` de array vazio é -Infinity: é este `isFinite` que o transforma em
  // `null` — `numeric` aceitaria 'NaN' e envenenaria a coluna em silêncio.
  return Number.isFinite(maior) ? maior : null;
}

/** Shape que a UI do inbox já renderiza (CitationsPanel — lib/ai/citations/types). */
export function citationsFromHits(hits: readonly KnowledgeHit[]): Citation[] {
  return hits.map((h) => ({
    chunk_id: h.chunk_id,
    // `knowledge_source_id` é FK de `ai_knowledge_sources`. O material do CATÁLOGO tem id
    // de OUTRA tabela: enfiá-lo aqui criaria uma FK falsa (anti-pattern nº 1) que a tela
    // seguiria até um 404. A camada e o id do material viajam no `metadata`, onde a tela
    // sabe que o significado depende de `layer`.
    knowledge_source_id: h.layer === 'tenant' ? h.material_id : null,
    score: h.similarity,
    snippet: h.content.slice(0, 240),
    metadata: { ...(h.source_ref ?? {}), layer: h.layer, material_id: h.material_id },
  }));
}
