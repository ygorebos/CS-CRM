import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PainelDoOperador } from "@/app/app/ai/agents/[id]/_components/PainelDoOperador";

/**
 * O painel do papel Operador (spec 16 §6).
 *
 * O que estes casos guardam não é layout — é **disciplina de informação**. A
 * spec pede que nada passe batido para quem configura, e a régua concreta disso
 * é: a tela diz a CONSEQUÊNCIA de uma escolha, não o nome interno da feature.
 * "Desabilitar agente operador" não informa nada a um dono de clínica.
 */
function renderPainel(overrides: Partial<React.ComponentProps<typeof PainelDoOperador>> = {}) {
  const props: React.ComponentProps<typeof PainelDoOperador> = {
    enabled: false,
    onEnabledChange: vi.fn(),
    model: "",
    onModelChange: vi.fn(),
    provider: "anthropic",
    toolIds: [],
    onToolIdsChange: vi.fn(),
    modeloDoConversador: "claude-sonnet-4-6",
    ...overrides,
  };
  // O ModelPicker busca modelos por react-query; sem o provider ele estoura.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PainelDoOperador {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe("painel do Operador — disciplina de informação", () => {
  it("DESLIGADO: a tela diz o que se perde, antes de a pessoa decidir", () => {
    renderPainel({ enabled: false });
    const aviso = screen.getByTestId("operador-consequencia");
    // O que CONTINUA acontecendo (decisão da spec 16 §2.1: desligar não desliga
    // o registro básico). Sem esta frase, o usuário conclui que desligar deixa o
    // sistema cego — e liga por medo, não por escolha.
    expect(aviso.textContent).toMatch(/continua atendendo/i);
    expect(aviso.textContent).toMatch(/registrado sozinho/i);
    // E o que PARA de acontecer.
    expect(aviso.textContent).toMatch(/decidir sobre a operação/i);
  });

  it("DESLIGADO: não mostra configuração que não vai valer", () => {
    renderPainel({ enabled: false });
    // Mostrar modelo e capacidades de um papel desligado convida a pessoa a
    // configurar algo que nunca roda — e a concluir que o produto está quebrado
    // quando nada acontece.
    expect(screen.queryByTestId("operador-capacidades")).toBeNull();
  });

  it("LIGADO: mostra o que ele pode mexer, e diz que é lista SÓ dele", () => {
    renderPainel({ enabled: true });
    expect(screen.getByTestId("operador-capacidades")).toBeTruthy();
    // A frase que impede o modelo mental errado: o usuário precisa saber que
    // isto não é a mesma lista da aba de conversa.
    expect(screen.getByText(/só deste papel/i)).toBeTruthy();
  });

  it("LIGADO e sem capacidade: explica que ainda serve para algo", () => {
    renderPainel({ enabled: true, toolIds: [] });
    // Estado legítimo (o papel ainda avisa promessa não cumprida). Sem esta
    // frase o usuário liga, não marca nada, e conclui que quebrou.
    expect(screen.getByTestId("operador-sem-capacidade").textContent).toMatch(/prometer algo/i);
  });

  it("o texto NÃO usa o nosso vocabulário interno", () => {
    renderPainel({ enabled: true });
    // "Operador", "papel", "tool", "MCP" são como NÓS chamamos as coisas. Quem
    // configura é dono de clínica, de loja, de imobiliária.
    const corpo = document.body.textContent ?? "";
    for (const jargao of ["MCP", "tool_ids", "operator_", "job", "payload"]) {
      expect(corpo, `vocabulário interno na tela: ${jargao}`).not.toContain(jargao);
    }
  });

  it("o modelo herdado tem NOME, e o caminho de volta existe", async () => {
    // Um Select não oferece "nenhum" como item. Sem o botão, escolher um modelo
    // seria de mão única — e o usuário não teria como saber por quê.
    const props = renderPainel({ enabled: true, model: "claude-haiku-4-5-20251001" });
    const voltar = screen.getByTestId("operador-modelo-herdar");
    await userEvent.click(voltar);
    expect(props.onModelChange).toHaveBeenCalledWith("");
  });

  it("sem modelo escolhido, não oferece o botão de voltar — não há para onde voltar", () => {
    renderPainel({ enabled: true, model: "" });
    expect(screen.queryByTestId("operador-modelo-herdar")).toBeNull();
  });

  it("ligar e desligar chega a quem salva", async () => {
    const props = renderPainel({ enabled: false });
    await userEvent.click(screen.getByTestId("operador-liga"));
    expect(props.onEnabledChange).toHaveBeenCalledWith(true);
  });
});
