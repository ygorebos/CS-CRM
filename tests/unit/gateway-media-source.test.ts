/**
 * T046 — o host que vem no envelope não decide de onde o CRM baixa.
 *
 * ## O que está sendo vigiado, e por que não é "detalhe de implementação"
 *
 * `media.ref` descreve um acontecimento do mundo externo. Se o download usasse
 * o host que vem ali, um envelope forjado faria o CRM buscar arquivo em endereço
 * arbitrário — de dentro da rede onde ele roda, com as credenciais dele. É SSRF
 * com o servidor fazendo o trabalho, e num produto multi-tenant a rede interna
 * é onde ficam o Postgres e o Redis de todo mundo.
 *
 * A defesa é de CONSTRUÇÃO, não de validação: não existe lista de hosts
 * permitidos para manter — o host simplesmente nunca vem do payload. Estes
 * testes provam a construção, e a sabotagem do T051 (usar o host do payload) é
 * o que confirma que eles vigiam de verdade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BASE = "http://gateway:8080";

vi.mock("@/lib/env", () => ({
  env: {
    GATEWAY_BASE_URL: "http://gateway:8080",
    GATEWAY_MAX_MEDIA_BYTES: 100 * 1024 * 1024,
    GATEWAY_INTERNAL_TOKEN: "token-interno-do-gateway",
  },
}));

import { fetchGatewayMedia } from "@/lib/messaging/media/gateway-source";
import { MediaTooLargeError } from "@/lib/messaging/media/types";

function respondeCom(
  bytes: number,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(new ArrayBuffer(bytes), {
        status: init.status ?? 200,
        headers: init.headers ?? { "content-type": "image/jpeg" },
      }),
    );
}

describe("fetchGatewayMedia (T046)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("baixa o anexo pela base configurada e devolve buffer + mime", async () => {
    const fetchMock = respondeCom(3);
    vi.stubGlobal("fetch", fetchMock);

    const media = await fetchGatewayMedia("media/abc123");

    expect(media.mime).toBe("image/jpeg");
    expect(media.buffer.byteLength).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/media/abc123`, expect.anything());
  });

  it("DESCARTA o host que veio no envelope e reconstrói sobre a base", async () => {
    const fetchMock = respondeCom(2);
    vi.stubGlobal("fetch", fetchMock);

    await fetchGatewayMedia("http://evil.example.com/media/abc123?x=1");

    // O caminho e a query sobrevivem; o host, não. Se este teste passar a
    // esperar `evil.example.com`, alguém trocou a defesa por confiança.
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/media/abc123?x=1`, expect.anything());
  });

  it("descarta também host interno plausível — a defesa não é lista de bloqueio", async () => {
    const fetchMock = respondeCom(2);
    vi.stubGlobal("fetch", fetchMock);

    // 169.254.169.254 é o endereço de metadados de nuvem: o alvo clássico de
    // SSRF. Ele não é recusado por estar numa lista — é recusado porque host
    // nenhum do payload é usado.
    await fetchGatewayMedia("http://169.254.169.254/latest/meta-data/");

    const [urlChamada] = fetchMock.mock.calls[0] as [string];
    expect(urlChamada.startsWith(`${BASE}/`)).toBe(true);
    expect(urlChamada).not.toContain("169.254.169.254");
  });

  it("caminho absoluto continua resolvendo DENTRO da base", async () => {
    const fetchMock = respondeCom(2);
    vi.stubGlobal("fetch", fetchMock);

    await fetchGatewayMedia("/media/abc123");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/media/abc123`, expect.anything());
  });

  it("manda a credencial do CRM no download", async () => {
    const fetchMock = respondeCom(2);
    vi.stubGlobal("fetch", fetchMock);

    await fetchGatewayMedia("media/abc123");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: "Bearer token-interno-do-gateway" },
      }),
    );
  });

  it("recusa ref vazia em vez de baixar a raiz do gateway", async () => {
    const fetchMock = respondeCom(2);
    vi.stubGlobal("fetch", fetchMock);

    // Sem isto, `new URL("", base)` viraria a própria base: o CRM guardaria a
    // página inicial do gateway como se fosse o anexo do cliente.
    await expect(fetchGatewayMedia("   ")).rejects.toThrow("gateway_media_ref_invalida");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propaga o status HTTP de erro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(fetchGatewayMedia("media/sumiu.jpg")).rejects.toThrow("gateway_media_404");
  });

  it("recusa anexo acima do teto declarado no content-length", async () => {
    vi.stubGlobal(
      "fetch",
      respondeCom(8, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(200 * 1024 * 1024),
        },
      }),
    );
    await expect(fetchGatewayMedia("media/grande.mp4")).rejects.toThrow(MediaTooLargeError);
  });

  it("recusa anexo que MENTE no content-length", async () => {
    // O cabeçalho é declaração do outro lado. Conferir só ele deixaria passar
    // exatamente quem quisesse estourar a memória do processo.
    vi.stubGlobal(
      "fetch",
      respondeCom(200 * 1024 * 1024 + 1, {
        headers: { "content-type": "video/mp4", "content-length": "10" },
      }),
    );
    await expect(fetchGatewayMedia("media/mentiroso.mp4")).rejects.toThrow(MediaTooLargeError);
  });

  it("usa o mime do envelope quando o content-type vem vazio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new ArrayBuffer(2), { status: 200 })),
    );
    const media = await fetchGatewayMedia("media/x", "audio/ogg; codecs=opus");
    expect(media.mime).toBe("audio/ogg; codecs=opus");
  });
});

describe("fetchGatewayMedia sem base configurada", () => {
  it("recusa antes de tocar a rede", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: {
        GATEWAY_BASE_URL: "",
        GATEWAY_MAX_MEDIA_BYTES: 100 * 1024 * 1024,
        GATEWAY_INTERNAL_TOKEN: "",
      },
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchGatewayMedia: semBase } = await import("@/lib/messaging/media/gateway-source");
    // Sem base não há "melhor esforço" possível: qualquer tentativa usaria o
    // host do payload, que é o que a função existe para não fazer.
    await expect(semBase("media/abc")).rejects.toThrow("gateway_media_base_missing");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.doUnmock("@/lib/env");
    vi.resetModules();
    vi.unstubAllGlobals();
  });
});
