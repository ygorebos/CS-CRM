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
 * ## Por que aceitar as duas, em vez de só arrumar o template
 *
 * O template mora na configuração do projeto Supabase, fora deste repo — o
 * `supabase/config.toml` só alcança a stack local do CLI. Um deploy pode estar
 * com o padrão do GoTrue sem que nada aqui saiba, e o sintoma é justamente uma
 * tela de erro que acusa a pessoa ("peça um novo") pelo que é configuração
 * nossa.
 *
 * ## Por que tem um BOTÃO, e não entra sozinho
 *
 * Porque o fragmento é digitável. Medido em 2026-08-09, num navegador limpo:
 * abrir `/auth/sessao#access_token=<token de outra conta>` deixava a pessoa
 * **logada na conta de quem fabricou o link, sem digitar nada** — fixação de
 * sessão / login-CSRF. O estrago não é a vítima perder acesso: é ela trabalhar
 * dentro do tenant alheio achando que é o dela, e digitar lead, contato e
 * conversa lá dentro.
 *
 * A trava é tornar o passo **visível e nominal**: a tela diz de qual conta se
 * trata e espera um clique. Auto-login silencioso a partir de URL é o que não
 * pode existir.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/lib/supabase/browser";
import { concluirLinkDeFragmento } from "@/app/actions/auth/concluirLinkDeFragmento";
import { Button } from "@/components/ui/button";

/**
 * Os `type` que o GoTrue emite em link de e-mail. Qualquer outro valor não veio
 * de um fluxo nosso — recusar é mais barato que adivinhar o destino.
 */
const TIPOS_ACEITOS = new Set(["recovery", "signup", "invite", "magiclink", "email_change"]);

/** Só para MOSTRAR de quem é a conta. Nunca para decidir nada. */
function emailDoToken(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const dados = JSON.parse(json) as { email?: string };
    return typeof dados.email === "string" ? dados.email : null;
  } catch {
    return null;
  }
}

type Estado =
  | { fase: "lendo" }
  | { fase: "confirmar"; accessToken: string; refreshToken: string; tipo: string; email: string | null }
  | { fase: "entrando" }
  | { fase: "saindo" };

export default function EstabelecerSessaoDoLink() {
  const router = useRouter();
  const [estado, setEstado] = useState<Estado>({ fase: "lendo" });

  useEffect(() => {
    // O fragmento vem no formato de query string: #a=1&b=2.
    const bruto = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(bruto);

    // Apaga o fragmento ANTES de qualquer outra coisa: token em histórico de
    // navegação é credencial em lugar que ninguém limpa.
    if (bruto) window.history.replaceState(null, "", window.location.pathname);

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    const tipo = params.get("type") ?? "";

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
      setEstado({ fase: "saindo" });
      router.replace(
        codigoDeErro === "otp_expired"
          ? "/login?error=link_expirado"
          : "/login?error=link_invalido",
      );
      return;
    }

    if (!accessToken || !refreshToken || !TIPOS_ACEITOS.has(tipo)) {
      // Nem token nem erro: não é o fluxo de fragmento. Alguém digitou o
      // endereço, o link veio truncado, ou o `type` não é de link de e-mail.
      setEstado({ fase: "saindo" });
      router.replace("/login?error=link_invalido");
      return;
    }

    setEstado({
      fase: "confirmar",
      accessToken,
      refreshToken,
      tipo,
      email: emailDoToken(accessToken),
    });
  }, [router]);

  const confirmar = useCallback(async () => {
    if (estado.fase !== "confirmar") return;
    setEstado({ fase: "entrando" });

    const supabase = createClient();
    const { error } = await supabase.auth.setSession({
      access_token: estado.accessToken,
      refresh_token: estado.refreshToken,
    });
    if (error) {
      router.replace("/login?error=link_invalido");
      return;
    }

    // O provisionamento do tenant precisa de service role — só existe no
    // servidor. Sem esta chamada, o signup pelo fragmento estabelecia sessão e
    // parava num /login mudo (medido).
    const resultado = await concluirLinkDeFragmento(estado.tipo);
    if (!resultado.ok) {
      router.replace(
        resultado.erro === "provisionamento"
          ? "/login?error=provisionamento"
          : "/login?error=link_invalido",
      );
      return;
    }
    router.replace(resultado.destino);
  }, [estado, router]);

  if (estado.fase === "confirmar") {
    const acao = estado.tipo === "recovery" ? "redefinir a senha" : "confirmar o acesso";
    return (
      <div className="space-y-4 text-center">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Confirme que é você</h1>
          <p className="text-sm text-muted-foreground">
            Este link vai {acao} da conta{" "}
            <strong className="text-foreground">{estado.email ?? "indicada no link"}</strong>.
          </p>
        </div>
        <Button className="w-full" onClick={confirmar}>
          Continuar
        </Button>
        <p className="text-xs text-muted-foreground">
          Não reconhece essa conta? Feche esta página — nada foi feito ainda.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-center" role="status" aria-live="polite">
      <h1 className="text-2xl font-semibold tracking-tight">
        {estado.fase === "entrando" ? "Entrando…" : "Confirmando seu link…"}
      </h1>
      <p className="text-sm text-muted-foreground">Só um instante.</p>
    </div>
  );
}
