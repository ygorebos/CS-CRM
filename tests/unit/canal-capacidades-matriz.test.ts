/**
 * A matriz de capacidade responde por TODO canal, e cada capacidade tem quem a
 * consuma.
 *
 * Dois defeitos distintos, ambos silenciosos:
 *
 * 1. **Canal sem linha.** `capabilitiesOf` é fail-closed e estoura, mas isso só
 *    acontece em runtime, no envio, na cara do corretor. Aqui a ausência aparece
 *    em teste — e o `Record<ChannelProvider, …>` do TypeScript não basta: ele
 *    pega chave faltando, não valor incoerente.
 *
 * 2. **Capacidade que ninguém consome.** É código morto que parece governança:
 *    lê-se a matriz, acredita-se que a tela obedece, e ela nem pergunta. Este
 *    teste cobra que toda capability nova esteja ligada ao vocabulário de envio
 *    ou a um consumidor declarado.
 */
import { describe, expect, it } from "vitest";

import {
  CHANNEL_CAPABILITIES,
  capabilitiesOf,
  type ChannelProvider,
} from "@/lib/channels/capabilities";
import { CAPABILITY_POR_TIPO } from "@/lib/messaging/payloads";

const PROVIDERS: ChannelProvider[] = [
  "waha",
  "meta_cloud",
  "whatsapp_uazapi",
  "whatsapp_cloud",
  "instagram",
  "messenger",
];

/**
 * As capacidades da spec 006. Escritas aqui de propósito: se uma sumir da matriz,
 * este teste quebra em vez de deixar a tela perguntar por um campo `undefined` —
 * que em JavaScript é falsy e desligaria a ação **em silêncio**, que é o pior
 * desfecho (a ação some da tela e ninguém sabe por quê).
 */
const CAPACIDADES_DE_FORMA = [
  "quotedReply",
  "sticker",
  "location",
  "contactCard",
  "menuMaxOptions",
  "ctaUrl",
  "locationRequest",
] as const;

describe("matriz de capacidade de canal", () => {
  it("todo provider tem linha na matriz", () => {
    for (const p of PROVIDERS) {
      expect(() => capabilitiesOf(p), `provider ${p} sem linha`).not.toThrow();
    }
    expect(Object.keys(CHANNEL_CAPABILITIES).sort()).toEqual([...PROVIDERS].sort());
  });

  it("toda capacidade de forma está declarada em TODO provider, sem undefined", () => {
    for (const p of PROVIDERS) {
      const caps = capabilitiesOf(p) as unknown as Record<string, unknown>;
      for (const c of CAPACIDADES_DE_FORMA) {
        expect(
          caps[c],
          `${p}.${c} está undefined — em JavaScript isso é falsy e desliga a ação ` +
            `na tela sem ninguém saber. Declare o valor, mesmo que seja false/null.`,
        ).toBeDefined();
      }
    }
  });

  it("menuMaxOptions é número positivo ou null — nunca zero", () => {
    for (const p of PROVIDERS) {
      const teto = capabilitiesOf(p).menuMaxOptions;
      if (teto === null) continue;
      expect(teto, `${p}: teto de menu zero significaria "tem menu, sem opção"`).toBeGreaterThan(0);
    }
  });

  it("capacidade citada por um tipo de envio existe na matriz", () => {
    // O elo que impede capability órfã: se um tipo diz precisar de `sticker` e a
    // matriz não tiver esse campo, a checagem do handler leria undefined e
    // deixaria passar tudo.
    for (const [tipo, cap] of Object.entries(CAPABILITY_POR_TIPO)) {
      if (cap === null) continue;
      for (const p of PROVIDERS) {
        const caps = capabilitiesOf(p) as unknown as Record<string, unknown>;
        expect(caps[cap], `tipo ${tipo} exige a capacidade ${cap}, ausente em ${p}`).toBeDefined();
      }
    }
  });

  it("o canal que a Central cria hoje suporta as formas que a tela vai oferecer", () => {
    // Não é zelo: é a diferença entre implementar a jornada e implementar uma
    // jornada que nenhum usuário alcança. `whatsapp_uazapi` é o que
    // `CHANNEL_PROVIDER_GATEWAY_WHATSAPP` cria.
    const caps = capabilitiesOf("whatsapp_uazapi");
    expect(caps.quotedReply).toBe(true);
    expect(caps.sticker).toBe(true);
    expect(caps.location).toBe(true);
    expect(caps.contactCard).toBe(true);
  });

  it("Messenger NÃO declara citação — o gateway recusa quoted_id nele com 422", () => {
    // Medido em gateway_go/internal/handlers/messages.go:264. Declarar `true` aqui
    // ofereceria na tela uma ação cujo desfecho garantido é erro de capacidade.
    expect(capabilitiesOf("messenger").quotedReply).toBe(false);
  });
});
