/**
 * Uma resposta só para "que transporte esta instalação tem?" (spec 005, T001).
 *
 * Antes desta função a mesma pergunta tinha três formas espalhadas:
 *
 *   - `getWahaClient() !== null`                     — app/onboarding/connect-whatsapp/page.tsx
 *   - `provisionamentoConfigurado()`                 — app/api/v1/channel-sessions/route.ts
 *   - `transporteLegadoPronto || provisionamento…()` — app/app/connections/page.tsx
 *
 * **Foi assim que o onboarding ficou para trás sem ninguém notar**: quem
 * acrescentou o ramo do gateway acrescentou em dois dos três lugares. A tela de
 * cadastro continuou perguntando só pelo legado, e numa instalação com gateway
 * ligado e WAHA ausente ela mostrava "WAHA não configurado" em vez do QR — o
 * usuário recém-cadastrado não conectava, e o produto morria no primeiro minuto.
 *
 * `null` é resposta legítima, não erro: instalação sem transporte nenhum existe,
 * e quem chama deve dizer o que falta em vez de fingir que dá para conectar.
 */
import { provisionamentoConfigurado } from "@/lib/gateway/provisionamento";

export type Transporte = "gateway" | "legacy";

/**
 * As duas perguntas de que a resolução depende, injetáveis para teste.
 *
 * São funções, não booleanos, porque as duas leem o ambiente **a cada chamada**
 * — `getWahaClient` não memoiza, e `provisionamentoConfigurado` lê `env` na
 * hora. Congelar em booleano no momento do import faria a resposta envelhecer
 * em processo longo, que é justamente o caso do worker.
 */
export type FontesDeTransporte = {
  gatewayPronto: () => boolean;
  legadoPronto: () => boolean;
};

/**
 * O legado, exatamente como as duas formas antigas o mediam — inclusive a
 * guarda do valor de exemplo. Sem ela, uma instalação que copiou o `.env.example`
 * e não trocou a chave se declararia pronta e falharia só na primeira mensagem.
 */
export function legadoConfigurado(): boolean {
  const url = process.env.WAHA_API_BASE_URL;
  const chave = process.env.WAHA_API_KEY;
  return Boolean(url && chave && chave !== "dev_plaintext_change_me");
}

const fontesPadrao: FontesDeTransporte = {
  gatewayPronto: provisionamentoConfigurado,
  legadoPronto: legadoConfigurado,
};

/**
 * Qual transporte esta instalação usa para NASCER uma conexão.
 *
 * **A precedência é regra, e por isso está no código e não no comentário**: com
 * os dois configurados, o gateway ganha. Ele é o destino da migração — nascer no
 * legado com o serviço novo de pé seria criar dívida no ato do cadastro, e cada
 * conexão nascida assim é uma migração a mais para a Fase 2 fazer depois.
 *
 * Não decide por onde uma conexão que JÁ existe fala: isso é `resolveSessionRef`,
 * que lê o `provider` gravado na linha. Esta função responde só sobre o novo.
 */
export function transporteDaInstalacao(
  fontes: FontesDeTransporte = fontesPadrao,
): Transporte | null {
  if (fontes.gatewayPronto()) return "gateway";
  if (fontes.legadoPronto()) return "legacy";
  return null;
}
