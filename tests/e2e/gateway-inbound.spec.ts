/**
 * A mensagem atravessa a costura e aparece NA TELA (T022 e T047 da spec 001).
 *
 * ## Por que esta spec existe se os invariantes já passam
 *
 * Os invariantes provam que a linha pousa no Postgres com as constraints reais.
 * Isso não é a promessa do produto. A promessa é que **o corretor vê a mensagem
 * do cliente** — e entre a linha e o olho dele há a listagem, o Realtime, o
 * escopo por organização, a renderização do anexo e a URL assinada. Toda essa
 * faixa é invisível para `curl` e para teste de banco, e é onde moram os defeitos
 * que fazem alguém desistir do produto.
 *
 * Por isso a doutrina de QA Visual chama `curl` de diagnóstico, não de prova.
 *
 * ## O emissor é o gateway de verdade — em comportamento
 *
 * A spec **assina** a entrega com HMAC-SHA512 sobre `timestamp.corpo`, usando o
 * segredo da conexão semeada, e bate na rota pública. Não há atalho por service
 * role, nem inserção direta em `messages`: se a autenticação, o mapa
 * token→organização ou a idempotência estiverem quebrados, esta spec fica
 * vermelha — que é o ponto.
 *
 * ## O que ela NÃO cobre, e onde isso está declarado
 *
 * Não cobre o provedor real (WhatsApp) nem o gateway em Go: o roteiro de ponta a
 * ponta com celular é o T030, e o de rajada é o T038a. Aqui a costura provada é
 * **envelope assinado → rota → ingest → tela**.
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Locator, type Page } from "@playwright/test";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const FIXTURE_PATH = path.join(process.cwd(), ".e2e-gateway.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

interface FixtureDoGateway {
  organization_id: string;
  channel_session_id: string;
  webhook_path_token: string;
  segredo: string;
}

function carregarCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function carregarFixture(): FixtureDoGateway {
  // Sempre re-semeia: o segredo pode ter sido rotacionado por outra frente, e
  // assinar com um segredo velho dá 401 numa conexão que existe — sintoma que
  // lê como "a rota está quebrada".
  execFileSync("npx", ["tsx", "scripts/seed-e2e-gateway.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as FixtureDoGateway;
}

const creds = carregarCreds();
const fixture = carregarFixture();
const ts = Date.now();

/** Número do "cliente" desta execução — sufixo próprio para não colidir com outras rodadas. */
const TELEFONE = `+5511${String(ts).slice(-9)}`;
const CORPO_DA_MENSAGEM = `Bom dia, quero um plano de saude ${ts}`;

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelope_version: 1,
    event_id: `01H${ts}E2E`,
    event_kind: "new_message",
    occurred_at: new Date().toISOString(),
    platform: "whatsapp_uazapi",
    message: {
      external_id: `E2E_${ts}`,
      direction: "inbound",
      type: "text",
      body: CORPO_DA_MENSAGEM,
    },
    participant: { external_id: TELEFONE, display_name: `Cliente E2E ${ts}` },
    ...over,
  };
}

/** Entrega assinada, exatamente como o gateway monta (contrato §2). */
async function entregar(corpo: Record<string, unknown>): Promise<Response> {
  const cru = JSON.stringify(corpo);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const assinatura = createHmac("sha512", fixture.segredo)
    .update(`${timestamp}.${cru}`, "utf8")
    .digest("hex");

  return fetch(`${APP_URL}/api/v1/webhooks/gateway/${fixture.webhook_path_token}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Gateway-Timestamp": timestamp,
      "X-Gateway-Signature": assinatura,
      "X-Gateway-Delivery-Id": `e2e-${ts}`,
    },
    body: cru,
  });
}

/**
 * Espera a entrega chegar ao FIM do processamento, e não só ao 202.
 *
 * ## O defeito que isto conserta (medido em 2026-08-08)
 *
 * A rota responde 202 **antes** de ingerir (ACK-primeiro). Uma asserção de
 * contagem logo depois, como `toHaveCount(1)`, é satisfeita no instante em que
 * existe uma bolha — e o Playwright para de olhar ali. Se a duplicata chegasse
 * meio segundo depois, ninguém veria.
 *
 * Não é hipótese: com o ingest sabotado para gravar `external_id` diferente a
 * cada entrega, o banco terminou com TRÊS mensagens de corpo idêntico e o teste
 * de "não duplica" passou **verde**. Pelo Princípio XI, teste que não fica
 * vermelho com a implementação sabotada não é prova.
 *
 * O sincronismo é lido do `webhook_events_log` — que é o próprio ACK durável da
 * rota, não um atalho inventado para o teste. A ASSERÇÃO continua na tela: isto
 * só decide QUANDO olhar.
 */
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function aguardarEntregasResolvidas(marcador: string, quantas: number): Promise<string[]> {
  const limite = Date.now() + 30_000;
  let ultimos: string[] = [];
  while (Date.now() < limite) {
    // Filtra pelo CORPO, não pela coluna `external_id`: numa entrega recusada
    // por assinatura a rota grava a linha antes de sequer ler o envelope, então
    // a coluna sai `null`. Casar pela coluna deixaria o caso da forjada esperando
    // para sempre por uma linha que existe.
    const { data } = await admin
      .from("webhook_events_log")
      .select("status")
      .eq("organization_id", fixture.organization_id)
      .like("raw_body", `%${marcador}%`);
    ultimos = ((data ?? []) as { status: string }[]).map((l) => l.status);
    // 'received' é estado transitório: a linha existe, a ingestão ainda corre.
    const resolvidas = ultimos.filter((s) => s === "processed" || s === "error");
    if (resolvidas.length >= quantas) return resolvidas;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `entregas de ${marcador} não resolveram em 30s (estados vistos: ${ultimos.join(",") || "nenhum"})`,
  );
}

/** Bolhas da THREAD que contêm este corpo — não a prévia da listagem. */
function bolhasCom(page: Page, corpo: string): Locator {
  return page.getByTestId("bolha-de-mensagem").filter({ hasText: corpo });
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe("recebimento pelo gateway — pela tela", () => {
  // A entrega responde 202 antes da ingestão (ACK-primeiro), então a mensagem
  // aparece por Realtime alguns instantes depois. O teto generoso é para o
  // vermelho significar "não chegou", e não "chegou devagar num CI carregado".
  test.setTimeout(120_000);

  test("mensagem assinada entra e aparece no inbox com contato e corpo certos", async ({
    page,
  }) => {
    const res = await entregar(envelope());
    // 202, e não 200: o corpo foi aceito para processamento. Um 200 aqui
    // significaria que alguém trocou o ACK-primeiro por processamento síncrono.
    expect(res.status).toBe(202);

    await login(page, creds.users.manager!.email);
    await page.goto(`${APP_URL}/app/inbox`);

    // A conversa aparece pelo nome do contato — que veio do envelope, porque o
    // contato é novo. Em contato já existente o nome humano vence (posse de
    // nome), e isso é cobrado no invariante T021.
    const conversa = page.getByText(`Cliente E2E ${ts}`).first();
    await expect(conversa).toBeVisible({ timeout: 30_000 });

    await conversa.click();
    // A BOLHA, não o texto solto: a prévia na listagem repete o corpo da última
    // mensagem, então `getByText(corpo)` fica verde mesmo se a conversa nunca
    // abrir. O que se prova aqui é que a mensagem chegou à THREAD.
    await expect(bolhasCom(page, CORPO_DA_MENSAGEM).first()).toBeVisible({ timeout: 15_000 });
  });

  test("reentrega do mesmo evento não duplica a mensagem na tela", async ({ page }) => {
    // Evento PRÓPRIO deste caso — não o do caso anterior. Reaproveitar aquele
    // faria a espera abaixo depender de quantos casos rodaram antes, e um
    // `-g` isolado passaria a contar entregas que nunca aconteceram.
    const idProprio = `E2E_DUP_${ts}`;
    const corpo = `Reentrega ${ts}`;
    const mesmo = envelope({
      event_id: `01H${ts}E2EDUP`,
      message: { external_id: idProprio, direction: "inbound", type: "text", body: corpo },
    });
    await entregar(mesmo);
    const segunda = await entregar(mesmo);
    // A segunda também é aceita — o gateway reentrega por desenho, e recusar
    // faria ele retentar para sempre uma entrega que já foi processada.
    expect(segunda.status).toBe(202);

    // As DUAS entregas têm de estar resolvidas antes de contar bolhas. Contar
    // antes disso mede a velocidade da máquina, não a idempotência.
    await aguardarEntregasResolvidas(idProprio, 2);

    await login(page, creds.users.manager!.email);
    await page.goto(`${APP_URL}/app/inbox`);
    await page.getByText(`Cliente E2E ${ts}`).first().click();

    // Uma bolha, não duas. É o `unique (organization_id, external_id)` visto do
    // lado de quem lê a conversa — e é o que torna seguro os dois caminhos
    // coexistirem durante a virada.
    const bolhas = bolhasCom(page, corpo);
    await expect(bolhas.first()).toBeVisible({ timeout: 30_000 });
    await expect(bolhas).toHaveCount(1);
  });

  test("entrega forjada não aparece na tela (T047 do lado do que NÃO entra)", async ({ page }) => {
    const cru = JSON.stringify(
      envelope({
        message: {
          external_id: `E2E_FORJADO_${ts}`,
          direction: "inbound",
          type: "text",
          body: `MENSAGEM FORJADA ${ts}`,
        },
      }),
    );
    const res = await fetch(`${APP_URL}/api/v1/webhooks/gateway/${fixture.webhook_path_token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Gateway-Timestamp": String(Math.floor(Date.now() / 1000)),
        "X-Gateway-Signature": "f".repeat(128),
      },
      body: cru,
    });
    expect(res.status).toBe(401);

    // Espera a entrega alcançar estado TERMINAL antes de afirmar ausência.
    // Sem isto, o caso passaria mesmo com a verificação de assinatura desligada:
    // olharia a tela antes de a mensagem forjada ser ingerida e leria o vazio
    // como prova. Com a recusa em pé o estado terminal é `error` (SC-012, a
    // recusa grava linha com motivo); com a verificação sabotada seria
    // `processed` — e aí a bolha aparece e a contagem abaixo reprova.
    const estados = await aguardarEntregasResolvidas(`E2E_FORJADO_${ts}`, 1);
    expect(estados).toContain("error");

    await login(page, creds.users.manager!.email);
    await page.goto(`${APP_URL}/app/inbox`);
    // A prova é de AUSÊNCIA na tela: o invariante já cobre "nada foi gravado",
    // e aqui se cobra que nada apareceu para o atendente ler como verdade.
    await expect(page.getByText(`MENSAGEM FORJADA ${ts}`)).toHaveCount(0);
  });

  test("mensagem com anexo entra mesmo quando o anexo não baixa (FR-025)", async ({ page }) => {
    const corpo = `Segue meu documento ${ts}`;
    const res = await entregar(
      envelope({
        event_id: `01H${ts}E2EMIDIA`,
        message: {
          external_id: `E2E_MIDIA_${ts}`,
          direction: "inbound",
          type: "image",
          body: corpo,
        },
        // Referência que não existe no gateway de teste: o download vai falhar,
        // e é justamente esse o caso a provar. Anexo quebrado não pode custar a
        // conversa — a inversão de gravidade que o FR-025 proíbe.
        media: { ref: `media/inexistente-${ts}.jpg`, mime: "image/jpeg", size_bytes: 1024 },
      }),
    );
    expect(res.status).toBe(202);

    await login(page, creds.users.manager!.email);
    await page.goto(`${APP_URL}/app/inbox`);
    await page.getByText(`Cliente E2E ${ts}`).first().click();

    await expect(bolhasCom(page, corpo).first()).toBeVisible({ timeout: 30_000 });
  });
});
