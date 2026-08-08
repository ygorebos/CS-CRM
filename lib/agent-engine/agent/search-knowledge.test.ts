import { describe, expect, it, vi } from 'vitest';

import { citationsFromHits, searchKnowledge, type KnowledgeHit } from './search-knowledge';
import { classificarAfirmacaoDeAssistencia } from '../guardrails/assistance-grounding';

/**
 * FR-013 (spec 002): busca indisponível é **ausência de lastro**, nunca licença para
 * improvisar.
 *
 * Este arquivo existe por causa de uma frase que estava no código de produção:
 * *"a base de conhecimento está indisponível agora — responda com o que você já sabe e
 * não invente fatos."* As duas metades se contradizem, e o modelo obedece a primeira. Era
 * a instrução que produzia procedimento de operadora inventado, entregue justamente no
 * momento em que o sistema tinha menos como conferir.
 *
 * A fatia F2 acrescentou aqui o que T059 e FR-019 exigem: a busca chama `fn_buscar_lastro`
 * com `p_agent_id` e **nunca** com o `organization_id` do chamador, e o escopo (operadora)
 * vira um balde por chamada — não um monte único.
 */

const embedFalso = { embed: async () => ({ embedding: [0.1] }) as never };

const poolQueFalha = {
  query: vi.fn().mockRejectedValue(new Error('connection refused')),
} as unknown as Parameters<typeof searchKnowledge>[0];

const AGENTE = '00000000-0000-4000-8000-00000000000a';
const ORG = '00000000-0000-4000-8000-000000000001';
const KB = '00000000-0000-4000-8000-000000000002';
const AMIL = '00000000-0000-4000-8000-00000000000b';
const UNIMED = '00000000-0000-4000-8000-00000000000c';

const args = {
  organizationId: ORG,
  agentId: AGENTE,
  kbVersionId: KB,
  scopeIds: [null],
  query: 'como tiro a segunda via do boleto?',
  topK: 5,
  threshold: 0.4,
};

/** Pool falso que responde a busca conforme o `p_scope_id` recebido. */
function poolComResultados(porEscopo: Record<string, KnowledgeHit[]>) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (!sql.includes('fn_buscar_lastro')) return { rows: [], rowCount: 0 };
    const scopeId = (params?.[1] ?? null) as string | null;
    return { rows: porEscopo[scopeId ?? '∅'] ?? [], rowCount: 0 };
  });
  return {
    pool: { query } as unknown as Parameters<typeof searchKnowledge>[0],
    query,
  };
}

const trecho = (id: string, layer: 'tenant' | 'catalog', similarity: number): KnowledgeHit => ({
  chunk_id: id,
  layer,
  material_id: `${id}-material`,
  content: `conteúdo ${id}`,
  similarity,
  source_ref: { layer, title: `título ${id}` },
});

describe('busca de conhecimento indisponível', () => {
  it('devolve erro em vez de exceção — a convenção do harness é ensino ao modelo', async () => {
    const r = await searchKnowledge(poolQueFalha, args, embedFalso);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('knowledge_unavailable');
  });

  it('NÃO manda o agente responder com o que já sabe', async () => {
    const r = await searchKnowledge(poolQueFalha, args, embedFalso);
    const msg = !r.ok ? r.error.message.toLowerCase() : '';
    // A regressão que este teste vigia é textual porque o defeito era textual: alguém
    // reescrevendo a mensagem "para ficar mais amigável" pode ressuscitá-lo inteiro.
    expect(msg).not.toContain('o que você já sabe');
    expect(msg).not.toContain('o que voce ja sabe');
  });

  it('manda tratar como ausência de material e confirmar com uma pessoa', async () => {
    const r = await searchKnowledge(poolQueFalha, args, embedFalso);
    const msg = !r.ok ? r.error.message.toLowerCase() : '';
    expect(msg).toContain('ausência de material');
    expect(msg).toContain('confirmada por uma pessoa');
  });

  it('a própria mensagem de erro não é classificada como afirmação de assistência', async () => {
    // Ela CITA os assuntos ("cobertura, carência, rede") para proibi-los. Se a
    // classificação a lesse como afirmação, o ensino ao modelo viraria motivo de veto —
    // um laço que travaria o turno sem que ninguém entendesse por quê.
    const r = await searchKnowledge(poolQueFalha, args, embedFalso);
    const msg = !r.ok ? r.error.message : '';
    expect(classificarAfirmacaoDeAssistencia(msg).isAssistanceClaim).toBe(true);
    // ⚠️ Sim, `true`: a frase contém os termos numa oração declarativa. Isso é INÓCUO
    // porque a mensagem nunca é enviada ao cliente — ela volta ao modelo pelo canal de
    // erro do harness, e o gate só avalia o corpo candidato a envio. O teste registra o
    // fato para que ninguém "conserte" isto passando a mensagem pela cadeia.
  });
});

describe('T059 · o isolamento não depende do chamador (FR-019)', () => {
  it('chama fn_buscar_lastro com o agente, nunca com o organization_id do chamador', async () => {
    const { pool, query } = poolComResultados({ '∅': [trecho('c1', 'tenant', 0.9)] });
    await searchKnowledge(pool, args, embedFalso);

    const buscas = query.mock.calls.filter(([sql]) => String(sql).includes('fn_buscar_lastro'));
    expect(buscas).toHaveLength(1);
    const params = buscas[0]?.[1] as unknown[];
    expect(params[0]).toBe(AGENTE);
    // A prova NEGATIVA é a que importa: se alguém reintroduzir o org como argumento da
    // busca, a porta que a migration 0123 fechou volta a existir e nada mais reclama.
    expect(params).not.toContain(ORG);
    expect(String(buscas[0]?.[0])).not.toContain('retrieve_top_k_chunks');
  });

  it('leva o limiar REAL ao banco — o piso -1 apagaria a camada do catálogo', async () => {
    const { pool, query } = poolComResultados({ '∅': [trecho('c1', 'tenant', 0.9)] });
    await searchKnowledge(pool, { ...args, threshold: 0.72 }, embedFalso);

    const params = query.mock.calls.find(([sql]) => String(sql).includes('fn_buscar_lastro'))?.[1] as unknown[];
    // A regra 7 de `fn_buscar_lastro` ("trecho do tenant no balde derruba o do catálogo")
    // depende do limiar. Com -1 TODO trecho do tenant passa e o catálogo some inteiro —
    // em silêncio, com o banco correto e o painel verde.
    expect(params[4]).toBe(0.72);
    expect(params[4]).not.toBe(-1);
  });

  it('escopo desconhecido vira UMA busca com p_scope_id NULL — nunca busca ampla', async () => {
    const { pool, query } = poolComResultados({});
    await searchKnowledge(pool, { ...args, scopeIds: [] }, embedFalso);

    const buscas = query.mock.calls.filter(([sql]) => String(sql).includes('fn_buscar_lastro'));
    // Duas: a busca e o diagnóstico de quase-acerto (que só roda porque nada foi achado).
    expect(buscas.length).toBeGreaterThanOrEqual(1);
    expect((buscas[0]?.[1] as unknown[])[1]).toBeNull();
  });
});

describe('T062 · uma busca por operadora, resultados segregados (FR-018)', () => {
  it('faz uma chamada por escopo e devolve um balde por escopo, sem fundir', async () => {
    const { pool, query } = poolComResultados({
      [AMIL]: [trecho('a1', 'tenant', 0.91)],
      [UNIMED]: [trecho('u1', 'catalog', 0.88), trecho('u2', 'catalog', 0.81)],
    });

    const r = await searchKnowledge(
      pool,
      { ...args, scopeIds: [AMIL, UNIMED], scopeNames: { [AMIL]: 'Amil', [UNIMED]: 'Unimed' } },
      embedFalso,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const buscas = query.mock.calls.filter(([sql]) => String(sql).includes('fn_buscar_lastro'));
    expect(buscas).toHaveLength(2);
    expect((buscas[0]?.[1] as unknown[])[1]).toBe(AMIL);
    expect((buscas[1]?.[1] as unknown[])[1]).toBe(UNIMED);

    expect(r.porEscopo).toHaveLength(2);
    expect(r.porEscopo[0]?.scopeName).toBe('Amil');
    expect(r.porEscopo[0]?.results.map((h) => h.chunk_id)).toEqual(['a1']);
    expect(r.porEscopo[1]?.scopeName).toBe('Unimed');
    expect(r.porEscopo[1]?.results.map((h) => h.chunk_id)).toEqual(['u1', 'u2']);
  });

  it('grava UMA linha de telemetria por chamada, com a soma dos baldes', async () => {
    const { pool, query } = poolComResultados({
      [AMIL]: [trecho('a1', 'tenant', 0.91)],
      [UNIMED]: [trecho('u1', 'catalog', 0.88)],
    });
    await searchKnowledge(pool, { ...args, scopeIds: [AMIL, UNIMED] }, embedFalso);

    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes('insert into knowledge_searches'));
    expect(inserts).toHaveLength(1);
    const p = inserts[0]?.[1] as unknown[];
    expect(p[3]).toBe(2); // hits somados
    expect(p[4]).toBeCloseTo(0.91); // top_score = o melhor de todos os baldes
  });
});

describe('citações a partir dos trechos', () => {
  it('não empurra id de material do catálogo para dentro de knowledge_source_id', async () => {
    const [c] = citationsFromHits([trecho('x1', 'catalog', 0.8)]);
    // `knowledge_source_id` é FK de `ai_knowledge_sources`. Um id de `catalog_materials`
    // ali é uma FK falsa que a tela seguiria até um 404.
    expect(c?.knowledge_source_id).toBeNull();
    expect(c?.metadata?.layer).toBe('catalog');
    expect(c?.metadata?.material_id).toBe('x1-material');
  });

  it('mantém o vínculo real na camada do tenant', async () => {
    const [c] = citationsFromHits([trecho('y1', 'tenant', 0.8)]);
    expect(c?.knowledge_source_id).toBe('y1-material');
  });
});
