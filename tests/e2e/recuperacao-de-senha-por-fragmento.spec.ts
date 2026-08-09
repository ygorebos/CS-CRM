import { readFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

/**
 * O link de redefinição no formato que o servidor NÃO enxerga.
 *
 * ## O defeito, medido em 2026-08-09
 *
 * O GoTrue entrega link de e-mail de duas formas, e elas chegam em lugares
 * diferentes da URL. Com o template padrão (`{{ .ConfirmationURL }}`) o clique
 * passa por `…/auth/v1/verify`, que **consome o token** e devolve `303` para
 * `…/auth/confirm#access_token=…&type=recovery`. Fragmento não sobe na
 * requisição HTTP — de dentro do route handler os parâmetros parecem ausentes,
 * e a pessoa caía em "Link inválido ou expirado" com o token já gasto. Pedir
 * outro repetia o mesmo desfecho, para sempre.
 *
 * ## Por que este teste dirige o browser, e não faz `fetch`
 *
 * Porque o comportamento sob teste **é do browser**: só ele carrega o fragmento
 * através do redirect e só ele o lê. Um `fetch` seguindo redirects mediria o
 * contrário do que interessa e passaria sem provar nada.
 *
 * ## O que faz o caso ficar vermelho
 *
 * A âncora é o destino (`/login/reset`), e não a ausência do texto de erro:
 * asserção negativa sem âncora de lugar passa em qualquer página que não
 * contenha o termo (doutrina de medição, regra 3).
 */

/**
 * O `.env.e2e` é injetado no `webServer`, NÃO no processo que roda os testes —
 * então `process.env` chega vazio aqui. Sem esta leitura o `test.skip` abaixo
 * dispara sempre, e a suíte fica verde sem ter medido nada: é o falso verde que
 * a doutrina de medição nomeia, com o agravante de parecer cobertura.
 */
function doEnvDoE2E(chave: string): string {
  if (process.env[chave]) return process.env[chave] as string;
  try {
    for (const linha of readFileSync(".env.e2e", "utf8").split("\n")) {
      const limpa = linha.trim();
      if (!limpa || limpa.startsWith("#")) continue;
      const i = limpa.indexOf("=");
      if (i > 0 && limpa.slice(0, i) === chave) return limpa.slice(i + 1);
    }
  } catch {
    /* sem .env.e2e: o skip abaixo cuida, e diz o motivo */
  }
  return "";
}

const URL_SUPABASE = doEnvDoE2E("NEXT_PUBLIC_SUPABASE_URL");
const CHAVE_SERVICO = doEnvDoE2E("SUPABASE_SERVICE_ROLE_KEY");
const EMAIL = process.env.E2E_OWNER_EMAIL ?? "cotadorsimplificado@gmail.com";

/**
 * Pede ao GoTrue o mesmo link que ele poria no e-mail. Não envia e-mail.
 *
 * `app` vem do `baseURL` do runner, e não de uma constante: no CI a porta é
 * outra (3001), e um endereço fixo mandaria o `redirect_to` para um app que não
 * existe — o caso reprovaria por motivo errado.
 */
async function gerarLinkDeRecuperacao(APP: string): Promise<string> {
  const resposta = await fetch(`${URL_SUPABASE}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      apikey: CHAVE_SERVICO,
      Authorization: `Bearer ${CHAVE_SERVICO}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "recovery",
      email: EMAIL,
      redirect_to: `${APP}/auth/confirm`,
    }),
  });
  if (!resposta.ok) {
    throw new Error(`generate_link falhou: ${resposta.status} ${await resposta.text()}`);
  }
  const corpo = (await resposta.json()) as { action_link?: string };
  if (!corpo.action_link) throw new Error("generate_link não devolveu action_link");
  return corpo.action_link;
}

test.describe("recuperação de senha pelo link de fragmento", () => {
  test.skip(
    !URL_SUPABASE || !CHAVE_SERVICO,
    "exige NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY",
  );

  test("o link padrão do GoTrue chega em /login/reset, não no erro", async ({ page, baseURL }) => {
    test.setTimeout(60_000);

    const link = await gerarLinkDeRecuperacao(baseURL!);
    // Confere a premissa ANTES de medir o desfecho: se o formato do link mudar,
    // este caso tem que dizer isso em vez de passar medindo outro caminho.
    expect(link).toContain("/auth/v1/verify");

    await page.goto(link);

    // O sinal de sucesso é o DESTINO. A tela intermediária de /auth/sessao pode
    // nem ser vista — esperar que ela apareça mediria a velocidade da máquina.
    await expect(page).toHaveURL(/\/login\/reset/, { timeout: 30_000 });

    // Só agora, com o lugar ancorado, a asserção negativa significa algo.
    await expect(page.getByText(/Link inválido ou expirado/i)).toHaveCount(0);

    // E a tela tem que servir para o que a pessoa veio fazer.
    await expect(page.getByLabel(/nova senha/i).first()).toBeVisible();
  });

  /**
   * O fragmento que o dono colou em 2026-08-09, letra por letra. O GoTrue
   * recusou o token e mandou o motivo no fragmento — que se perdia junto com
   * ele. A tela então dizia "peça um novo" para quem já tinha pedido, e pedir de
   * novo invalida o anterior: quem clicasse no e-mail antigo ficava em laço.
   */
  test("link recusado pelo GoTrue diz POR QUE, e não manda pedir outro à toa", async ({ page }) => {
    await page.goto(
      `/auth/confirm#error=access_denied&error_code=otp_expired` +
        `&error_description=Email+link+is+invalid+or+has+expired&sb=`,
    );

    await expect(page).toHaveURL(/\/login\?error=link_expirado/, { timeout: 20_000 });
    await expect(page.getByText(/já foi usado ou passou da validade/i)).toBeVisible();
    // A genérica não pode aparecer junto: duas mensagens sobre a mesma coisa,
    // uma delas errada, é pior que uma só.
    await expect(page.getByText(/Link inválido ou expirado/i)).toHaveCount(0);
  });

  test("sem fragmento nenhum, /auth/sessao devolve ao erro honesto", async ({ page }) => {
    await page.goto("/auth/sessao");
    await expect(page).toHaveURL(/\/login\?error=link_invalido/, { timeout: 15_000 });
    await expect(page.getByText(/Link inválido ou expirado/i)).toBeVisible();
  });
});
