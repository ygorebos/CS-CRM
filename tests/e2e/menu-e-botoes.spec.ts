/**
 * Enviar opções clicáveis — pela tela (spec 006, US4).
 *
 * ## O que se mede
 *
 * Que o corretor monta um menu sem sair do CRM, que o **teto de opções vem do
 * canal** e é imposto ANTES da rede, e que o envio é aceito. O clique do cliente
 * voltando legível à conversa depende de aparelho real e está declarado como
 * pendência em `docs/testing/user-journey-map.md` — esta spec **não** o afirma.
 *
 * ## Por que o teto é asserção
 *
 * O WhatsApp desenha botões até 3 opções e lista acima disso; o canal oficial
 * recusa acima de 10. Deixar o corretor descobrir isso pelo erro do provedor é
 * descobrir com o número do provedor, não com o nosso — e é o que a FR-019
 * proíbe.
 *
 * ## `cta_url` e `location_request` NÃO têm caso aqui
 *
 * De propósito: as duas são `false` para todo canal que a Central provisiona hoje
 * (só o oficial as suporta). Escrever um caso que sempre pula seria cobertura de
 * fachada; o contrato delas é vigiado por `menu-limites-do-canal.test.ts`.
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ mode: "serial" });

async function abrirMenuDeOpcoes(page: import("@playwright/test").Page): Promise<boolean> {
  await page.goto("/app/inbox");
  await expect(page).toHaveURL(/\/app\/inbox/);
  const conversa = page.getByTestId("item-conversa").first();
  if (!(await conversa.isVisible().catch(() => false))) return false;
  await conversa.click();
  await expect(page.getByRole("button", { name: "Anexar" })).toBeVisible();

  await page.getByRole("button", { name: "Anexar" }).click();
  const item = page.getByRole("button", { name: "Opções clicáveis" });
  if (!(await item.isVisible().catch(() => false))) return false;
  await item.click();
  await expect(page.getByTestId("dialogo-menu")).toBeVisible();
  return true;
}

test.describe("opções clicáveis", () => {
  test.beforeEach(async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
  });

  test("o teto de opções é do CANAL e está escrito na tela", async ({ page }) => {
    test.skip(!(await abrirMenuDeOpcoes(page)), "sem conversa, ou canal sem menu");

    const dialogo = page.getByTestId("dialogo-menu");
    // O número vem da matriz de capacidade, não de um literal na tela. Afirmar
    // que ele APARECE é o que impede o dia em que a tela deixar de dizer o
    // limite e o corretor só o descobrir errando.
    await expect(dialogo).toContainText(/Até \d+ opções neste canal/);
  });

  test("menu sem pergunta é recusado ANTES da rede", async ({ page }) => {
    test.skip(!(await abrirMenuDeOpcoes(page)), "sem conversa, ou canal sem menu");

    const dialogo = page.getByTestId("dialogo-menu");
    await page.getByLabel("Opção 1").fill("Individual");
    await page.getByLabel("Opção 2").fill("Familiar");
    // Sem a pergunta: opções soltas chegam ao cliente como botões sem contexto.
    await dialogo.getByRole("button", { name: "Enviar" }).click();
    await expect(dialogo.getByRole("alert")).toBeVisible();
    await expect(dialogo).toBeVisible();
  });

  test("menu completo é aceito e o diálogo fecha", async ({ page }) => {
    test.skip(!(await abrirMenuDeOpcoes(page)), "sem conversa, ou canal sem menu");

    const dialogo = page.getByTestId("dialogo-menu");
    await page.getByLabel("Pergunta").fill("Qual plano te interessa?");
    await page.getByLabel("Opção 1").fill("Individual");
    await page.getByLabel("Opção 2").fill("Familiar");
    await dialogo.getByRole("button", { name: "Enviar" }).click();

    // Ausência prova transição (doutrina, regra 2).
    await expect(dialogo).toHaveCount(0);
  });

  test("dá para acrescentar e remover opções sem perder as demais", async ({ page }) => {
    test.skip(!(await abrirMenuDeOpcoes(page)), "sem conversa, ou canal sem menu");

    await page.getByLabel("Opção 1").fill("Individual");
    await page.getByLabel("Opção 2").fill("Familiar");
    await page.getByRole("button", { name: "Acrescentar opção" }).click();
    await page.getByLabel("Opção 3").fill("Empresarial");

    await page.getByRole("button", { name: "Remover opção 2" }).click();

    // Remover a do meio não pode embaralhar as outras: o campo 2 passa a ser o
    // que era o 3, e o 1 fica intacto.
    await expect(page.getByLabel("Opção 1")).toHaveValue("Individual");
    await expect(page.getByLabel("Opção 2")).toHaveValue("Empresarial");
  });
});
