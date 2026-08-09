/**
 * Diagnóstico (e cura opcional) da cifra at-rest dos segredos de canal.
 *
 * ## Por que existe
 *
 * A cifra tinha uma única origem — a GUC `app.nuvemshop_oauth_key` — e ela NUNCA
 * pôde ser setada em Supabase gerenciado: `ALTER DATABASE ... SET` de GUC
 * customizada exige superusuário, e o papel `postgres` não é um. O sintoma não
 * aparecia aqui: aparecia lá na frente, com a tela recusando criar conexão em
 * 422, e com a conexão antiga carregando `\x00` no lugar do segredo — o
 * placeholder que fazia o fail-closed do gateway recusar 100% das entregas.
 *
 * Este script responde três perguntas de uma vez, ANTES de alguém tentar
 * conectar: a instalação sabe cifrar? por qual das duas cifras? existe conexão
 * com segredo de mentira?
 *
 * ```
 * npx tsx --env-file=.env.local scripts/verificar-cifra-de-segredos.ts
 * npx tsx --env-file=.env.local scripts/verificar-cifra-de-segredos.ts --curar
 * ```
 *
 * `--curar` gera segredo REAL para as conexões que estão com placeholder. É
 * seguro por construção: o segredo antigo era `\x00`, então não há entrega
 * legítima assinada com ele para invalidar — quem assinava com aquilo já estava
 * sendo recusado.
 */
import { cifraLocalDisponivel, ehEnvelopeLocal } from "@/lib/crypto/envelope-secreto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  gerarSegredoDeWebhook,
  pareceSegredoPlaceholder,
  provisionarSegredoDeWebhook,
} from "@/lib/webhooks/provisionar-segredo";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

const curar = process.argv.includes("--curar");

async function main(): Promise<void> {
  const admin = createAdminClient();

  console.log(`cifra na aplicação: ${cifraLocalDisponivel() ? "disponível" : "AUSENTE"}`);

  const { data: gucOk } = await admin.rpc("fn_encrypt_oauth", { plaintext: "sonda" });
  console.log(`cifra no banco (GUC): ${gucOk ? "disponível" : "AUSENTE"}`);

  // Round-trip real, com a configuração REAL desta instalação. Sem isto o
  // diagnóstico diria "tem chave" sem provar que a chave funciona.
  const amostra = gerarSegredoDeWebhook();
  const cifrado = await encryptWebhookSecret(admin, amostra);
  if (!cifrado) {
    console.error(
      "FALHA: nenhuma cifra disponível — nenhuma conexão de canal consegue nascer.\n" +
        "Defina SECRET_ENCRYPTION_KEY (openssl rand -hex 32) no ambiente do app.",
    );
    process.exitCode = 1;
    return;
  }
  const volta = await decryptWebhookSecret(admin, cifrado);
  console.log(`round-trip: ${volta === amostra ? "ok" : "FALHOU"}`);
  console.log(`formato gravado: ${ehEnvelopeLocal(cifrado) ? "envelope da aplicação" : "pgp_sym do banco"}`);
  if (volta !== amostra) process.exitCode = 1;

  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, provider, webhook_secret_encrypted");
  if (error) {
    console.error(`não consegui listar as conexões: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const linhas = (data ?? []) as {
    id: string;
    organization_id: string;
    provider: string | null;
    webhook_secret_encrypted: string | null;
  }[];
  const podres = linhas.filter((l) => pareceSegredoPlaceholder(l.webhook_secret_encrypted));
  console.log(`conexões: ${linhas.length} — com segredo de mentira: ${podres.length}`);

  for (const l of podres) console.log(`  placeholder: ${l.id} (${l.provider ?? "?"})`);

  if (!curar || podres.length === 0) {
    if (podres.length > 0) console.log("rode com --curar para gerar segredo real nessas conexões");
    return;
  }

  for (const l of podres) {
    const novo = await provisionarSegredoDeWebhook(admin);
    if (!novo) {
      console.error(`  ${l.id}: cifra indisponível — nada gravado`);
      process.exitCode = 1;
      continue;
    }
    const { error: upErr } = await admin
      .from("channel_sessions")
      .update({ webhook_secret_encrypted: novo })
      .eq("id", l.id)
      .eq("organization_id", l.organization_id);
    console.log(`  ${l.id}: ${upErr ? `FALHOU (${upErr.message})` : "curada"}`);
    if (upErr) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
