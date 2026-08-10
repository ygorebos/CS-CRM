/**
 * A lacuna vira tarefa, e a tarefa some quando é feita — spec 002, US5, T110, SC-013.
 *
 * ═══ O QUE SC-013 COBRA, INTEIRO ═══
 *
 * "após 10 recusas por falta de lastro, o corretor identifica **na tela**, sem ajuda, ao
 * menos um assunto concreto que precisa carregar, e a lacuna **desaparece da lista** depois
 * que ele carrega o material correspondente."
 *
 * São DUAS afirmações, e a segunda é a que ninguém prova por engano. Provar só a primeira
 * (a lacuna aparece) passa verde num produto onde a lista nunca esvazia — e uma lista de
 * tarefas que não esvazia é a forma mais comum de um mecanismo anti-morte morrer: o
 * corretor escreve o material, volta, vê a mesma linha pedindo o mesmo trabalho, e para de
 * ler a tela.
 *
 * ═══ POR QUE ESTE SPEC INDEXA DE VERDADE ═══
 *
 * O fechamento acontece no `rag-indexer`, ao terminar uma fonte com trechos > 0 — e
 * "trechos > 0" só existe depois de embeddar. Semear o estado final no banco provaria que a
 * tela sabe esconder aviso resolvido, que não é o que SC-013 mede. Por isso aqui o material
 * entra pelo FORMULÁRIO, o `event-log-drain` roda o indexador de verdade, e o embedding é o
 * do provedor configurado. É a diferença entre "a query foi montada" e "carregar material
 * fecha a lacuna".
 *
 * ═══ OS PARES NEGATIVOS SÃO METADE DO SPEC ═══
 *
 * Um `update` sem o filtro de escopo fecharia TODAS as lacunas ao primeiro material — e
 * passaria neste spec se ele só olhasse a operadora do material. Por isso o cenário tem
 * três lacunas e o material cobre UMA:
 *
 *   - a da operadora que recebeu material  → tem de sumir
 *   - a da operadora que não recebeu nada  → tem de continuar
 *   - a SEM operadora identificada         → tem de continuar, e é a mais importante das
 *     três: é a pergunta que o sistema não soube nem classificar, e fechá-la por
 *     proximidade esconderia exatamente o caso que mais precisa de gente olhando.
 *
 * ═══ PRÉ-REQUISITOS (dois deles não são óbvios) ═══
 *
 *   # 1. REDIS DE PÉ. Sem ele o indexador morre com um `fetch failed` genérico, e o spec
 *   #    reprova três asserções depois, em "os avisos não fecharam" — apontando para o
 *   #    lugar errado do produto. Medido em 2026-08-09: foi a causa de quatro execuções
 *   #    vermelhas seguidas que pareciam defeito do fechamento.
 *   docker run -d --name e2e-redis redis:7-alpine
 *   docker run -d --name e2e-srh --link e2e-redis:redis -p 3998:80 \
 *     -e SRH_MODE=env -e SRH_TOKEN="$UPSTASH_REDIS_REST_TOKEN" \
 *     -e SRH_CONNECTION_STRING="redis://redis:6379" hiett/serverless-redis-http:latest
 *
 *   # 2. CHAVE DE EMBEDDING no `.env.e2e` (sem ela o arquivo inteiro é PULADO — ver abaixo).
 *
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/lacunas-acionaveis.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-t110-lacunas");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

let creds: Creds;
let pool: pg.Pool;

const ESCOPO_COBERTO = "Operadora Que Recebe Material E2E";
const ESCOPO_INTOCADO = "Operadora Que Fica Sem Material E2E";
const TELEFONE = "+5585999997110";

/**
 * As perguntas de exemplo. Escolhidas para cair em categorias DIFERENTES do léxico
 * (`prazos` e `rede`): com o mesmo assunto nas duas operadoras, um agrupamento que ignorasse
 * o nome do escopo somaria as duas num balde só e o par negativo perderia o sentido.
 */
const PERGUNTA_COBERTA = "qual e a carencia para internacao nesse plano?";
const PERGUNTA_INTOCADA = "quais hospitais estao na rede credenciada em fortaleza?";
const PERGUNTA_SEM_OPERADORA = "quanto tempo demora pra liberar o reembolso do exame?";

/** O corpo do aviso no formato EXATO que `escalar-sem-lastro` grava e o agregador lê. */
function corpoDoAviso(pergunta: string, operadora: string | null): string {
  return [
    `O cliente perguntou: "${pergunta}"`,
    `Operadora: ${operadora ?? "não identificada"}`,
    "O agente não tinha material para responder e devolveu a conversa para a fila.",
  ].join("\n");
}

async function limpar(): Promise<void> {
  const nomes = [ESCOPO_COBERTO, ESCOPO_INTOCADO];
  await pool.query(
    `delete from agent_inbox_items
      where organization_id = $1 and kind = 'assistance_without_grounding'`,
    [creds.org_id],
  );
  await pool.query(
    `delete from ai_knowledge_sources
      where organization_id = $1
        and scope_id in (select id from knowledge_scopes where organization_id = $1 and display_name = any($2))`,
    [creds.org_id, nomes],
  );
  await pool.query(
    "delete from knowledge_scopes where organization_id = $1 and display_name = any($2)",
    [creds.org_id, nomes],
  );
  await pool.query("delete from contacts where organization_id = $1 and phone_number = $2", [
    creds.org_id,
    TELEFONE,
  ]);
}

async function criarEscopo(nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into knowledge_scopes (organization_id, display_name, is_active)
     values ($1, $2, true) returning id`,
    [creds.org_id, nome],
  );
  return rows[0]!.id;
}

async function semearRecusas(
  contato: string,
  quantas: number,
  pergunta: string,
  operadora: string | null,
  scopeId: string | null,
): Promise<void> {
  for (let i = 0; i < quantas; i++) {
    await pool.query(
      `insert into agent_inbox_items
         (organization_id, kind, severity, title, body, ref_kind, ref_id, knowledge_scope_id, status)
       values ($1, 'assistance_without_grounding', 'warn',
               'Pergunta sem material para responder — o cliente está esperando',
               $2, 'contact', $3, $4, 'open')`,
      [creds.org_id, corpoDoAviso(pergunta, operadora), contato, scopeId],
    );
  }
}

/** Quantos avisos daquela operadora continuam ABERTOS — a medida de fato, fora da tela. */
async function abertosDe(scopeId: string | null): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text n from agent_inbox_items
      where organization_id = $1
        and kind = 'assistance_without_grounding'
        and status = 'open'
        and ${scopeId === null ? "knowledge_scope_id is null" : "knowledge_scope_id = $2"}`,
    scopeId === null ? [creds.org_id] : [creds.org_id, scopeId],
  );
  return Number(rows[0]!.n);
}

/**
 * Pelo `carregarEnvLocal()`, nunca lendo o arquivo de ambiente direto do disco: naquele
 * caminho o ambiente injetado no `webServer` é ignorado e a prova passa a falar com o
 * arquivo do checkout — que aponta para PRODUÇÃO. É o defeito que
 * `tests/unit/seed-nao-le-env-local-do-disco.test.ts` vigia, e ele reprova este arquivo se
 * a leitura crua voltar.
 */
function internalSecret(): string {
  const secret = carregarEnvLocal().INTERNAL_SECRET;
  if (!secret) throw new Error("INTERNAL_SECRET ausente — o .env.e2e é quem o define");
  return secret;
}

/**
 * Roda o indexador de verdade. Três passadas com folga: o material nasce `building`, o
 * evento de indexação é consumido em lote, e embeddar N pares leva chamadas de rede.
 *
 * ⚠️ Pelo `request` da página, e NÃO por um `fetch` para uma porta escrita à mão. O
 * servidor sob teste é o que o `webServer` do `playwright.config.ts` sobe (porta 3001 por
 * padrão, `E2E_PORT` quando há duas frentes na mesma máquina); um endereço fixo no spec
 * drena OUTRO processo — que pode ser um build anterior, com outro ambiente. Medido em
 * 2026-08-09: o drain caía num servidor manual sem a mudança sob teste, e a falha aparecia
 * três asserções depois, como "os avisos não fecharam".
 */
async function drenar(req: APIRequestContext): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const res = await req.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${internalSecret()}` },
    });
    if (!res.ok()) {
      throw new Error(`drain → HTTP ${res.status()}: ${(await res.text()).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

let escopoCoberto = "";
let escopoIntocado = "";

test.beforeAll(async () => {
  if (!fs.existsSync(CREDS_PATH)) throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

  const conn = process.env.SUPABASE_DB_URL;
  if (!conn) throw new Error("SUPABASE_DB_URL ausente — o .env.e2e é quem a define");
  pool = new pg.Pool({ connectionString: conn, max: 2 });

  // Estado que sobrevive entre execuções é a causa favorita do "piorou sem eu mexer":
  // aviso resolvido na rodada anterior faria a contagem inicial nascer errada.
  await limpar();

  const contato = (
    await pool.query<{ id: string }>(
      `insert into contacts (organization_id, name, phone_number)
       values ($1, 'Cliente da lacuna', $2) returning id`,
      [creds.org_id, TELEFONE],
    )
  ).rows[0]!.id;

  escopoCoberto = await criarEscopo(ESCOPO_COBERTO);
  escopoIntocado = await criarEscopo(ESCOPO_INTOCADO);

  // Dez, como SC-013 enuncia — e mais que as outras duas, para esta lacuna nascer no topo
  // da lista (a ordenação é por contagem).
  await semearRecusas(contato, 10, PERGUNTA_COBERTA, ESCOPO_COBERTO, escopoCoberto);
  await semearRecusas(contato, 4, PERGUNTA_INTOCADA, ESCOPO_INTOCADO, escopoIntocado);
  await semearRecusas(contato, 3, PERGUNTA_SEM_OPERADORA, null, null);
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

/** O texto da tela de Evolução, já com a lista de lacunas carregada. */
async function textoDaEvolucao(page: Page): Promise<string> {
  await page.goto("/app/ai/evolution");
  await expect(page).toHaveURL(/\/app\/ai\/evolution/);
  // Âncora de LUGAR antes de qualquer asserção negativa: `not.toContain` passa em qualquer
  // página que não tenha o termo, inclusive numa que o teste nunca quis abrir.
  await expect(page.getByText(/não tinha material/i).first()).toBeVisible({ timeout: 60_000 });
  return page.locator("body").innerText();
}

// Uma sessão só para toda a jornada: os casos são etapas do MESMO fluxo (a lacuna aparece,
// o material entra, a lacuna some) e rodá-los fora de ordem mediria outro produto.
test.describe.configure({ mode: "serial" });

/**
 * Sem provedor de embedding não há indexação, e sem indexação não há o que medir aqui — o
 * caso central deste arquivo é "material buscável fecha a lacuna". Pular é a resposta
 * honesta; a alternativa (dublar o embedding) mediria o dublê, e é o defeito que a doutrina
 * de medição nomeia. O CI ainda não tem chave nem Redis: lá este arquivo aparece como
 * PULADO, com esta frase — visível no relatório, não um verde que não mediu nada.
 */
const SEM_PROVEDOR_DE_EMBEDDING = !process.env.OPENAI_API_KEY && !process.env.AI_GATEWAY_API_KEY;

test.describe("a lacuna vira tarefa, e some quando o material chega (SC-013)", () => {
  test.skip(
    SEM_PROVEDOR_DE_EMBEDDING,
    "sem OPENAI_API_KEY nem AI_GATEWAY_API_KEY: o material nunca vira trecho buscável, e é o trecho que fecha a lacuna",
  );

  test("o corretor identifica o assunto concreto, com a pergunta real e o que fazer", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email, creds.password);
    const corpo = await textoDaEvolucao(page);

    // 1) OPERADORA + ASSUNTO + CONTAGEM na MESMA frase. Afirmá-los separados passaria com
    //    os três presentes em linhas diferentes — que é o retrato de uma tela que somou
    //    baldes. O assunto é o rótulo do corretor ("cobertura"), não a categoria interna;
    //    qual categoria o léxico atribui a cada pergunta é medição, não escolha do teste.
    expect(corpo).toContain(
      `Clientes da ${ESCOPO_COBERTO} perguntaram sobre cobertura em 10 conversas`,
    );
    // 2) A PERGUNTA REAL, como o cliente escreveu. É o que faz o material se escrever
    //    sozinho; sem ela o corretor lê uma categoria e ainda tem que adivinhar.
    expect(corpo).toContain(PERGUNTA_COBERTA);
    // 3) O QUE FAZER, como botão e não como conselho.
    await expect(page.getByRole("link", { name: "Escrever esse material" }).first()).toBeVisible();

    // As outras duas lacunas também estão na tela — é o retrato ANTES, e é o que dá sentido
    // ao par negativo do caso seguinte.
    expect(corpo).toContain(ESCOPO_INTOCADO);
    expect(corpo).toContain("Nessas conversas o agente não identificou a operadora");

    await captura(page, "1-tres-lacunas-antes-do-material");
  });

  test("CONTROLE: as três lacunas estão abertas no banco antes do material", async () => {
    expect(await abertosDe(escopoCoberto)).toBe(10);
    expect(await abertosDe(escopoIntocado)).toBe(4);
    expect(await abertosDe(null)).toBe(3);
  });

  test("carregar o material pela tela faz a lacuna daquela operadora sumir da lista", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await login(page, creds.users.manager!.email, creds.password);

    // O caminho do corretor: o botão da lacuna leva à tela de materiais.
    await page.goto("/app/ai/evolution");
    await page
      .getByRole("link", { name: "Escrever esse material" })
      .first()
      .click();
    await expect(page).toHaveURL(/\/app\/ai\/knowledge\/sources/, { timeout: 30_000 });

    await page.getByRole("button", { name: /novo material/i }).click();
    await page.getByLabel(/operadora/i).first().click();
    await page.getByRole("option", { name: ESCOPO_COBERTO }).click();
    await page.locator("#material-nome").fill("Carencia de internacao");
    await page.locator("#material-pergunta-0").fill("Qual a carência para internação?");
    await page
      .locator("#material-resposta-0")
      .fill(
        "A carência para internação eletiva é de 180 dias a partir da assinatura do contrato. " +
          "Para urgência e emergência, o prazo é de 24 horas.",
      );
    await page.getByRole("button", { name: "Salvar material" }).click();
    // ⚠️ O SINAL É O DIÁLOGO SUMIR, e não o rótulo "Salvar material" desaparecer. O botão
    // troca para "Salvando…" no primeiro instante do clique: uma espera pelo texto antigo
    // se satisfaz com a requisição ainda em voo, e o teste segue para o drain antes de a
    // fonte existir. Medido em 2026-08-09 — a captura da falha mostrava o diálogo aberto
    // com "Salvando…" e o caso reprovando por "os avisos não fecharam", que apontava para
    // o lugar errado do produto.
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 60_000 });
    // E a prova de chegada, positiva: o material está na lista da operadora certa.
    await expect(page.getByText("Carencia de internacao").first()).toBeVisible({
      timeout: 30_000,
    });

    await captura(page, "2-material-salvo");

    // O indexador de verdade — é ele que fecha a lacuna, e só depois de produzir trecho.
    await drenar(page.request);

    // A medida de fato, antes da tela: o material fechou os DEZ avisos daquela operadora…
    expect(await abertosDe(escopoCoberto), "os avisos da operadora coberta não fecharam").toBe(0);
    // …e NÃO tocou nos outros dois grupos. É o par que impede o `update` sem filtro.
    expect(await abertosDe(escopoIntocado), "fechou a lacuna da operadora ERRADA").toBe(4);
    expect(await abertosDe(null), "fechou a lacuna SEM operadora identificada").toBe(3);

    // Agora a tela. A ausência é o sinal — presença provaria só que a página carregou.
    const depois = await textoDaEvolucao(page);
    expect(depois, "a lacuna coberta continuou na lista").not.toContain(PERGUNTA_COBERTA);
    expect(depois).not.toContain(ESCOPO_COBERTO);
    // E as outras duas continuam pedindo trabalho que de fato falta fazer.
    expect(depois).toContain(ESCOPO_INTOCADO);
    expect(depois).toContain(PERGUNTA_INTOCADA);
    expect(depois).toContain(PERGUNTA_SEM_OPERADORA);

    await captura(page, "3-lacuna-coberta-sumiu-as-outras-ficaram");
  });

  test("a Central concorda: saiu dos abertos e continua achável em Resolvidos", async ({
    page,
  }) => {
    // Fechar não é apagar. O aviso resolvido é o que responde "por que esta operadora tinha
    // lacuna semana passada?" — trocá-lo por memória vazia seria perder a única fonte dessa
    // resposta, e é o defeito que um `delete` "que limpa a lista" introduziria.
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/inbox");
    await expect(page).toHaveURL(/\/app\/ai\/inbox/);

    // A lista chega por requisição depois da casca da tela: ler o corpo sem esperar por um
    // item mede o cabeçalho e as abas — e a asserção negativa abaixo passaria por ausência
    // de conteúdo, não por o aviso ter sido fechado. Medido em 2026-08-09.
    await expect(page.getByText(/Pergunta sem material/i).first()).toBeVisible({
      timeout: 30_000,
    });
    const abertos = await page.locator("body").innerText();
    expect(abertos).not.toContain(PERGUNTA_COBERTA);
    // Âncora positiva na MESMA tela: os avisos que continuam abertos estão aqui. Sem ela, a
    // negativa acima passaria numa página vazia.
    expect(abertos).toContain(PERGUNTA_INTOCADA);

    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text n from agent_inbox_items
        where organization_id = $1 and knowledge_scope_id = $2 and status = 'resolved'`,
      [creds.org_id, escopoCoberto],
    );
    expect(rows[0]!.n, "os avisos fechados foram APAGADOS em vez de resolvidos").toBe("10");

    await captura(page, "4-central-sem-o-aviso-coberto");
  });
});
