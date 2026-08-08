/**
 * A queda do gateway não pode ser silenciosa (spec 004, T037 / FR-023).
 *
 * O Princípio XIV declara o gateway como SPOF — instância única, sem réplica —
 * e proíbe que a queda dele aconteça em silêncio. O silêncio aqui tem forma
 * específica e cruel: com o gateway fora, nada entra e nada sai, e a tela do
 * corretor fica **idêntica a um dia devagar**. Ele não abre chamado porque não
 * tem o que reportar.
 *
 * O que este arquivo cobra:
 *   1. gateway fora → aviso na Central, um por organização QUE DEPENDE dele;
 *   2. gateway fora de novo → nada de aviso repetido (Central enterrada é
 *      Central ignorada);
 *   3. gateway de volta → o aviso FECHA sozinho. Aviso crítico que fica aberto
 *      depois do conserto ensina o hábito que a Central não pode criar;
 *   4. ninguém depende do gateway → nada acontece, e a rede nem é tocada. Alarme
 *      falso em instalação que não virou a chave é o jeito mais rápido de a
 *      Central perder credibilidade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { GATEWAY_BASE_URL: "https://gw.exemplo", GATEWAY_INBOUND_ENABLED: true },
}));
import { env as envFalso } from "@/lib/env";

import { avisarGatewayForaDoAr, KIND_GATEWAY_FORA } from "@/lib/gateway/aviso-de-gateway-fora";

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

interface Conexao {
  organization_id: string;
  ingest_path: string | null;
  gateway_connection_id: string | null;
}

/**
 * Dublê do Supabase com o mínimo que o módulo encadeia. Guarda os inserts e os
 * updates para as asserções — o que importa é o efeito observável na Central.
 */
function fakeSupabase(conexoes: Conexao[], avisosAbertos: string[] = []) {
  const inseridos: Record<string, unknown>[] = [];
  const resolvidos: string[] = [];
  const abertos = new Set(avisosAbertos);

  const client = {
    from(tabela: string) {
      if (tabela === "channel_sessions") {
        return {
          select: () => ({
            is: () => ({ limit: async () => ({ data: conexoes, error: null }) }),
          }),
        };
      }
      if (tabela === "agent_inbox_items") {
        return {
          select: () => ({
            eq: (_c1: string, org: string) => ({
              eq: () => ({
                eq: () => ({
                  limit: () => ({
                    maybeSingle: async () => ({
                      data: abertos.has(org) ? { id: `aviso-${org}` } : null,
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          }),
          insert: async (linha: Record<string, unknown>) => {
            inseridos.push(linha);
            abertos.add(linha.organization_id as string);
            return { error: null };
          },
          // O dublê guarda o PAYLOAD do update, não só o efeito: medido nesta
          // task — uma primeira versão só removia do conjunto, e trocar
          // `status: "resolved"` por `status: "open"` deixava a suíte verde.
          // Dublê que ignora o que foi escrito não prova escrita nenhuma.
          update: (payload: Record<string, unknown>) => ({
            eq: () => ({
              eq: () => ({
                in: (_col: string, orgs: string[]) => ({
                  select: async () => {
                    if (payload.status !== "resolved") {
                      return { data: [], error: null };
                    }
                    const fechados = orgs.filter((o) => abertos.has(o));
                    for (const o of fechados) {
                      abertos.delete(o);
                      resolvidos.push(o);
                    }
                    return { data: fechados.map((o) => ({ id: `aviso-${o}` })), error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no dublê: ${tabela}`);
    },
  };

  return { client: client as never, inseridos, resolvidos };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  envFalso.GATEWAY_BASE_URL = "https://gw.exemplo";
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const CONEXAO_QUE_ENVIA: Conexao = {
  organization_id: ORG_A,
  ingest_path: "legacy",
  gateway_connection_id: "conn-1",
};
const CONEXAO_QUE_RECEBE: Conexao = {
  organization_id: ORG_B,
  ingest_path: "gateway",
  gateway_connection_id: null,
};

describe("avisarGatewayForaDoAr (FR-023)", () => {
  it("gateway fora: abre UM aviso por organização que depende dele", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { client, inseridos } = fakeSupabase([CONEXAO_QUE_ENVIA, CONEXAO_QUE_RECEBE]);

    const r = await avisarGatewayForaDoAr(client, { requestId: "req-1" });

    expect(r.alcancavel).toBe(false);
    expect(r.avisosAbertos).toBe(2);
    // As duas dependências contam: quem RECEBE pela rota nova e quem ENVIA pela
    // conexão. Basta uma para a queda doer.
    expect(inseridos.map((i) => i.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(inseridos[0]).toMatchObject({ kind: KIND_GATEWAY_FORA, severity: "critical" });
    // A cópia é para o corretor, não para nós: sem jargão, e dizendo que nada se
    // perdeu — senão o aviso vira pânico sem ação possível.
    expect(String(inseridos[0]!.body)).toMatch(/nada se perde/i);
  });

  it("segunda rodada com o gateway ainda fora: não repete o aviso", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { client, inseridos } = fakeSupabase([CONEXAO_QUE_ENVIA], [ORG_A]);

    const r = await avisarGatewayForaDoAr(client, { requestId: "req-2" });

    expect(r.avisosAbertos).toBe(0);
    expect(inseridos).toHaveLength(0);
  });

  it("gateway de volta: o aviso FECHA sozinho", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    const { client, resolvidos } = fakeSupabase([CONEXAO_QUE_ENVIA], [ORG_A]);

    const r = await avisarGatewayForaDoAr(client, { requestId: "req-3" });

    expect(r.alcancavel).toBe(true);
    expect(r.avisosResolvidos).toBe(1);
    expect(resolvidos).toEqual([ORG_A]);
  });

  it("resposta de erro conta como fora — 502 não é 'no ar'", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502 } as Response);
    const { client, inseridos } = fakeSupabase([CONEXAO_QUE_ENVIA]);

    const r = await avisarGatewayForaDoAr(client, { requestId: "req-4" });

    expect(r.alcancavel).toBe(false);
    expect(inseridos).toHaveLength(1);
  });

  it("ninguém depende do gateway: não sonda, não avisa", async () => {
    const { client, inseridos } = fakeSupabase([
      { organization_id: ORG_A, ingest_path: "legacy", gateway_connection_id: null },
    ]);

    const r = await avisarGatewayForaDoAr(client, { requestId: "req-5" });

    expect(r.alcancavel).toBeNull();
    expect(inseridos).toHaveLength(0);
    // A sondagem nem sai: alarme falso em toda instalação que ainda não virou a
    // chave é o jeito mais rápido de ensinar a ignorar a Central.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha na leitura das conexões não derruba o dreno", async () => {
    const client = {
      from: () => ({
        select: () => ({ is: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }),
      }),
    } as never;

    const r = await avisarGatewayForaDoAr(client, { requestId: "req-6" });

    expect(r).toEqual({ alcancavel: null, avisosAbertos: 0, avisosResolvidos: 0 });
  });
});
