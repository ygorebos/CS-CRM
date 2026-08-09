/**
 * O endereço de volta dos links de e-mail — UM lugar só.
 *
 * ─── Por que isto virou função (medido em 2026-08-09) ───────────────────────
 *
 * O `?type=` é carimbo NOSSO, não do GoTrue: no fluxo PKCE ele acrescenta só
 * `code=…` e não diz de que fluxo o link veio, então sem o carimbo
 * `/auth/confirm` não sabe separar redefinição de senha de confirmação de
 * cadastro — e mandaria quem veio trocar a senha para o onboarding.
 *
 * O carimbo foi escrito direto nas duas server actions, e isso quebrou os
 * templates do repo, que compõem o link assim:
 *
 *     href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery"
 *
 * Com `RedirectTo` já terminando em `?type=recovery`, o resultado tem DOIS `?`:
 *
 *     /auth/confirm?type=recovery?token_hash=XXX&type=recovery
 *
 * O segundo `?` é literal — `token_hash` deixa de existir como parâmetro, e o
 * link morre. Passou despercebido porque o projeto na nuvem **não usa** estes
 * templates (emite PKCE), então o caminho consertado funcionava de verdade
 * enquanto o do ambiente de teste quebrava. Só o e2e viu, e o e2e não gateia
 * merge.
 *
 * Agora o contrato é explícito e tem os dois lados num arquivo só: esta função
 * **sempre** devolve uma URL com query, e os templates **sempre** continuam com
 * `&`. `tests/unit/link-de-email-compoe-url-valida.test.ts` compõe os dois e
 * reprova se a URL final perder um parâmetro.
 */

/** Os fluxos que `/auth/confirm` sabe encaminhar. */
export type TipoDeLinkDeEmail = "recovery" | "signup";

/**
 * O `redirect_to` que vai ao GoTrue. Termina SEMPRE com query — é o que torna
 * o `&` dos templates correto, e não uma coincidência.
 */
export function urlDeCallbackDeEmail(origin: string, tipo: TipoDeLinkDeEmail): string {
  return `${origin.replace(/\/+$/, "")}/auth/confirm?type=${tipo}`;
}
