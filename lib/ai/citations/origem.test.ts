import { describe, expect, it } from "vitest";

import { descreverOrigem, deveMostrarOrigem, type Citation } from "./types";

/**
 * A origem da resposta, sem modo de depuração (spec 002 · FR-022, FR-039, SC-008).
 *
 * ## O que estes casos vigiam
 *
 * A citação existia, mas atrás de `useDebugToggle` — um interruptor que o corretor precisa
 * descobrir. FR-022 diz o contrário com todas as letras: ele chega ao trecho **sem ativar
 * nenhum modo de depuração**. Rastreabilidade que depende de achar um interruptor é a mesma
 * classe de defeito do `rag_must_hit` que ninguém avaliava — está na tela e não vale.
 *
 * E FR-039 exige mais que mostrar o trecho: exige dizer **de qual camada** ele veio. Não é
 * enfeite. Se a informação está errada e veio do material do próprio corretor, quem corrige
 * é ele; se veio do catálogo, é quem o cura. Sem essa marca ele não sabe a quem cobrar, e
 * descobre pelo cliente irritado.
 */

const comCitacao = (metadata: Record<string, unknown>): Citation => ({
  chunk_id: "c1",
  snippet: "Para a segunda via, acesse o app e toque em Financeiro.",
  metadata,
});

describe("descreverOrigem · FR-039, a camada tem dono", () => {
  it("material do corretor é rotulado em português, não como 'tenant'", () => {
    const o = descreverOrigem(
      comCitacao({ layer: "tenant", title: "Boletos 2026", scope: "Operadora A", updated_at: "2026-08-01" }),
    );
    expect(o.camada).toBe("tenant");
    expect(o.camadaRotulo).toBe("Material seu");
    expect(o.titulo).toBe("Boletos 2026");
    expect(o.escopo).toBe("Operadora A");
    expect(o.atualizadoEm).toBe("2026-08-01");
  });

  it("material do catálogo se identifica como conteúdo que veio com o produto", () => {
    const o = descreverOrigem(comCitacao({ layer: "catalog", title: "Segunda via", scope: "Operadora B" }));
    expect(o.camada).toBe("catalog");
    expect(o.camadaRotulo).toBe("Veio com o produto");
  });

  it("camada desconhecida não inventa rótulo — melhor vazio que errado", () => {
    // Citação antiga, gravada antes de a camada existir. Chutar "Material seu" mandaria o
    // corretor corrigir um material que talvez não seja dele.
    const o = descreverOrigem(comCitacao({ title: "Antiga" }));
    expect(o.camada).toBeNull();
    expect(o.camadaRotulo).toBeNull();
    expect(o.titulo).toBe("Antiga");
  });

  it("string vazia é ausência, não conteúdo", () => {
    const o = descreverOrigem(comCitacao({ layer: "tenant", title: "   ", scope: "" }));
    expect(o.titulo).toBeNull();
    expect(o.escopo).toBeNull();
  });

  it("citação sem metadata nenhum não explode", () => {
    expect(descreverOrigem({ chunk_id: "c1" }).camada).toBeNull();
  });
});

describe("deveMostrarOrigem · FR-022, sem modo de depuração", () => {
  const metaComCitacao = {
    ai_generated: true,
    citations: [{ chunk_id: "c1", metadata: { layer: "tenant" } }],
  };

  it("resposta da IA com citação mostra a origem — sem depender de interruptor nenhum", () => {
    // A assinatura não recebe `debugCitations`, e isso é o teste: não há como um modo de
    // depuração influenciar esta decisão, porque ele não entra aqui.
    expect(deveMostrarOrigem({ isOutbound: true, metadata: metaComCitacao })).toBe(true);
  });

  it("mensagem recebida do cliente não tem origem a mostrar", () => {
    expect(deveMostrarOrigem({ isOutbound: false, metadata: metaComCitacao })).toBe(false);
  });

  it("mensagem escrita por humano não é sinalizada como sem lastro", () => {
    expect(
      deveMostrarOrigem({ isOutbound: true, metadata: { citations: [{ chunk_id: "c1" }] } }),
    ).toBe(false);
  });

  it("resposta da IA SEM citação não sinaliza problema (US3 cenário 4)", () => {
    // Saudação e qualificação de venda não têm o que citar, e FR-020 garante que elas saem
    // sem âncora. Marcar isso como falta seria treinar o corretor a ignorar o aviso.
    expect(deveMostrarOrigem({ isOutbound: true, metadata: { ai_generated: true, citations: [] } })).toBe(
      false,
    );
  });

  it("metadata ausente ou torto não quebra a bolha", () => {
    expect(deveMostrarOrigem({ isOutbound: true, metadata: null })).toBe(false);
    expect(deveMostrarOrigem({ isOutbound: true, metadata: "nao é objeto" })).toBe(false);
  });
});
