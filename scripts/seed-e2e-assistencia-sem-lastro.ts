/**
 * Cenário da recusa por falta de lastro (spec 002, fatia F1).
 *
 * Monta o estado que existe DEPOIS de o agente recusar uma afirmação de assistência —
 * **chamando a função REAL** `escalarAssistenciaSemLastro`, nunca reproduzindo as
 * escritas na mão. Um seed que ligasse o estado com `UPDATE` próprio provaria o teste
 * contra a minha cópia da regra, não contra a regra. É o mesmo princípio do
 * `seed-e2e-escalacao.ts`, e ele existe porque a alternativa já enganou gente.
 *
 * ⚠️ **O que este seed NÃO simula, e a spec diz isso em voz alta:** o veto em si. Para o
 * gate decidir, é preciso um turno com modelo — e a suíte E2E roda sem chave de IA (o
 * `.env.e2e` nasce sem `AI_GATEWAY_API_KEY`, de propósito, porque é o estado de um
 * primeiro deploy). O veto está provado por unidade e por **sabotagem** em
 * `lib/agent-engine/guardrails/`; o que se prova pela TELA aqui é o que o corretor vê
 * quando ele acontece — que é o que a doutrina de QA Visual cobra e o que nenhum teste
 * unitário alcança.
 *
 * Idempotente: reexecutar resolve o aviso anterior e refaz o episódio.
 * Escreve o bloco `assistencia_sem_lastro` em `.e2e-creds.json`.
 *
 * Uso (depois de scripts/seed-e2e-credentials.ts):
 *   pnpm exec tsx --env-file=.env.local scripts/seed-e2e-assistencia-sem-lastro.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { escalarAssistenciaSemLastro } from "../lib/agent-engine/agent/escalar-sem-lastro";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
anunciarDestino("seed-e2e-assistencia-sem-lastro", credenciais);

const admin = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const pool = new pg.Pool({ connectionString: credenciais.dbUrl });

const CREDS = path.join(process.cwd(), ".e2e-creds.json");
const TELEFONE = "+5585988887777";
const NOME_CONTATO = "Cliente sem lastro E2E";

/**
 * A pergunta do cliente. Escolhida de propósito no assunto que mais custa quando a
 * resposta está errada: carência é o que faz alguém marcar uma cirurgia achando que tem
 * cobertura.
 */
export const PERGUNTA_DO_CLIENTE =
  "Boa tarde! Minha esposa precisa fazer uma cirurgia. Qual é a carência do nosso plano para internação?";

const log = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof escalarAssistenciaSemLastro>[1]["log"];

async function idDe<T extends { id: string }>(
  p: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  o: string,
): Promise<string> {
  const { data, error } = await p;
  if (error || !data) throw new Error(`${o}: ${error?.message ?? "sem linha"}`);
  return (data as T).id;
}

async function main(): Promise<void> {
  const creds = JSON.parse(fs.readFileSync(CREDS, "utf8")) as {
    org_id: string;
    [k: string]: unknown;
  };
  const orgId = creds.org_id;

  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1)
    .maybeSingle();
  const sessaoId = sessao
    ? (sessao as { id: string }).id
    : await idDe(
        admin
          .from("channel_sessions")
          .insert({
            organization_id: orgId,
            waha_session_name: `e2e-lastro-${Date.now()}`,
            webhook_secret_encrypted: "\\x00",
          })
          .select("id")
          .single(),
        "channel_sessions",
      );

  const { data: contatoExistente } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("phone_number", TELEFONE)
    .maybeSingle();
  const contatoId = contatoExistente
    ? (contatoExistente as { id: string }).id
    : await idDe(
        admin
          .from("contacts")
          .insert({
            organization_id: orgId,
            phone_number: TELEFONE,
            display_name: NOME_CONTATO,
          })
          .select("id")
          .single(),
        "contacts",
      );

  const { data: conversaExistente } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId)
    .limit(1)
    .maybeSingle();
  const conversaId = conversaExistente
    ? (conversaExistente as { id: string }).id
    : await idDe(
        admin
          .from("conversations")
          .insert({
            organization_id: orgId,
            contact_id: contatoId,
            channel_session_id: sessaoId,
            status: "ai_handling",
          })
          .select("id")
          .single(),
        "conversations",
      );

  // Reset do episódio: o aviso deduplica por (org, kind, contato, status='open'), então
  // sem isto a segunda execução não criaria nada e o teste leria o item da primeira.
  await pool.query(
    `update agent_inbox_items set status = 'resolved'
      where organization_id = $1 and kind = 'assistance_without_grounding'
        and ref_kind = 'contact' and ref_id = $2 and status = 'open'`,
    [orgId, contatoId],
  );
  await pool.query(
    `update conversations set status = 'ai_handling' where organization_id = $1 and id = $2`,
    [orgId, conversaId],
  );

  // A pergunta do cliente na conversa — é ela que o corretor precisa ler no aviso.
  await admin.from("messages").insert({
    organization_id: orgId,
    conversation_id: conversaId,
    direction: "inbound",
    type: "text",
    body: PERGUNTA_DO_CLIENTE,
    status: "received",
  });

  // ── A FUNÇÃO REAL ──────────────────────────────────────────────────────────────
  const criados = await escalarAssistenciaSemLastro(pool, {
    tenantId: orgId,
    leadId: contatoId,
    conversationId: conversaId,
    perguntaOriginal: PERGUNTA_DO_CLIENTE,
    escopo: null, // F1 ainda não tem vínculo cliente↔operadora — "não identificada"
    log,
  });

  creds.assistencia_sem_lastro = {
    conversation_id: conversaId,
    contact_id: contatoId,
    contact_name: NOME_CONTATO,
    pergunta: PERGUNTA_DO_CLIENTE,
    avisos_criados: criados,
  };
  fs.writeFileSync(CREDS, `${JSON.stringify(creds, null, 2)}\n`);

  const { rows } = await pool.query<{ status: string }>(
    `select status from conversations where organization_id = $1 and id = $2`,
    [orgId, conversaId],
  );
  // eslint-disable-next-line no-console
  console.info(
    `[seed] recusa semeada · aviso criado: ${criados} · conversa agora: ${rows[0]?.status ?? "?"}`,
  );
  await pool.end();
}

void main();
