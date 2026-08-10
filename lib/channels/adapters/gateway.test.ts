/**
 * O adapter do gateway (spec 004, T031-T034), contra um dublê do fetch.
 *
 * O que se cobra é o CONTRATO do lado de fora: qual rota, qual cabeçalho, qual
 * corpo — porque é isso que o gateway recebe, e um campo errado ali é envio que
 * volta 400 em produção com o teste unitário verde.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `lib/env` é um singleton parseado no import — stubEnv não o alcança. O mock
// do módulo é o único jeito de o teste controlar a configuração.
vi.mock("@/lib/env", () => ({
  env: { GATEWAY_BASE_URL: "https://gw.exemplo", GATEWAY_INTERNAL_TOKEN: "tok-interno" },
}));
// O objeto mockado, importado de volta para o teste poder mudá-lo por caso.
import { env as envFalso } from "@/lib/env";

import { gatewayAdapter } from "./gateway";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  envFalso.GATEWAY_BASE_URL = "https://gw.exemplo";
  envFalso.GATEWAY_INTERNAL_TOKEN = "tok-interno";
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function respostaOk(corpo: unknown, status = 200) {
  return {
    ok: status < 300,
    status,
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
  } as Response;
}

describe("gatewayAdapter.send", () => {
  it("fala a rota certa, com a credencial em CABEÇALHO e o tipo SEM tradução", async () => {
    fetchMock.mockResolvedValue(respostaOk({ message_id: "wamid-123" }));

    const res = await gatewayAdapter.send({
      sessionRef: "conn-uuid-1",
      to: "+5585999990000",
      kind: "text",
      body: "olá",
    });

    expect(res.externalId).toBe("wamid-123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gw.exemplo/v1/messages");
    // FR-018: credencial em header, nunca em query string.
    expect(url).not.toContain("tok-interno");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-interno");
    const corpo = JSON.parse(init.body as string);
    // A conexão vai como veio do CANAL (FR-017) e o tipo é o vocabulário
    // inglês compartilhado — a 1ª versão traduzia para "texto" e todo envio
    // voltaria 400 (medido em messages.go:293 do gateway).
    expect(corpo).toMatchObject({ connection_id: "conn-uuid-1", to: "+5585999990000", tipo: "text" });
    // organization_id NUNCA viaja: o gateway resolve o dono pela conexão.
    expect(JSON.stringify(corpo)).not.toContain("organization");
  });

  it("mídia vai por referência de endereço, nunca embutida (FR-024)", async () => {
    fetchMock.mockResolvedValue(respostaOk({ message_id: "wamid-m" }));
    await gatewayAdapter.send({
      sessionRef: "conn-1",
      to: "+55",
      kind: "image",
      media: { url: "https://storage/assinada.png", mime: "image/png", filename: "foto.png" },
    });
    const corpo = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(corpo.midia_url).toBe("https://storage/assinada.png");
    expect(corpo.midia_mime).toBe("image/png");
  });

  it("a legenda da mídia viaja — imagem com texto não chega muda", async () => {
    // Achado na análise de fim da Fase 3: a primeira versão do adapter ignorava
    // `media.caption`. O gateway repassa a legenda no campo `texto`, ao lado da
    // mídia (`sender/dispatch.go:63`), e os dois adapters antigos já mandavam —
    // só o novo esquecia. O cliente recebia a foto sem uma palavra, e nada no
    // CRM indicava que faltou algo: para ele o envio deu certo.
    fetchMock.mockResolvedValue(respostaOk({ message_id: "wamid-l" }));
    await gatewayAdapter.send({
      sessionRef: "conn-1",
      to: "+55",
      kind: "image",
      media: {
        url: "https://storage/assinada.png",
        mime: "image/png",
        caption: "olha a proposta que preparei",
      },
    });
    const corpo = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(corpo.texto).toBe("olha a proposta que preparei");
  });

  it("resposta sem message_id devolve null — nunca inventa id (FR-019)", async () => {
    fetchMock.mockResolvedValue(respostaOk({}));
    const res = await gatewayAdapter.send({ sessionRef: "c", to: "+55", kind: "text", body: "x" });
    expect(res.externalId).toBeNull();
  });

  it("erro do gateway sobe com status e corpo — diagnóstico possível", async () => {
    fetchMock.mockResolvedValue(respostaOk({ erro: "conexao_desconectada" }, 409));
    await expect(
      gatewayAdapter.send({ sessionRef: "c", to: "+55", kind: "text", body: "x" }),
    ).rejects.toThrow(/409.*conexao_desconectada/);
  });

  it("sem configuração é NOOP com null — mesmo comportamento do adapter WAHA", async () => {
    envFalso.GATEWAY_BASE_URL = "";
    const res = await gatewayAdapter.send({ sessionRef: "c", to: "+55", kind: "text", body: "x" });
    expect(res.externalId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("gatewayAdapter.resolveRecipient", () => {
  it("grupo não tem endereço — o caminho novo mantém o impedimento (FR-025)", () => {
    expect(
      gatewayAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "g@g.us",
        phoneNumber: "+55",
        waIdentity: null,
      }),
    ).toBeNull();
  });

  it("a identidade canônica do contato vence o telefone solto", () => {
    expect(
      gatewayAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5585000000000",
        waIdentity: "phone:+5585999990000",
      }),
    ).toBe("+5585999990000");
  });
});

/**
 * Spec 006 — os campos que o gateway JÁ aceitava e o CRM nunca preenchia.
 *
 * Nenhum deles é campo novo do outro lado: `quoted_id`, `latitude`, `longitude`,
 * `nome`, `endereco` e `contatos` estão no `envioRequest` do gateway desde antes
 * desta feature. O defeito era só de cá — e é por isso que citar era impossível e
 * `location`/`contact` eram tipos anunciados e inenviáveis.
 */
describe("gatewayAdapter.send — formas de mensagem da spec 006", () => {
  async function corpoEnviado(envelope: Parameters<typeof gatewayAdapter.send>[0]) {
    fetchMock.mockResolvedValue(respostaOk({ message_id: "wamid.OK" }));
    await gatewayAdapter.send(envelope);
    return JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
  }

  it("a CITAÇÃO viaja como quoted_id", async () => {
    const corpo = await corpoEnviado({
      sessionRef: "conn-1",
      to: "+5585999990000",
      kind: "text",
      body: "sim, cobre",
      replyToExternalId: "wamid.ORIGINAL",
    });
    expect(corpo.quoted_id).toBe("wamid.ORIGINAL");
  });

  it("sem citação, o campo NÃO vai — corpo enxuto é contrato, não estilo", async () => {
    const corpo = await corpoEnviado({
      sessionRef: "conn-1",
      to: "+5585999990000",
      kind: "text",
      body: "oi",
    });
    expect(corpo).not.toHaveProperty("quoted_id");
  });

  it("a citação acompanha MÍDIA também, não só texto", async () => {
    const corpo = await corpoEnviado({
      sessionRef: "conn-1",
      to: "+5585999990000",
      kind: "image",
      replyToExternalId: "wamid.ORIGINAL",
      media: { url: "https://s/foto.jpg", mime: "image/jpeg", filename: "foto.jpg", caption: "essa" },
    });
    expect(corpo.quoted_id).toBe("wamid.ORIGINAL");
    expect(corpo.midia_url).toBe("https://s/foto.jpg");
  });

  it("localização vai como latitude/longitude/nome/endereco", async () => {
    const corpo = await corpoEnviado({
      sessionRef: "conn-1",
      to: "+5585999990000",
      kind: "location",
      location: { lat: -23.5613, lng: -46.6565, name: "Clínica X", address: "Av. Paulista, 1000" },
    });
    expect(corpo.latitude).toBe(-23.5613);
    expect(corpo.longitude).toBe(-46.6565);
    expect(corpo.nome).toBe("Clínica X");
    expect(corpo.endereco).toBe("Av. Paulista, 1000");
  });

  it("contato vai como `contatos` com nome e telefone — UM telefone por entrada", async () => {
    // O gateway modela `contatoRequest{Nome,Telefone}`, não uma lista de números.
    // Medido antes de escrever: mandar `telefones: []` faria todo envio de contato
    // voltar 400 falando de campo obrigatório ausente.
    const corpo = await corpoEnviado({
      sessionRef: "conn-1",
      to: "+5585999990000",
      kind: "contact",
      contacts: [{ name: "Dra. Ana", phones: ["+5511999998888", "+5511777776666"] }],
    });
    expect(corpo.contatos).toEqual([
      { nome: "Dra. Ana", telefone: "+5511999998888" },
      { nome: "Dra. Ana", telefone: "+5511777776666" },
    ]);
  });

  it("o `tipo` continua sendo o vocabulário inglês compartilhado com o gateway", async () => {
    const corpo = await corpoEnviado({
      sessionRef: "conn-1",
      to: "+5585999990000",
      kind: "location",
      location: { lat: 1, lng: 2 },
    });
    expect(corpo.tipo).toBe("location");
  });
});
