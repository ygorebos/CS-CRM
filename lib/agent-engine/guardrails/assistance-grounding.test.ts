import { describe, expect, it } from 'vitest';

import {
  assistanceGroundingGate,
  classificarAfirmacaoDeAssistencia,
  type Grounding,
} from './assistance-grounding';
import type { GateContext } from './before-send';

/**
 * A classificação determinística de "afirmação de assistência" (spec 002, FR-009/FR-010).
 *
 * O que este arquivo vigia, e por quê: FR-010 diz que instrução de prompt **não** satisfaz
 * o requisito. Se um dia alguém trocar esta função por uma chamada de modelo, os casos
 * abaixo continuam sendo a definição do que o produto promete — e nenhum deles depende de
 * rede, de chave de IA ou de sorte de amostragem.
 */

const ctxBase = (over: Partial<GateContext>): GateContext =>
  ({
    now: new Date('2026-08-08T12:00:00Z'),
    body: '',
    optedOut: false,
    provider: 'waha',
    pacing: { knobs: {}, state: {}, crmDailyLimit: null },
    spinning: { knobs: {}, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: 'inject' },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...over,
  }) as unknown as GateContext;

const ancora = (id: string): Grounding => ({
  chunk_id: id,
  material_id: 'mat-1',
  layer: 'tenant',
  similarity: 0.8,
});

describe('classificação de afirmação de assistência', () => {
  it('procedimento de segunda via é afirmação — é o caso que abre a spec', () => {
    const r = classificarAfirmacaoDeAssistencia(
      'Para tirar a segunda via do boleto, acesse o portal do beneficiário e clique em Financeiro.',
    );
    expect(r.isAssistanceClaim).toBe(true);
    expect(r.categorias).toContain('cobranca');
  });

  it('carência e cobertura entram — são as afirmações que mais custam quando erradas', () => {
    expect(classificarAfirmacaoDeAssistencia('A carência para parto é de 300 dias.').isAssistanceClaim).toBe(true);
    expect(
      classificarAfirmacaoDeAssistencia('Esse exame está coberto pelo plano, pode agendar.').isAssistanceClaim,
    ).toBe(true);
  });

  it('discurso de conversão passa inteiro — FR-020', () => {
    // Sem esta linha a feature quebraria a missão de vender, que é a outra metade do
    // princípio IX e a única que funciona em tenant sem acervo nenhum.
    for (const texto of [
      'Oi! Tudo bem? Sou o assistente virtual do Corretor João.',
      'Posso te mandar uma simulação para quantas vidas?',
      'Você prefere atendimento em Fortaleza ou em Sobral?',
      'Perfeito, vou preparar duas opções e te mando ainda hoje.',
    ]) {
      expect(classificarAfirmacaoDeAssistencia(texto).isAssistanceClaim, texto).toBe(false);
    }
  });

  it('pergunta sobre o assunto NÃO é afirmação — senão o agente não descobre a operadora', () => {
    const r = classificarAfirmacaoDeAssistencia('Você já tentou emitir a segunda via pelo aplicativo do plano?');
    expect(r.isAssistanceClaim).toBe(false);
    expect(r.motivo).toBe('somente_pergunta');
  });

  it('pergunta MAIS afirmação é afirmação — o viés de A-03 desempata para o lado caro de desfazer', () => {
    const r = classificarAfirmacaoDeAssistencia(
      'A carência já venceu no seu caso. Quer que eu confirme a rede credenciada também?',
    );
    expect(r.isAssistanceClaim).toBe(true);
  });

  it('frase sem pontuação final conta como afirmação — é como se escreve procedimento no WhatsApp', () => {
    const r = classificarAfirmacaoDeAssistencia('o reembolso sai em até 30 dias');
    expect(r.isAssistanceClaim).toBe(true);
  });

  it('acento e caixa não mudam o veredito', () => {
    expect(classificarAfirmacaoDeAssistencia('A CARÊNCIA é de 180 dias').isAssistanceClaim).toBe(true);
    expect(classificarAfirmacaoDeAssistencia('a carencia e de 180 dias').isAssistanceClaim).toBe(true);
  });

  it('termo dentro de outra palavra não casa — fronteira de palavra é o que evita falso positivo bobo', () => {
    // "guia" em "seguia", "rede" em "aprendendo": sem fronteira, o gate recusaria
    // conversa comum e o corretor desligaria o guarda inteiro por irritação.
    expect(classificarAfirmacaoDeAssistencia('ele seguia o roteiro combinado').isAssistanceClaim).toBe(false);
  });
});

describe('gate assistance_grounding', () => {
  it('desarmado não avalia nada, e o trace registra que ninguém armou', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({ body: 'A carência é de 180 dias.', groundings: [] }),
    );
    expect(v.pass).toBe(true);
    expect(v.pass && v.skipped).toBe('disarmed');
  });

  it('armado, afirmação de assistência sem âncora é VETO', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({ assistanceGroundingEnforced: true, body: 'A carência é de 180 dias.', groundings: [] }),
    );
    expect(v.pass).toBe(false);
    expect(!v.pass && v.code).toBe('assistencia_sem_lastro');
  });

  it('armado, afirmação COM âncora passa', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'A carência é de 180 dias.',
        groundings: [ancora('c1')],
      }),
    );
    expect(v.pass).toBe(true);
  });

  it('armado, texto que não é assistência passa mesmo sem âncora nenhuma', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({ assistanceGroundingEnforced: true, body: 'Oi! Posso te ajudar com uma cotação?', groundings: [] }),
    );
    expect(v.pass).toBe(true);
  });

  it('min_citations do guardrail vira piso de verdade — 2 âncoras exigidas, 1 não basta', () => {
    const ctx = (n: number): GateContext =>
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'A carência é de 180 dias.',
        minCitations: 2,
        groundings: Array.from({ length: n }, (_, i) => ancora(`c${i}`)),
      });
    expect(assistanceGroundingGate.evaluate(ctx(1)).pass).toBe(false);
    expect(assistanceGroundingGate.evaluate(ctx(2)).pass).toBe(true);
  });

  it('min_citations abaixo de 1 não desliga o gate — o piso do requisito não é configurável para baixo', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'A carência é de 180 dias.',
        minCitations: 0,
        groundings: [],
      }),
    );
    expect(v.pass).toBe(false);
  });

  it('a classificação vinda do turno é respeitada — mas é a MESMA função, não uma segunda regra', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({ assistanceGroundingEnforced: true, body: 'oi', isAssistanceClaim: true, groundings: [] }),
    );
    expect(v.pass).toBe(false);
  });

  it('o veto não leva o corpo no detail — ele é persistido, e o corpo é texto sobre um cliente', () => {
    const corpo = 'A carência do seu plano é de 180 dias, senhor José da Silva.';
    const v = assistanceGroundingGate.evaluate(
      ctxBase({ assistanceGroundingEnforced: true, body: corpo, groundings: [] }),
    );
    expect(v.pass).toBe(false);
    const detail = JSON.stringify(!v.pass ? (v.detail ?? {}) : {});
    expect(detail).not.toContain('José');
    expect(detail).not.toContain('carência');
  });
});
