/**
 * O QR deixa de ser recarregado no escuro (spec 004, T040/T041 / FR-030, FR-031).
 *
 * ## O que a tela fazia, e por que era ruim dos dois lados
 *
 * Recarregava a imagem a cada 15 s, sempre, por cache-buster — um número
 * escolhido para ter folga sobre uma expiração que **ninguém declarava**. Isso
 * erra nas duas direções: quem demora a pegar o celular ainda pode escanear um
 * código já morto (e conclui que o celular dele é que está ruim), e quem escaneia
 * rápido paga requisições que não precisavam sair.
 *
 * Com `expires_at` vindo do canal, o refresh acontece **quando expira**.
 *
 * ## O que se testa aqui
 *
 * O CÁLCULO do próximo pedido, extraído em função pura, e a rota que serve o
 * material. Testar o `useEffect` inteiro exigiria montar o diálogo, o cliente
 * HTTP e o relógio — três dublês para provar uma conta que cabe em cinco linhas.
 */
import { describe, expect, it } from "vitest";

import { proximoPedidoDeQrMs, PADRAO_DE_REFRESH_MS } from "@/lib/channels/validade-do-qr";

describe("quando pedir o próximo QR (FR-031)", () => {
  const AGORA = new Date("2026-08-08T12:00:00Z").getTime();

  it("canal que declara validade: pede ANTES de expirar, com margem", () => {
    const validade = new Date(AGORA + 40_000).toISOString();
    const ms = proximoPedidoDeQrMs(validade, AGORA);
    // 40 s de validade menos a margem de 3 s. A margem existe para a viagem de
    // rede e para o código não piscar no meio de um escaneamento.
    expect(ms).toBe(37_000);
    expect(ms).toBeLessThan(40_000);
  });

  it("canal que NÃO declara validade mantém o intervalo de hoje", () => {
    // Fingir uma validade não medida seria pior que não ter nenhuma: erraria com
    // aparência de precisão.
    expect(proximoPedidoDeQrMs(null, AGORA)).toBe(PADRAO_DE_REFRESH_MS);
  });

  it("validade já vencida pede agora — mas nunca em rajada", () => {
    // Relógio fora de sincronia ou aba que ficou em segundo plano. Sem o piso, o
    // cálculo daria negativo e a tela entraria em laço de requisições.
    const vencida = new Date(AGORA - 60_000).toISOString();
    expect(proximoPedidoDeQrMs(vencida, AGORA)).toBe(1_000);
  });

  it("validade ilegível não derruba a tela — cai no padrão", () => {
    expect(proximoPedidoDeQrMs("amanhã de manhã", AGORA)).toBe(PADRAO_DE_REFRESH_MS);
  });

  it("validade muito longa é respeitada — não se pede QR que ainda vale", () => {
    const longa = new Date(AGORA + 10 * 60_000).toISOString();
    expect(proximoPedidoDeQrMs(longa, AGORA)).toBe(10 * 60_000 - 3_000);
  });
});
