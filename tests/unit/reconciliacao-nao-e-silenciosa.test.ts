/**
 * A ponta que PUXA, e por que ela não pode ser silenciosa
 * (spec 004, T050 / FR-013a, Princípio XIV).
 *
 * ## O que a fila em disco NÃO cobre
 *
 * O gateway guarda o que não conseguiu entregar e retenta. Isso protege contra
 * **o CRM** estar fora do ar — e só. Não protege contra o gateway perder a
 * própria fila, contra a escrita aceita cuja transação morreu depois, nem contra
 * defeito no empurrador. As três terminam igual: a mensagem **nunca chegou a
 * existir** deste lado, e um CRM que só espera ser empurrado não tem como saber.
 *
 * ## O que se cobra aqui
 *
 * Que a rodada peça conteúdo **só do que falta** (janela completa não gera
 * chamada nenhuma), que a reingestão use o **mesmo caminho** da entrega normal, e
 * que recuperar alguma coisa **alarme** — reconciliar em silêncio transforma rede
 * de segurança em tapa-buraco permanente, com o defeito de origem intacto e agora
 * invisível porque alguém o conserta a cada minuto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { GATEWAY_BASE_URL: "https://gw.exemplo", GATEWAY_ADMIN_TOKEN: "tok-admin" },
}));

const ingeridos: unknown[] = [];
vi.mock("@/lib/gateway/ingest", () => ({
  ingerirEnvelope: vi.fn(async (_a: unknown, _s: unknown, env: unknown) => {
    ingeridos.push(env);
    return { ok: true };
  }),
}));
vi.mock("@/lib/gateway/envelope", () => ({
  parseEnvelope: (cru: unknown) => ({ ok: true, envelope: cru }),
}));

import { alarmarDivergencia, reconciliarConexao } from "@/lib/gateway/reconciliacao";

const ORG = "11111111-1111-4111-8111-111111111111";
const CANAL = "22222222-2222-4222-8222-222222222222";
const CONN = "conn-do-gateway";

const fetchMock = vi.fn();

function resposta(corpo: unknown) {
  return { ok: true, status: 200, json: async () => corpo } as Response;
}

/** Dublê que responde quais external_ids o CRM JÁ tem. */
function supabaseCom(existentes: string[]) {
  const inseridos: Record<string, unknown>[] = [];
  const abertos: string[] = [];
  const client = {
    from: (tabela: string) => {
      if (tabela === "messages") {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({ data: existentes.map((e) => ({ external_id: e })), error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              }),
            }),
          }),
        }),
        insert: async (linha: Record<string, unknown>) => {
          inseridos.push(linha);
          abertos.push(linha.organization_id as string);
          return { error: null };
        },
      };
    },
  };
  return { client: client as never, inseridos };
}

const conexao = { channelSessionId: CANAL, organizationId: ORG, gatewayConnectionId: CONN };
const janela = { since: new Date("2026-08-08T11:00:00Z"), until: new Date("2026-08-08T12:00:00Z"), requestId: "req-1" };

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  ingeridos.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("reconciliarConexao (FR-013a)", () => {
  it("janela completa: descobre que não falta nada e NÃO pede conteúdo", async () => {
    // A fase 2 é a cara. Pedir corpo, mídia e contato de cada mensagem de uma
    // hora de conversa a cada tique pagaria o preço do caso raro no caso comum.
    fetchMock.mockResolvedValue(
      resposta({ messages: [{ external_id: "wamid-1", direction: "inbound", timestamp: "" }] }),
    );
    const { client } = supabaseCom(["wamid-1"]);

    const r = await reconciliarConexao(client, conexao, janela);

    expect(r.faltantes).toBe(0);
    expect(r.recuperadas).toBe(0);
    // UMA chamada: a varredura da janela. A busca de conteúdo não saiu.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mensagem faltando: pede SÓ o que falta e reingere pelo caminho normal", async () => {
    fetchMock
      .mockResolvedValueOnce(
        resposta({
          messages: [
            { external_id: "wamid-tenho", direction: "inbound", timestamp: "" },
            { external_id: "wamid-falta", direction: "inbound", timestamp: "" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        resposta({ envelopes: [{ message: { external_id: "wamid-falta" } }], nao_encontrados: [] }),
      );
    const { client } = supabaseCom(["wamid-tenho"]);

    const r = await reconciliarConexao(client, conexao, janela);

    expect(r.faltantes).toBe(1);
    expect(r.recuperadas).toBe(1);
    const corpo = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    // Só o id que falta. Mandar a janela inteira faria o gateway rebuscar o que
    // o CRM já tem.
    expect(corpo.ids).toEqual(["wamid-falta"]);
    // Reingestão pelo MESMO caminho da entrega normal: um atalho aqui gravaria
    // diferente do principal, e a diferença só apareceria no dia do incidente.
    expect(ingeridos).toHaveLength(1);
  });

  it("id que o provedor já não tem volta DECLARADO — insistir seria laço eterno", async () => {
    fetchMock
      .mockResolvedValueOnce(
        resposta({ messages: [{ external_id: "wamid-sumiu", direction: "inbound", timestamp: "" }] }),
      )
      .mockResolvedValueOnce(resposta({ envelopes: [], nao_encontrados: ["wamid-sumiu"] }));
    const { client } = supabaseCom([]);

    const r = await reconciliarConexao(client, conexao, janela);

    expect(r.faltantes).toBe(1);
    expect(r.recuperadas).toBe(0);
    expect(r.irrecuperaveis).toBe(1);
  });

  it("gateway fora não derruba a rodada nem finge janela limpa", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { client } = supabaseCom([]);

    const r = await reconciliarConexao(client, conexao, janela);

    expect(r).toMatchObject({ faltantes: 0, recuperadas: 0 });
    expect(ingeridos).toHaveLength(0);
  });
});

describe("recuperar em silêncio é proibido (Princípio XIV)", () => {
  it("recuperação abre aviso na Central, com severidade de conferência", async () => {
    const { client, inseridos } = supabaseCom([]);

    const abriu = await alarmarDivergencia(client, ORG, 3, "req-2");

    expect(abriu).toBe(true);
    expect(inseridos[0]).toMatchObject({
      kind: "gateway_reconciliation_gap",
      // `warn` e não `critical`: as mensagens JÁ estão na conversa certa. O que
      // se pede é conferir se alguém ficou sem resposta, não ação de emergência.
      severity: "warn",
      organization_id: ORG,
    });
    // A cópia tem de dizer o que ACONTECEU com a conversa — "reconciliação" e
    // "divergência" são palavras nossas.
    expect(String(inseridos[0]!.title)).toMatch(/atrasadas/i);
    expect(String(inseridos[0]!.body)).toMatch(/sem resposta/i);
  });
});
