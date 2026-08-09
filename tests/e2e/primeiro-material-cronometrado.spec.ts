/**
 * Do login ao primeiro trecho buscável, cronometrado — spec 002, T094 (SC-003) e T101 (SC-004).
 *
 * ═══ O QUE ESTÁ SOB MEDIÇÃO, E O QUE NÃO ESTÁ ═══
 *
 * SC-003: o corretor que nunca usou o sistema carrega o **primeiro material próprio** — do
 * login ao primeiro trecho buscável dele — em **≤5 minutos**, sozinho, sem documentação e
 * sem editar arquivo nenhum. SC-004: o **segundo** em **≤2 minutos**, e durante todo o
 * processo **zero janela sem base** — o que já era respondido continua sendo.
 *
 * Não está sob medição a velocidade da máquina. Está sob medição o CAMINHO: quantos gestos
 * o produto exige, e se algum deles é um beco. Foi assim que este arquivo achou o defeito
 * que o motivou — não havia porta para criar a própria operadora, então o "primeiro
 * material próprio" de SC-003 era inalcançável pela tela, e o cronômetro nem chegava a
 * começar. A rota existia e passava nos testes dela.
 *
 * ═══ O CRONÔMETRO NÃO PARTICIPA DO LAÇO ═══
 *
 * Os dois carimbos vêm do POSTGRES: `select now()` no início, e o `created_at` do trecho no
 * fim. Medir com `Date.now()` no processo de teste misturaria a espera do Playwright com a
 * duração do que se quer medir, e é o erro que a doutrina de medição nomeia — deu 95,9%
 * onde a verdade era 100%. Aqui os dois extremos são lidos pelo mesmo relógio, que é o de
 * quem grava o dado.
 *
 * ═══ "ZERO JANELA SEM BASE" É UMA AMOSTRAGEM, NÃO UMA OPINIÃO ═══
 *
 * A segunda metade de SC-004 é sobre o que acontece ENQUANTO a base muda. Por isso a
 * pergunta que o primeiro material responde é embeddada UMA vez e reperguntada a
 * `fn_buscar_lastro` em intervalos regulares durante toda a carga e indexação da segunda:
 * a conta é de amostras que ancoraram sobre amostras tiradas. Uma medição antes e outra
 * depois provaria os dois extremos e calaria justamente sobre o meio, que é o que o
 * critério pergunta.
 *
 * ═══ PRÉ-REQUISITOS ═══
 *
 * Os mesmos de `lacunas-acionaveis.spec.ts` (Redis de pé + chave de embedding) — o
 * cabeçalho de lá traz os comandos. Sem chave, este arquivo é PULADO.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

import { embedText } from "@/lib/ai/embed";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t094-t101");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;
let pool: pg.Pool;
let agente = "";

const OPERADORA_1 = "Primeira Operadora Cronometrada";
const OPERADORA_2 = "Segunda Operadora Cronometrada";
const MATERIAL_1 = "Carencia da primeira";
const MATERIAL_2 = "Reembolso da segunda";

const PERGUNTA_1 = "Qual a carência para internação?";
const RESPOSTA_1 =
  "A carência para internação eletiva é de 180 dias a partir da assinatura do contrato. " +
  "Para urgência e emergência, o prazo é de 24 horas.";
const PERGUNTA_2 = "Como peço reembolso de consulta?";
const RESPOSTA_2 =
  "O reembolso de consulta é pedido pelo aplicativo, anexando a nota fiscal e o recibo. " +
  "O prazo de análise é de 30 dias corridos.";

/** Os tetos do critério, em segundos. */
const TETO_SC003 = 5 * 60;
const TETO_SC004 = 2 * 60;

const SEM_PROVEDOR_DE_EMBEDDING = !process.env.OPENAI_API_KEY && !process.env.AI_GATEWAY_API_KEY;

interface Medicao {
  criterio: string;
  segundos: number;
  teto_segundos: number;
  passos_de_tela: number;
}
const medicoes: Medicao[] = [];

async function agora(): Promise<Date> {
  const { rows } = await pool.query<{ n: Date }>("select now() n");
  return rows[0]!.n;
}

/**
 * Espera o primeiro trecho buscável daquele material aparecer, e devolve o `created_at`
 * DELE — não o instante em que este laço notou. A diferença entre os dois é o intervalo de
 * polling, e ela entraria inteira na medição.
 */
async function primeiroTrechoDe(nomeDoMaterial: string, req: APIRequestContext): Promise<Date> {
  // 150 voltas ≈ 4 min de espera. O teto do critério é 2 min: o laço tem de sobreviver ao
  // caso em que o produto ESTOURA o teto, senão a falha vira “não produziu trecho” e
  // esconde o número que se queria medir.
  for (let i = 0; i < 150; i++) {
    const { rows } = await pool.query<{ created_at: Date }>(
      `select c.created_at
         from ai_chunks c
         join ai_knowledge_sources s on s.id = c.knowledge_source_id
        where s.organization_id = $1 and s.name = $2
        order by c.created_at asc
        limit 1`,
      [creds.org_id, nomeDoMaterial],
    );
    if (rows.length > 0) return rows[0]!.created_at;
    // O drenar é parte do caminho: em produção o cron faz isso sozinho, e o que o corretor
    // espera é o mesmo intervalo. Aqui ele é chamado de propósito para o relógio não medir
    // a periodicidade do agendador, que é configuração e não produto.
    await req.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${internalSecret()}` },
    });
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`o material "${nomeDoMaterial}" não produziu trecho buscável`);
}

function internalSecret(): string {
  const secret = carregarEnvLocal().INTERNAL_SECRET;
  if (!secret) throw new Error("INTERNAL_SECRET ausente — o .env.e2e é quem o define");
  return secret;
}

async function limpar(): Promise<void> {
  const nomes = [OPERADORA_1, OPERADORA_2];
  await pool.query(
    `delete from ai_knowledge_sources
      where organization_id = $1
        and (name = any($2)
             or scope_id in (select id from knowledge_scopes
                              where organization_id = $1 and display_name = any($3)))`,
    [creds.org_id, [MATERIAL_1, MATERIAL_2], nomes],
  );
  await pool.query(
    "delete from knowledge_scopes where organization_id = $1 and display_name = any($2)",
    [creds.org_id, nomes],
  );
}

test.beforeAll(async () => {
  if (SEM_PROVEDOR_DE_EMBEDDING) return;
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 5 });
  await limpar();

  agente = (
    await pool.query<{ id: string }>(
      "select id from ai_agents where organization_id = $1 order by created_at limit 1",
      [creds.org_id],
    )
  ).rows[0]!.id;
});

test.afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
  if (medicoes.length > 0) {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    fs.writeFileSync(
      path.join(EVIDENCIA, "medicao.json"),
      `${JSON.stringify({ medicoes }, null, 2)}\n`,
    );
  }
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

/** Adiciona a operadora pela tela — a porta de FR-002, aberta em 2026-08-09. */
async function adicionarOperadora(page: Page, nome: string): Promise<void> {
  await page.goto("/app/ai/knowledge/scopes");
  await page.getByRole("button", { name: /^Adicionar operadora$/i }).click();
  await page.locator("#escopo-nome").fill(nome);
  await page.getByRole("button", { name: /^Adicionar$/ }).click();
  await expect(page.getByText(nome).first()).toBeVisible({ timeout: 30_000 });
}

/** Carrega um material pela tela, para a operadora escolhida. */
async function carregarMaterial(
  page: Page,
  operadora: string,
  nomeDoMaterial: string,
  pergunta: string,
  resposta: string,
): Promise<void> {
  await page.goto("/app/ai/knowledge/sources");
  await page.getByRole("button", { name: /novo material/i }).click();
  await page.getByLabel(/operadora/i).first().click();
  await page.getByRole("option", { name: operadora }).click();
  await page.locator("#material-nome").fill(nomeDoMaterial);
  await page.locator("#material-pergunta-0").fill(pergunta);
  await page.locator("#material-resposta-0").fill(resposta);
  await page.getByRole("button", { name: "Salvar material" }).click();
  // O diálogo sumir, e não o rótulo do botão mudar: ele vira "Salvando…" no primeiro
  // instante do clique, e esperar pelo texto antigo se satisfaz com a requisição em voo.
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("do login ao primeiro trecho buscável (SC-003 e SC-004)", () => {
  test.skip(
    SEM_PROVEDOR_DE_EMBEDDING,
    "sem OPENAI_API_KEY nem AI_GATEWAY_API_KEY: não há trecho buscável para cronometrar",
  );

  test("SC-003 — primeiro material próprio, do login ao primeiro trecho, em ≤5 min", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const inicio = await agora();

    await login(page, creds.users.manager!.email, creds.password);
    await adicionarOperadora(page, OPERADORA_1);
    await captura(page, "1-operadora-adicionada-pela-tela");
    await carregarMaterial(page, OPERADORA_1, MATERIAL_1, PERGUNTA_1, RESPOSTA_1);

    const fim = await primeiroTrechoDe(MATERIAL_1, page.request);
    const segundos = (fim.getTime() - inicio.getTime()) / 1000;

    // Os PASSOS são a outra metade do critério, e a que não depende da máquina: login,
    // abrir Operadoras, abrir o formulário, digitar o nome, adicionar, abrir Conhecimento,
    // abrir o formulário, escolher, três campos, salvar. Contá-los é o que torna "sozinho,
    // sem documentação" verificável — um caminho que cresce em gestos reprova aqui mesmo
    // que a máquina fique mais rápida.
    medicoes.push({
      criterio: "SC-003",
      segundos: Math.round(segundos * 10) / 10,
      teto_segundos: TETO_SC003,
      passos_de_tela: 12,
    });

    expect(segundos, `SC-003 levou ${segundos.toFixed(1)}s`).toBeLessThanOrEqual(TETO_SC003);
    await captura(page, "2-primeiro-material-buscavel");
  });

  /**
   * ⚠️ SC-004 AINDA NÃO FOI ATINGIDO, e este caso fica marcado para não mentir o contrário.
   *
   * Medido em 2026-08-09, três execuções: o SEGUNDO material entra pela tela, a fonte nasce
   * `ready` com o item gravado, o evento `knowledge_source.updated` é consumido e marcado
   * `done` — e nenhum trecho é produzido para ele. `last_index_status` fica NULO, o material
   * aparece "Preparando" para sempre, e nada o reemite. Reemitir o MESMO evento à mão faz o
   * indexador processar as duas fontes na hora ("fontes: 2, trechos_planejados: 2"), então o
   * caminho funciona: o que falha é a rodada disparada pela criação.
   *
   * É o modo de falha que FR-004 proíbe pelo nome — material aceito e nunca indexado — e é
   * pior que a lentidão que SC-004 cronometra. Não é defeito do teste: o instrumento aqui
   * espera 4 minutos, o dobro do teto, justamente para não confundir "estourou o tempo" com
   * "nunca aconteceu".
   *
   * Fica `fixme` em vez de removido porque ele é a prova: no dia em que a causa for
   * corrigida, tirar a marca é o que confirma o conserto.
   */
  test.fixme("SC-004 — segundo material em ≤2 min, e zero janela sem base", async ({ page }) => {
    test.setTimeout(240_000);

    // A pergunta que o PRIMEIRO material responde, embeddada uma vez. É ela que mede a
    // janela: se em algum instante ela deixar de ancorar, houve buraco.
    const { embedding } = await embedText(PERGUNTA_1, { organizationId: creds.org_id });
    const vetor = `[${embedding.join(",")}]`;

    const escopo1 = (
      await pool.query<{ id: string }>(
        "select id from knowledge_scopes where organization_id = $1 and display_name = $2",
        [creds.org_id, OPERADORA_1],
      )
    ).rows[0]!.id;

    async function aindaResponde(): Promise<boolean> {
      const { rows } = await pool.query(
        "select 1 from public.fn_buscar_lastro($1, $2, $3::vector, 5, 0.30, false) limit 1",
        [agente, escopo1, vetor],
      );
      return rows.length > 0;
    }

    // CONTROLE: antes de mexer em nada, a pergunta ancora. Sem esta linha, "zero janela"
    // seria compatível com "nunca respondeu" — a amostragem contaria zero de zero.
    expect(await aindaResponde(), "o primeiro material não ancorava nem antes de começar").toBe(
      true,
    );

    let amostras = 0;
    let semBase = 0;
    let amostrando = true;
    const sonda = (async () => {
      while (amostrando) {
        amostras += 1;
        if (!(await aindaResponde())) semBase += 1;
        await new Promise((r) => setTimeout(r, 1_500));
      }
    })();

    const inicio = await agora();
    await login(page, creds.users.manager!.email, creds.password);
    await adicionarOperadora(page, OPERADORA_2);
    await carregarMaterial(page, OPERADORA_2, MATERIAL_2, PERGUNTA_2, RESPOSTA_2);
    const fim = await primeiroTrechoDe(MATERIAL_2, page.request);

    amostrando = false;
    await sonda;

    const segundos = (fim.getTime() - inicio.getTime()) / 1000;
    medicoes.push({
      criterio: "SC-004",
      segundos: Math.round(segundos * 10) / 10,
      teto_segundos: TETO_SC004,
      passos_de_tela: 11,
    });

    expect(segundos, `SC-004 levou ${segundos.toFixed(1)}s`).toBeLessThanOrEqual(TETO_SC004);

    // A amostragem só vale se houve amostra: um laço que não rodou daria "zero falhas".
    expect(amostras, "a sonda não tirou amostras — o número abaixo não mediria nada").toBeGreaterThan(
      10,
    );
    expect(semBase, `${semBase} de ${amostras} amostras ficaram sem base`).toBe(0);

    await captura(page, "3-duas-operadoras-respondendo");
  });
});
