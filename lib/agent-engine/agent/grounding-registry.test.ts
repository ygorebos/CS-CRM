import { describe, expect, it, vi } from 'vitest';

import { linhasDeGrounding, registrarGroundings } from './grounding-registry';
import type { Citation } from '@/lib/ai/citations/types';

/**
 * A âncora como registro permanente (spec 002 · FR-021, FR-023, T105).
 *
 * ## O que estes casos vigiam
 *
 * A âncora já viajava em `messages.metadata`, e isso basta para a TELA. O que não bastava:
 * provar. `jsonb` não tem `not null` por chave, não indexa por camada, e não responde "que
 * material ancorou respostas este mês" sem varrer mensagem.
 *
 * Os dois defeitos que estes casos pegam são de robustez, e os dois passariam verdes numa
 * implementação que "funciona no caminho feliz": uma citação malformada derrubar o insert
 * inteiro (levando junto as âncoras boas da MESMA resposta), e a falha de gravação subir
 * como exceção — o que, no ponto onde isto roda, viraria erro de turno numa resposta que
 * o cliente já leu.
 */

const cit = (over: Partial<Citation> = {}): Citation => ({
  chunk_id: 'chunk-1',
  score: 0.72,
  snippet: 'A segunda via sai pelo aplicativo.',
  metadata: { layer: 'tenant', material_id: 'src-1', title: 'Boletos 2026', scope: 'Operadora A' },
  ...over,
});

describe('linhasDeGrounding · o que vira registro', () => {
  it('leva a cópia histórica inteira, não só os ids', () => {
    // É esta cópia que responde depois da reindexação, quando `chunk_id` já não existe
    // (FR-023). Guardar só o id seria guardar um ponteiro para o vazio.
    const [l] = linhasDeGrounding([cit()]);
    expect(l).toEqual({
      chunkId: 'chunk-1',
      layer: 'tenant',
      materialId: 'src-1',
      similarity: 0.72,
      sourceRef: { layer: 'tenant', material_id: 'src-1', title: 'Boletos 2026', scope: 'Operadora A' },
    });
  });

  it('citação com camada desconhecida é descartada SEM levar as boas junto', () => {
    // `layer` tem CHECK no banco. Uma linha com camada inventada faz o insert inteiro
    // falhar — e a resposta perderia TODAS as âncoras por causa de uma malformada.
    const linhas = linhasDeGrounding([
      cit({ metadata: { layer: 'inventada' } }),
      cit({ chunk_id: 'chunk-2' }),
    ]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.chunkId).toBe('chunk-2');
  });

  it('citação sem metadata nenhum não vira linha', () => {
    expect(linhasDeGrounding([{ chunk_id: 'c' }])).toEqual([]);
  });

  it('material do catálogo é registrado como catálogo', () => {
    const [l] = linhasDeGrounding([cit({ metadata: { layer: 'catalog', material_id: 'cat-9' } })]);
    expect(l?.layer).toBe('catalog');
    expect(l?.materialId).toBe('cat-9');
  });

  it('score ausente vira nulo, não zero', () => {
    // Zero afirmaria "similaridade nenhuma", que é diferente de "não medida" — e é o
    // tipo de mentira que envenena média de painel.
    const [l] = linhasDeGrounding([cit({ score: undefined })]);
    expect(l?.similarity).toBeNull();
  });
});

describe('registrarGroundings · nunca derruba o turno', () => {
  const pool = (query: ReturnType<typeof vi.fn>) => ({ query }) as never;

  it('falha de escrita vira aviso, não exceção', async () => {
    // Roda DEPOIS do envio: a resposta já saiu e o cliente já leu. Deixar a exceção subir
    // transformaria um registro de diagnóstico em erro de turno.
    const query = vi.fn().mockRejectedValue(new Error('relation does not exist'));
    const warn = vi.fn();
    await expect(
      registrarGroundings(
        pool(query),
        { organizationId: 'org-1', messageId: 'msg-1', citations: [cit()] },
        { warn } as never,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('resposta sem citação não vai ao banco', async () => {
    const query = vi.fn();
    await registrarGroundings(pool(query), { organizationId: 'o', messageId: 'm', citations: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('resposta só com citação malformada também não vai ao banco', async () => {
    const query = vi.fn();
    await registrarGroundings(pool(query), {
      organizationId: 'o',
      messageId: 'm',
      citations: [{ chunk_id: 'c' }],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('o insert não duplica em reprocessamento', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await registrarGroundings(pool(query), {
      organizationId: 'org-1',
      messageId: 'msg-1',
      citations: [cit()],
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('on conflict');
    expect(sql).toContain('do nothing');
  });
});
