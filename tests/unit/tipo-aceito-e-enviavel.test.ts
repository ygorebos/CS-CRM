/**
 * Todo tipo que a API aceita, ela consegue entregar (spec 006, FR-017).
 *
 * ## O defeito que este arquivo existe para não deixar voltar
 *
 * `location` e `contact` estavam no enum de tipos de envio desde sempre — e eram
 * IMPOSSÍVEIS de enviar. O corpo da requisição não tinha onde carregar coordenada
 * nem cartão de contato, então o pedido saía incompleto e o canal respondia
 * "campos obrigatórios ausentes: latitude e longitude". Um `422` do provedor,
 * depois da rede, na cara do corretor.
 *
 * Isso é pior que não ter o tipo: a lista anunciava uma capacidade que não
 * existia. O que este teste cobra é o elo — enum de envio, carga declarada e
 * capacidade de canal andam juntos, ou nenhum tipo novo nasce.
 */
import { describe, expect, it } from "vitest";

import { capabilitiesOf, type ChannelProvider } from "@/lib/channels/capabilities";
import { OUTBOUND_MESSAGE_TYPES } from "@/lib/messaging/message-types";
import { CAPABILITY_POR_TIPO, EXIGENCIA_POR_TIPO } from "@/lib/messaging/payloads";
import { sendMessageSchema } from "@/lib/schemas/messaging";

const CONV = "0e5d3a1c-1111-4111-8111-111111111111";

describe("nenhum tipo é aceito sem poder ser entregue", () => {
  it("todo tipo do vocabulário de envio declara o que exige", () => {
    for (const tipo of OUTBOUND_MESSAGE_TYPES) {
      expect(
        EXIGENCIA_POR_TIPO[tipo],
        `tipo "${tipo}" é aceito no envio e não declara carga — é exatamente o ` +
          `defeito de location/contact: anunciado e inenviável`,
      ).toBeDefined();
    }
  });

  it("todo tipo do vocabulário de envio declara qual capacidade exige", () => {
    for (const tipo of OUTBOUND_MESSAGE_TYPES) {
      expect(CAPABILITY_POR_TIPO, `tipo "${tipo}" sem capacidade declarada`).toHaveProperty(tipo);
    }
  });

  it("a capacidade citada por um tipo existe em todo canal", () => {
    const providers: ChannelProvider[] = [
      "waha",
      "meta_cloud",
      "whatsapp_uazapi",
      "whatsapp_cloud",
      "instagram",
      "messenger",
    ];
    for (const [tipo, cap] of Object.entries(CAPABILITY_POR_TIPO)) {
      if (cap === null) continue;
      for (const p of providers) {
        const caps = capabilitiesOf(p) as unknown as Record<string, unknown>;
        expect(caps[cap], `tipo ${tipo} exige ${cap}, ausente em ${p}`).toBeDefined();
      }
    }
  });
});

describe("validação da carga por tipo, antes da rede", () => {
  it("location SEM coordenada é recusada nomeando o campo", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "location",
      body: "olha o endereço",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Nomear o campo é o que separa "recusado com motivo" de "recusado".
      expect(r.error.issues.some((i) => i.path.includes("location"))).toBe(true);
    }
  });

  it("location com coordenada válida passa", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "location",
      location: { lat: -23.5613, lng: -46.6565, name: "Clínica X" },
    });
    expect(r.success).toBe(true);
  });

  it("coordenada fora do intervalo é recusada — não é o canal que vai descobrir", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "location",
      location: { lat: 999, lng: -46.6565 },
    });
    expect(r.success).toBe(false);
  });

  it("contact SEM contatos é recusado nomeando o campo", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "contact",
      body: "segue o contato",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("contacts"))).toBe(true);
    }
  });

  it("contato sem telefone é recusado — cartão sem número não serve para nada", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "contact",
      contacts: [{ name: "Dra. Ana", phones: [] }],
    });
    expect(r.success).toBe(false);
  });

  it("contact válido passa", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "contact",
      contacts: [{ name: "Dra. Ana", phones: ["+5511999998888"] }],
    });
    expect(r.success).toBe(true);
  });

  it("texto sem corpo continua sendo recusado", () => {
    const r = sendMessageSchema.safeParse({ conversation_id: CONV, type: "text" });
    expect(r.success).toBe(false);
  });

  it("mídia sem anexo continua sendo recusada", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "image",
      body: "olha a foto",
    });
    expect(r.success).toBe(false);
  });

  it("figurinha exige anexo — não é texto com outro nome", () => {
    const r = sendMessageSchema.safeParse({ conversation_id: CONV, type: "sticker", body: "oi" });
    expect(r.success).toBe(false);
  });

  it("template sem nome é recusado antes de qualquer custo", () => {
    // Template é o único tipo cobrado por entrega. Deixar sair sem nome gastaria
    // dinheiro para receber erro.
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "template",
      body: "oi",
    });
    expect(r.success).toBe(false);
  });
});

describe("citação no envio", () => {
  it("reply_to_message_id é UUID do CRM, não identificador do canal", () => {
    // Aceitar `wamid.…` pelo corpo deixaria o cliente apontar para mensagem de
    // outro tenant — a Lei Zero pela porta dos fundos.
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "text",
      body: "sim",
      reply_to_message_id: "wamid.ABC",
    });
    expect(r.success).toBe(false);
  });

  it("citação vale para qualquer tipo, não só texto", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "image",
      media_storage_path: "org/conv/foto.jpg",
      reply_to_message_id: "0e5d3a1c-2222-4222-8222-222222222222",
    });
    expect(r.success).toBe(true);
  });
});
