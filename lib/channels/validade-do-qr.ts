/**
 * Quando pedir o próximo material de pareamento (spec 004, T041 / FR-031).
 *
 * ## A conta que a tela fazia no escuro
 *
 * A Central recarregava o QR a cada 15 s, sempre. O número tinha uma razão — dar
 * folga sobre a expiração do WhatsApp, medida em ~20 s — mas era um palpite sobre
 * algo que ninguém declarava. Erra nas duas direções: quem demora a pegar o
 * celular ainda escaneia um código morto (e conclui que o aparelho dele é que
 * está ruim), e quem escaneia rápido paga requisições que não precisavam sair.
 *
 * O contrato do gateway declara `expires_at`, e é por isso que a rota de
 * pareamento não é um proxy. Esta função é o que traduz a validade em ritmo.
 *
 * Fica em módulo próprio, e não dentro do componente, porque é a única parte
 * testável sem montar diálogo, cliente HTTP e relógio — três dublês para provar
 * uma conta de cinco linhas.
 */

/** Ritmo de quem NÃO declara validade — o comportamento de hoje, preservado. */
export const PADRAO_DE_REFRESH_MS = 15_000;

/**
 * Margem antes do vencimento: cobre a viagem de rede do pedido novo e evita que
 * o código pisque no meio de um escaneamento.
 */
export const MARGEM_MS = 3_000;

/** Piso absoluto entre dois pedidos. Sem ele, validade vencida vira laço. */
export const PISO_MS = 1_000;

/**
 * Em quantos milissegundos pedir material novo.
 *
 * `validade` ausente ou ilegível cai no padrão: fingir uma validade que não foi
 * medida seria pior que não ter nenhuma — erraria com aparência de precisão.
 */
export function proximoPedidoDeQrMs(
  validade: string | null | undefined,
  agora: number = Date.now(),
): number {
  if (!validade) return PADRAO_DE_REFRESH_MS;
  const vence = new Date(validade).getTime();
  if (!Number.isFinite(vence)) return PADRAO_DE_REFRESH_MS;
  // Relógio fora de sincronia, ou aba que ficou em segundo plano: o resultado
  // fica negativo e o piso é o que impede a rajada de requisições.
  return Math.max(PISO_MS, vence - agora - MARGEM_MS);
}
