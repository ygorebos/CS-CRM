/**
 * O limite do menu é do CANAL, e é imposto ANTES da rede (spec 006, FR-019).
 *
 * O WhatsApp desenha botões até 3 opções e lista acima disso; o canal oficial
 * recusa acima de 10. Deixar passar faria o provedor recusar — e o corretor
 * descobriria o teto pelo erro, com o número do provedor e não com o nosso.
 *
 * O que este arquivo NÃO testa: o valor 10 estar certo. Isso é a matriz de
 * capacidade, medida contra o gateway em `canal-capacidades-matriz.test.ts`.
 * Aqui se testa que o limite EXISTE e é o do canal — não um número escrito na
 * tela nem no schema.
 */
import { describe, expect, it } from "vitest";

import { capabilitiesOf } from "@/lib/channels/capabilities";
import { CAPABILITY_POR_TIPO, menuPayloadSchema } from "@/lib/messaging/payloads";
import { sendMessageSchema } from "@/lib/schemas/messaging";

const CONV = "0e5d3a1c-1111-4111-8111-111111111111";

describe("teto de opções do menu", () => {
  it("o menu declara depender da capacidade do canal, não de um número fixo", () => {
    expect(CAPABILITY_POR_TIPO.menu).toBe("menuMaxOptions");
  });

  it("o schema NÃO carrega o teto — ele é do canal", () => {
    // Um `max()` aqui seria a matriz de capacidade escrita duas vezes, e a
    // segunda cópia envelhece: o dia em que um canal aceitar 20, o schema
    // recusaria 11 sem ninguém entender por quê.
    const vinteOpcoes = Array.from({ length: 20 }, (_, i) => `Opção ${i + 1}`);
    expect(menuPayloadSchema.safeParse({ options: vinteOpcoes }).success).toBe(true);
  });

  it("menu sem nenhuma opção é recusado — botão nenhum não é menu", () => {
    expect(menuPayloadSchema.safeParse({ options: [] }).success).toBe(false);
  });

  it("o canal que a Central cria hoje tem teto declarado", () => {
    const teto = capabilitiesOf("whatsapp_uazapi").menuMaxOptions;
    expect(teto).not.toBeNull();
    expect(teto!).toBeGreaterThan(0);
  });

  it("canal sem menu declara null — e é isso que desliga a ação na tela", () => {
    expect(capabilitiesOf("instagram").menuMaxOptions).toBeNull();
    expect(capabilitiesOf("messenger").menuMaxOptions).toBeNull();
  });

  it("menu exige o texto da pergunta junto com as opções", () => {
    // Opções sem pergunta chegam ao cliente como botões sem contexto.
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "menu",
      menu: { options: ["Individual", "Familiar"] },
    });
    expect(r.success).toBe(false);
  });

  it("menu completo passa a validação de corpo", () => {
    const r = sendMessageSchema.safeParse({
      conversation_id: CONV,
      type: "menu",
      body: "Qual plano te interessa?",
      menu: { options: ["Individual", "Familiar"], footer: "Responda tocando" },
    });
    expect(r.success).toBe(true);
  });

  it("cta_url exige rótulo e URL https — botão http é downgrade que nós oferecemos", () => {
    expect(
      sendMessageSchema.safeParse({
        conversation_id: CONV,
        type: "cta_url",
        body: "Simule agora",
        cta_url: { button_label: "Abrir", button_url: "http://exemplo.com" },
      }).success,
    ).toBe(false);

    expect(
      sendMessageSchema.safeParse({
        conversation_id: CONV,
        type: "cta_url",
        body: "Simule agora",
        cta_url: { button_label: "Abrir", button_url: "https://exemplo.com" },
      }).success,
    ).toBe(true);
  });

  it("pedido de localização exige o texto do pedido", () => {
    expect(
      sendMessageSchema.safeParse({ conversation_id: CONV, type: "location_request" }).success,
    ).toBe(false);
    expect(
      sendMessageSchema.safeParse({
        conversation_id: CONV,
        type: "location_request",
        body: "Me manda sua localização",
      }).success,
    ).toBe(true);
  });
});
