import { describe, expect, it } from 'vitest';

import {
  assistanceGroundingGate,
  classificarAfirmacaoDeAssistencia,
  ehAprendizadoDeConversa,
  type Grounding,
} from './assistance-grounding';
import type { CategoriaAssistencia } from './lexico-assistencia';
import type { GateContext } from './before-send';
import { DEFAULT_CHANNEL_PROVIDER } from '@/lib/channels/capabilities';

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
    provider: DEFAULT_CHANNEL_PROVIDER,
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

const ancora = (
  id: string,
  categorias: readonly CategoriaAssistencia[] = ['prazos'],
  similarity = 0.8,
  // FR-040: default `false` porque a esmagadora maioria dos casos é material carregado
  // pelo corretor. O caso do aprendizado automático é explícito, e tem describe próprio.
  aprendidoDeConversa = false,
): Grounding => ({
  chunk_id: id,
  material_id: 'mat-1',
  layer: 'tenant',
  similarity,
  categorias,
  aprendidoDeConversa,
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

/**
 * Pertinência da âncora (T138) — **similaridade não é aboutness**.
 *
 * O que estes casos vigiam: até aqui o gate perguntava "existe âncora acima do limiar?",
 * nunca "a âncora é sobre este assunto?". Medido em 2026-08-08 com embeddings reais contra
 * o catálogo semeado, no limiar que o produto usa (`rag_similarity_threshold = 0.40`):
 *
 *   - "como funciona o reembolso"  → ancorou em "Como consultar a rede credenciada", 0.460
 *   - duas perguntas quaisquer     → ancoraram em "O que é carência", 0.377 e 0.407
 *
 * Um texto de rede credenciada autorizava uma afirmação sobre reembolso, e a resposta saía
 * **com citação** — parecendo mais confiável, não menos. É o pior desfecho possível de uma
 * feature que existe para o agente parar de inventar.
 *
 * Por que não se conserta no limiar: a âncora CORRETA mais fraca medida foi 0.495, colada
 * na ERRADA mais forte (0.460). Não há corte que separe as duas, e calibrar em cinco
 * amostras é ajustar ao ruído. A régua tem de ser outra — o assunto, não a distância.
 */
describe('pertinência da âncora — similaridade não é aboutness (T138)', () => {
  const REEMBOLSO = 'O reembolso é pago em até 30 dias.';

  it('o caso medido: afirmação de reembolso ancorada em rede credenciada é VETO', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: REEMBOLSO,
        groundings: [ancora('c1', ['rede'], 0.46)],
      }),
    );
    expect(v.pass).toBe(false);
    expect(!v.pass && v.code).toBe('assistencia_sem_lastro');
  });

  it('a mesma afirmação, ancorada no assunto certo, passa', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: REEMBOLSO,
        groundings: [ancora('c1', ['cobranca'], 0.46)],
      }),
    );
    expect(v.pass).toBe(true);
  });

  it('similaridade altíssima NÃO compra pertinência — 0.99 no assunto errado ainda é veto', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: REEMBOLSO,
        groundings: [ancora('c1', ['rede'], 0.99)],
      }),
    );
    expect(v.pass).toBe(false);
  });

  it('o piso de min_citations conta só as âncoras PERTINENTES', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: REEMBOLSO,
        minCitations: 2,
        groundings: [ancora('c1', ['cobranca']), ancora('c2', ['rede'])],
      }),
    );
    expect(v.pass).toBe(false);
  });

  it('frase a frase: a que tem âncora não salva a que não tem', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'O reembolso é pago em até 30 dias. A rede credenciada tem 40 hospitais.',
        groundings: [ancora('c1', ['cobranca'])],
      }),
    );
    expect(v.pass).toBe(false);
  });

  it('as duas frases ancoradas nos seus assuntos passam', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'O reembolso é pago em até 30 dias. A rede credenciada tem 40 hospitais.',
        groundings: [ancora('c1', ['cobranca']), ancora('c2', ['rede'])],
      }),
    );
    expect(v.pass).toBe(true);
  });

  it('o detail diz que a recusa foi por pertinência, não por ausência — são diagnósticos opostos', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: REEMBOLSO,
        groundings: [ancora('c1', ['rede'])],
      }),
    );
    expect(v.pass).toBe(false);
    const detail = !v.pass ? ((v.detail ?? {}) as Record<string, unknown>) : {};
    expect(detail.ancoras).toBe(1);
    expect(detail.pertinentes).toBe(0);
  });

  it('categoria fechada entra no detail; o corpo e os termos casados NUNCA', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'O reembolso do senhor José é pago em 30 dias.',
        groundings: [ancora('c1', ['rede'])],
      }),
    );
    const detail = JSON.stringify(!v.pass ? (v.detail ?? {}) : {});
    expect(detail).toContain('cobranca');
    expect(detail).not.toContain('José');
    expect(detail).not.toContain('reembolso');
  });

  it('classificação forçada pelo chamador sem assunto detectável: pertinência não é avaliada, e o gate volta a contar', () => {
    // Guarda de compatibilidade. `isAssistanceClaim: true` com corpo sem termo do léxico
    // não dá categoria nenhuma para comparar — inventar uma seria pior que declarar que
    // não avaliou. O trace diz isso, para o léxico ser calibrado sobre medição (T030).
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        assistanceGroundingEnforced: true,
        body: 'oi',
        isAssistanceClaim: true,
        groundings: [ancora('c1', ['rede'])],
      }),
    );
    expect(v.pass).toBe(true);
  });
});

/**
 * FR-040 · T123 — o que foi aprendido de conversa não sustenta afirmação de assistência.
 *
 * ## Por que a regra existe
 *
 * O acervo indexa conversas passadas, e isso é bom para tom, jeito de responder e as
 * dúvidas que os clientes realmente têm. É veneno como fonte de FATO: o que um atendente
 * humano disse sobre carência há oito meses vira "material", e o agente o repete com a
 * mesma cara de certeza que teria o manual da operadora. Um erro humano pontual vira regra
 * institucional — com citação para provar.
 *
 * ## Por que isto é teste unitário e não invariante de banco
 *
 * A tarefa pedia `tests/invariants/aprendizado-nao-ancora-assistencia.test.ts`. A regra
 * não vive no banco: `fn_buscar_lastro` devolve o trecho normalmente (e deve — ele ajuda o
 * modelo a escrever), e quem recusa é o gate, em TypeScript. Um invariante de Postgres
 * mediria a busca, que não é onde a decisão está — passaria verde com o gate quebrado.
 */
describe('FR-040 — aprendizado de conversa não ancora assistência', () => {
  const corpo = 'A carência para parto é de 180 dias, conforme o seu contrato.';

  it('âncora aprendida de conversa NÃO libera a afirmação', () => {
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        body: corpo,
        assistanceGroundingEnforced: true,
        groundings: [ancora('c1', ['prazos'], 0.9, true)],
      }),
    );
    expect(v.pass).toBe(false);
    expect(!v.pass && v.code).toBe('assistencia_sem_lastro');
  });

  it('a recusa DIZ que havia âncora descartada por origem', () => {
    // Sem este número, uma recusa com citações na tela pareceria defeito do gate — e o
    // próximo a investigar concluiria que o veto está quebrado.
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        body: corpo,
        assistanceGroundingEnforced: true,
        groundings: [ancora('c1', ['prazos'], 0.9, true)],
      }),
    );
    expect(!v.pass && v.detail?.descartadas_por_origem).toBe(1);
  });

  it('a aprendida não ENGROSSA o número que libera a afirmação', () => {
    // O defeito que este caso pega: filtrar só na hora de escolher a âncora, mas contar
    // todas para bater o piso. Com piso 2, uma boa + uma aprendida passaria — e metade da
    // prova seria conversa antiga.
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        body: corpo,
        assistanceGroundingEnforced: true,
        minCitations: 2,
        groundings: [ancora('c1', ['prazos'], 0.9, false), ancora('c2', ['prazos'], 0.9, true)],
      }),
    );
    expect(v.pass).toBe(false);
  });

  it('material de verdade ao lado da aprendida continua liberando', () => {
    // A regra corta a origem errada, não o assunto: quem tem material próprio sobre o
    // assunto responde normalmente, mesmo com uma conversa antiga no mesmo balde.
    const v = assistanceGroundingGate.evaluate(
      ctxBase({
        body: corpo,
        assistanceGroundingEnforced: true,
        groundings: [ancora('c1', ['prazos'], 0.9, false), ancora('c2', ['prazos'], 0.9, true)],
      }),
    );
    expect(v.pass).toBe(true);
  });

  it('ehAprendizadoDeConversa reconhece as DUAS grafias que o banco aceita', () => {
    // O CHECK de `ai_knowledge_sources.source_type` aceita 'conversations' e 'conversation'.
    // Uma lista escrita à mão que esquecesse a segunda deixaria passar exatamente o que o
    // requisito proíbe — e ninguém veria, porque a grafia rara é a mais antiga.
    expect(ehAprendizadoDeConversa({ source_type: 'conversations' })).toBe(true);
    expect(ehAprendizadoDeConversa({ source_type: 'conversation' })).toBe(true);
    expect(ehAprendizadoDeConversa({ source_type: 'policy' })).toBe(false);
    expect(ehAprendizadoDeConversa(undefined)).toBe(false);
  });
});
