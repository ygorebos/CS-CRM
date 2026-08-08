/**
 * Fixture do E2E de recebimento pelo gateway (spec 001, T022/T047).
 *
 * Cria — ou reaproveita — UMA conexão marcada `ingest_path='gateway'`, com um
 * segredo de assinatura **conhecido pelo teste**. É o mínimo que a spec precisa
 * para se comportar como o gateway de verdade: assinar a entrega com o mesmo
 * material que a rota vai usar para verificar.
 *
 * ## Por que o segredo é semeado, e não lido do banco
 *
 * `channel_sessions.webhook_secret_encrypted` é **cifrado** (`fn_encrypt_oauth`)
 * e o teste não tem como decifrá-lo pelo PostgREST. Então o script grava um
 * segredo escolhido por ele e o devolve em arquivo, do mesmo jeito que
 * `.e2e-creds.json` faz com a senha dos usuários.
 *
 * Ele é escrito com `fn_encrypt_oauth` — a função REAL do banco, e não um
 * `bytea` fabricado. Cifrar à mão faria o teste passar contra um formato que a
 * produção não usa, e a primeira entrega real seria a que descobre isso.
 *
 * Run: npx tsx scripts/seed-e2e-gateway.ts
 */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-gateway", credenciais);

const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ARQUIVO = path.join(process.cwd(), ".e2e-gateway.json");

/** 32 hex — acima do piso de 16 que a rota exige (segredo curto é placeholder). */
const SEGREDO = "e2e0123456789abcdef0123456789abc";
const TOKEN = "e2e_gateway_token_fixo";
const NOME_DA_SESSAO = "e2e-gateway";

export interface FixtureDoGateway {
  organization_id: string;
  channel_session_id: string;
  webhook_path_token: string;
  segredo: string;
}

async function main(): Promise<void> {
  const { data: orgs, error: orgErr } = await admin
    .from("organizations")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1);
  if (orgErr) throw new Error(`organizations: ${orgErr.message}`);
  const org = orgs?.[0]?.id as string | undefined;
  if (!org) {
    throw new Error(
      "nenhuma organização no banco — rode scripts/seed-e2e-credentials.ts antes deste",
    );
  }

  // Cifra pela função real. Se a chave de cifra não estiver semeada, isto falha
  // ALTO aqui — e não silenciosamente na primeira entrega, onde o sintoma seria
  // "401 misterioso" em vez de "a instalação não tem chave".
  const { data: cifrado, error: cifraErr } = await admin.rpc("fn_encrypt_oauth" as never, {
    plaintext: SEGREDO,
  } as never);
  if (cifraErr || !cifrado) {
    throw new Error(
      `fn_encrypt_oauth falhou (${cifraErr?.message ?? "sem retorno"}) — ` +
        "a chave app.nuvemshop_oauth_key não está semeada neste banco",
    );
  }

  const { data: existente } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", org)
    .eq("webhook_path_token", TOKEN)
    .maybeSingle();

  const linha = {
    organization_id: org,
    waha_session_name: NOME_DA_SESSAO,
    webhook_path_token: TOKEN,
    webhook_secret_encrypted: cifrado,
    provider: "whatsapp_uazapi",
    ingest_path: "gateway",
    gateway_connection_id: "conn_e2e_gateway",
    display_name: "Canal E2E do gateway",
    status: "WORKING",
  };

  let sessionId: string;
  if (existente?.id) {
    // Re-semear atualiza o segredo: uma execução anterior pode ter deixado
    // outro, e o teste que assina com o novo tomaria 401 num canal que "existe".
    const { error } = await admin
      .from("channel_sessions")
      .update(linha)
      .eq("id", existente.id as string);
    if (error) throw new Error(`update channel_sessions: ${error.message}`);
    sessionId = existente.id as string;
  } else {
    const { data, error } = await admin
      .from("channel_sessions")
      .insert(linha)
      .select("id")
      .single();
    if (error || !data) throw new Error(`insert channel_sessions: ${error?.message}`);
    sessionId = data.id as string;
  }

  const fixture: FixtureDoGateway = {
    organization_id: org,
    channel_session_id: sessionId,
    webhook_path_token: TOKEN,
    segredo: SEGREDO,
  };
  fs.writeFileSync(ARQUIVO, JSON.stringify(fixture, null, 2));
  // eslint-disable-next-line no-console
  console.info(`[seed-e2e-gateway] pronto: conexão ${sessionId} (org ${org}) → ${ARQUIVO}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[seed-e2e-gateway] falhou:", err);
  process.exit(1);
});
