import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";

/**
 * O critério que esta tela existe para cumprir: **ligar custa UM passo** (SC-011).
 *
 * O escopo do catálogo nasce desligado (A-20), então ligar é o primeiro gesto de todo
 * corretor numa instalação nova — e ele acontece dentro do teto de 10 minutos do Princípio
 * VIII, cronometrado. É por isso que estes testes olham a CONTAGEM de chamadas e a AUSÊNCIA
 * de diálogo/botão de salvar, e não só "o estado mudou": a regressão que quebra SC-011 não
 * é o interruptor parar de funcionar, é alguém acrescentar um "tem certeza?" bem-
 * intencionado no meio do caminho, com todos os outros testes continuando verdes.
 *
 * O arquivo é `.ts` (e não `.tsx`) por causa do conjunto de escrita desta sessão — daí o
 * `createElement` em vez de JSX. Não muda nada do que é exercitado.
 */

const patchMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { patch: (...args: unknown[]) => patchMock(...args) },
}));

const showApiErrorMock = vi.fn();
vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: (...args: unknown[]) => showApiErrorMock(...args),
}));

const toastSuccess = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}));

import { EscoposClient } from "@/app/app/ai/knowledge/scopes/_client";

const ROTULO = { singular: "Operadora", plural: "Operadoras" };

const AMIL: EscopoDoTenant = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  display_name: "Amil",
  official_code: "326305",
  origin: "catalogo",
  is_active: false,
  materials_count: 4,
  own_materials_count: 0,
};

const MINHA: EscopoDoTenant = {
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  display_name: "Cooperativa do Vale",
  official_code: null,
  origin: "proprio",
  is_active: true,
  materials_count: 2,
  own_materials_count: 2,
};

function montar(escopos: EscopoDoTenant[] = [AMIL, MINHA], truncado = false) {
  return render(
    createElement(EscoposClient, { rotulo: ROTULO, escoposIniciais: escopos, truncado }),
  );
}

beforeEach(() => {
  patchMock.mockReset();
  showApiErrorMock.mockReset();
  toastSuccess.mockReset();
  toastInfo.mockReset();
});

describe("ligar custa um passo (SC-011)", () => {
  it("um clique no interruptor faz UMA chamada, com o corpo do contrato", async () => {
    patchMock.mockResolvedValue({ data: { ...AMIL, is_active: true } });

    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Ligar Amil" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock).toHaveBeenCalledWith(`/api/v1/knowledge-scopes/${AMIL.id}`, {
      is_active: true,
    });
  });

  it("não há confirmação nem salvar: o clique é a operação inteira", async () => {
    patchMock.mockResolvedValue({ data: { ...AMIL, is_active: true } });

    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Ligar Amil" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    // Nenhum diálogo abriu e nenhum botão de salvar/confirmar apareceu — se um deles
    // existisse, ligar custaria dois passos e SC-011 estaria quebrado.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /salvar|confirmar|tem certeza/i })).toBeNull();
  });

  it("o interruptor vira ANTES da resposta — esperar a rede convida ao clique duplo", () => {
    // Promessa que nunca resolve: o estado visto aqui é o otimista, não o do servidor.
    patchMock.mockReturnValue(new Promise(() => {}));

    montar();
    const interruptor = screen.getByRole("switch", { name: "Ligar Amil" });
    fireEvent.click(interruptor);

    expect(screen.getByRole("switch", { name: "Desligar Amil" })).toBeChecked();
  });

  it("clicar de novo enquanto a primeira chamada está no ar não dispara uma segunda", () => {
    patchMock.mockReturnValue(new Promise(() => {}));

    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Ligar Amil" }));
    fireEvent.click(screen.getByRole("switch", { name: "Desligar Amil" }));

    expect(patchMock).toHaveBeenCalledTimes(1);
  });
});

describe("desligar diz a consequência (FR-008)", () => {
  it("avisa que o agente parou de responder, e que o material não foi perdido", async () => {
    patchMock.mockResolvedValue({ data: { ...MINHA, is_active: false } });

    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Desligar Cooperativa do Vale" }));

    await waitFor(() => expect(toastInfo).toHaveBeenCalledTimes(1));
    const aviso = String(toastInfo.mock.calls[0]?.[0]);
    expect(aviso).toContain("parou de responder sobre Cooperativa do Vale");
    expect(aviso).toContain("continua salvo");
  });

  it("a consequência também fica na tela, não só no aviso que some", () => {
    montar();
    expect(
      screen.getByText(/Desligado: o agente não responde sobre Amil/),
    ).toBeInTheDocument();
  });
});

describe("quando a chamada falha", () => {
  it("o interruptor volta ao que era e o erro aparece — não finge que ligou", async () => {
    patchMock.mockRejectedValue(new Error("rede caiu"));

    montar();
    fireEvent.click(screen.getByRole("switch", { name: "Ligar Amil" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("switch", { name: "Ligar Amil" })).not.toBeChecked();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("o corretor distingue o que veio pronto do que ele criou (FR-039)", () => {
  it("cada linha carrega sua origem", () => {
    montar();
    expect(screen.getByText("Já vem no sistema")).toBeInTheDocument();
    expect(screen.getByText("Você adicionou")).toBeInTheDocument();
  });

  it("o rótulo da entidade vem do vocabulário, não cravado na tela", () => {
    render(
      createElement(EscoposClient, {
        rotulo: { singular: "Convênio", plural: "Convênios" },
        escoposIniciais: [AMIL],
        truncado: false,
      }),
    );
    expect(screen.getByRole("heading", { name: "Convênios" })).toBeInTheDocument();
  });
});

describe("estados de borda", () => {
  it("lista vazia explica o caminho em vez de deixar a tela muda", () => {
    montar([]);
    expect(screen.getByText("Nada por aqui ainda")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir para Conhecimento" })).toHaveAttribute(
      "href",
      "/app/ai/knowledge/sources",
    );
  });

  it("ligado sem material avisa que o interruptor sozinho não responde nada", () => {
    montar([{ ...AMIL, is_active: true, materials_count: 0 }]);
    expect(
      screen.getByText(/Ligado, mas ainda sem material/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Carregar material" })).toBeInTheDocument();
  });

  it("a busca só aparece quando a lista é grande o bastante para precisar dela", () => {
    montar();
    expect(screen.queryByRole("searchbox")).toBeNull();

    const muitos = Array.from({ length: 12 }, (_, i) => ({
      ...AMIL,
      id: `cccccccc-3333-4333-8333-00000000000${i}`,
      display_name: `Operadora ${i}`,
    }));
    montar(muitos);
    expect(screen.getByRole("searchbox", { name: "Buscar operadoras" })).toBeInTheDocument();
  });
});
