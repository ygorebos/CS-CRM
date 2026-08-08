/**
 * T059 / FR-027 — o recebimento desligado não pode passar por "dia devagar".
 *
 * A combinação vigiada aqui é a que ninguém percebe: conexão apontada para o
 * gateway (`ingest_path='gateway'`) com o interruptor global desligado. A rota
 * responde 404, o gateway descarta sem retentar — 404 é defeito de configuração
 * pelo contrato §5 — e a tela fica exatamente igual a uma segunda-feira fraca.
 *
 * O teste tem dois lados, e o segundo importa tanto quanto o primeiro: avisar
 * quando é o caso, e **calar quando não é**. Aviso que aparece em instalação
 * saudável ensina a ignorar a Central, e aí o aviso verdadeiro também morre.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { avisarRecebimentoDesligado } from "@/lib/gateway/aviso-de-recebimento-desligado";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

function adminDuplo(opts: {
  conexoes: Array<{ organization_id: string }>;
  jaAberto?: Set<string>;
}) {
  const inseridos: Array<Record<string, unknown>> = [];
  let consultasDeConexao = 0;

  const admin = {
    from: (tabela: string) => {
      const filtros: Record<string, unknown> = {};
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros[coluna] = valor;
          return cadeia;
        },
        is: () => cadeia,
        limit: () => cadeia,
        insert: (dados: Record<string, unknown>) => {
          inseridos.push({ tabela, ...dados });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: async () => {
          if (tabela === "agent_inbox_items") {
            const org = String(filtros.organization_id ?? "");
            return { data: opts.jaAberto?.has(org) ? { id: "ja-existe" } : null, error: null };
          }
          return { data: null, error: null };
        },
        then: <T,>(onOk: (v: { data: unknown; error: null }) => T) => {
          if (tabela === "channel_sessions") {
            consultasDeConexao += 1;
            return Promise.resolve({ data: opts.conexoes, error: null }).then(onOk);
          }
          return Promise.resolve({ data: null, error: null }).then(onOk);
        },
      };
      return cadeia;
    },
  } as unknown as SupabaseClient;

  return { admin, inseridos, contarConsultasDeConexao: () => consultasDeConexao };
}

describe("aviso de recebimento desligado (T059)", () => {
  it("com o recebimento LIGADO não avisa nada — e nem consulta o banco", async () => {
    const { admin, inseridos, contarConsultasDeConexao } = adminDuplo({
      conexoes: [{ organization_id: ORG_A }],
    });

    const n = await avisarRecebimentoDesligado(admin, { habilitado: true, requestId: "r" });

    expect(n).toBe(0);
    expect(inseridos).toHaveLength(0);
    // O caminho normal é este, uma vez por minuto, para sempre. Consultar o
    // banco aqui seria custo permanente para responder uma pergunta que a
    // configuração já respondeu.
    expect(contarConsultasDeConexao()).toBe(0);
  });

  it("desligado E sem conexão migrada não avisa — é o estado normal de quem não virou a chave", async () => {
    const { admin, inseridos } = adminDuplo({ conexoes: [] });

    const n = await avisarRecebimentoDesligado(admin, { habilitado: false, requestId: "r" });

    // Avisar aqui seria alarme falso em 100% das instalações que ainda estão no
    // caminho legado — e alarme falso é o que ensina a ignorar a Central.
    expect(n).toBe(0);
    expect(inseridos).toHaveLength(0);
  });

  it("desligado COM conexão migrada avisa, uma vez por organização", async () => {
    const { admin, inseridos } = adminDuplo({
      // Duas conexões da mesma org + uma de outra: o interruptor é global, então
      // todas estão quebradas do mesmo jeito e com o mesmo conserto.
      conexoes: [
        { organization_id: ORG_A },
        { organization_id: ORG_A },
        { organization_id: ORG_B },
      ],
    });

    const n = await avisarRecebimentoDesligado(admin, { habilitado: false, requestId: "r" });

    expect(n).toBe(2);
    expect(inseridos).toHaveLength(2);
    expect(inseridos.map((i) => i.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(inseridos[0]!.kind).toBe("gateway_inbound_down");
    expect(inseridos[0]!.severity).toBe("critical");
    // O corpo tem de dizer o que fazer. "Houve um problema de configuração" sem
    // o nome da chave manda a pessoa abrir um chamado para ligar um booleano.
    expect(String(inseridos[0]!.body)).toContain("GATEWAY_INBOUND_ENABLED");
    // E tem de dizer o que fazer ENQUANTO isso: quem está esperando resposta é
    // uma pessoa, e ela não sabe que houve um problema de configuração.
    expect(String(inseridos[0]!.body)).toContain("aparelho");
  });

  it("não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const { admin, inseridos } = adminDuplo({
      conexoes: [{ organization_id: ORG_A }, { organization_id: ORG_B }],
      jaAberto: new Set([ORG_A]),
    });

    const n = await avisarRecebimentoDesligado(admin, { habilitado: false, requestId: "r" });

    // O dreno roda a cada minuto: sem deduplicar, uma noite inteira desligado
    // enterraria a Central em 480 avisos idênticos.
    expect(n).toBe(1);
    expect(inseridos.map((i) => i.organization_id)).toEqual([ORG_B]);
  });
});
