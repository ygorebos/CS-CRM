/**
 * A instalação nasce sabendo, e ligar o que ela trouxe não pede deploy — T041 e T139 (SC-010).
 *
 * ═══ AS DUAS AFIRMAÇÕES, E POR QUE ELAS ANDAM JUNTAS ═══
 *
 * FR-030 diz que uma instalação nova **nasce** com o catálogo curado semeado e indexado, com
 * os escopos dele **inativos para o tenant** (A-20). SC-010 diz que criar escopo e material
 * passa a ancorar resposta **sem** reinício, build, migration manual ou intervenção.
 *
 * Uma sem a outra não vale: catálogo que vem pronto mas exige deploy para valer é o mesmo
 * que não vir; e "sem deploy" provado sobre material que o próprio teste semeou no banco não
 * diz nada sobre o que o corretor recebe ao se cadastrar.
 *
 * ═══ POR QUE INATIVO, E POR QUE ISSO É O TESTE MAIS IMPORTANTE DAQUI ═══
 *
 * Espelho do catálogo nasce DESLIGADO de propósito (A-20): o corretor vende algumas
 * operadoras, não todas as que existem. Se nascesse ligado, o agente afirmaria coisas sobre
 * operadoras que ele não vende — com âncora, com citação, parecendo certo. É o modo de falha
 * mais caro desta spec, porque ele não parece defeito na tela: parece o produto funcionando.
 *
 * Por isso o caso do interruptor vem com o PAR: antes de ligar, a busca não ancora nada
 * daquele nome; depois de ligar, ancora. Só a segunda metade provaria que ligar funciona e
 * calaria sobre o estado inicial, que é o que A-20 protege.
 *
 * ═══ O QUE "SEM DEPLOY" SIGNIFICA AQUI, MEDIDO ═══
 *
 * O processo do app não é reiniciado entre o clique e a busca. Não há build, não há
 * migration, não há cron a esperar: o interruptor é um `PATCH`, e a próxima pergunta já vê
 * a diferença. É isso que a busca logo depois do clique prova — e é o que separa "a
 * configuração foi salva" de "a configuração passou a valer".
 *
 * Pré-requisitos: os de `lacunas-acionaveis.spec.ts` (Redis + chave de embedding).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

import { embedText } from "@/lib/ai/embed";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t041-t139");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;
let pool: pg.Pool;
let agente = "";
/** O espelho que o teste liga — escolhido pelo trecho curado que ele carrega. */
let espelho = { id: "", nome: "", trecho: "", chunkId: "" };

const SEM_PROVEDOR_DE_EMBEDDING = !process.env.OPENAI_API_KEY && !process.env.AI_GATEWAY_API_KEY;

/**
 * O que a busca ancora naquele balde.
 *
 * ⚠️ Devolve `chunk_id`, e não só a contagem. A primeira versão contava linhas e reprovava
 * o par negativo: o catálogo semeado tem material **"vale para todos"**, que responde
 * mesmo com a operadora desligada — e responde CERTO, porque não é sobre aquela operadora.
 * Contar linha misturava "o balde abriu" com "existe material geral", que são coisas
 * diferentes. A asserção é sobre O TRECHO daquela operadora, pelo id.
 */
async function ancoras(scopeId: string, vetor: string): Promise<{ layer: string; chunk_id: string }[]> {
  const { rows } = await pool.query<{ layer: string; chunk_id: string }>(
    "select layer, chunk_id from public.fn_buscar_lastro($1, $2, $3::vector, 5, 0.40, false)",
    [agente, scopeId, vetor],
  );
  return rows;
}

test.beforeAll(async () => {
  if (SEM_PROVEDOR_DE_EMBEDDING) return;
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 3 });

  agente = (
    await pool.query<{ id: string }>(
      "select id from ai_agents where organization_id = $1 order by created_at limit 1",
      [creds.org_id],
    )
  ).rows[0]!.id;

  // O espelho e o trecho curado que ele carrega. Vem do BANCO e não de uma constante no
  // teste: o conteúdo do catálogo é curadoria, muda sem avisar o teste, e um literal aqui
  // viraria vermelho a cada edição do catálogo — reprovando o produto por causa do teste.
  // `cc.applies_to_all = false`: o trecho tem de ser DAQUELA operadora. Um trecho "vale
  // para todos" responderia com o interruptor desligado — corretamente —, e o par negativo
  // do próximo caso perderia o sentido.
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    content: string;
    chunk_id: string;
  }>(
    `select ks.id, ks.display_name, cc.content, cc.id as chunk_id
       from knowledge_scopes ks
       join catalog_scopes cs on cs.id = ks.catalog_scope_id
       join catalog_chunks cc on cc.catalog_scope_id = cs.id
      where ks.organization_id = $1 and ks.deleted_at is null and cc.applies_to_all = false
      order by ks.display_name
      limit 1`,
    [creds.org_id],
  );
  if (rows.length === 0) {
    throw new Error(
      "a organização não tem espelho do catálogo com trecho — a instalação NÃO nasceu sabendo, e é isto que T041 mede",
    );
  }
  espelho = {
    id: rows[0]!.id,
    nome: rows[0]!.display_name,
    trecho: rows[0]!.content,
    chunkId: rows[0]!.chunk_id,
  };

  // Estado inicial garantido: desligado. Uma execução anterior pode ter deixado ligado, e
  // aí o par "antes/depois" mediria dois 'depois'.
  await pool.query("update knowledge_scopes set is_active = false where id = $1", [espelho.id]);
});

test.afterAll(async () => {
  if (!pool) return;
  // Devolve o tenant ao estado em que a instalação o entrega. Ligado, ele mudaria o
  // resultado de qualquer spec que rode depois — e o vermelho apareceria longe daqui.
  await pool.query("update knowledge_scopes set is_active = false where id = $1", [espelho.id]);
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

test.describe.configure({ mode: "serial" });

test.describe("a instalação nasce sabendo, e ligar não pede deploy (T041, SC-010)", () => {
  test.skip(
    SEM_PROVEDOR_DE_EMBEDDING,
    "sem chave de embedding: a busca não tem como responder, e é ela que prova o 'sem deploy'",
  );

  test("a conta nova já lista o que veio no sistema — e TUDO desligado (A-20)", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/scopes");
    await expect(page.getByText(espelho.nome).first()).toBeVisible({ timeout: 30_000 });

    const corpo = await page.locator("body").innerText();
    // O badge de origem (FR-039): o corretor tem de saber de quem é a responsabilidade
    // por aquele conteúdo antes de ligá-lo.
    expect(corpo).toContain("Já vem no sistema");

    // Nenhum ligado. É A-20 dita em número, e é a metade que um teste de "a lista aparece"
    // não cobriria.
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text n from knowledge_scopes
        where organization_id = $1 and catalog_scope_id is not null and is_active = true`,
      [creds.org_id],
    );
    expect(rows[0]!.n, "espelho do catálogo nasceu LIGADO — o agente falaria de operadora que o corretor não vende").toBe("0");

    await captura(page, "1-catalogo-veio-e-esta-desligado");
  });

  test("desligado, o material curado NÃO ancora — o par que dá sentido ao próximo caso", async () => {
    const { embedding } = await embedText(espelho.trecho, { organizationId: creds.org_id });
    const antes = await ancoras(espelho.id, `[${embedding.join(",")}]`);
    // A pergunta é o próprio texto curado: se NEM ele ancora, é porque o balde está
    // fechado — e não porque a pergunta não casou.
    expect(
      antes.map((l) => l.chunk_id),
      "o trecho da operadora DESLIGADA ancorou",
    ).not.toContain(espelho.chunkId);
  });

  test("UM clique liga, e a próxima pergunta já responde — sem reinício, build ou migration", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/scopes");

    const linha = page.locator("li").filter({ hasText: espelho.nome }).first();
    await expect(linha).toBeVisible({ timeout: 30_000 });
    // A RESPOSTA do PATCH, capturada. O interruptor é otimista: texto e contador viram no
    // clique, antes da rede — e a cópia da linha já diz "o agente responde sobre …". Medir
    // qualquer coisa da tela aqui mede o otimismo, não a chegada. Medido em 2026-08-10:
    // duas asserções de tela passaram sobre um clique que NÃO tinha persistido.
    const [resposta] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/knowledge-scopes/") && r.request().method() === "PATCH",
        { timeout: 30_000 },
      ),
      linha.getByRole("switch").click(),
    ]);
    const corpoDaResposta = await resposta.text();
    expect(
      resposta.status(),
      `PATCH devolveu ${resposta.status()}: ${corpoDaResposta.slice(0, 200)}`,
    ).toBe(200);

    // ⚠️ O sinal de chegada é o AVISO, não o contador. O interruptor é otimista: o estado
    // local vira no clique, antes da resposta, e o contador "1 de N" aparece na hora mesmo
    // que o PATCH falhe e a linha volte atrás. Medido em 2026-08-10 — a primeira versão
    // esperava o contador, passava, e a busca depois não achava nada: a falha aparecia
    // duas asserções à frente, longe da causa.
    await captura(page, "2a-depois-do-clique");

    // O que o clique FEZ no banco, antes de perguntar à busca. Sem esta leitura, um clique
    // que não persiste vira "a busca não ancorou" — e a caçada começa no lugar errado.
    const estado = await pool.query<{ is_active: boolean }>(
      "select is_active from knowledge_scopes where id = $1",
      [espelho.id],
    );
    expect(estado.rows[0]!.is_active, "o clique não ligou a operadora no banco").toBe(true);

    // E agora a mesma pergunta do caso anterior, no MESMO processo do app — nada foi
    // reiniciado, nada foi construído, nenhuma migration rodou entre um caso e outro.
    const { embedding } = await embedText(espelho.trecho, { organizationId: creds.org_id });
    const depois = await ancoras(espelho.id, `[${embedding.join(",")}]`);
    expect(
      depois.map((l) => l.chunk_id),
      "ligar pela tela não fez o material daquela operadora passar a responder",
    ).toContain(espelho.chunkId);
    // E ancorou na camada CURADA, não em material do tenant — que nem existe aqui.
    expect(depois.every((l) => l.layer === "catalog")).toBe(true);

    await captura(page, "2-ligado-e-respondendo-sem-deploy");
  });

  test("e o acervo próprio continua vazio — a tela diz o que fazer, sem mandar para o beco", async ({
    page,
  }) => {
    // O estado inicial de 100% dos usuários. Testar só com base povoada esconde exatamente
    // esta tela, que é a que decide se o corretor volta.
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/sources");
    await expect(page).toHaveURL(/\/app\/ai\/knowledge\/sources/);

    const corpo = await page.locator("body").innerText();
    // Jargão nosso na tela do corretor é defeito de produto, e o estado vazio é onde ele
    // mais escapa — é texto escrito uma vez e raramente relido.
    expect(corpo).not.toMatch(/\bchunks?\b|\bembeddings?\b|\blastro\b|\bRAG\b/i);

    await captura(page, "3-acervo-proprio-vazio");
  });
});
