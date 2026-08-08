import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolverExigenciaDeLastro } from "@/lib/agent-engine/guardrails/assistance-grounding";
import { GUARDRAILS_DO_AGENTE_PADRAO } from "@/lib/ai/agents/guardrails-padrao";
import { guardrailsSchema } from "@/lib/ai/guardrails-schema";

/**
 * A instalação fresca **recusa** assistência sem material — spec 002, FR-030, SC-001,
 * SC-011 e SC-017.
 *
 * ═══ O defeito que este arquivo impede ═══
 *
 * O gate `assistance_grounding` nasce desarmado (`GateContext.assistanceGroundingEnforced`
 * ausente = no-op), e quem o arma é o caminho do agente — mas só quando o guardrail
 * `rag_must_hit` está ligado na configuração. `createDefaultAgent.ts` não gravava
 * guardrail nenhum.
 *
 * Somando as duas coisas: a instalação nova teria o guarda instalado e desligado. O agente
 * afirmaria procedimento de operadora sem material nenhum, FR-030 seria falso, SC-001
 * ("100% das mensagens de assistência ancoradas") seria inatingível — e nada disso apareceria,
 * porque cada peça, isolada, está correta. Foi achado na análise cruzada dos artefatos, não
 * por teste nenhum.
 *
 * Este arquivo é a costura: prova que o valor de fábrica é válido, que ele ARMA o gate, e
 * que ele continua sendo escrito nos dois caminhos de gravação da action.
 */

const ACTION = path.join(process.cwd(), "app/actions/onboarding/createDefaultAgent.ts");

describe("o agente padrão da instalação nasce recusando sem lastro", () => {
  it("o valor de fábrica é um guardrail válido — o Zod da tela o aceitaria", () => {
    expect(() => guardrailsSchema.parse(GUARDRAILS_DO_AGENTE_PADRAO)).not.toThrow();
  });

  it("e ele ARMA o gate — que é a única coisa que importa", () => {
    // Um guardrail sintaticamente válido que não armasse nada seria o mesmo defeito com
    // outra roupa: configuração que existe, valida, salva e não faz.
    const { enforce, minCitations } = resolverExigenciaDeLastro(GUARDRAILS_DO_AGENTE_PADRAO);
    expect(enforce).toBe(true);
    expect(minCitations).toBeGreaterThanOrEqual(1);
  });

  it("a action grava o valor nos DOIS caminhos — criar e reaproveitar", () => {
    // A action tem dois caminhos de escrita: `insert` (org nova) e `update` (repetir o
    // passo do onboarding, que precisa ser inofensivo). Gravar num só deixaria metade das
    // instalações sem o guarda, e a metade errada — quem repetiu o passo é quem teve
    // problema antes.
    const fonte = fs.readFileSync(ACTION, "utf8");
    const ocorrencias = fonte.split("GUARDRAILS_DO_AGENTE_PADRAO").length - 1;
    // 1 import + 2 escritas
    expect(ocorrencias, "esperado: import + insert + update").toBe(3);
  });

  it("desligar continua sendo possível — o padrão é opinião, não prisão", () => {
    // Um produto que não deixa desligar a própria trava vira o que o corretor contorna
    // por fora, e aí ele perde a trava inteira em vez de uma parte dela.
    expect(resolverExigenciaDeLastro([]).enforce).toBe(false);
  });
});
