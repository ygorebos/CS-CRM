/**
 * T057 — o canal de origem na tela.
 *
 * Duas regras, e a segunda é a que costuma faltar em selo de UI:
 *
 *  1. O que aparece é o nome que o usuário reconhece ("Instagram"), não o
 *     vocabulário de banco ("whatsapp_uazapi"). Ele não escolheu uazapi; ele
 *     escolheu WhatsApp.
 *  2. **Canal implícito não ganha selo.** Hoje ~100% das conversas são WhatsApp:
 *     marcar todas seria ruído em toda linha, e ruído constante deixa de ser
 *     lido — inclusive no dia em que aparecesse a conversa diferente, que é a
 *     única que o selo existe para destacar.
 */
import { describe, expect, it } from "vitest";

import { rotuloDeCanal, seloDeCanal } from "@/lib/channels/rotulo-de-canal";

describe("rótulo de canal (T057)", () => {
  it("traduz o vocabulário de banco para o nome que o usuário reconhece", () => {
    expect(rotuloDeCanal("whatsapp_uazapi")).toBe("WhatsApp");
    expect(rotuloDeCanal("meta_cloud")).toBe("WhatsApp");
    expect(rotuloDeCanal("waha")).toBe("WhatsApp");
    expect(rotuloDeCanal("instagram")).toBe("Instagram");
    expect(rotuloDeCanal("messenger")).toBe("Messenger");
  });

  it("não mostra selo para o canal implícito", () => {
    for (const p of ["waha", "whatsapp_uazapi", "meta_cloud", "whatsapp_cloud"]) {
      expect(seloDeCanal(p)).toBeNull();
    }
  });

  it("mostra selo para o canal que é diferente", () => {
    expect(seloDeCanal("instagram")).toBe("Instagram");
    expect(seloDeCanal("messenger")).toBe("Messenger");
  });

  it("canal que este build não conhece não vira selo com nome cru", () => {
    // O gateway pode aprender um canal antes de o CRM ganhar release — é a
    // promessa da US4. Um selo escrito "telegram_beta_2" seria pior que selo
    // nenhum: expõe nome interno e não ajuda ninguém.
    expect(seloDeCanal("telegram_beta_2")).toBeNull();
    expect(rotuloDeCanal("telegram_beta_2")).toBeNull();
  });

  it("ausência de canal não quebra a tela", () => {
    // Conversa em cache de antes do campo existir, ou conexão apagada.
    expect(seloDeCanal(null)).toBeNull();
    expect(seloDeCanal(undefined)).toBeNull();
    expect(rotuloDeCanal("")).toBeNull();
  });
});
