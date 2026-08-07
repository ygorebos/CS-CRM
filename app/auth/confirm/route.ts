import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/confirm — troca o token do e-mail (token_hash) por uma sessão.
 *
 * É o destino único dos links de e-mail do GoTrue (templates customizados em
 * supabase/templates/): confirmação de signup E redefinição de senha.
 *
 * - type=signup  → provisiona o tenant (org + membership admin) e entra no
 *                  onboarding. Provisionamento é idempotente (link clicado 2x).
 * - type=recovery → sessão de recovery estabelecida; segue para /login/reset
 *                  onde o usuário define a senha nova.
 *
 * Fluxo canônico do @supabase/ssr: verifyOtp grava os cookies de sessão via
 * cookies() do next/headers; o Next anexa os Set-Cookie ao redirect retornado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const requestId = request.headers.get("x-request-id");

  // NÃO usar `url.origin` aqui. Num Next.js standalone (`node server.js`, que é
  // como a imagem de produção roda), o origin é o endereço em que o PROCESSO
  // escutou — `HOSTNAME=0.0.0.0`, `PORT=3000` — e não o host público. Atrás de
  // qualquer proxy reverso o Location sai como `https://0.0.0.0:3000/...` e o
  // browser recusa com ERR_ADDRESS_INVALID: a pessoa clica no link de redefinir
  // senha e cai numa página de erro, mesmo tendo a sessão já estabelecida.
  //
  // O Next fixa isso no boot e não há env que corrija — `__NEXT_PRIVATE_ORIGIN`
  // é escrita por ele, não lida. Medido: com `Host` E `X-Forwarded-Host`
  // corretos, o redirect continua `0.0.0.0`. Só o esquema vem do
  // `X-Forwarded-Proto`, o que explica o `https://` no endereço quebrado.
  //
  // Também não se lê `X-Forwarded-Host` aqui: quem controlasse esse cabeçalho
  // controlaria o destino do redirect, e isso é open redirect de phishing dentro
  // do fluxo de recuperação de senha. A fonte é a mesma que
  // requestPasswordReset.ts usa para montar o link do e-mail — configuração, não
  // requisição.
  const redirectTo = (path: string) =>
    NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  if (!tokenHash || !type) {
    return redirectTo("/login?error=link_invalido");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error || !data.user) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: error?.message ?? "no_user" },
      requestId,
    });
    return redirectTo("/login?error=link_invalido");
  }

  if (type === "recovery") {
    return redirectTo("/login/reset");
  }

  try {
    await ensureTenantForUser(data.user);
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: data.user.id,
      metadata: { reason: e instanceof Error ? e.message : String(e) },
      requestId,
    });
    return redirectTo("/login?error=provisionamento");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: data.user.id,
    metadata: {},
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}
