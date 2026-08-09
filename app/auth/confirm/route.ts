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
/**
 * O token existiu e não vale mais (usado, vencido, ou cancelado por um pedido
 * mais novo) — em oposição a um link truncado ou forjado.
 *
 * O GoTrue devolve `otp_expired` nos três casos, e a mensagem é sempre "Email
 * link is invalid or has expired". Olhar o `code` primeiro e a mensagem só como
 * rede: `error.code` é recente no cliente e pode vir vazio em versão anterior.
 */
function tokenGasto(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "otp_expired") return true;
  return /invalid or has expired/i.test(error.message ?? "");
}

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

  // ── PKCE: o formato que o app REALMENTE emite, e que este arquivo ignorava ──
  //
  // `@supabase/ssr` usa PKCE por padrão. `resetPasswordForEmail` chamado da
  // Server Action grava um `code_verifier` em cookie e manda um link
  // `…/verify?token=pkce_…`, que redireciona para `/auth/confirm?code=<uuid>` —
  // **query `code`**, sem `token_hash` e sem fragmento nenhum.
  //
  // Nada aqui lia `code`, então o primeiro clique caía no ramo cego e terminava
  // em "Link inválido ou expirado". Medido em 2026-08-09 com o link do dono:
  // primeiro clique = `link_invalido`; o segundo, com o token já gasto, virava
  // `link_expirado` — o que fazia o defeito parecer problema de validade.
  //
  // Isto nunca funcionou, e nenhum teste pegava: `admin/generate_link` emite
  // token NÃO-PKCE, então toda medição feita por ele passava por um caminho que
  // usuário nenhum percorre.
  const codigoPkce = url.searchParams.get("code");
  const erroNaQuery = url.searchParams.get("error_code") ?? url.searchParams.get("error");

  // O GoTrue devolve o erro do PKCE na QUERY (e repetido no fragmento). Ler a
  // query aqui é o que evita depender do fragmento, que o servidor não vê.
  if (erroNaQuery) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: url.searchParams.get("error_description"), code: erroNaQuery },
      requestId,
    });
    return redirectTo(
      erroNaQuery === "otp_expired" ? "/login?error=link_expirado" : "/login?error=link_invalido",
    );
  }

  if (codigoPkce) {
    const supabasePkce = await createClient();
    const { data, error } = await supabasePkce.auth.exchangeCodeForSession(codigoPkce);

    if (error || !data.user) {
      await audit({
        action: "auth.email_link_rejected",
        metadata: { type, reason: error?.message ?? "no_user", code: error?.code ?? "pkce" },
        requestId,
      });
      return redirectTo(
        tokenGasto(error) ? "/login?error=link_expirado" : "/login?error=link_invalido",
      );
    }

    // O `type` vem do nosso próprio `redirectTo` (requestPasswordReset /
    // signUp o carimbam): o GoTrue só acrescenta `code`, não diz de que fluxo
    // veio. Sem ele, recovery e signup terminariam no mesmo lugar.
    if (type === "recovery") return redirectTo("/login/reset");

    try {
      await ensureTenantForUser(data.user);
    } catch (e) {
      await audit({
        action: "auth.signup_provision_failed",
        actorUserId: data.user.id,
        metadata: { reason: e instanceof Error ? e.message : String(e), via: "pkce" },
        requestId,
      });
      return redirectTo("/login?error=provisionamento");
    }
    void audit({
      action: "auth.signup_confirmed",
      actorUserId: data.user.id,
      metadata: { via: "pkce" },
      requestId,
    });
    return redirectTo("/onboarding/welcome");
  }

  if (!tokenHash || !type) {
    // NÃO é necessariamente link inválido — e tratá-lo como tal custou uma
    // sessão inteira de diagnóstico em 2026-08-09. Com o template PADRÃO do
    // GoTrue (`{{ .ConfirmationURL }}`), o clique passa por
    // `…/auth/v1/verify`, que consome o token e devolve 303 para
    // `…/auth/confirm#access_token=…`. Fragmento não sobe na requisição: daqui
    // os dois parâmetros parecem simplesmente ausentes.
    //
    // Quem enxerga o fragmento é o browser. `/auth/sessao` é uma página cliente
    // que o lê e estabelece a sessão; se não houver nada lá, ela mesma manda
    // para o erro. O fragmento sobrevive ao redirect porque o destino não tem
    // fragmento próprio — comportamento de browser, coberto por
    // `tests/e2e/recuperacao-de-senha-por-fragmento.spec.ts`.
    //
    // NÃO se audita aqui. Este ramo é alcançável por qualquer GET anônimo —
    // varredura, robô, link colado pela metade — e `api_audit_log` é
    // append-only com retenção de 5 anos e sem teto de escrita. Medido em
    // 2026-08-09: 5 requisições anônimas a `/auth/confirm` = 5 linhas. Quem
    // audita é `concluirLinkDeFragmento`, do outro lado, onde já se sabe se
    // havia token de verdade e de quem ele era.
    return redirectTo("/auth/sessao");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error || !data.user) {
    await audit({
      action: "auth.email_link_rejected",
      metadata: { type, reason: error?.message ?? "no_user", code: error?.code ?? null },
      requestId,
    });
    // "Gasto" e "inválido" NÃO são a mesma coisa para quem está do outro lado, e
    // este ramo tratava os dois com a mesma frase — a genérica, que manda pedir
    // outro link sem dizer que pedir outro foi justamente o que matou o
    // anterior.
    //
    // Medido em 2026-08-09, com o link do dono: o formato de FRAGMENTO já
    // chegava em `link_expirado` com a frase certa, e este — o formato de
    // QUERY, que é o dos templates DESTE repo, isto é o caminho normal de todo
    // usuário — caía na genérica. A mensagem boa estava no caminho raro e a
    // ruim no comum.
    return redirectTo(tokenGasto(error) ? "/login?error=link_expirado" : "/login?error=link_invalido");
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
