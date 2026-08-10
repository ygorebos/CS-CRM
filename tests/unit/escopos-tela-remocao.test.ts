import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";

/**
 * A porta da remoção na tela (T099, a outra metade de FR-008).
 *
 * A rota existir não basta: rota sem porta é meia entrega, e o corretor que criou uma
 * operadora por engano não tem como desfazer. Estes casos medem o que decide o uso —
 * quem ganha o botão, o que a pergunta diz ANTES do clique, e o que a lista faz depois.
 *
 * ═══ POR QUE ESTE ARQUIVO NÃO CONTRADIZ `escopos-tela-um-passo` ═══
 *
 * Lá o critério é que LIGAR custe um clique (SC-011), e que ninguém enfie um "tem certeza?"
 * no caminho. Aqui a confirmação é obrigatória — e a diferença não é gosto: ligar é o gesto
 * do primeiro dia, cronometrado; remover é raro, mexe na lista inteira e não tem desfazer
 * na tela. O que o teste de lá vigia é o caminho do interruptor, e ele continua com zero
 * portões.
 *
 * O arquivo é `.ts` (não `.tsx`) pela mesma razão do irmão — daí o `createElement`.
 */

const deleteMock = vi.fn();
const patchMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    patch: (...args: unknown[]) => patchMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
  },
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

/** Veio do catálogo: NÃO ganha botão de remover — a sincronização o recria. */
const AMIL: EscopoDoTenant = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  display_name: "Amil",
  official_code: "326305",
  origin: "catalogo",
  is_active: false,
  materials_count: 4,
  own_materials_count: 0,
};

/** Criada pelo corretor: é a única removível. */
const MINHA: EscopoDoTenant = {
  id: "bbbbbbbb-2222-4222-8222-222222222222",
  display_name: "Cooperativa do Vale",
  official_code: null,
  origin: "proprio",
  is_active: true,
  materials_count: 2,
  own_materials_count: 2,
};

function montar(escopos: EscopoDoTenant[] = [AMIL, MINHA]) {
  return render(
    createElement(EscoposClient, { rotulo: ROTULO, escoposIniciais: escopos, truncado: false }),
  );
}

beforeEach(() => {
  deleteMock.mockReset();
  patchMock.mockReset();
  showApiErrorMock.mockReset();
  toastSuccess.mockReset();
  toastInfo.mockReset();
});

describe("remover uma operadora própria (T099)", () => {
  it("só o que o corretor criou ganha o botão — o do catálogo não", async () => {
    montar();
    expect(screen.getByRole("button", { name: "Remover Cooperativa do Vale" })).toBeTruthy();
    // Oferecer o botão no espelho seria ensinar um caminho que a rota recusa com 403.
    expect(screen.queryByRole("button", { name: "Remover Amil" })).toBeNull();
  });

  it("o primeiro clique PERGUNTA, e não chama a rota", async () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Remover Cooperativa do Vale" }));

    expect(deleteMock).not.toHaveBeenCalled();
    // A pergunta diz as três coisas que decidem, antes de o corretor escolher.
    const pergunta = screen.getByText(/Remover Cooperativa do Vale\?/);
    expect(pergunta.textContent).toContain("para de responder");
    expect(pergunta.textContent).toContain("arquivado");
    expect(pergunta.textContent).toContain("de onde vieram");
  });

  it("confirmado, chama DELETE uma vez e a linha SAI da lista", async () => {
    deleteMock.mockResolvedValue({ data: { id: MINHA.id, deleted: true, materials_archived: 2 } });
    montar();

    fireEvent.click(screen.getByRole("button", { name: "Remover Cooperativa do Vale" }));
    fireEvent.click(screen.getByRole("button", { name: "Sim, remover" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledTimes(1));
    expect(deleteMock).toHaveBeenCalledWith(`/api/v1/knowledge-scopes/${MINHA.id}`);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remover Cooperativa do Vale" })).toBeNull(),
    );
    // O que sobrou continua ali: remover uma não recarrega nem esvazia a lista.
    expect(screen.getByRole("switch", { name: "Ligar Amil" })).toBeTruthy();
  });

  it("o aviso diz quantos materiais foram ARQUIVADOS — não 'apagados'", async () => {
    deleteMock.mockResolvedValue({ data: { id: MINHA.id, deleted: true, materials_archived: 2 } });
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Remover Cooperativa do Vale" }));
    fireEvent.click(screen.getByRole("button", { name: "Sim, remover" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    const aviso = String(toastSuccess.mock.calls[0]?.[0]);
    expect(aviso).toContain("2 materiais foram arquivados");
    expect(aviso).not.toMatch(/apagad|exclu[íi]d/i);
  });

  it("cancelar fecha a pergunta e não chama nada", () => {
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Remover Cooperativa do Vale" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByText(/Remover Cooperativa do Vale\?/)).toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("se a chamada falha, a linha CONTINUA na lista e o erro aparece", async () => {
    deleteMock.mockRejectedValue(new Error("500"));
    montar();
    fireEvent.click(screen.getByRole("button", { name: "Remover Cooperativa do Vale" }));
    fireEvent.click(screen.getByRole("button", { name: "Sim, remover" }));

    await waitFor(() => expect(showApiErrorMock).toHaveBeenCalledTimes(1));
    // Otimismo aqui seria pior que lentidão: sumir e voltar faz o corretor achar que
    // removeu, e a próxima coisa que ele faz é fechar a tela.
    expect(screen.getByRole("button", { name: "Remover Cooperativa do Vale" })).toBeTruthy();
  });

  it("o interruptor continua sem portão — SC-011 não foi contaminado", async () => {
    patchMock.mockResolvedValue({ data: { ...AMIL, is_active: true } });
    montar();

    fireEvent.click(screen.getByRole("switch", { name: "Ligar Amil" }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Remover Amil\?/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Sim, remover" })).toBeNull();
  });
});
