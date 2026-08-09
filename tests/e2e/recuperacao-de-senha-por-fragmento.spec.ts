import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { loadEnvLocal, uniqueEmail } from "./helpers/auth";

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
 * Em CI as duas variáveis vêm do ambiente do job (o workflow publica o
 * `.env.e2e` no `$GITHUB_ENV`); numa máquina de desenvolvimento vêm do
 * `.env.local`. É o mesmo idioma das outras specs de auth.
 */
const envLocal = loadEnvLocal();
const URL_SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL ?? envLocal.NEXT_PUBLIC_SUPABASE_URL ?? "";
const CHAVE_SERVICO =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? envLocal.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * A conta é SEMEADA por esta spec, e não herdada.
 *
 * Medido no CI em 2026-08-09: presumir uma conta existente deu
 * `404 user_not_found` — o banco da suíte é fresco e não conhece ninguém. Toda
 * spec de auth deste repo semeia a própria conta pelo mesmo motivo; herdar
 * transforma o caso num teste do estado do banco, não do produto.
 */
const EMAIL = uniqueEmail("fragmento");
const SENHA = "SenhaDoFragmento!123";
let idDoUsuario: string | null = null;

function admin() {
  return createClient(URL_SUPABASE, CHAVE_SERVICO, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

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

  test.beforeAll(async () => {
    const { data, error } = await admin().auth.admin.createUser({
      email: EMAIL,
      password: SENHA,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`seed createUser: ${error?.message}`);
    idDoUsuario = data.user.id;
  });

  // Conta de teste que sobrevive à execução vira lixo que a próxima sessão
  // encontra e não sabe de quem é.
  test.afterAll(async () => {
    if (idDoUsuario) await admin().auth.admin.deleteUser(idDoUsuario);
  });

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
