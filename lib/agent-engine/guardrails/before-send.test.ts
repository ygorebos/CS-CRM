import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { assistanceGroundingGate, type Grounding } from './assistance-grounding';
import { BEFORE_SEND_GATES, runBeforeSend } from './before-send';
import type { Logger } from '../obs/logger';

/**
 * A PROPAGAÇÃO do veto de lastro pela cadeia REAL — spec 002, FR-009/FR-010.
 *
 * Provar o gate isolado (`assistance-grounding.test.ts`) prova a DECISÃO. Este arquivo
 * prova o CAMINHO: `enforceAssistanceGrounding` e `groundings` precisam atravessar
 * `RunBeforeSendArgs` → `GateContext` → gate → veto → trace persistido. Um campo que
 * morresse no meio deixaria a suíte inteira verde com o gate desligado em produção — que
 * é exatamente o defeito que esta feature veio corrigir noutro guardrail (`rag_must_hit`
 * salvava e ninguém avaliava).
 *
 * Pool/cliente falsos no molde de `tests/unit/gate-vazamento-interno.test.ts`: o que se
 * exercita é o runner de verdade, não um gate de mentira.
 */

const COMERCIAL = new Date('2026-07-28T13:00:00Z'); // 10h BRT, terça — dentro da janela

/** Afirmação de assistência: procedimento de operadora em oração declarativa. */
const AFIRMA = 'A carência para internação é de 180 dias no seu plano.';
/** Conversão pura: nenhum termo do léxico de assistência. */
const VENDE = 'Posso preparar duas opções de plano para você comparar?';

const ancora: Grounding = {
  chunk_id: '00000000-0000-4000-8000-0000000000c1',
  material_id: '00000000-0000-4000-8000-0000000000a1',
  layer: 'tenant',
  similarity: 0.83,
  // Âncora do assunto por construção: este arquivo exercita OUTRO eixo, e a pertinência
  // (T138) tem suíte própria em assistance-grounding.test.ts.
  categorias: ['cobranca', 'acesso', 'rede', 'cobertura', 'prazos', 'canais', 'regras'],
  aprendidoDeConversa: false,
};

function chamaCadeiaReal(args: {
  body: string;
  armado: boolean;
  groundings?: readonly Grounding[];
  minCitations?: number;
}): { run: ReturnType<typeof runBeforeSend>; inserts: ReturnType<typeof vi.fn> } {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const inserts = vi.fn().mockResolvedValue({ rows: [{ id: 'trace-1' }] });
  const pool = { connect: vi.fn().mockResolvedValue(client), query: inserts } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    inserts,
    run: runBeforeSend({
      pool,
      log,
      tenantId: '00000000-0000-4000-8000-000000000001',
      leadId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000003',
      channelSessionId: '00000000-0000-4000-8000-000000000004',
      body: args.body,
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: COMERCIAL,
      rng: () => 0,
      sleep: async () => {},
      ...(args.armado ? { enforceAssistanceGrounding: true } : {}),
      ...(args.groundings !== undefined ? { groundings: args.groundings } : {}),
      ...(args.minCitations !== undefined ? { minCitations: args.minCitations } : {}),
      send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    }),
  };
}

describe('o veto de lastro atravessa a cadeia real', () => {
  it('está na cadeia global e é o mesmo objeto exportado', () => {
    // Sem isto o gate poderia ser testado à exaustão e nunca rodar em produção.
    expect(BEFORE_SEND_GATES).toContain(assistanceGroundingGate);
  });

  it('armada e sem âncora: veta no gate certo, e o trace sobrevive ao rollback', async () => {
    const { run, inserts } = chamaCadeiaReal({ body: AFIRMA, armado: true, groundings: [] });
    const r = await run;
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') throw new Error('inalcançável');
    expect(r.gate).toBe('assistance_grounding');
    expect(r.code).toBe('assistencia_sem_lastro');
    expect(r.trace).toContainEqual(
      expect.objectContaining({
        gate: 'assistance_grounding',
        verdict: 'veto',
        code: 'assistencia_sem_lastro',
        // `objectContaining` no detail de propósito: ele ganhou o diagnóstico de
        // pertinência (T138) e vai ganhar mais. O que ESTE teste vigia é o veto no gate
        // certo com zero âncoras — não o formato inteiro do detail, que tem suíte própria.
        detail: expect.objectContaining({ ancoras: 0, piso: 1 }),
      }),
    );
    const sql = String(inserts.mock.calls[0]?.[0] ?? '');
    expect(sql).toMatch(/insert into before_send_traces/);
  });

  it('armada e COM âncora: o mesmo corpo é enviado', async () => {
    const r = await chamaCadeiaReal({ body: AFIRMA, armado: true, groundings: [ancora] }).run;
    expect(r.status).toBe('sent');
    expect(r.trace).toContainEqual({ gate: 'assistance_grounding', verdict: 'pass' });
  });

  it('DESARMADA: o MESMO corpo sem âncora sai, e o trace diz que ninguém armou', async () => {
    // A guarda de vacuidade do par acima. E o `skipped: disarmed` é o que separa
    // "avaliou e liberou" de "ninguém ligou" — a medição sobre a qual o léxico da
    // classificação vai ser calibrado depois.
    const r = await chamaCadeiaReal({ body: AFIRMA, armado: false, groundings: [] }).run;
    expect(r.status).toBe('sent');
    expect(r.trace).toContainEqual({
      gate: 'assistance_grounding',
      verdict: 'skipped',
      code: 'disarmed',
    });
  });

  it('armada, discurso de conversão sem âncora nenhuma: sai normalmente (FR-020)', async () => {
    // O tenant sem acervo continua vendendo. Se este teste ficar vermelho, a feature
    // desligou a outra metade do princípio IX.
    const r = await chamaCadeiaReal({ body: VENDE, armado: true, groundings: [] }).run;
    expect(r.status).toBe('sent');
    expect(r.trace).toContainEqual({ gate: 'assistance_grounding', verdict: 'pass' });
  });

  it('o veto acontece ANTES do anti-ban — não gasta cota com texto que já ia ser barrado', async () => {
    const { run } = chamaCadeiaReal({ body: AFIRMA, armado: true, groundings: [] });
    const r = await run;
    if (r.status !== 'vetoed') throw new Error('inalcançável');
    const nomes = r.trace.map((t) => t.gate);
    const iGate = nomes.indexOf('assistance_grounding');
    // pacing entra no trace como 'skipped' (curto-circuito) — o que prova que não rodou.
    expect(r.trace[nomes.indexOf('pacing')]).toEqual({ gate: 'pacing', verdict: 'skipped' });
    expect(iGate).toBeLessThan(nomes.indexOf('pacing'));
  });

  it('min_citations chega ao gate pela cadeia, não só pela chamada direta', async () => {
    const r = await chamaCadeiaReal({
      body: AFIRMA,
      armado: true,
      groundings: [ancora],
      minCitations: 2,
    }).run;
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') throw new Error('inalcançável');
    expect(r.trace).toContainEqual(
      expect.objectContaining({
        gate: 'assistance_grounding',
        verdict: 'veto',
        code: 'assistencia_sem_lastro',
        // O que este teste vigia é o piso chegar pela cadeia — a âncora É pertinente aqui.
        detail: expect.objectContaining({ ancoras: 1, pertinentes: 1, piso: 2 }),
      }),
    );
  });
});
