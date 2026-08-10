/**
 * Enviar localização, cartão de contato e figurinha — pela tela (spec 006, US3).
 *
 * ## O defeito que esta spec fecha
 *
 * `location` e `contact` estavam no enum de tipos da API e eram **impossíveis de
 * enviar**: o corpo não tinha onde carregar coordenada nem cartão, então o pedido
 * saía incompleto e o canal recusava com "campos obrigatórios ausentes". Um erro
 * do provedor, depois da rede, na cara do corretor. Anunciar e não entregar é
 * pior que não ter.
 *
 * ## O que se mede aqui, e o que NÃO se mede
 *
 * Mede-se que a ação **existe na tela**, que o formulário **recusa carga inválida
 * antes da rede** e que o envio **é aceito**. Não se mede que o mapa abre no lugar
 * certo no aparelho do cliente, nem que o contato salva na agenda, nem que a
 * figurinha chega sem moldura — isso é formato de terceiro, e formato de terceiro
 * só se sabe medindo o terceiro (doutrina de medição, regra 5). Essa prova está
 * declarada como pendência de ambiente em `docs/testing/user-journey-map.md`.
 *
 * ## Por que os casos podem PULAR
 *
 * As três ações são oferecidas por CAPACIDADE do canal (FR-018). Num canal que
 * não as declara, elas corretamente não aparecem — e o teste pula dizendo isso,
 * em vez de falhar acusando o código. Pular em silêncio é que seria erro.
 */
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

test.describe.configure({ mode: "serial" });

/** Abre a primeira conversa do inbox e devolve `false` se não houver nenhuma. */
async function abrirPrimeiraConversa(page: import("@playwright/test").Page): Promise<boolean> {
  await page.goto("/app/inbox");
  await expect(page).toHaveURL(/\/app\/inbox/);
  const conversa = page.getByTestId("item-conversa").first();
  if (!(await conversa.isVisible().catch(() => false))) return false;
  await conversa.click();
  await expect(page.getByRole("button", { name: "Anexar" })).toBeVisible();
  return true;
}

test.describe("enviar o que o canal já sabe entregar", () => {
  test.beforeEach(async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
  });

  test("localização: o formulário recusa coordenada inválida ANTES da rede", async ({ page }) => {
    test.skip(!(await abrirPrimeiraConversa(page)), "sem conversa no inbox");

    await page.getByRole("button", { name: "Anexar" }).click();
    const item = page.getByRole("button", { name: "Localização" });
    test.skip(
      !(await item.isVisible().catch(() => false)),
      "o canal desta conversa não declara localização — a ação corretamente não aparece",
    );
    await item.click();

    const dialogo = page.getByTestId("dialogo-localizacao");
    await expect(dialogo).toBeVisible();

    // Latitude fora do intervalo. O motivo tem de nomear o CAMPO — "dados
    // inválidos" mandaria o corretor adivinhar qual dos quatro está errado.
    await page.getByLabel("Latitude").fill("999");
    await page.getByLabel("Longitude").fill("-46.6565");
    await dialogo.getByRole("button", { name: "Enviar" }).click();

    await expect(dialogo.getByRole("alert")).toBeVisible();
    // E o diálogo NÃO fecha: fechar sem enviar faria o corretor achar que mandou.
    await expect(dialogo).toBeVisible();
  });

  test("localização válida é aceita e o diálogo fecha", async ({ page }) => {
    test.skip(!(await abrirPrimeiraConversa(page)), "sem conversa no inbox");

    await page.getByRole("button", { name: "Anexar" }).click();
    const item = page.getByRole("button", { name: "Localização" });
    test.skip(!(await item.isVisible().catch(() => false)), "canal sem localização");
    await item.click();

    const dialogo = page.getByTestId("dialogo-localizacao");
    await page.getByLabel("Latitude").fill("-23.5613");
    await page.getByLabel("Longitude").fill("-46.6565");
    await page.getByLabel("Nome do lugar").fill("Clínica São Lucas");
    await dialogo.getByRole("button", { name: "Enviar" }).click();

    // Ausência prova transição. Esperar o diálogo APARECER provaria só que ele
    // apareceu — o que já era verdade antes do clique (doutrina, regra 2).
    await expect(dialogo).toHaveCount(0);
  });

  test("contato: cartão sem telefone é recusado com motivo", async ({ page }) => {
    test.skip(!(await abrirPrimeiraConversa(page)), "sem conversa no inbox");

    await page.getByRole("button", { name: "Anexar" }).click();
    const item = page.getByRole("button", { name: "Contato" });
    test.skip(!(await item.isVisible().catch(() => false)), "canal sem cartão de contato");
    await item.click();

    const dialogo = page.getByTestId("dialogo-contato");
    await expect(dialogo).toBeVisible();
    await page.getByLabel("Nome").fill("Dra. Ana Ribeiro");
    // Telefone vazio de propósito: cartão sem número chega ao cliente e não serve
    // para nada.
    await dialogo.getByRole("button", { name: "Enviar" }).click();
    await expect(dialogo.getByRole("alert")).toBeVisible();
  });

  test("figurinha aparece como escolha própria, separada de fotos", async ({ page }) => {
    test.skip(!(await abrirPrimeiraConversa(page)), "sem conversa no inbox");

    await page.getByRole("button", { name: "Anexar" }).click();
    const figurinha = page.getByRole("button", { name: "Figurinha" });
    test.skip(!(await figurinha.isVisible().catch(() => false)), "canal sem figurinha");

    // A diferença entre figurinha e foto é de INTENÇÃO, não de arquivo: o mesmo
    // `.webp` é foto num item e figurinha no outro. Enquanto o tipo era inferido
    // do MIME, figurinha simplesmente não existia no produto — todo webp virava
    // imagem.
    await expect(figurinha).toBeVisible();
    await expect(page.getByRole("button", { name: "Fotos e vídeos" })).toBeVisible();
  });
});
