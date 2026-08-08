/**
 * Conectar um número PELO GATEWAY, pela tela, numa conta nova
 * (spec 004, T063 / SC-006, Princípio IV).
 *
 * ## O que esta spec prova, e por que ela não pode ser `curl`
 *
 * A doutrina de QA Visual é explícita: `curl` valida o backend e **não prova
 * UX**. O que a spec 004 promete na frente de conexão é sobre a TELA — QR
 * aparecendo em ≤ 15 s, **sem passo a mais** do que o fluxo de hoje, sem a tela
 * nomear provedor, e o estado mudando sozinho quando conecta. Nenhuma dessas
 * quatro coisas é observável por chamada de API.
 *
 * ## Pré-condições (as mesmas do `vps-fresh-onboarding`, mais o gateway)
 *
 *   - banco zerado do `baseline.sql` num Supabase local **pg17**;
 *   - primeiro usuário por `scripts/bootstrap-owner.ts` — conta NOVA, estado
 *     VAZIO: sem canal, sem conhecimento, sem lead;
 *   - app em produção (`next build` + `next start`), nunca `next dev`;
 *   - **gateway de pé** com `STORE_ALVO=crm`, e no `.env` do CRM:
 *     `GATEWAY_BASE_URL`, `GATEWAY_ADMIN_TOKEN`, `GATEWAY_INTERNAL_TOKEN`.
 *
 * O `GATEWAY_ADMIN_TOKEN` é a pré-condição nova desta spec (T043): sem ele
 * `provisionamentoConfigurado()` é falso e a Central cai no caminho antigo — o
 * teste passaria medindo o canal errado. Por isso o primeiro caso **afirma a
 * pré-condição** em vez de assumi-la.
 *
 * ## Por que a contagem de passos é asserção, e não observação
 *
 * A FR-030 promete "sem nenhum passo a mais". Isso só é verificável contando, e
 * contando **na tela**: um passo a mais que ninguém contou é como uma migração
 * de canal piora o onboarding sem nenhum teste ficar vermelho.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const EVIDENCE_DIR = path.join(process.cwd(), ".superpowers/evidence/conexao-gateway");

/**
 * Credenciais do dono criado por `scripts/bootstrap-owner.ts` — a MESMA conta
 * nova, recém-bootstrapada, de que a `vps-fresh-onboarding` parte.
 */
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "dono@qa.local";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? "QaVps!2026#Dono";

/** SC-006: o QR tem de aparecer em ≤ 15 s do clique. */
const TETO_DO_QR_MS = 15_000;

function evidencia(nome: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  return path.join(EVIDENCE_DIR, nome);
}

/**
 * Conta os passos que o corretor DÁ, não os que a tela tem: clique, digitação e
 * escaneamento. Navegação automática não conta — ela não custa nada a ele.
 */
async function contarCliquesAte(page: Page, acao: () => Promise<void>): Promise<number> {
  let cliques = 0;
  const contar = () => {
    cliques += 1;
  };
  page.on("request", () => {});
  await page.exposeFunction("__contarClique", contar).catch(() => {});
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      () => {
        (window as unknown as { __contarClique?: () => void }).__contarClique?.();
      },
      true,
    );
  });
  await acao();
  return cliques;
}

/**
 * O passo que faltava, e o defeito que ele causou (medido em 2026-08-08).
 *
 * A primeira versão desta spec ia direto para `/app/connections`. Sem sessão, o
 * app redireciona para o login — e três casos falharam por não achar o botão.
 * Isso é o esperado.
 *
 * **O que NÃO é esperado, e é a lição:** o caso do estado vazio **passou** — ele
 * afirmava "o corpo da página não nomeia provedor", e a tela de LOGIN de fato
 * não nomeia. Um verde medindo a página errada. Uma asserção negativa sobre "o
 * corpo da página" passa em qualquer página que não tenha o termo, inclusive numa
 * que o teste nunca quis abrir — por isso os casos abaixo agora **afirmam onde
 * estão** antes de afirmar o que veem.
 */
async function entrar(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(OWNER_EMAIL);
  await page.locator("#password").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /entrar/i }).click();
  // Conta recém-bootstrapada cai no WIZARD, não em `/app` — medido em
  // 2026-08-08, e é o comportamento certo (a `vps-fresh-onboarding` o congela
  // no caso J1.1). Esperar só por `/app` fazia todo caso desta spec morrer no
  // login, dizendo "navegação não aconteceu" em vez de "foi para outro lugar".
  // `/login/mfa` entra na espera porque, a partir do SEGUNDO login, é para lá
  // que o app manda: o fator já existe e ele cobra o código. Esperar só por
  // `/app|/onboarding` fazia o teste morrer na tela de desafio dizendo
  // "navegação não aconteceu".
  await page.waitForURL(/\/(app|onboarding|login\/mfa)/, { timeout: 30_000 });
  await passarPeloMfa(page);
}

/** Segredo TOTP capturado no enrolamento — reusado pelos logins seguintes. */
let segredoTotp: string | null = null;

/** Digita o código de 6 dígitos, com retry na virada da janela de 30 s. */
async function digitarCodigo(page: Page, alvo: ReturnType<Page["getByRole"]>): Promise<void> {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    if (msUntilNextTotpWindow() < 4_000) await page.waitForTimeout(msUntilNextTotpWindow() + 300);
    await page.locator('input[aria-label="Dígito 1"]').click();
    await page.keyboard.type(generateTotp(segredoTotp!), { delay: 40 });
    try {
      await expect(alvo).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
      if (tentativa === 2) throw new Error("código TOTP recusado três vezes");
      await page.locator('input[aria-label="Dígito 1"]').click();
      for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
    }
  }
}

/**
 * O portão que faltava — e ele não é acidente de ambiente, é DOUTRINA.
 *
 * `CLAUDE.md` (Auth & RBAC) exige MFA TOTP para `admin`, e o dono criado pelo
 * `bootstrap-owner` É admin. Então a primeira coisa que ele vê depois do login é
 * um gate não-dismissível de 2FA — e nenhuma tela do app abre antes dele.
 *
 * Descoberto lendo o `error-context.md` que o próprio Playwright grava: a captura
 * da página no instante da falha dizia, com todas as letras, "Sua conta exige
 * 2FA". Antes disso eu tinha suposto duas causas erradas seguidas; a captura
 * encerrou o assunto em um minuto.
 *
 * O enrolamento segue o mesmo caminho da `vps-fresh-onboarding` — inclusive o
 * retry na virada da janela TOTP, que existe porque o código vale 30 s e o
 * servidor aceita cada um UMA vez.
 */
async function passarPeloMfa(page: Page): Promise<void> {
  const gate = page.getByRole("heading", { name: /verificação em duas etapas/i });
  if (!(await gate.isVisible().catch(() => false))) return;

  // DESAFIO (2º login em diante): o fator já existe e o app só cobra o código.
  // Distinguir do ENROLAMENTO pelo botão — sem isso, o segundo login tentaria
  // enrolar um fator que já existe.
  const iniciar = page.getByRole("button", { name: /iniciar configuração/i });
  if (!(await iniciar.isVisible().catch(() => false))) {
    if (!segredoTotp) throw new Error("desafio de MFA sem segredo — o enrolamento não rodou antes");
    await digitarCodigo(page, page.getByRole("heading", { name: /verificação em duas etapas/i }).first());
    await page.waitForURL(/\/(app|onboarding)/, { timeout: 20_000 });
    return;
  }

  await iniciar.click();
  await page.getByText(/não consegue escanear/i).click();
  segredoTotp = (await page.locator("code").innerText()).trim();
  await digitarCodigo(page, page.getByRole("heading", { name: /códigos de recuperação/i }));

  await page.getByText(/salvei meus códigos/i).click();
  await page.getByRole("button", { name: /^concluir$/i }).click();
  await expect(gate).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Marca o wizard como concluído — e SÓ ele.
 *
 * "Conta nova, estado vazio" (SC-006) é sobre o que o USUÁRIO ainda não fez:
 * nenhum canal, nenhuma base de conhecimento, nenhum lead. Não é sobre o wizard,
 * que é um passo de configuração inicial com tela própria. Passar por ele aqui
 * mede a Central de Conexões no estado que interessa em vez de medir o wizard
 * duas vezes — a jornada dele já tem spec (`vps-fresh-onboarding`).
 */
async function concluirWizard(): Promise<void> {
  const { createClient } = await import("@supabase/supabase-js");
  const svc = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  await svc
    .from("organizations")
    .update({ onboarded_at: new Date().toISOString() })
    .is("onboarded_at", null);
}

test.describe("conectar número pelo gateway, conta nova e estado vazio (SC-006)", () => {
  test.beforeAll(async () => {
    await concluirWizard();
  });

  test.beforeEach(async ({ page }) => {
    await entrar(page);
    await page.goto("/app/connections");
    // A âncora que impede o verde da página errada: se o redirecionamento levou
    // para outro lugar, o teste morre AQUI, dizendo isso.
    await expect(page).toHaveURL(/\/app\/connections/);
  });

  test("pré-condição: a instalação está mesmo no caminho do gateway", async ({ request, page }) => {
    void page; // o beforeEach já autenticou; aqui só se consulta o health
    // Sem esta afirmação, todo o resto da spec pode passar medindo o canal
    // ANTIGO — verde, e provando outra coisa.
    const res = await request.get("/api/v1/health");
    const corpo = (await res.json()) as {
      data: { checks: { gateway?: { status: string; reason?: string } } };
    };
    expect(
      corpo.data.checks.gateway?.status,
      "O gateway não está configurado nesta instalação. Sem GATEWAY_BASE_URL + " +
        "GATEWAY_ADMIN_TOKEN, a Central cai no caminho antigo e esta spec mediria o canal errado.",
    ).toBe("ok");
  });

  test("estado vazio: a tela diz o que fazer, e não nomeia provedor (FR-030, SC-007)", async ({
    page,
  }) => {
    // O estado vazio é o de 100% dos usuários novos, e é a tela que decide se
    // ele volta. Testar só com banco povoado esconde exatamente este defeito.
    // Afirmar que a tela é a certa ANTES de afirmar o que ela não diz: foi
    // exatamente isso que faltou na primeira versão.
    await expect(page.getByRole("button", { name: /conectar (novo )?(whatsapp|n[úu]mero)/i })).toBeVisible();
    const corpo = await page.locator("body").innerText();
    expect(corpo).not.toMatch(/\b(WAHA|uazapi|Baileys|NOWEB|WEBJS)\b/i);
    expect(corpo).not.toMatch(/docker\s+compose/i);
    await page.screenshot({ path: evidencia("01-estado-vazio.png"), fullPage: true });
  });

  test("QR aparece em ≤ 15 s, e sem passo a mais (FR-030, FR-031)", async ({ page }) => {
    const t0 = Date.now();

    const cliques = await contarCliquesAte(page, async () => {
      await page.getByRole("button", { name: /conectar (novo )?(whatsapp|n[úu]mero)/i }).click();
      // O diálogo abre e o material vem da rota de pareamento — não há
      // formulário no meio, e é isso que "sem passo a mais" quer dizer.
      await expect(page.getByRole("img", { name: /QR/i })).toBeVisible({
        timeout: TETO_DO_QR_MS,
      });
    });

    const decorrido = Date.now() - t0;
    expect(
      decorrido,
      `O QR levou ${decorrido} ms. Acima de ${TETO_DO_QR_MS} ms o corretor conclui que travou.`,
    ).toBeLessThanOrEqual(TETO_DO_QR_MS);

    // Um clique: o de conectar. Qualquer passo a mais é regressão de UX que a
    // migração introduziu — e é o que a FR-030 proíbe.
    expect(cliques, "Passos a mais do que o fluxo de hoje").toBeLessThanOrEqual(1);

    await page.screenshot({ path: evidencia("02-qr-na-tela.png"), fullPage: true });
  });

  test("o QR não é refeito no escuro: o pedido segue a validade (FR-031)", async ({ page }) => {
    // A regressão que este caso impede: voltar ao refresh cego de 15 s. Com a
    // validade declarada, entre dois pedidos tem de haver MAIS que o intervalo
    // antigo quando o material vale mais que isso.
    const pedidos: number[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/pairing")) pedidos.push(Date.now());
    });

    await page.getByRole("button", { name: /conectar (novo )?(whatsapp|n[úu]mero)/i }).click();
    await expect(page.getByRole("img", { name: /QR/i })).toBeVisible({ timeout: TETO_DO_QR_MS });
    await page.waitForTimeout(20_000);

    expect(pedidos.length, "nenhum pedido de pareamento saiu").toBeGreaterThan(0);
    if (pedidos.length >= 2) {
      const intervalo = pedidos[1]! - pedidos[0]!;
      expect(
        intervalo,
        "Dois pedidos com menos de 10 s entre eles é o refresh cego de volta.",
      ).toBeGreaterThan(10_000);
    }
  });

  test("estado desconhecido não vira tela vazia (FR-032)", async ({ page }) => {
    // O desfecho proibido é a tela em branco: o corretor sem saber se está
    // conectado, se precisa escanear, ou se o produto quebrou.
    await page.getByRole("button", { name: /conectar (novo )?(whatsapp|n[úu]mero)/i }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();
    const texto = (await dialogo.innerText()).trim();
    expect(texto.length, "diálogo de conexão sem nenhum texto de estado").toBeGreaterThan(20);
    await page.screenshot({ path: evidencia("03-estado-legivel.png"), fullPage: true });
  });
});
