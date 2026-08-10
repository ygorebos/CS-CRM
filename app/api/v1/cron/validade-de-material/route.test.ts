/**
 * A BORDA da rota de cron `validade-de-material` (spec 002, T136).
 *
 * O worker tem teste próprio (`workers/validade-de-material.test.ts`); o que se mede aqui
 * é só o que a rota acrescenta, e cada item existe por um modo de falha concreto:
 *
 *   1. **Fail-closed de verdade.** Rota de cron é pública — o guardião é o segredo, não a
 *      obscuridade da URL. E "sem segredo configurado" tem de ser 403, não 200: uma
 *      instalação sem `INTERNAL_SECRET` que deixasse a rota aberta entregaria a varredura
 *      (e a escrita na Central) a qualquer um que descobrisse o caminho.
 *   2. **A query é input externo e passa por Zod.** `dias` chega da URL; sem validação,
 *      `?dias=99999` viraria uma janela de 273 anos e a Central nasceria com um aviso para
 *      cada material datado da instalação.
 *   3. **O parâmetro chega mesmo ao worker.** Um `default` aceito e depois ignorado é o
 *      tipo de defeito que passa em todo teste de status code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DIAS_DE_ANTECEDENCIA } from "@/workers/validade-de-material";
import type * as ModuloDaValidade from "@/workers/validade-de-material";

/**
 * `vi.hoisted` porque as fábricas de `vi.mock` sobem para o topo do arquivo: um `const`
 * declarado aqui embaixo ainda não existe quando elas rodam.
 */
const h = vi.hoisted(() => ({
  varrer: vi.fn(),
  env: { INTERNAL_CRON_SECRET: "cron-secret", INTERNAL_SECRET: "internal-secret" } as Record<
    string,
    unknown
  >,
}));

const varrer = h.varrer;
const envMock = h.env;

vi.mock("@/lib/env", () => ({ env: h.env }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
// Só `avisarValidadeDeMaterial` é dublado: as constantes do módulo (a janela padrão, que a
// rota usa como default do Zod) continuam sendo as de produção. Trocar as duas faria o
// teste medir números inventados por ele mesmo.
vi.mock("@/workers/validade-de-material", async (original) => {
  const real = await original<typeof ModuloDaValidade>();
  return { ...real, avisarValidadeDeMaterial: h.varrer };
});

const RESULTADO_VAZIO = {
  hoje: "2026-08-08",
  limite: "2026-09-07",
  dias_de_antecedencia: DIAS_DE_ANTECEDENCIA,
  materiais_do_corretor: 0,
  materiais_do_catalogo: 0,
  avisos_abertos: 0,
  ja_avisados: 0,
  organizacoes: 0,
};

async function chamar(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new Request(url, { headers }) as never);
}

const COM_SEGREDO = { authorization: "Bearer cron-secret" };
const BASE = "http://test.local/api/v1/cron/validade-de-material";

beforeEach(() => {
  varrer.mockReset();
  varrer.mockResolvedValue(RESULTADO_VAZIO);
  envMock.INTERNAL_CRON_SECRET = "cron-secret";
  envMock.INTERNAL_SECRET = "internal-secret";
});

describe("cron validade-de-material", () => {
  it("sem Authorization: 403, e o worker nem é chamado", async () => {
    const res = await chamar(BASE);
    expect(res.status).toBe(403);
    expect(varrer).not.toHaveBeenCalled();
  });

  it("com segredo errado: 403", async () => {
    const res = await chamar(BASE, { authorization: "Bearer chute" });
    expect(res.status).toBe(403);
    expect(varrer).not.toHaveBeenCalled();
  });

  it("sem NENHUM segredo configurado: 403 — a ausência fecha a porta, não a abre", async () => {
    envMock.INTERNAL_CRON_SECRET = "";
    envMock.INTERNAL_SECRET = "";
    const res = await chamar(BASE, COM_SEGREDO);
    expect(res.status).toBe(403);
    expect(varrer).not.toHaveBeenCalled();
  });

  it("com segredo: 200, resultado no envelope `data`, e a janela padrão vale", async () => {
    const res = await chamar(BASE, COM_SEGREDO);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { dias_de_antecedencia: number } };
    expect(body.data.dias_de_antecedencia).toBe(DIAS_DE_ANTECEDENCIA);
    expect(varrer).toHaveBeenCalledTimes(1);
    expect(varrer.mock.calls[0]![1]).toMatchObject({ diasDeAntecedencia: DIAS_DE_ANTECEDENCIA });
  });

  it("`dias` da query chega ao worker", async () => {
    const res = await chamar(`${BASE}?dias=7`, COM_SEGREDO);
    expect(res.status).toBe(200);
    expect(varrer.mock.calls[0]![1]).toMatchObject({ diasDeAntecedencia: 7 });
  });

  it("`dias` fora da faixa: 422, e nada é varrido", async () => {
    for (const q of ["dias=0", "dias=99999", "dias=abacaxi"]) {
      const res = await chamar(`${BASE}?${q}`, COM_SEGREDO);
      expect(res.status, q).toBe(422);
    }
    expect(varrer).not.toHaveBeenCalled();
  });

  it("worker explodindo vira 500 — e não 200 com corpo vazio", async () => {
    varrer.mockRejectedValueOnce(new Error("acervo_query_failed: boom"));
    const res = await chamar(BASE, COM_SEGREDO);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
  });

  it("toda resposta carrega X-Request-Id", async () => {
    const res = await chamar(BASE, COM_SEGREDO);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
