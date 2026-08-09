/**
 * Supabase client para Server Components, Route Handlers e Server Actions.
 *
 * Lê/escreve cookies via next/headers. Sempre use `getUser()` (valida JWT no
 * backend), NUNCA `getSession()` (confia no cookie local sem revalidar).
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * O cookie de `code_verifier` do PKCE precisa de `SameSite=Lax`. O de sessão,
 * não — ele continua `Strict`.
 *
 * ## Por que, medido em 2026-08-09
 *
 * O e-mail de redefinição chega assim: clique no link do Resend, que redireciona
 * para `supabase.co/auth/v1/verify`, que redireciona para `/auth/confirm?code=…`.
 * A última navegação vem de **outro site**. `SameSite=Strict` não viaja em
 * navegação cross-site — medido com interceptação de requisição: **0 cookies**
 * chegaram, o verifier entre eles. Sem verifier, `exchangeCodeForSession` não
 * tem como fechar o PKCE e a redefinição de senha é impossível por construção.
 *
 * `Lax` viaja em navegação de topo por GET, que é exatamente o clique do e-mail.
 *
 * O afrouxamento é seguro e vale só para o verifier: ele é `httpOnly`, vale uma
 * vez, e está preso ao `code` gerado no MESMO fluxo. Um `code` de terceiro com o
 * verifier da vítima não casa — a troca falha. O cookie de SESSÃO, que é o que
 * CSRF de verdade quer, permanece `Strict`.
 */
function ajustarSameSite(name: string, options: CookieOptions): CookieOptions {
  if (!name.includes("code-verifier")) return options;
  return { ...options, sameSite: "lax" };
}

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, ajustarSameSite(name, options));
          });
        } catch {
          // setAll pode ser chamado de Server Component; nesse caso, ignoramos.
          // Refresh de sessão acontece no middleware do Next.
        }
      },
    },
    // D-01.01: cookie name canônico alinhado ao middleware.
    cookieOptions: {
      name: "sb-deskcomm-auth",
      sameSite: "strict",
      httpOnly: true,
      secure: cookieSecure(),
      path: "/",
    },
  });
}
