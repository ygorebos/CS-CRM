/**
 * Cifra/decifra de secrets de webhooks (at-rest) — retrofit da spec §10.
 *
 * ## Duas cifras, uma escrita e duas leituras
 *
 * A original vive no banco: RPCs `fn_encrypt_oauth`/`fn_decrypt_oauth` (pgp_sym
 * AES-256 com a chave na GUC `app.nuvemshop_oauth_key`), com GRANT apenas para
 * service_role — sempre chame com o admin client.
 *
 * Ela depende de a GUC estar setada, e no Supabase gerenciado **isso não é
 * possível**: `ALTER DATABASE ... SET` de GUC customizada exige superusuário, e
 * o papel `postgres` não é um. Medido em 2026-08-08 — `permission denied to set
 * parameter`. Resultado: encrypt falhava sempre, e conexão de canal NUNCA
 * conseguia nascer (422 "cifra indisponível") nesta instalação.
 *
 * Por isso a ESCRITA agora prefere a cifra da aplicação
 * (`lib/crypto/envelope-secreto.ts`, AES-256-GCM com chave do ambiente), caindo
 * para o RPC só onde ela não estiver configurada. A LEITURA aceita as duas e
 * decide pelo DADO — o envelope local se identifica por magic no começo do
 * ciphertext. Nenhuma coluna muda de tipo e nenhum segredo antigo precisa ser
 * reescrito: é expand/contract com as duas formas legíveis ao mesmo tempo.
 *
 * Contrato de erro (inalterado): encrypt SEM chave nenhuma retorna null (o
 * caller decide — rotas de escrita respondem 422 com instrução); decrypt que
 * falha retorna null (o caller aplica o precedente WAHA: hmacSkipped, nunca 500).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  cifrarSegredo,
  cifraLocalDisponivel,
  decifrarSegredo,
  ehEnvelopeLocal,
} from "@/lib/crypto/envelope-secreto";
import { logger } from "@/lib/logger";

/** Cifra um secret. Retorna o bytea (formato hex "\x…" do PostgREST) ou null se a chave estiver ausente/erro. */
export async function encryptWebhookSecret(
  admin: SupabaseClient,
  plaintext: string,
): Promise<string | null> {
  if (cifraLocalDisponivel()) return cifrarSegredo(plaintext);

  const { data, error } = await admin.rpc("fn_encrypt_oauth", { plaintext });
  if (error || !data) {
    logger.warn("[webhooks.secrets] encrypt falhou: nenhuma cifra disponível", {
      error: error?.message ?? "empty",
      dica: "defina SECRET_ENCRYPTION_KEY (32 bytes hex) no ambiente do app",
    });
    return null;
  }
  return data as string;
}

/** Decifra um secret cifrado (bytea hex ou hex puro de jsonb). null em falha. */
export async function decryptWebhookSecret(
  admin: SupabaseClient,
  ciphertext: string,
): Promise<string | null> {
  // O formato manda, não a configuração: um segredo gravado pela cifra antiga
  // continua sendo lido pela cifra antiga mesmo depois da virada, e vice-versa.
  if (ehEnvelopeLocal(ciphertext)) return decifrarSegredo(ciphertext);

  const normalized = ciphertext.startsWith("\\x") ? ciphertext : `\\x${ciphertext}`;
  const { data, error } = await admin.rpc("fn_decrypt_oauth", { ciphertext: normalized });
  if (error || !data) return null;
  return data as string;
}

export interface RuleActionInput {
  type: string;
  config?: Record<string, unknown>;
}

/**
 * Troca `config.secret` (plaintext, input do editor) por `config.secret_enc`
 * (hex cifrado) em ações call_webhook antes de gravar no jsonb da regra.
 * `secret_enc` já presente (round-trip do editor sem re-digitar) passa direto.
 * Retorna null se a cifra estiver indisponível (caller responde 422).
 */
export async function encryptRuleActionSecrets(
  admin: SupabaseClient,
  actions: RuleActionInput[],
): Promise<RuleActionInput[] | null> {
  const out: RuleActionInput[] = [];
  for (const action of actions) {
    if (action.type === "call_webhook" && typeof action.config?.secret === "string" && action.config.secret) {
      const enc = await encryptWebhookSecret(admin, action.config.secret);
      if (enc === null) return null;
      const { secret: _plain, ...restConfig } = action.config;
      out.push({ ...action, config: { ...restConfig, secret_enc: enc.replace(/^\\x/, "") } });
    } else {
      const { secret: _drop, ...restConfig } = action.config ?? {};
      out.push({ ...action, config: restConfig });
    }
  }
  return out;
}
