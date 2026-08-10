/**
 * Remover uma operadora criada por engano — spec 002, T099, jornada J10.
 *
 * ═══ O QUE ESTE SPEC PROVA, E O QUE ELE NÃO PROVA ═══
 *
 * **Prova**: o que o corretor vê e faz. Que o botão só existe onde a rota aceita, que o
 * primeiro clique PERGUNTA (e a pergunta diz o que para, o que fica e o que continua
 * explicável), que a linha some da lista depois do 200, e que o aviso fala em material
 * **arquivado** — porque é o que acontece, e "apagado" seria mentira.
 *
 * **NÃO prova**: a inércia na busca. "O material para de ancorar" é uma afirmação sobre a
 * `fn_buscar_lastro`, e para exercitá-la seria preciso um turno com modelo — a suíte E2E
 * roda sem chave de IA, de propósito, porque é o estado de um primeiro deploy. Essa metade
 * está em `tests/invariants/escopo-removido-fica-inerte.test.ts`, contra Postgres real, com
 * o caso que prova que o material removido NÃO é promovido ao balde "vale para todos".
 *
 * Dizer isso em voz alta é o ponto: um spec que insinuasse provar as duas metades daria
 * impressão de cobertura onde há uma delas.
 *
 * ═══ POR QUE O PRÉ-REQUISITO É SEMEADO, E NÃO CRIADO PELA TELA ═══
 *
 * A tela do tenant não cria escopo próprio — a criação é da rota (`POST
 * /api/v1/knowledge-scopes`) e do catálogo, do lado da plataforma. Semear pelo banco aqui
 * não enfraquece o teste: o objeto sob prova é a REMOÇÃO, e semear o estado inicial pela
 * porta mais curta é o que mantém o spec medindo uma coisa só.
 *
 * Pré-requisitos (stack local do baseline, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/escopo-remocao.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t099-remocao");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;
let pool: pg.Pool;
/** O escopo PRÓPRIO, o único removível. */
let escopoProprio = "";
/** O espelho do catálogo — existe para provar que ele NÃO ganha botão. */
let escopoEspelho = "";

const NOME_PROPRIO = "Cooperativa do Vale (engano)";
const NOME_ESPELHO = "Operadora Curada E2E";

/**
 * A limpeza tem ORDEM obrigatória, e ela é a mesma regra que a feature ensina: apagar o
 * escopo com material dentro é recusado pelo banco
 * (`ai_knowledge_sources_scope_xor_all`, porque a FK é `on delete set null`). A primeira
 * versão desta função tentava o contrário e derrubou a bateria inteira — o teste tropeçou
 * exatamente na constraint que ele existe para documentar.
 */
async function limpar(): Promise<void> {
  await pool.query(
    `delete from ai_knowledge_sources
      where scope_id in (select id from knowledge_scopes where display_name = any($1))`,
    [[NOME_PROPRIO, NOME_ESPELHO]],
  );
  await pool.query("delete from knowledge_scopes where display_name = any($1)", [
    [NOME_PROPRIO, NOME_ESPELHO],
  ]);
  await pool.query("delete from catalog_scopes where slug = 'e2e-t099'");
}

test.beforeAll(async () => {
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 2 });

  // Estado que sobrevive entre execuções é a causa favorita do "piorou sem eu mexer"
  // (CLAUDE.md, regra 6). Zeramos o que esta spec cria, sempre.
  await limpar();

  escopoProprio = (
    await pool.query<{ id: string }>(
      `insert into knowledge_scopes (organization_id, display_name, is_active)
       values ($1, $2, true) returning id`,
      [creds.org_id, NOME_PROPRIO],
    )
  ).rows[0]!.id;

  // Um material dentro do balde: é o que faz `materials_archived` ser 1 e não 0 — e é
  // exatamente o caso em que o `delete` físico seria recusado pelo banco.
  const agente = (
    await pool.query<{ id: string }>(
      "select id from ai_agents where organization_id = $1 order by created_at limit 1",
      [creds.org_id],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, scope_id, applies_to_all)
     values ($1, $2, 'policy', 'Manual da Cooperativa (engano)', $3, false)`,
    [creds.org_id, agente, escopoProprio],
  );

  // O espelho do catálogo, criado pelo caminho REAL (a função de sincronização), para o
  // caso do 403 não medir uma linha montada à mão que só se parece com um espelho.
  const catalogo = (
    await pool.query<{ id: string }>(
      `insert into catalog_scopes (slug, display_name) values ('e2e-t099', $1) returning id`,
      [NOME_ESPELHO],
    )
  ).rows[0]!.id;
  await pool.query("select fn_sincronizar_escopos_do_catalogo($1)", [creds.org_id]);
  escopoEspelho = (
    await pool.query<{ id: string }>(
      "select id from knowledge_scopes where organization_id = $1 and catalog_scope_id = $2",
      [creds.org_id, catalogo],
    )
  ).rows[0]!.id;
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

test.describe("a operadora criada por engano sai da lista (T099 · FR-008)", () => {
  test("só a operadora PRÓPRIA ganha botão de remover", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/scopes");

    // Âncora de LUGAR antes de qualquer asserção negativa (CLAUDE.md, regra 3): sem isto,
    // "não existe botão de remover" passaria em qualquer página do produto.
    await expect(page).toHaveURL(/\/app\/ai\/knowledge\/scopes/);
    // `.first()` porque o nome aparece três vezes na linha (título, frase de estado e o
    // link para o material) — `getByText` em strict mode recusa a ambiguidade, e ela é da
    // tela, não do teste.
    await expect(page.getByText(NOME_PROPRIO).first()).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("button", { name: `Remover ${NOME_PROPRIO}` })).toBeVisible();
    // O espelho está NA MESMA TELA e não tem o botão — a recusa é dita pela ausência, e
    // não por um 403 depois do gesto.
    await expect(page.getByText(NOME_ESPELHO).first()).toBeVisible();
    await expect(page.getByRole("button", { name: `Remover ${NOME_ESPELHO}` })).toHaveCount(0);

    await captura(page, "lista-com-remover-so-no-proprio");
  });

  test("o primeiro clique pergunta, e a pergunta diz o que acontece", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/scopes");
    await page.getByRole("button", { name: `Remover ${NOME_PROPRIO}` }).click();

    const pergunta = page.getByText(new RegExp(`Remover ${NOME_PROPRIO.replace(/[()]/g, "\\$&")}\\?`));
    await expect(pergunta).toBeVisible();
    const texto = await pergunta.innerText();
    expect(texto).toContain("para de responder");
    expect(texto).toContain("arquivado");
    expect(texto).toContain("de onde vieram");

    // A operadora ainda está lá: perguntar não é remover.
    await expect(page.getByText(NOME_PROPRIO).first()).toBeVisible();
    await captura(page, "pergunta-antes-de-remover");
  });

  test("confirmado, a linha SOME e o aviso fala em material arquivado", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/scopes");
    await page.getByRole("button", { name: `Remover ${NOME_PROPRIO}` }).click();
    await page.getByRole("button", { name: "Sim, remover" }).click();

    // AUSÊNCIA prova a transição (CLAUDE.md, regra 2): esperar o botão APARECER passaria
    // na hora, porque ele já estava visível antes do clique.
    await expect(page.getByRole("button", { name: `Remover ${NOME_PROPRIO}` })).toHaveCount(0, {
      timeout: 30_000,
    });

    const corpo = (await page.locator("body").innerText()).toLowerCase();
    expect(corpo).toContain("arquivado");
    // "apagado" seria mentira, e é a palavra que o corretor teme.
    expect(corpo).not.toMatch(/apagad[oa]|exclu[íi]d[oa]/);

    await captura(page, "depois-de-remover");

    // Recarregar é o que separa "sumiu da tela" de "sumiu do sistema".
    await page.reload();
    await expect(page).toHaveURL(/\/app\/ai\/knowledge\/scopes/);
    await expect(page.getByText(NOME_PROPRIO)).toHaveCount(0);
    // E o vizinho continua lá — remover uma não esvazia a lista.
    await expect(page.getByText(NOME_ESPELHO).first()).toBeVisible();
  });

  test("o banco confirma o que a tela disse: arquivado, não apagado", async () => {
    // A tela pode mentir por otimismo; o banco não. Esta é a ponte entre o que o corretor
    // leu ("arquivado") e o que de fato aconteceu com o acervo dele.
    const escopo = await pool.query<{ deleted_at: string | null; is_active: boolean }>(
      "select deleted_at, is_active from knowledge_scopes where id = $1",
      [escopoProprio],
    );
    expect(escopo.rows).toHaveLength(1);
    expect(escopo.rows[0]!.deleted_at).not.toBeNull();
    expect(escopo.rows[0]!.is_active).toBe(false);

    const fontes = await pool.query<{ status: string; is_active: boolean }>(
      "select status, is_active from ai_knowledge_sources where scope_id = $1",
      [escopoProprio],
    );
    expect(fontes.rows).toHaveLength(1);
    expect(fontes.rows[0]).toEqual({ status: "archived", is_active: false });

    // A trilha existe, e com a contagem — é por ela que se investiga "sumiu a operadora".
    const trilha = await pool.query<{ metadata: Record<string, unknown> }>(
      `select metadata from api_audit_log
        where action = 'knowledge_scope.deleted' and resource_id = $1
        order by created_at desc limit 1`,
      [escopoProprio],
    );
    expect(trilha.rows).toHaveLength(1);
    expect(trilha.rows[0]!.metadata.materials_archived).toBe(1);
  });

  test("removida, ela não volta pela porta do vínculo de contato", async ({ page }) => {
    // A rota de contatos aceita `knowledge_scope_id`. Sem o filtro de `deleted_at`, um id
    // de escopo removido continuaria vinculável — e o cliente cairia em "vale para todos"
    // sem nada na tela dizer por quê.
    void page;
    const contato = (
      await pool.query<{ id: string }>(
        `insert into contacts (organization_id, name, phone_number)
         values ($1, 'Cliente T099', '+5585999990099') returning id`,
        [creds.org_id],
      )
    ).rows[0]!.id;
    try {
      const alcancavel = await pool.query(
        "select 1 from knowledge_scopes where id = $1 and organization_id = $2 and deleted_at is null",
        [escopoProprio, creds.org_id],
      );
      expect(alcancavel.rowCount).toBe(0);
    } finally {
      await pool.query("delete from contacts where id = $1", [contato]);
    }
  });
});
