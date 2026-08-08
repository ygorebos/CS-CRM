/**
 * Canal não nasce sem saber enviar (spec 004, FR-014 / T030).
 *
 * ## O defeito que este arquivo impede
 *
 * `getAdapter()` é fail-closed, e isso está certo — mas ele falha **no envio**:
 * fundo na pilha, com `unknown_channel_provider`, possivelmente dias depois de o
 * corretor ter pareado o número. Para quem está na tela o desfecho é pior que um
 * erro: o canal conectou, recebe mensagem, e **nunca responde**. É o "canal morto
 * na mão do corretor" que a FR-014 nomeia, e ele não se parece com defeito — se
 * parece com o produto sendo ruim.
 *
 * ## Por que existe agora, se hoje não acontece
 *
 * Medido: as duas rotas de criação gravam `waha` (default da coluna) e
 * `meta_cloud`, e os dois têm adapter. Nenhum caminho atual produz canal mudo.
 *
 * A guarda é para o que a spec 004 vai fazer: acrescentar providers do gateway.
 * O instante em que alguém acrescentar um provider sem adapter é exatamente o
 * instante em que ninguém vai lembrar desta consequência — e o teste que falha
 * ali é mais barato que o corretor descobrindo pelo cliente.
 */
import { describe, expect, it } from "vitest";

import { getAdapter, providerPodeEnviar, providersQuePodemEnviar } from "@/lib/channels";
import type { ChannelProvider } from "@/lib/channels/types";

/**
 * Providers que uma rota de criação pode gravar hoje.
 *
 * `waha` é o default da coluna `channel_sessions.provider`
 * (`baseline.sql:1891`), usado por `app/api/v1/channel-sessions/route.ts`;
 * `meta_cloud` é o de `app/api/v1/channels/official/route.ts:164`.
 *
 * **Ao acrescentar rota de criação, acrescente o provider aqui.** A lista existir
 * é o que torna a asserção verificável em vez de opinião.
 */
const PROVIDERS_QUE_ROTA_DE_CRIACAO_GRAVA: ChannelProvider[] = ["waha", "meta_cloud"];

describe("canal não nasce sem saber enviar (FR-014)", () => {
  it.each(PROVIDERS_QUE_ROTA_DE_CRIACAO_GRAVA)(
    "provider '%s' — criável hoje, portanto tem de saber enviar",
    (provider) => {
      expect(
        providerPodeEnviar(provider),
        `Uma rota de criação grava '${provider}', e ele não tem adapter de envio.\n` +
          "Isso cria canal que conecta, recebe e nunca responde — e o corretor descobre\n" +
          "pelo cliente. Ou o adapter entra, ou a criação passa a recusar com erro legível.",
      ).toBe(true);
    },
  );

  it("provider sem adapter é reconhecido como incapaz de enviar, e não silenciosamente aceito", () => {
    // Estes chegam pelo gateway (spec 001); o envio deles ainda não existe.
    // `whatsapp_uazapi` SAIU desta lista em 2026-08-08: a Fase 3 lhe deu adapter.
    for (const provider of ["whatsapp_cloud", "instagram", "messenger"] as const) {
      expect(providerPodeEnviar(provider)).toBe(false);
      expect(() => getAdapter(provider)).toThrow(/unknown_channel_provider/);
    }
  });

  it("a matriz de envio não encolhe sem alguém notar", () => {
    // Se um adapter for removido ou virar null, esta lista muda e o teste reprova.
    // Não é redundância com o caso acima: aquele cobre o que É criável, este cobre
    // o inverso — perder capacidade de envio que já existia.
    expect(providersQuePodemEnviar().sort()).toEqual(["meta_cloud", "waha", "whatsapp_uazapi"]);
  });
});
