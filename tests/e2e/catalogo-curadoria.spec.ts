/**
 * A curadoria da plataforma, pela tela — spec 002, T040 (US7, FR-037).
 *
 * ═══ POR QUE ESTA TELA TEM DONO DIFERENTE ═══
 *
 * O catálogo curado é a partição `catalog_*`: **sem `organization_id`**. Quem edita não é o
 * corretor, é quem cuida da instalação — e o que ele escreve alcança TODAS as organizações
 * ao mesmo tempo. Errar aqui não estraga um tenant: estraga o produto inteiro de uma vez.
 *
 * ═══ A TRAVA QUE ESTE ARQUIVO EXISTE PARA VIGIAR ═══
 *
 * Corrigir material curado **não reescreve**: cria `version + 1`, e a anterior continua
 * guardada (FR-037, trava 6). A tela nem tem botão "Salvar" — tem "Publicar versão N". A
 * diferença não é de vocabulário: com sobrescrita, uma correção apaga a resposta que o
 * agente deu semana passada, e o `message_groundings` de todas as organizações passa a
 * apontar para um texto que ninguém pode mais ler. O caso da versão mede isso NO BANCO,
 * porque é lá que a diferença existe — a tela mostra o mesmo título nos dois desenhos.
 *
 * ═══ E A TRAVA QUE VEM DE GRAÇA COM ELA ═══
 *
 * O que a plataforma cria chega ao tenant como ESPELHO **desligado** (A-20). Curadoria que
 * ligasse sozinha faria toda organização passar a afirmar coisas sobre uma operadora que
 * ela não vende, no instante em que alguém da plataforma clicasse "Criar". O caso final
 * cobra o espelho existindo e `is_active = false`.
 *
 * Pré-requisitos: `scripts/seed-e2e-credentials.ts` e `scripts/seed-e2e-system-update.ts`
 * (é ele que promove o usuário `admin` a dono do servidor — `platform_admins` é superfície
 * diferente do `role` da organização). O spec roda o segundo sozinho.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t040-curadoria");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  /** O segundo fator do `admin` — o seed o deixa verificado (`auth.mfa_factors`). */
  admin_totp?: { factor_id: string; secret: string };
}

let creds: Creds;
let pool: pg.Pool;

const SLUG = "operadora-curada-e2e";
const NOME = "Operadora Curada E2E";
const MATERIAL_SLUG = "carencia-curada-e2e";
const MATERIAL_TITULO = "Carencia de internacao (curado)";
const TEXTO_V1 = "A carência para internação eletiva é de 180 dias a partir da assinatura.";
const TEXTO_V2 = "A carência para internação eletiva é de 90 dias a partir da assinatura.";

async function limpar(): Promise<void> {
  await pool.query(
    `delete from knowledge_scopes
      where catalog_scope_id in (select id from catalog_scopes where slug = $1)`,
    [SLUG],
  );
  await pool.query(
    `delete from catalog_chunks
      where catalog_scope_id in (select id from catalog_scopes where slug = $1)`,
    [SLUG],
  );
  await pool.query(
    `delete from catalog_materials
      where catalog_scope_id in (select id from catalog_scopes where slug = $1)`,
    [SLUG],
  );
  await pool.query("delete from catalog_scopes where slug = $1", [SLUG]);
}

test.beforeAll(async () => {
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 2 });

  // Dono do servidor. Idempotente — e obrigatório: sem `platform_admins`, a tela de
  // curadoria responde 403 e o spec falharia por falta de papel, não por defeito.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });

  await limpar();
});

test.afterAll(async () => {
  if (!pool) return;
  // O catálogo é GLOBAL: uma operadora de teste esquecida aqui aparece na tela de toda
  // organização deste banco, inclusive nas dos outros specs.
  await limpar();
  await pool.end();
});

/**
 * Login do dono do servidor — com segundo fator, porque o `admin` do seed o tem.
 *
 * ⚠️ **Uma vez só, e a sessão é compartilhada** (`mode: serial` + contexto reaproveitado).
 * Código TOTP vale UMA vez dentro da janela de 30 s: quatro casos logando em sequência
 * mandam o mesmo código, e o segundo é recusado como replay. Foi o que derrubou a
 * `reset-password-mfa` (issue #80), e a primeira versão deste arquivo repetia o erro —
 * logava em cada caso.
 */
async function loginComSegundoFator(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();

  const segredo = creds.admin_totp?.secret;
  if (!segredo) throw new Error("`.e2e-creds.json` sem admin_totp — rode seed-e2e-credentials.ts");

  await page.waitForURL(/\/login\/mfa/, { timeout: 30_000 });
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(segredo), { delay: 40 });
    try {
      // Ausência prova transição: o desafio SUMIR é o sinal, não ele estar visível.
      await page.waitForURL(/\/app|\/admin/, { timeout: 10_000 });
      return;
    } catch {
      await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    }
  }
  throw new Error("o segundo fator recusou duas tentativas seguidas");
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

/**
 * UMA sessão para os quatro casos. Ver `loginComSegundoFator`: o custo de logar de novo não
 * é tempo, é um código TOTP recusado por replay.
 *
 * O contexto é criado PREGUIÇOSAMENTE, no primeiro caso, e não num `beforeAll`: criá-lo lá
 * deu "Target page, context or browser has been closed" já no primeiro clique — o
 * `beforeAll` que abre o contexto e o que fecha o pool são hooks distintos, e o ciclo de
 * vida do browser não é o mesmo do arquivo. Preguiçoso, o dono do contexto é quem o usa.
 */
let contexto: BrowserContext | undefined;
let pagina: Page | undefined;

async function sessaoDoDono(browser: Browser): Promise<Page> {
  if (pagina) return pagina;
  contexto = await browser.newContext();
  pagina = await contexto.newPage();
  await loginComSegundoFator(pagina, creds.users.admin!.email, creds.password);
  return pagina;
}

test.afterAll(async () => {
  await contexto?.close();
  contexto = undefined;
  pagina = undefined;
});

test.describe("curadoria do catálogo (T040, FR-037)", () => {
  test("o dono do servidor cria a operadora curada pela tela", async ({ browser }) => {
    // O default de 30 s do config não cabe aqui: o login com segundo fator pode ESPERAR a
    // virada da janela TOTP (até 30 s) antes de digitar, e ainda tem uma segunda tentativa.
    // Medido em 2026-08-10: estourava o teste e o erro chegava como "Target page, context
    // or browser has been closed" — o teardown do timeout, não a causa.
    test.setTimeout(180_000);
    const page = await sessaoDoDono(browser);
    await page.goto("/admin/catalogo");
    await expect(page).toHaveURL(/\/admin\/catalogo/);

    // A tela abre na aba "O que está faltando" — as lacunas que a curadoria ainda não
    // cobriu, que é a pergunta que o curador chega fazendo. Criar operadora mora na aba
    // ao lado, e é preciso ir até ela como o curador vai.
    await page.getByRole("tab", { name: "Operadoras" }).click();
    await page.getByRole("button", { name: /nova operadora/i }).click();
    await page.locator("#escopo-nome").fill(NOME);
    await page.locator("#escopo-slug").fill(SLUG);
    // A resposta da rota é o sinal de chegada — o diálogo fecha no otimismo da tela.
    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/catalog/scopes") && r.request().method() === "POST",
        { timeout: 30_000 },
      ),
      page.getByRole("button", { name: "Criar operadora" }).click(),
    ]);
    expect(resposta.status(), await resposta.text()).toBeLessThan(300);

    const { rows } = await pool.query<{ display_name: string }>(
      "select display_name from catalog_scopes where slug = $1",
      [SLUG],
    );
    expect(rows, "a operadora curada não chegou ao banco").toHaveLength(1);
    expect(rows[0]!.display_name).toBe(NOME);

    await captura(page, "1-operadora-curada-criada");
  });

  test("o material curado nasce na versão 1", async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await sessaoDoDono(browser);
    await page.goto("/admin/catalogo");
    await page.getByRole("tab", { name: "Operadoras" }).click();
    await page.getByText(NOME).first().click();
    await expect(page).toHaveURL(/\/admin\/catalogo\/[0-9a-f-]{36}/, { timeout: 30_000 });

    await page.getByRole("button", { name: /novo material/i }).click();
    await page.locator("#material-slug").fill(MATERIAL_SLUG);
    await page.locator("#material-titulo").fill(MATERIAL_TITULO);
    await page.locator("#material-texto").fill(TEXTO_V1);
    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/v1\/catalog\/scopes\/[0-9a-f-]+\/materials/.test(r.url()) && r.request().method() === "POST",
        { timeout: 60_000 },
      ),
      // O rótulo do botão JÁ diz a regra: "Criar versão 1", não "Salvar".
      page.getByRole("button", { name: /criar versão 1/i }).click(),
    ]);
    expect(resposta.status(), await resposta.text()).toBeLessThan(300);

    const { rows } = await pool.query<{ version: number; body: string }>(
      "select version, body from catalog_materials where slug = $1 order by version",
      [MATERIAL_SLUG],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);

    await captura(page, "2-material-curado-versao-1");
  });

  test("corrigir NÃO reescreve: publica a versão 2 e a 1 continua guardada (FR-037)", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await sessaoDoDono(browser);
    await page.goto("/admin/catalogo");
    await page.getByRole("tab", { name: "Operadoras" }).click();
    await page.getByText(NOME).first().click();
    // O botão da tela diz a regra em voz alta — "Corrigir (publica a versão 2)". Não existe
    // "Salvar" nesta tela, e é isso que este caso vigia.
    await page.getByRole("button", { name: /corrigir \(publica a versão 2\)/i }).click();

    await page.locator("#material-texto").fill(TEXTO_V2);
    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/v1\/catalog\/materials\//.test(r.url()) && r.request().method() === "PATCH",
        { timeout: 60_000 },
      ),
      page.getByRole("button", { name: /publicar versão 2/i }).click(),
    ]);
    expect(resposta.status(), await resposta.text()).toBeLessThan(300);

    // A prova mora no BANCO: a tela mostraria o mesmo título nos dois desenhos, o que
    // reescreve e o que versiona. DUAS linhas, e a de baixo com o texto ANTIGO intacto.
    const { rows } = await pool.query<{ version: number; body: string }>(
      "select version, body from catalog_materials where slug = $1 order by version",
      [MATERIAL_SLUG],
    );
    expect(rows.map((r) => r.version), "a correção sobrescreveu em vez de versionar").toEqual([
      1, 2,
    ]);
    expect(rows[0]!.body, "a versão 1 foi reescrita — a resposta já dada virou ilegível").toContain(
      "180 dias",
    );
    expect(rows[1]!.body).toContain("90 dias");

    await captura(page, "3-versao-2-publicada");
  });

  test("o que a plataforma cria chega ao tenant DESLIGADO (A-20)", async () => {
    // `fn_sincronizar_escopos_do_catalogo` é a função do produto — a mesma que o
    // provisionamento chama. Reproduzir o insert do espelho aqui provaria o teste contra a
    // minha cópia da regra.
    await pool.query("select public.fn_sincronizar_escopos_do_catalogo($1)", [creds.org_id]);

    const { rows } = await pool.query<{ is_active: boolean; display_name: string }>(
      `select ks.is_active, ks.display_name
         from knowledge_scopes ks
         join catalog_scopes cs on cs.id = ks.catalog_scope_id
        where ks.organization_id = $1 and cs.slug = $2`,
      [creds.org_id, SLUG],
    );
    expect(rows, "a operadora curada não virou espelho no tenant").toHaveLength(1);
    expect(
      rows[0]!.is_active,
      "o espelho nasceu LIGADO — toda organização passaria a falar de uma operadora que não vende",
    ).toBe(false);
  });
});
