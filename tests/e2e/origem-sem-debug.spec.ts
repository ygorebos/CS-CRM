/**
 * De onde veio essa resposta — em no máximo 3 interações, com a depuração DESLIGADA.
 * Spec 002, US3, T103, SC-008 (FR-022, FR-039).
 *
 * ═══ O CRITÉRIO É O NÚMERO, E POR ISSO ELE É CONTADO ═══
 *
 * SC-008 não diz "a origem está disponível": diz que o corretor **chega ao texto do
 * trecho** em até 3 interações de tela. A diferença é o que separa a feature entregue do
 * botão que existe atrás de um menu atrás de uma aba. Por isso este spec conta cliques
 * numa variável e afirma o total — uma regressão que acrescente um passo (um "ver mais",
 * uma aba, um modal intermediário) deixa todas as outras asserções verdes e quebra ESTA.
 *
 * ═══ E POR ISSO A DEPURAÇÃO FICA DESLIGADA ═══
 *
 * A citação já esteve atrás do toggle de depuração (T106 a tirou de lá). Um spec que
 * ligasse o toggle para "poder ver a origem" mediria o caminho do desenvolvedor, não o do
 * corretor — e continuaria verde no dia em que a origem voltasse para trás do interruptor.
 * Aqui nada é ligado: o estado é o de quem acabou de entrar.
 *
 * ═══ O QUE ESTE SPEC NÃO PROVA ═══
 *
 * Que a citação corresponde ao trecho que a busca realmente usou. Isso exige um turno com
 * modelo, e a suíte roda sem chave de IA de propósito. O elo entre busca e citação está em
 * `tests/invariants/precedencia-de-camada.test.ts` e no registro de
 * `message_groundings` (`rastreabilidade-sobrevive-reindex.test.ts`). Aqui o objeto é a
 * TELA: dado que a resposta tem origem, quantos passos até lê-la.
 *
 * Pré-requisitos (stack local do baseline, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/origem-sem-debug.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t103-origem");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;
let pool: pg.Pool;

const CONTATO = "Cliente da Origem E2E";
const TELEFONE = "+5585999990103";
/** O texto do TRECHO — é a ele que o corretor tem de chegar, não ao nome do manual. */
const TRECHO =
  "A segunda via do boleto sai pelo portal do beneficiario, na aba Financeiro, ate o dia 25.";
const MATERIAL = "Manual de cobranca da Operadora X";
const ESCOPO_NOME = "Operadora X (origem E2E)";

/**
 * `conversations.contact_id` é `on delete RESTRICT` — histórico de conversa não some por
 * contato apagado, e é a decisão certa. A limpeza tem de descer na ordem: conversa (que
 * leva as mensagens e as âncoras por cascade), depois contato, depois escopo.
 */
async function limpar(): Promise<void> {
  await pool.query(
    `delete from conversations
      where organization_id = $1
        and contact_id in (select id from contacts where organization_id = $1 and phone_number = $2)`,
    [creds.org_id, TELEFONE],
  );
  await pool.query(
    "delete from contacts where organization_id = $1 and phone_number = $2",
    [creds.org_id, TELEFONE],
  );
  await pool.query("delete from knowledge_scopes where display_name = $1", [ESCOPO_NOME]);
}

test.beforeAll(async () => {
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 2 });

  // Regra 6 do CLAUDE.md: estado que sobrevive entre execuções é a causa favorita do
  // "piorou sem eu mexer". A conversa e a mensagem saem por cascade do contato.
  await limpar();

  const escopo = (
    await pool.query<{ id: string }>(
      `insert into knowledge_scopes (organization_id, display_name, is_active)
       values ($1, $2, true) returning id`,
      [creds.org_id, ESCOPO_NOME],
    )
  ).rows[0]!.id;

  const contato = (
    await pool.query<{ id: string }>(
      `insert into contacts (organization_id, name, phone_number, knowledge_scope_id, knowledge_scope_source)
       values ($1, $2, $3, $4, 'cadastro') returning id`,
      [creds.org_id, CONTATO, TELEFONE, escopo],
    )
  ).rows[0]!.id;

  const sessao = (
    await pool.query<{ id: string }>(
      `select id from channel_sessions where organization_id = $1 order by created_at limit 1`,
      [creds.org_id],
    )
  ).rows[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
         values ($1, 'sessao-origem-e2e', 'WORKING', '\\x00'::bytea) returning id`,
        [creds.org_id],
      )
    ).rows[0]!.id;

  const conversa = (
    await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group)
       values ($1, $2, $3, 'open', false) returning id`,
      [creds.org_id, contato, sessao],
    )
  ).rows[0]!.id;

  await pool.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                           type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, 'text', 'inbound', 'delivered', 'como tiro a segunda via do boleto?', 'external_device', now() - interval '2 minutes')`,
    [creds.org_id, conversa, sessao, contato],
  );

  // A resposta do agente, COM a citação embutida em `metadata` — que é como ela viaja de
  // verdade (atômica com a mensagem, `inbound-turn.ts`). Semear a citação por fora, numa
  // tabela à parte, provaria um caminho que não existe em produção.
  const resposta = (
    await pool.query<{ id: string }>(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at, metadata)
       values ($1, $2, $3, $4, 'text', 'outbound', 'delivered',
               'Pelo portal do beneficiario, na aba Financeiro.', 'ai', now(), $5::jsonb)
       returning id`,
      [
        creds.org_id,
        conversa,
        sessao,
        contato,
        JSON.stringify({
          ai_generated: true,
          citations: [
            {
              chunk_id: "11111111-1111-4111-8111-111111111111",
              score: 0.89,
              snippet: TRECHO,
              metadata: {
                layer: "tenant",
                title: MATERIAL,
                scope: ESCOPO_NOME,
                updated_at: "2026-08-01T00:00:00.000Z",
                section_title: "Segunda via",
              },
            },
          ],
        }),
      ],
    )
  ).rows[0]!.id;

  await pool.query(
    `insert into message_groundings (organization_id, message_id, layer, chunk_id, source_ref, similarity)
     values ($1, $2, 'tenant', '11111111-1111-4111-8111-111111111111', $3::jsonb, 0.89)`,
    [
      creds.org_id,
      resposta,
      JSON.stringify({ layer: "tenant", title: MATERIAL, scope: ESCOPO_NOME }),
    ],
  );
});

test.afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

test.describe("de onde veio a resposta, sem ligar nada (SC-008)", () => {
  test("o texto do trecho está a 2 interações — e o teto de SC-008 é 3", async ({ page }) => {
    await login(page, creds.users.agent!.email, creds.password);

    let interacoes = 0;

    // (1) abrir a conversa. O login não conta: ele é o custo de entrar no produto, não o
    // de responder "de onde veio isso".
    await page.goto("/app/inbox");
    await expect(page).toHaveURL(/\/app\/inbox/);
    await page.getByText(CONTATO).first().click();
    interacoes += 1;

    await expect(page.getByText(/portal do beneficiario/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await captura(page, "conversa-com-a-resposta-do-agente");

    // (2) o botão de origem. Ele está NA BOLHA, visível, sem nenhum interruptor ligado.
    const origem = page.getByRole("button", { name: "Mostrar citações da resposta" });
    await expect(origem).toBeVisible();
    await origem.click();
    interacoes += 1;

    // O TEXTO DO TRECHO — não o nome do manual. É o que FR-022 pede: chegar ao trecho.
    await expect(page.getByText(TRECHO.slice(0, 60), { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await captura(page, "painel-de-origem-com-o-trecho");

    expect(interacoes, "SC-008 dá um teto de 3 interações de tela").toBeLessThanOrEqual(3);
  });

  test("o painel diz de QUEM é o material — camada, escopo e título (FR-039)", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/inbox");
    await page.getByText(CONTATO).first().click();
    await page.getByRole("button", { name: "Mostrar citações da resposta" }).click();

    const painel = (await page.locator("body").innerText()).toLowerCase();
    // A camada decide a quem o corretor cobra a correção — material dele, ele mesmo.
    // O rótulo é "Material seu" (`descreverOrigem`), e não "tenant": o corretor não
    // conhece a palavra do sistema.
    expect(painel).toContain("material seu");
    expect(painel).toContain(ESCOPO_NOME.toLowerCase());
    expect(painel).toContain(MATERIAL.toLowerCase());
  });

  test("a origem aparece SEM modo de depuração — o interruptor não decide isso", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/inbox");

    // Âncora de lugar ANTES da asserção negativa (CLAUDE.md, regra 3).
    await expect(page).toHaveURL(/\/app\/inbox/);
    await page.getByText(CONTATO).first().click();
    await expect(page.getByText(/portal do beneficiario/i).first()).toBeVisible({
      timeout: 30_000,
    });

    // Nenhum interruptor de depuração foi tocado nesta sessão — e o botão de origem já
    // está lá. Se alguém devolver a citação para trás do toggle, este caso reprova.
    await expect(
      page.getByRole("button", { name: "Mostrar citações da resposta" }),
    ).toBeVisible();
    await expect(page.getByRole("switch", { name: /depura|debug/i })).toHaveCount(0);
  });
});
