import { describe, expect, it } from "vitest";

import {
  assistanceGroundingGate,
  resolverExigenciaDeLastro,
} from "@/lib/agent-engine/guardrails/assistance-grounding";
import type { GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { guardrailsSchema } from "@/lib/ai/guardrails-schema";
import { DEFAULT_CHANNEL_PROVIDER } from "@/lib/channels/capabilities";

/**
 * Teste de **efeito** do guardrail `rag_must_hit` — spec 002, FR-015 e SC-012.
 *
 * ═══ Por que este arquivo existe separado ═══
 *
 * O defeito que ele fecha não era "o valor não salva". O valor salvava: a tela edita, o
 * Zod valida, o banco grava. O defeito era que **nenhum runtime lia**. Um teste de
 * gravação (escreve, lê de volta, compara) passaria com folga sobre esse defeito e daria
 * ao self-hoster a impressão de que a trava está de pé.
 *
 * É o caso que o Princípio XI nomeia: *"configuração exposta na tela tem teste de EFEITO,
 * não só de gravação"*. O que se prova aqui é que **ligar a opção muda o comportamento**.
 *
 * O par de casos abaixo é o teste inteiro: mesmo texto, mesma ausência de âncora, e o
 * único delta é o guardrail. Se os dois derem o mesmo resultado, a opção voltou a mentir.
 */

const ctx = (over: Partial<GateContext>): GateContext =>
  ({
    now: new Date("2026-08-08T12:00:00Z"),
    body: "A carência para internação é de 180 dias.",
    optedOut: false,
    provider: DEFAULT_CHANNEL_PROVIDER,
    pacing: { knobs: {}, state: {}, crmDailyLimit: null },
    spinning: { knobs: {}, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    groundings: [],
    ...over,
  }) as unknown as GateContext;

/** O que a tela grava quando o corretor marca "Exigir citação da base". */
const GUARDRAIL_LIGADO = guardrailsSchema.parse([
  { kind: "rag_must_hit", min_citations: 1, reason: "não responder sem material" },
]);

describe("rag_must_hit tem efeito observável, não só persistência", () => {
  it("DESLIGADO: a mesma resposta sem lastro é enviada", () => {
    const { enforce, minCitations } = resolverExigenciaDeLastro([]);
    expect(enforce).toBe(false);
    const v = assistanceGroundingGate.evaluate(
      ctx({ assistanceGroundingEnforced: enforce, minCitations }),
    );
    expect(v.pass).toBe(true);
  });

  it("LIGADO: a mesma resposta sem lastro é barrada — este par é a prova", () => {
    const { enforce, minCitations } = resolverExigenciaDeLastro(GUARDRAIL_LIGADO);
    expect(enforce).toBe(true);
    const v = assistanceGroundingGate.evaluate(
      ctx({ assistanceGroundingEnforced: enforce, minCitations }),
    );
    expect(v.pass).toBe(false);
    expect(!v.pass && v.code).toBe("assistencia_sem_lastro");
  });

  it("min_citations do guardrail chega ao gate — 3 exigidas, 2 âncoras não bastam", () => {
    const guardrails = guardrailsSchema.parse([
      { kind: "rag_must_hit", min_citations: 3, reason: "assunto sensível" },
    ]);
    const { enforce, minCitations } = resolverExigenciaDeLastro(guardrails);
    expect(minCitations).toBe(3);
    const comAncoras = (n: number) =>
      assistanceGroundingGate.evaluate(
        ctx({
          assistanceGroundingEnforced: enforce,
          minCitations,
          groundings: Array.from({ length: n }, (_, i) => ({
            chunk_id: `c${i}`,
            material_id: "m",
            layer: "tenant" as const,
            similarity: 0.9,
            // Do assunto por construção — pertinência (T138) tem suíte própria.
            categorias: ["cobranca", "acesso", "rede", "cobertura", "prazos", "canais", "regras"] as const,
          })),
        }),
      );
    expect(comAncoras(2).pass).toBe(false);
    expect(comAncoras(3).pass).toBe(true);
  });

  it("guardrails torto no jsonb não arma o gate nem derruba o envio", () => {
    // A coluna é jsonb e o produto é self-host: banco de clone antigo pode ter qualquer
    // coisa ali. O modo de falha certo é "não arma", nunca exceção no caminho de envio.
    for (const torto of [null, undefined, "rag_must_hit", 42, {}, [null], [{ kind: 7 }]]) {
      expect(resolverExigenciaDeLastro(torto).enforce, JSON.stringify(torto)).toBe(false);
    }
  });

  it("dois rag_must_hit no array: vence o mais exigente, não o último", () => {
    // Deixar a ordem do array decidir a exigência poria uma regra de segurança na mão de
    // quem editou por último o jsonb.
    const { minCitations } = resolverExigenciaDeLastro([
      { kind: "rag_must_hit", min_citations: 3 },
      { kind: "rag_must_hit", min_citations: 1 },
    ]);
    expect(minCitations).toBe(3);
  });
});
