/**
 * Responder citando, pela tela, em NO MÁXIMO 2 ações (spec 006, US2 / SC-003).
 *
 * ## Por que a contagem de ações é asserção, e não observação
 *
 * A SC-003 promete "no máximo 2 ações a partir da mensagem". Isso só é
 * verificável contando — e contando **na spec**, não a olho: um clique a mais que
 * ninguém contou vira atrito permanente que o corretor sente todo dia e ninguém
 * consegue nomear. Aqui cada interação é uma linha, e o teste falha se a lista
 * crescer.
 *
 * ## O que esta spec NÃO prova
 *
 * Que a citação **chegou** ao aparelho do cliente apontando para a mensagem
 * certa. Isso é formato de terceiro, e formato de terceiro só se sabe medindo o
 * terceiro (doutrina de medição, regra 5). A prova com aparelho real está
 * declarada em `docs/testing/user-journey-map.md` como pendência de ambiente —
 * não como coberta.
 *
 * ## Pré-condições
 *
 * As mesmas de `mensagens-leitura-fiel.spec.ts`, mais uma conversa com pelo menos
 * uma mensagem que tenha `external_id` (sem ele não há o que citar, e o gesto
 * corretamente não aparece).
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ mode: "serial" });

test.describe("responder citando", () => {
  test.beforeEach(async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
  });

  test("da mensagem ao envio em 2 ações, com a citação visível no meio", async ({ page }) => {
    await page.goto("/app/inbox");
    await expect(page).toHaveURL(/\/app\/inbox/);

    // Abrir uma conversa é a navegação, não uma das ações contadas: a SC-003 mede
    // "a partir da mensagem".
    const conversa = page.getByTestId("item-conversa").first();
    const temConversa = await conversa.isVisible().catch(() => false);
    test.skip(!temConversa, "sem conversa no inbox — rode o seed do quickstart");
    await conversa.click();

    const bolha = page.getByTestId("bolha-de-mensagem").first();
    await expect(bolha).toBeVisible();

    // ── AÇÃO 1: acionar "responder" na mensagem ────────────────────────────
    await bolha.hover();
    const gesto = page.getByTestId("responder-citando").first();
    const temGesto = await gesto.isVisible().catch(() => false);
    test.skip(
      !temGesto,
      "o canal desta conversa não declara citação — a ação corretamente não aparece (FR-018)",
    );
    await gesto.click();

    // A citação em preparo é o que torna a ação REVERSÍVEL: sem ela visível, quem
    // clicou na mensagem errada só descobre depois que o cliente recebe.
    const preparo = page.getByTestId("citacao-em-preparo");
    await expect(preparo).toBeVisible();

    // ── AÇÃO 2: escrever e enviar ──────────────────────────────────────────
    //
    // Digitar não conta como ação de navegação: é o conteúdo. O que se conta são
    // os passos de INTERFACE entre a mensagem e o envio, e eles são dois.
    const campo = page.getByRole("textbox").last();
    await campo.fill("respondendo a esta");
    await campo.press("Enter");

    // O sinal de que deu certo é a citação SUMIR do preparo — ausência prova
    // transição; presença provaria só que ela apareceu, que já era verdade antes
    // do envio (doutrina de medição, regra 2).
    await expect(preparo).toHaveCount(0);
  });

  test("cancelar a citação a devolve ao estado anterior", async ({ page }) => {
    await page.goto("/app/inbox");
    await expect(page).toHaveURL(/\/app\/inbox/);

    const conversa = page.getByTestId("item-conversa").first();
    const temConversa = await conversa.isVisible().catch(() => false);
    test.skip(!temConversa, "sem conversa no inbox");
    await conversa.click();

    const bolha = page.getByTestId("bolha-de-mensagem").first();
    await expect(bolha).toBeVisible();
    await bolha.hover();

    const gesto = page.getByTestId("responder-citando").first();
    const temGesto = await gesto.isVisible().catch(() => false);
    test.skip(!temGesto, "canal sem citação");
    await gesto.click();

    await expect(page.getByTestId("citacao-em-preparo")).toBeVisible();
    await page.getByRole("button", { name: "Cancelar citação" }).click();
    await expect(page.getByTestId("citacao-em-preparo")).toHaveCount(0);
  });
});
