/**
 * A dispensa de MFA que **só existe fora de produção**.
 *
 * ## Por que isto tem trava, e não é só um `if (env.X)`
 *
 * Uma chave que desliga segundo fator é exatamente o tipo de coisa que viaja
 * junto num `.env` copiado para o servidor — e ninguém percebe, porque o
 * sintoma é a ausência de uma tela. Por isso a chave sozinha NÃO desliga nada:
 * ela só tem efeito quando o próprio endereço do app é local. Num ambiente com
 * URL pública, ligá-la é inócuo de propósito.
 *
 * Isso mantém a doutrina intacta onde ela protege alguém de verdade (`admin` e
 * super-admin com TOTP obrigatório em produção) e tira do caminho o custo que
 * ela cobrava em desenvolvimento: cada login de teste dependia de um código de
 * 30 s que só vale uma vez, e re-execuções começavam no desafio sem ter o
 * segredo (medido — cinco reprovações seguidas sem nada do produto mudar).
 */
import { env } from "@/lib/env";

/** O endereço configurado do app é uma máquina de desenvolvimento? */
function enderecoLocal(): boolean {
  const url = (env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return false;
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "http:") return false; // produção fala https; local, não
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * O segundo fator está dispensado NESTE ambiente? Só quando as duas coisas
 * valem: a chave está ligada **e** o app responde num endereço local.
 */
export function mfaDispensadaNesteAmbiente(): boolean {
  return env.MFA_DISPENSADA_LOCAL === "true" && enderecoLocal();
}
