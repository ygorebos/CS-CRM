import { describe, expect, it, vi } from 'vitest';

import { searchKnowledge } from './search-knowledge';
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
 */

const poolQueFalha = {
  query: vi.fn().mockRejectedValue(new Error('connection refused')),
} as unknown as Parameters<typeof searchKnowledge>[0];

const args = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  kbVersionId: '00000000-0000-4000-8000-000000000002',
  query: 'como tiro a segunda via do boleto?',
  topK: 5,
  threshold: 0.4,
};

describe('busca de conhecimento indisponível', () => {
  it('devolve erro em vez de exceção — a convenção do harness é ensino ao modelo', async () => {
    const r = await searchKnowledge(poolQueFalha, args, { embed: async () => ({ embedding: [0.1] }) as never });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('knowledge_unavailable');
  });

  it('NÃO manda o agente responder com o que já sabe', async () => {
    const r = await searchKnowledge(poolQueFalha, args, { embed: async () => ({ embedding: [0.1] }) as never });
    const msg = !r.ok ? r.error.message.toLowerCase() : '';
    // A regressão que este teste vigia é textual porque o defeito era textual: alguém
    // reescrevendo a mensagem "para ficar mais amigável" pode ressuscitá-lo inteiro.
    expect(msg).not.toContain('o que você já sabe');
    expect(msg).not.toContain('o que voce ja sabe');
  });

  it('manda tratar como ausência de material e confirmar com uma pessoa', async () => {
    const r = await searchKnowledge(poolQueFalha, args, { embed: async () => ({ embedding: [0.1] }) as never });
    const msg = !r.ok ? r.error.message.toLowerCase() : '';
    expect(msg).toContain('ausência de material');
    expect(msg).toContain('confirmada por uma pessoa');
  });

  it('a própria mensagem de erro não é classificada como afirmação de assistência', async () => {
    // Ela CITA os assuntos ("cobertura, carência, rede") para proibi-los. Se a
    // classificação a lesse como afirmação, o ensino ao modelo viraria motivo de veto —
    // um laço que travaria o turno sem que ninguém entendesse por quê.
    const r = await searchKnowledge(poolQueFalha, args, { embed: async () => ({ embedding: [0.1] }) as never });
    const msg = !r.ok ? r.error.message : '';
    expect(classificarAfirmacaoDeAssistencia(msg).isAssistanceClaim).toBe(true);
    // ⚠️ Sim, `true`: a frase contém os termos numa oração declarativa. Isso é INÓCUO
    // porque a mensagem nunca é enviada ao cliente — ela volta ao modelo pelo canal de
    // erro do harness, e o gate só avalia o corpo candidato a envio. O teste registra o
    // fato para que ninguém "conserte" isto passando a mensagem pela cadeia.
  });
});
