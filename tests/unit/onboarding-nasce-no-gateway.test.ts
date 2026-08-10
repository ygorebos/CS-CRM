/**
 * A porta do onboarding provisiona NO GATEWAY quando a instalação usa gateway.
 *
 * ## O defeito que este arquivo vigia, medido em produção (2026-08-10)
 *
 * `ensureChannelSession` chamava `criarConexaoDeCanal` sempre. Com o gateway
 * configurado, a conexão do usuário novo nascia assim:
 *
 *     ingest_path           = 'gateway'   (o carimbo segue GATEWAY_INBOUND_ENABLED)
 *     gateway_connection_id = NULL        (não havia conexão no gateway)
 *     provider              = 'waha'      (a sessão nasceu no WAHA)
 *
 * Uma linha que diz receber pela rota nova e foi criada na antiga. A mensagem
 * não se perdia — só o webhook do gateway lê `ingest_path` —, mas o gateway
 * ficava de pé e sem uso na porta por onde passam 100% dos usuários novos.
 *
 * ## Por que o teste é do MÓDULO e não da rota
 *
 * A regra que interessa é "qual criador é escolhido", e ela é uma função das
 * variáveis de ambiente. Exercitá-la pela rota exigiria dublê de sessão, de
 * cookie e de cliente Supabase — três peças para medir um `if`, e nenhuma delas
 * é o que quebrou.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { caminhoDeIngestaoParaConexaoNova } from "@/lib/gateway/caminho-de-ingestao";
import { pngDeDataUrl } from "@/app/api/v1/onboarding/whatsapp/qr/route";

describe("qual criador a porta do onboarding escolhe", () => {
  const originais = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originais };
  });

  it("com gateway configurado, provisiona no gateway — não só no WAHA", async () => {
    // ADMIN e não INTERNAL: são tokens diferentes com donos diferentes — o
    // interno é a portaria de ENVIO, o admin é o que PROVISIONA instância no
    // provedor (e custa dinheiro). Configurar só o interno deixa o CRM falando
    // com o gateway e sem conseguir criar conexão nenhuma. Foi exatamente o
    // estado em que a produção ficou em 2026-08-10, e este teste é o que o
    // denunciou.
    process.env.GATEWAY_BASE_URL = "https://gateway-crm.exemplo";
    process.env.GATEWAY_ADMIN_TOKEN = "adm";
    const { provisionamentoConfigurado } = await import("@/lib/gateway/provisionamento");
    expect(provisionamentoConfigurado()).toBe(true);
  });

  it("com endereço e SEM token de admin, não provisiona — e isso é proposital", async () => {
    process.env.GATEWAY_BASE_URL = "https://gateway-crm.exemplo";
    process.env.GATEWAY_ADMIN_TOKEN = "";
    const { provisionamentoConfigurado } = await import("@/lib/gateway/provisionamento");
    expect(provisionamentoConfigurado()).toBe(false);
  });

  it("sem endereço do gateway, segue no caminho antigo", async () => {
    process.env.GATEWAY_BASE_URL = "";
    process.env.GATEWAY_ADMIN_TOKEN = "adm";
    const { provisionamentoConfigurado } = await import("@/lib/gateway/provisionamento");
    expect(provisionamentoConfigurado()).toBe(false);
  });

  it("o carimbo de ingestão NÃO é prova de que a conexão é do gateway", () => {
    // Esta é a assimetria que produziu o defeito: o carimbo segue o interruptor
    // global, então dizer 'gateway' não implica ter conexão no gateway. Quem
    // decide isso é `gateway_connection_id`, e é por ele que as rotas perguntam.
    expect(caminhoDeIngestaoParaConexaoNova(true)).toBe("gateway");
    expect(caminhoDeIngestaoParaConexaoNova(false)).toBe("legacy");
  });
});

describe("o QR do gateway chega no <img> da tela", () => {
  it("converte o data: URL do gateway em bytes de PNG", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const bytes = pngDeDataUrl(`data:image/png;base64,${png.toString("base64")}`);
    expect(bytes).not.toBeNull();
    expect(Array.from(bytes!.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("recusa o que não é PNG em vez de devolver imagem morta", () => {
    // O provedor também sabe devolver QR em texto puro. Repassar isso como
    // `image/png` daria <img> quebrado na primeira tela do produto.
    expect(pngDeDataUrl("2@AbCd/EfGh+IjKl=")).toBeNull();
    expect(pngDeDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeNull();
    expect(pngDeDataUrl(null)).toBeNull();
  });
});
