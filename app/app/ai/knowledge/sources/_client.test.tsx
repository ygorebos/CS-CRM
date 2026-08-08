import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { KnowledgeSourcesClient } from "./_client";
import type { EscopoNaTela, MaterialDoCorretor } from "./_regras";

/**
 * A ponte entre a regra e a tela (spec 002, T090).
 *
 * `_regras.test.ts` prova que a REGRA classifica certo. Este arquivo prova que a tela
 * **mostra** o que ela classificou — são falhas diferentes: dá para ter a regra impecável
 * e um JSX que desenha só o nome do material, e o corretor continuaria sem enxergar que
 * nada dele virou conteúdo buscável (FR-004, FR-005).
 *
 * Não substitui a prova pela tela de verdade (Playwright, conta nova, banco fresco) — essa
 * é tarefa própria e está declarada no relatório.
 */

vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({ useRealtimeChannel: () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

const ROTULO = { singular: "Operadora", plural: "Operadoras" };

const AMIL: EscopoNaTela = {
  id: "esc-amil",
  display_name: "Amil",
  origin: "catalogo",
  is_active: true,
};

function material(sobre: Partial<MaterialDoCorretor> = {}): MaterialDoCorretor {
  return {
    id: "m1",
    name: "Segunda via do boleto",
    scope_id: "esc-amil",
    applies_to_all: false,
    status: "ready",
    chunks_count: 8,
    last_index_status: "success",
    last_index_error: null,
    last_indexed_at: "2026-08-08T11:00:00Z",
    valid_until: null,
    is_active: true,
    created_at: "2026-08-08T10:00:00Z",
    ...sobre,
  };
}

function montar(materiais: MaterialDoCorretor[], escopos: EscopoNaTela[] = [AMIL]) {
  return render(
    <KnowledgeSourcesClient
      agentId="agente-1"
      rotulo={ROTULO}
      escopos={escopos}
      materiais={materiais}
      escopoInicial={null}
    />,
  );
}

describe("o que a tela mostra por material", () => {
  it("material sem nenhum trecho aparece como problema, e não como salvo", () => {
    montar([material({ chunks_count: 0 })]);

    expect(screen.getByText("Sem conteúdo aproveitável")).toBeInTheDocument();
    expect(screen.getByText(/hoje ele não responde nada com isto/)).toBeInTheDocument();
    // E o topo o contabiliza, para quem tem dezenas de materiais não precisar caçá-lo.
    expect(
      screen.getByText("Nenhum responde hoje, e 1 precisa da sua atenção."),
    ).toBeInTheDocument();
  });

  it("material pronto mostra a contagem de trechos (FR-005)", () => {
    montar([material({ chunks_count: 8 })]);

    expect(screen.getByText("Respondendo")).toBeInTheDocument();
    expect(screen.getByText(/8 trechos para consultar/)).toBeInTheDocument();
  });

  it("material vencido não se passa por respondendo (FR-026)", () => {
    montar([material({ valid_until: "2020-01-01" })]);

    expect(screen.queryByText("Respondendo")).toBeNull();
    expect(screen.getByText(/Venceu em 01\/01\/2020/)).toBeInTheDocument();
  });

  it("os quatro slots fixos não existem mais: N materiais na mesma operadora convivem", () => {
    // O que o índice único do banco e a tela antiga tornavam impossível (FR-003).
    montar([
      material({ id: "m1", name: "Boleto" }),
      material({ id: "m2", name: "Carteirinha" }),
      material({ id: "m3", name: "Rede credenciada" }),
      material({ id: "m4", name: "Reembolso" }),
      material({ id: "m5", name: "Carências" }),
    ]);

    for (const nome of ["Boleto", "Carteirinha", "Rede credenciada", "Reembolso", "Carências"]) {
      expect(screen.getByText(nome)).toBeInTheDocument();
    }
    expect(screen.queryByText("FAQ")).toBeNull();
    expect(screen.queryByText("Conversas opt-in")).toBeNull();
  });

  it("sem nada ligado, a tela manda ligar em vez de oferecer um formulário inútil", () => {
    montar([], [{ ...AMIL, is_active: false }]);

    expect(screen.getByText("Nada ligado ainda")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ligar o que eu vendo" })).toHaveAttribute(
      "href",
      "/app/ai/knowledge/scopes",
    );
    expect(screen.queryByRole("button", { name: /Novo material/ })).toBeNull();
  });
});
