/**
 * Cura as conexões de canal cujo segredo de webhook é placeholder.
 *
 * ## Por que isto NÃO está na migration nem no apêndice do baseline
 *
 * A doutrina manda corrigir os dados ANTES de a regra nova depender deles, e ela
 * continua valendo — o que muda é **onde**, porque este dado depende de uma
 * chave que o SQL ainda não tem quando roda.
 *
 * Medido: `public.fn_encrypt_oauth` faz
 * `raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente'` quando a chave é
 * nula ou tem menos de 32 caracteres, e a chave só existe no banco depois que
 * `ensure_encryption_key` a semeia em `private.app_secrets` — que o kit
 * self-host documenta rodar **"APÓS aplicar o baseline"**.
 *
 * Consequência de cifrar dentro do baseline:
 *   - no `install.sh`, que roda com `ON_ERROR_STOP=1`, **a instalação de uma VPS
 *     nova aborta**;
 *   - no `update.sh`, que roda **sem** a flag, falha em silêncio: o placeholder
 *     permanece e a rota fail-closed recusa 100% das entregas daquela conexão
 *     sem ninguém saber.
 *
 * Por isso a cura é um passo de aplicação, chamado depois da chave existir.
 *
 * ## Idempotente e conservador
 *
 * Só toca linha cujo segredo é placeholder. Rodar duas vezes não regenera nada,
 * e conexão que já tem segredo bom nunca é mexida — trocar o segredo de uma
 * conexão viva faria o gateway, que já tem o antigo, passar a ser recusado.
 *
 * Uso:
 *   pnpm tsx scripts/curar-segredos-de-canal.ts          # cura
 *   pnpm tsx scripts/curar-segredos-de-canal.ts --dry-run # só relata
 */
import { createClient } from "@supabase/supabase-js";

import {
  pareceSegredoPlaceholder,
  provisionarSegredoDeWebhook,
} from "@/lib/webhooks/provisionar-segredo";

interface Linha {
  id: string;
  organization_id: string;
  webhook_secret_encrypted: string | null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "[curar-segredos] NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórias.",
    );
    process.exit(1);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, webhook_secret_encrypted");

  if (error) {
    console.error(`[curar-segredos] falha ao ler channel_sessions: ${error.message}`);
    process.exit(1);
  }

  const linhas = (data ?? []) as Linha[];
  const alvos = linhas.filter((l) => pareceSegredoPlaceholder(l.webhook_secret_encrypted));

  console.info(
    `[curar-segredos] ${linhas.length} conexão(ões) no banco; ` +
      `${alvos.length} com segredo placeholder.`,
  );

  if (alvos.length === 0) {
    console.info("[curar-segredos] nada a fazer.");
    return;
  }

  if (dryRun) {
    for (const l of alvos) {
      console.info(`[curar-segredos] (dry-run) curaria a conexão ${l.id} (org ${l.organization_id})`);
    }
    return;
  }

  let curadas = 0;
  let falhas = 0;

  for (const l of alvos) {
    const cifrado = await provisionarSegredoDeWebhook(admin);
    if (!cifrado) {
      // Sem cifra não se grava nada — nem placeholder de volta. O operador
      // precisa saber que falta configuração de servidor, e o passo seguinte
      // (ensure_encryption_key) é o conserto.
      console.error(
        "[curar-segredos] cifra indisponível (a chave foi semeada? " +
          "`ensure_encryption_key` roda DEPOIS do baseline). Nenhuma linha foi alterada.",
      );
      process.exit(1);
    }

    const { error: upErr } = await admin
      .from("channel_sessions")
      .update({ webhook_secret_encrypted: cifrado })
      .eq("id", l.id);

    if (upErr) {
      falhas += 1;
      console.error(`[curar-segredos] conexão ${l.id}: ${upErr.message}`);
      continue;
    }
    curadas += 1;
  }

  console.info(`[curar-segredos] ${curadas} curada(s), ${falhas} falha(s).`);

  // Falha parcial não pode passar por sucesso: conexão que ficou com placeholder
  // vai recusar toda entrega do gateway, e o silêncio é o pior desfecho.
  if (falhas > 0) process.exit(1);
}

void main();
