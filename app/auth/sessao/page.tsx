"use client";

/**
 * A metade do link de e-mail que o servidor NÃO enxerga.
 *
 * ## O defeito que isto conserta (medido em 2026-08-09)
 *
 * O GoTrue tem duas formas de entregar um link de e-mail, e elas chegam em
 * lugares diferentes da URL:
 *
 * | template | o que chega em /auth/confirm |
 * |---|---|
 * | `{{ .RedirectTo }}?token_hash=…&type=…` (o do repo) | **query** — o servidor lê |
 * | `{{ .ConfirmationURL }}` (o padrão do GoTrue) | **fragmento** — o servidor NUNCA vê |
 *
 * Com o template padrão, o clique passa antes por
 * `…/auth/v1/verify?token=…&redirect_to=…`, que **consome o token** e devolve
 * `303` para `…/auth/confirm#access_token=…&type=recovery`. Fragmento não sobe
 * na requisição: `/auth/confirm` via `token_hash` e `type` nulos e mandava a
 * pessoa para "Link inválido ou expirado" — com o token já gasto, de modo que
 * pedir outro repetia o mesmo desfecho para sempre. Um pedido de redefinição,
 * zero chances de redefinir.
 *
 * Medido assim, no projeto real:
 *
 * ```
 * POST /auth/v1/admin/generate_link → action_link
 * GET  <action_link> → 303
 *   location: http://localhost:3000/auth/confirm#access_token=…&type=recovery
 * ```
 *
 * ## Por que aceitar as duas, em vez de só arrumar o template
 *
 * O template mora na configuração do projeto Supabase, fora deste repo — o
 * `supabase/config.toml` só alcança a stack local do CLI. Um deploy pode estar
 * com o padrão do GoTrue sem que nada aqui saiba, e o sintoma é justamente uma
 * tela de erro que acusa a pessoa ("peça um novo") pelo que é configuração
 * nossa. Aceitar as duas formas é o que torna o fluxo indiferente a isso.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/browser";

export default function EstabelecerSessaoDoLink() {
  const router = useRouter();
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    // O fragmento vem no formato de query string: #a=1&b=2.
    const bruto = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(bruto);
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const tipo = params.get("type");

    // O GoTrue também manda o MOTIVO da recusa no fragmento — e era ele que se
    // perdia. Medido em 2026-08-09, na tela do dono:
    //
    //   #error=access_denied&error_code=otp_expired
    //   &error_description=Email+link+is+invalid+or+has+expired
    //
    // Sem ler isto, a tela dizia "Link inválido ou expirado. Peça um novo" para
    // quem já tinha pedido — e pedir de novo INVALIDA o link anterior, então
    // quem clicasse no e-mail antigo entrava num laço. Dizer o motivo é o que
    // transforma um beco sem saída numa instrução.
    const codigoDeErro = params.get("error_code") ?? params.get("error");
    if (codigoDeErro) {
      setFalhou(true);
      router.replace(
        codigoDeErro === "otp_expired"
          ? "/login?error=link_expirado"
          : "/login?error=link_invalido",
      );
      return;
    }

    if (!accessToken || !refreshToken) {
      // Nem token nem erro: não é o fluxo de fragmento. Alguém digitou o
      // endereço, ou o link veio truncado.
      setFalhou(true);
      router.replace("/login?error=link_invalido");
      return;
    }

    let cancelado = false;
    void (async () => {
      const supabase = createClient();
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (cancelado) return;
      if (error) {
        setFalhou(true);
        router.replace("/login?error=link_invalido");
        return;
      }
      // Apaga o fragmento antes de sair: token em histórico de navegação é
      // credencial em lugar que ninguém limpa.
      window.history.replaceState(null, "", window.location.pathname);
      router.replace(tipo === "recovery" ? "/login/reset" : "/onboarding/welcome");
    })();

    return () => {
      cancelado = true;
    };
  }, [router]);

  return (
    <div className="space-y-2 text-center" role="status" aria-live="polite">
      <h1 className="text-2xl font-semibold tracking-tight">
        {falhou ? "Link inválido" : "Confirmando seu link…"}
      </h1>
      <p className="text-sm text-muted-foreground">
        {falhou ? "Redirecionando…" : "Só um instante."}
      </p>
    </div>
  );
}
