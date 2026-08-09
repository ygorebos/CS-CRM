"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser } from "@/lib/auth/provision";
import { audit } from "@/lib/audit";

export type ResultadoDoFragmento =
  | { ok: true; destino: string }
  | { ok: false; erro: "sem_sessao" | "provisionamento" };

/**
 * Fecha o caminho do link de e-mail que chega pelo FRAGMENTO.
 *
 * ## Por que existe (o buraco que ela tapa, medido em 2026-08-09)
 *
 * `/auth/confirm?token_hash=…` faz DUAS coisas: estabelece a sessão **e**, no
 * signup, chama `ensureTenantForUser` — sem org e sem membership, o
 * `/onboarding/welcome` cai em `resolveActiveOrg() === null` e manda a pessoa
 * para `/login`.
 *
 * O ramo de fragmento (`/auth/sessao`) só sabia fazer a primeira. Medido no
 * navegador: confirmar o cadastro pelo link padrão do GoTrue terminava em
 * `http://localhost:3000/login`, **sem mensagem nenhuma** — sessão válida, org
 * inexistente, e a pessoa parada numa tela de login que ela acabou de
 * atravessar. Beco sem saída silencioso, o mesmo defeito que o fragmento já
 * tinha causado na recuperação de senha, um caminho ao lado.
 *
 * O provisionamento **não pode** morar na página cliente: `ensureTenantForUser`
 * usa service role, que nunca vai ao browser. Daí uma Server Action — a fonte
 * confiável é o `getUser()` daqui (JWT validado no servidor), nunca o corpo.
 */
export async function concluirLinkDeFragmento(tipo: string | null): Promise<ResultadoDoFragmento> {
  const requestId = (await headers()).get("x-request-id");
  const supabase = await createClient();

  // NUNCA getSession() — o cookie que a página cliente acabou de gravar é
  // exatamente o que não se pode confiar sem validar contra o GoTrue.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // A auditoria vive AQUI, e não no GET cego de /auth/confirm: lá qualquer
    // requisição anônima (varredura, robô, link colado errado) escrevia uma
    // linha em `api_audit_log` — append-only, retenção de 5 anos, sem teto.
    // Medido: 5 GETs anônimos = 5 linhas. Aqui só chega quem trouxe token.
    void audit({
      action: "auth.email_link_sem_query",
      metadata: { type: tipo, reason: "fragmento_sem_sessao_valida" },
      requestId,
    });
    return { ok: false, erro: "sem_sessao" };
  }

  if (tipo === "recovery") {
    return { ok: true, destino: "/login/reset" };
  }

  try {
    await ensureTenantForUser(user);
  } catch (e) {
    void audit({
      action: "auth.signup_provision_failed",
      actorUserId: user.id,
      metadata: { reason: e instanceof Error ? e.message : String(e), via: "fragmento" },
      requestId,
    });
    return { ok: false, erro: "provisionamento" };
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: user.id,
    metadata: { via: "fragmento" },
    requestId,
  });

  return { ok: true, destino: "/onboarding/welcome" };
}
