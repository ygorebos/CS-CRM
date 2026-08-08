/**
 * Provisionamento do segredo de webhook de uma conexão de canal.
 *
 * ## O defeito que fez este arquivo existir
 *
 * As duas rotas que criam conexão gravavam `webhook_secret_encrypted:
 * Buffer.from([0])` — **um byte de enfeite**. A coluna é `NOT NULL`, então
 * alguém precisou pôr algo ali, e o que foi posto não era segredo nenhum.
 *
 * Enquanto o único consumidor era o webhook legado, isso passou despercebido:
 * aquele caminho tem uma válvula que aceita entrega sem assinatura, porque o
 * emissor dele não sabe assinar. O placeholder simplesmente caía no caminho de
 * exceção, e o caminho de exceção era o estado PERMANENTE de toda instalação.
 *
 * A entrega do gateway é fail-closed **sem válvula**. Com o placeholder, ela
 * recusaria 100% das entregas de qualquer conexão criada pelo onboarding — que
 * é justamente o caminho do corretor. Não é hipótese: o mínimo aceito é 16
 * bytes, e um byte não chega perto.
 *
 * ## Por que a falha ao cifrar NÃO grava nada
 *
 * Sem a GUC de cifra configurada, `fn_encrypt_oauth` devolve null. Gravar o
 * segredo em claro seria pior que recusar, e gravar o placeholder de novo
 * empurraria o defeito para a primeira mensagem que chegasse — longe daqui,
 * onde ninguém liga uma coisa à outra. Quem chama decide o que responder, mas
 * ninguém grava conexão que já nasce incapaz de verificar entrega.
 */
import { randomBytes } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

/**
 * 32 bytes de aleatoriedade forte, em hex (64 caracteres). Bem acima do mínimo
 * de 16 que a verificação de assinatura exige, e do mesmo tamanho de chave que
 * o HMAC-SHA512 usa internamente — não há ganho em ir além, nem margem em ficar
 * abaixo.
 */
export function gerarSegredoDeWebhook(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Gera e cifra um segredo novo. `null` significa "a cifra não está disponível
 * nesta instalação" — nunca "deu ruim, segue o jogo".
 */
export async function provisionarSegredoDeWebhook(
  admin: SupabaseClient,
): Promise<string | null> {
  return encryptWebhookSecret(admin, gerarSegredoDeWebhook());
}

/**
 * Um `webhook_secret_encrypted` é placeholder? Serve ao diagnóstico e à cura de
 * linhas antigas.
 *
 * O critério é o TAMANHO do ciphertext, não o conteúdo: `pgp_sym_encrypt` de um
 * segredo de 64 caracteres produz algo na casa das centenas de bytes hex,
 * enquanto o placeholder é literalmente `\x00`. Qualquer coisa curta demais para
 * ser um envelope pgp cifrado não é segredo — e tratar como se fosse é o que
 * transformava "fail-closed" em teatro.
 */
export function pareceSegredoPlaceholder(cifrado: string | null | undefined): boolean {
  if (!cifrado) return true;
  const hex = cifrado.startsWith("\\x") ? cifrado.slice(2) : cifrado;
  // 32 bytes de ciphertext é menos que o cabeçalho de qualquer envelope pgp_sym.
  return hex.length < 64;
}
