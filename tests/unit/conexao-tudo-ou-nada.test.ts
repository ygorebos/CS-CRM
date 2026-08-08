/**
 * Criar canal é tudo-ou-nada entre DOIS sistemas (spec 004, T043 / FR-033, FR-012).
 *
 * ## O que pode sobrar quando ninguém é dono da compensação
 *
 * Não existe transação atravessando HTTP. O gateway cria a instância no provedor
 * e devolve um `connection_id`; o CRM grava a linha dele. Entre os dois passos há
 * uma janela, e o que ela produz quando o segundo falha é uma **instância órfã**:
 * o gateway acha que o CRM está usando, o CRM não sabe que ela existe, e ninguém
 * a reconhece como sua quando a fatura do provedor chega.
 *
 * A T003 decidiu que a compensação tem **um dono só**: o CRM criou, o CRM desfaz.
 *
 * ## Por que a ordem é gateway-primeiro
 *
 * Se a linha do CRM viesse antes, um provisionamento que falhasse deixaria canal
 * fantasma **na tela do usuário** — e ele tentaria parear um número que não
 * existe em lugar nenhum. Na ordem certa, a falha do primeiro passo não deixa
 * rastro, e a do segundo é compensada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    GATEWAY_BASE_URL: "https://gw.exemplo",
    GATEWAY_ADMIN_TOKEN: "tok-admin",
    GATEWAY_INTERNAL_TOKEN: "tok-interno",
  },
}));
import { env as envFalso } from "@/lib/env";

// A cifra do segredo por conexão tem teste próprio; aqui ela é ruído que exigiria
// um dublê de `rpc` só para chegar ao que este arquivo mede — a compensação.
vi.mock("@/lib/webhooks/provisionar-segredo", () => ({
  provisionarSegredoDeWebhook: vi.fn(async () => "\\x0102"),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { provisionarEGravarConexao } from "@/lib/channels/criar-conexao";
import {
  apagarNoGatewaySemLancar,
  criarConexaoNoGateway,
  ErroDoGateway,
  estadoConhecido,
  provisionamentoConfigurado,
} from "@/lib/gateway/provisionamento";

const fetchMock = vi.fn();

function resposta(status: number, corpo: unknown) {
  return {
    ok: status < 300,
    status,
    json: async () => corpo,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  envFalso.GATEWAY_BASE_URL = "https://gw.exemplo";
  envFalso.GATEWAY_ADMIN_TOKEN = "tok-admin";
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provisionamento no gateway (FR-033)", () => {
  it("usa o token ADMIN, em cabeçalho, e leva a Idempotency-Key", async () => {
    fetchMock.mockResolvedValue(resposta(201, { connection_id: "conn-1", status: "created" }));

    const r = await criarConexaoNoGateway({
      platform: "whatsapp_uazapi",
      label: "Comercial",
      idempotencyKey: "channel:org-1:org_1111_abc",
    });

    expect(r.connectionId).toBe("conn-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.exemplo/v1/connections");
    const cabecalhos = init.headers as Record<string, string>;
    // Token ADMIN, não o interno: criar instância custa dinheiro e apagar é
    // irreversível. O gateway RECUSA o interno nestas rotas, então trocar um
    // pelo outro falha alto — mas o teste afirma qual sai daqui.
    expect(cabecalhos.Authorization).toBe("Bearer tok-admin");
    expect(cabecalhos.Authorization).not.toContain("tok-interno");
    expect(cabecalhos["Idempotency-Key"]).toBe("channel:org-1:org_1111_abc");
    expect(url).not.toContain("tok-admin");
  });

  it("o alvo de escrita NÃO viaja no corpo — nem `delivery`, nem organização", async () => {
    // O alvo é configuração do PROCESSO do gateway. Vindo no corpo, um chamador
    // poderia redirecionar a escrita de uma conexão para outro banco; e o dono
    // da conexão é quem apresentou a credencial, nunca o corpo.
    fetchMock.mockResolvedValue(resposta(201, { connection_id: "conn-2", status: "created" }));
    await criarConexaoNoGateway({ platform: "whatsapp_uazapi", idempotencyKey: "k" });
    const corpo = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(corpo).toEqual({ platform: "whatsapp_uazapi" });
    expect(JSON.stringify(corpo)).not.toContain("organization");
  });

  it("201 sem connection_id falha ALTO — é o único órfão sem culpa do CRM", async () => {
    // Sem id não há o que gravar NEM o que compensar. Aceitar calado deixaria
    // uma instância paga que ninguém consegue rastrear.
    fetchMock.mockResolvedValue(resposta(201, { status: "created" }));
    await expect(
      criarConexaoNoGateway({ platform: "whatsapp_uazapi", idempotencyKey: "k" }),
    ).rejects.toThrow(/connection_id/);
  });

  it("gateway inalcançável vira 502, não 500 — o defeito não é nosso", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      criarConexaoNoGateway({ platform: "whatsapp_uazapi", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ status: 502, codigo: "gateway_inalcancavel" });
  });

  it("erro do gateway preserva o código — quem lê precisa saber o que fazer", async () => {
    fetchMock.mockResolvedValue(
      resposta(422, { error: { code: "plataforma_nao_suportada", message: "telegram" } }),
    );
    const erro = await criarConexaoNoGateway({
      platform: "telegram",
      idempotencyKey: "k",
    }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDoGateway);
    expect((erro as ErroDoGateway).codigo).toBe("plataforma_nao_suportada");
  });

  it("sem GATEWAY_ADMIN_TOKEN não sai chamada nenhuma", async () => {
    envFalso.GATEWAY_ADMIN_TOKEN = "";
    expect(provisionamentoConfigurado()).toBe(false);
    await expect(
      criarConexaoNoGateway({ platform: "whatsapp_uazapi", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ codigo: "gateway_nao_configurado" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a compensação (FR-012)", () => {
  it("DELETE devolve true quando desfez", async () => {
    fetchMock.mockResolvedValue(resposta(204, {}));
    expect(await apagarNoGatewaySemLancar("conn-1")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.exemplo/v1/connections/conn-1");
    expect(init.method).toBe("DELETE");
  });

  it("NUNCA lança — quem chama já está tratando outra falha", async () => {
    // Uma exceção aqui trocaria "não consegui criar o canal" por um erro sobre a
    // limpeza, e o usuário leria a mensagem errada sobre o problema errado.
    fetchMock.mockRejectedValue(new Error("gateway sumiu"));
    expect(await apagarNoGatewaySemLancar("conn-1")).toBe(false);
  });
});

describe("vocabulário de estado (FR-032)", () => {
  it("os seis estados do contrato passam intactos", () => {
    for (const e of [
      "created",
      "awaiting_scan",
      "connecting",
      "connected",
      "disconnected",
      "failed",
    ] as const) {
      expect(estadoConhecido(e)).toBe(e);
    }
  });

  it("estado desconhecido cai em failed — nunca em tela vazia", () => {
    // Fail-closed E legível. Deixar passar o desconhecido produz o pior
    // desfecho: o corretor sem saber se está conectado, se precisa escanear, ou
    // se o produto quebrou.
    for (const cru of ["opening", "", null, undefined, 42, {}]) {
      expect(estadoConhecido(cru)).toBe("failed");
    }
  });
});

// ---------------------------------------------------------------------------
// A orquestração: provisiona lá, grava aqui, desfaz se a segunda metade falhar
// ---------------------------------------------------------------------------
describe("provisionarEGravarConexao — o tudo-ou-nada de ponta a ponta", () => {
  function supabaseQue(desfecho: "grava" | "recusa") {
    return {
      from: () => ({
        insert: (linha: Record<string, unknown>) => ({
          select: () => ({
            single: async () =>
              desfecho === "grava"
                ? { data: { id: "linha-1", ...linha }, error: null }
                : { data: null, error: { message: "unique_violation: numero ja conectado" } },
          }),
        }),
      }),
    } as never;
  }

  const pedidoBase = {
    organizationId: "org-1",
    sessionName: "org_1111_abc",
    actorUserId: "user-1",
    requestId: "req-1",
    origem: "central" as const,
    platform: "whatsapp_uazapi",
  };

  it("caminho feliz: a linha nasce apontando para a conexão do gateway", async () => {
    const criar = vi.fn(async () => ({
      connectionId: "conn-9",
      platform: "whatsapp_uazapi",
      status: "created" as const,
    }));
    const apagar = vi.fn(async () => true);

    const r = await provisionarEGravarConexao(supabaseQue("grava"), pedidoBase, {
      criarNoGateway: criar,
      apagarNoGateway: apagar,
    });

    expect(r.ok).toBe(true);
    expect(r.gatewayConnectionId).toBe("conn-9");
    // Nada a desfazer quando deu certo — um DELETE aqui apagaria a instância que
    // o usuário acabou de conectar.
    expect(apagar).not.toHaveBeenCalled();
  });

  it("a gravação falha: a instância é DESFEITA, não fica órfã", async () => {
    const criar = vi.fn(async () => ({
      connectionId: "conn-orfa",
      platform: "whatsapp_uazapi",
      status: "created" as const,
    }));
    const apagar = vi.fn(async () => true);

    const r = await provisionarEGravarConexao(supabaseQue("recusa"), pedidoBase, {
      criarNoGateway: criar,
      apagarNoGateway: apagar,
    });

    expect(r.ok).toBe(false);
    // A asserção que congela o defeito: sem esta chamada sobra uma instância que
    // nenhum dos dois lados reconhece como sua, e que continua sendo cobrada.
    expect(apagar).toHaveBeenCalledWith("conn-orfa");
  });

  it("a idempotência é derivada da conexão — retry não vira segunda instância", async () => {
    const criar = vi.fn(async () => ({
      connectionId: "conn-1",
      platform: "whatsapp_uazapi",
      status: "created" as const,
    }));
    const apagar = vi.fn(async () => true);

    await provisionarEGravarConexao(supabaseQue("grava"), pedidoBase, {
      criarNoGateway: criar,
      apagarNoGateway: apagar,
    });
    await provisionarEGravarConexao(supabaseQue("grava"), pedidoBase, {
      criarNoGateway: criar,
      apagarNoGateway: apagar,
    });

    const chaves = criar.mock.calls.map(
      (c) => (c as unknown as [{ idempotencyKey: string }])[0].idempotencyKey,
    );
    // MESMA chave nas duas: é isso que faz o gateway devolver a mesma instância
    // depois de um timeout do CRM. Chave aleatória por chamada tornaria a
    // proteção enfeite, e cada timeout viraria uma instância paga e órfã.
    expect(chaves[0]).toBe(chaves[1]);
    expect(chaves[0]).toContain("org_1111_abc");
  });

  it("provisionamento que falha não deixa rastro NENHUM no CRM", async () => {
    // A ordem importa: instância primeiro, linha depois. Ao contrário, um
    // provisionamento falho deixaria canal fantasma na tela, e o corretor
    // tentaria parear um número que não existe em lugar nenhum.
    const criar = vi.fn(async () => {
      throw new ErroDoGateway(502, "erro_do_provedor", "provedor fora");
    });
    const apagar = vi.fn(async () => true);
    let inseriu = false;
    const supabase = {
      from: () => ({
        insert: () => {
          inseriu = true;
          return { select: () => ({ single: async () => ({ data: {}, error: null }) }) };
        },
      }),
    } as never;

    await expect(
      provisionarEGravarConexao(supabase, pedidoBase, {
        criarNoGateway: criar,
        apagarNoGateway: apagar,
      }),
    ).rejects.toBeInstanceOf(ErroDoGateway);
    expect(inseriu).toBe(false);
    expect(apagar).not.toHaveBeenCalled();
  });
});
