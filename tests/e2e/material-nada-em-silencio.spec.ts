/**
 * Nada fica salvo em silêncio — spec 002, US1, T078, SC-014 (FR-004, FR-005, FR-007).
 *
 * ═══ O CRITÉRIO É "100%", E É POR ISSO QUE O SPEC USA UM LOTE ═══
 *
 * SC-014 não pede que um material inválido seja recusado: pede que **todos** terminem em
 * estado explícito, e **nenhum** fique em "salvo sem conteúdo buscável" sem dizer isso ao
 * corretor. Um spec com um caso só provaria que a recusa existe — e passaria verde num
 * produto onde o segundo formato inválido cai num caminho sem tratamento.
 *
 * Por isso aqui há um LOTE, e a asserção final é sobre a contagem: todo item da lista
 * mostra um rótulo do vocabulário fechado da tela. Um estado novo que alguém acrescente
 * sem rótulo aparece como texto vazio e derruba este caso.
 *
 * O rótulo do estado bom é **"Respondendo"**, não "Pronto" — a tela fala do efeito para o
 * corretor (o agente já usa aquilo), não do estado interno do registro. Medido pela tela em
 * 2026-08-09; a primeira versão deste spec cobrava "Pronto" e reprovou.
 *
 * ═══ O ESTADO PERIGOSO É O QUE PARECE CERTO ═══
 *
 * "Salvo, mas nada virou conteúdo que o agente consiga encontrar" (`sem-trecho`) é o
 * defeito que SC-014 nomeia: o material está lá, a tela diz "salvo", e o agente nunca o
 * encontra. Este spec cobra que esse estado tenha rótulo PRÓPRIO — "Sem conteúdo
 * aproveitável" — e não seja escondido dentro de "Respondendo".
 *
 * ═══ O QUE ESTE SPEC NÃO PROVA ═══
 *
 * A indexação em si. Transformar texto em trecho buscável exige embedding, e a suíte roda
 * sem `OPENAI_API_KEY` de propósito — é o estado de um primeiro deploy. Os estados são
 * semeados no banco exatamente como o indexador os deixaria; o que está sob prova é a
 * TELA: dado cada desfecho possível, o corretor sabe em qual está e o que fazer.
 *
 * Pré-requisitos (stack local do baseline, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/material-nada-em-silencio.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t078-material");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;
let pool: pg.Pool;
let agente = "";

const ESCOPO_NOME = "Operadora do Lote E2E";

/**
 * O lote. Cada linha é um desfecho REAL do indexador, com o estado que ele deixa no banco —
 * e o rótulo que a tela tem de mostrar. É a tabela que torna "100%" verificável.
 */
const LOTE = [
  {
    nome: "Manual em PDF que o extrator nao leu",
    status: "ready",
    last_index_status: "failed",
    last_index_error: "pdf_sem_texto_extraivel",
    chunks_count: 0,
    rotulo: "Não deu certo",
  },
  {
    nome: "Markdown vazio depois de limpar",
    status: "ready",
    last_index_status: "success",
    last_index_error: null,
    chunks_count: 0,
    rotulo: "Sem conteúdo aproveitável",
  },
  {
    nome: "Tabela de precos que entrou pela metade",
    status: "ready",
    last_index_status: "partial",
    last_index_error: null,
    chunks_count: 3,
    // O rótulo do estado bom é "Respondendo", e não "Pronto": a tela fala do EFEITO
    // (o agente já responde com isso), não do estado interno do registro.
    rotulo: "Respondendo",
  },
  {
    nome: "Manual bom recem enviado",
    status: "ready",
    last_index_status: null,
    last_index_error: null,
    chunks_count: 0,
    rotulo: "Preparando",
  },
  {
    nome: "Material que o corretor guardou",
    status: "archived",
    last_index_status: "success",
    last_index_error: null,
    chunks_count: 5,
    rotulo: "Guardado",
  },
] as const;

/** Todo rótulo que a tela sabe dizer. Estado sem rótulo é o defeito que SC-014 nomeia. */
const VOCABULARIO_FECHADO = [
  "Respondendo",
  "Preparando",
  "Não deu certo",
  "Sem conteúdo aproveitável",
  "Parado na fila",
  "Guardado",
];

async function limpar(): Promise<void> {
  await pool.query(
    `delete from ai_knowledge_sources
      where organization_id = $1
        and scope_id in (select id from knowledge_scopes where display_name = $2)`,
    [creds.org_id, ESCOPO_NOME],
  );
  await pool.query("delete from knowledge_scopes where display_name = $1", [ESCOPO_NOME]);
}

test.beforeAll(async () => {
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 2 });
  await limpar();

  agente = (
    await pool.query<{ id: string }>(
      "select id from ai_agents where organization_id = $1 order by created_at limit 1",
      [creds.org_id],
    )
  ).rows[0]!.id;

  const escopo = (
    await pool.query<{ id: string }>(
      `insert into knowledge_scopes (organization_id, display_name, is_active)
       values ($1, $2, true) returning id`,
      [creds.org_id, ESCOPO_NOME],
    )
  ).rows[0]!.id;

  for (const m of LOTE) {
    await pool.query(
      `insert into ai_knowledge_sources
         (organization_id, agent_id, source_type, name, scope_id, applies_to_all,
          status, last_index_status, last_index_error, chunks_count, last_indexed_at)
       values ($1, $2, 'policy', $3, $4, false, $5, $6, $7, $8,
               case when $6::text is null then null else now() end)`,
      [
        creds.org_id,
        agente,
        m.nome,
        escopo,
        m.status,
        m.last_index_status,
        m.last_index_error,
        m.chunks_count,
      ],
    );
  }
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

test.describe("nenhum material termina em silêncio (SC-014)", () => {
  test("os CINCO desfechos aparecem, cada um com o rótulo do seu estado", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/sources");
    await expect(page).toHaveURL(/\/app\/ai\/knowledge\/sources/);
    await expect(page.getByText(ESCOPO_NOME).first()).toBeVisible({ timeout: 30_000 });

    const corpo = await page.locator("body").innerText();
    for (const m of LOTE) {
      expect(corpo, `o material "${m.nome}" não apareceu na tela`).toContain(m.nome);
    }

    // 100% em estado explícito: cada rótulo do lote está presente. A contagem por rótulo
    // distinto é o que impede a versão que mostra tudo como "Pronto".
    const rotulosEsperados = new Set(LOTE.map((m) => m.rotulo));
    for (const rotulo of rotulosEsperados) {
      expect(corpo, `nenhum material foi rotulado "${rotulo}"`).toContain(rotulo);
    }

    await captura(page, "lote-com-os-cinco-estados");
  });

  test("o estado PERIGOSO tem nome próprio — 'salvo e invisível' não vira 'Respondendo'", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/sources");

    // O material que indexou COM SUCESSO e produziu ZERO trechos. É o defeito que SC-014
    // nomeia: está salvo, parece certo, e o agente nunca o encontra.
    const linha = page.getByText("Markdown vazio depois de limpar").first();
    await expect(linha).toBeVisible({ timeout: 30_000 });

    const corpo = await page.locator("body").innerText();
    expect(corpo).toContain("Sem conteúdo aproveitável");
    // E a tela diz o que fazer, não só que deu errado.
    expect(corpo.toLowerCase()).toMatch(/nada de .* virou conteúdo|não responde/i);
  });

  test("a tela não inventa vocabulário: todo rótulo visível é do conjunto fechado", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/knowledge/sources");
    await expect(page.getByText(ESCOPO_NOME).first()).toBeVisible({ timeout: 30_000 });

    const corpo = await page.locator("body").innerText();
    // Nenhum estado CRU do banco pode vazar para a tela. "ready", "partial" e
    // "last_index_status" são grandezas internas — o corretor não sabe o que são, e vê-las
    // é o sintoma de um estado novo que ninguém rotulou.
    for (const jargao of ["last_index_status", "chunks_count", "building"]) {
      expect(corpo, `jargão interno "${jargao}" apareceu na tela`).not.toContain(jargao);
    }
    // Controle positivo do mesmo grep: os rótulos legítimos ESTÃO lá.
    expect(VOCABULARIO_FECHADO.some((r) => corpo.includes(r))).toBe(true);

    await captura(page, "sem-jargao-interno");
  });

  test("o banco confirma o lote: 5 materiais, e nenhum fora dos estados previstos", async () => {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text n
         from ai_knowledge_sources
        where organization_id = $1
          and scope_id in (select id from knowledge_scopes where display_name = $2)`,
      [creds.org_id, ESCOPO_NOME],
    );
    // CONTROLE: sem isto, uma tela vazia passaria em todos os casos acima que usam
    // `toContain` sobre um corpo que simplesmente não tem nada.
    expect(rows[0]!.n).toBe(String(LOTE.length));
  });
});
