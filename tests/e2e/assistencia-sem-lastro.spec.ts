/**
 * O QUE O CORRETOR VÊ quando o agente recusa por falta de material — spec 002, fatia F1,
 * FR-011 e FR-012.
 *
 * ═══ O QUE ESTE SPEC PROVA, E O QUE ELE NÃO PROVA ═══
 *
 * **Prova**: a recusa não morre em log. Ela vira uma conversa de volta na fila humana e
 * um aviso acionável na tela, com a pergunta original do cliente, a operadora envolvida e
 * o que fazer a seguir — em português que um corretor entende, sem vocabulário interno do
 * produto.
 *
 * **NÃO prova**: o veto em si. Para o gate `assistance_grounding` decidir é preciso um
 * turno com modelo, e a suíte E2E roda **sem chave de IA** — o `.env.e2e` nasce sem
 * `AI_GATEWAY_API_KEY` de propósito, porque é o estado real de um primeiro deploy. O veto
 * está provado por unidade e confirmado por **sabotagem** em
 * `lib/agent-engine/guardrails/assistance-grounding.test.ts` e `before-send.test.ts`.
 *
 * Dizer isso em voz alta é o ponto. Um spec que insinuasse provar o veto inteiro seria
 * pior que não existir: daria a impressão de cobertura onde há metade dela, que é o mesmo
 * defeito que o botão "Testar" tinha e que a spec 002 corrige noutro lugar.
 *
 * ═══ POR QUE O SEED CHAMA A FUNÇÃO REAL ═══
 *
 * `scripts/seed-e2e-assistencia-sem-lastro.ts` chama `escalarAssistenciaSemLastro`, não
 * um `INSERT` equivalente. Um seed que montasse o estado na mão provaria este teste
 * contra uma cópia da regra — e no dia em que a função mudasse, o teste continuaria
 * verde. Mesmo princípio do `seed-e2e-escalacao.ts`.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm exec tsx --env-file=.env.local scripts/seed-e2e-assistencia-sem-lastro.ts
 *   pnpm e2e:build && pnpm exec playwright test tests/e2e/assistencia-sem-lastro.spec.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/002-f1-lastro");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
  assistencia_sem_lastro?: {
    conversation_id: string;
    contact_id: string;
    contact_name: string;
    pergunta: string;
    avisos_criados: number;
  };
}

let creds: Creds;

test.beforeAll(() => {
  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("rode scripts/seed-e2e-credentials.ts antes");
  }
  creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!creds.assistencia_sem_lastro) {
    throw new Error("rode scripts/seed-e2e-assistencia-sem-lastro.ts antes");
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

test.describe("a recusa por falta de material vira trabalho, não silêncio", () => {
  test("o aviso chega ao corretor pela porta que ele já usa, com contador", async ({ page }) => {
    await login(page, creds.users.agent!.email, creds.password);

    // Pela PORTA, não digitando a URL: tela que só existe para quem sabe o caminho é
    // tela que não existe (Princípio II — "tela nova tem porta").
    //
    // A porta é o sino do cabeçalho, e não o item "Alertas" da barra lateral: medido
    // aqui em 2026-08-08, o grupo "IA" do `lib/navigation/registry.ts` **não renderiza
    // para o papel `agent`** — quem atende no dia a dia não veria o item nenhum. O sino
    // aparece em toda tela e já traz a contagem, que é o que faz o aviso ser notado em
    // vez de esperar alguém abrir a tela certa.
    const sino = page.getByRole("link", { name: /central de avisos/i }).first();
    await expect(sino).toBeVisible({ timeout: 30_000 });
    await expect(sino).toContainText("1"); // o aviso desta recusa, contado
    await sino.click();
    await page.waitForURL(/\/app\/ai\/inbox/, { timeout: 30_000 });

    // O rótulo que o corretor lê. Ele fala do que FALTA, não do guardrail que agiu:
    // "recusa por ausência de lastro" é verdade e é inútil para quem precisa agir.
    await expect(
      page.getByText(/pergunta de cliente ficou sem resposta por falta de material/i),
    ).toBeVisible({ timeout: 30_000 });

    await captura(page, "alertas-com-aviso-de-falta-de-material");
  });

  test("o aviso carrega os três campos que FR-012 exige", async ({ page }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/ai/inbox");

    const e = creds.assistencia_sem_lastro!;
    const corpo = page.getByText(/o cliente perguntou/i).first();
    await expect(corpo).toBeVisible({ timeout: 30_000 });

    const texto = (await page.locator("body").innerText()).toLowerCase();

    // (1) a pergunta original — sem ela o corretor não sabe o que carregar
    expect(texto).toContain("carência do nosso plano");
    // (2) a operadora, ou a informação honesta de que ela é desconhecida
    expect(texto).toContain("não identificada");
    // (3) o motivo, e o que fazer a seguir
    expect(texto).toContain("não há material carregado");
    expect(texto).toContain("carregue o material");

    void e;
    await captura(page, "aviso-com-pergunta-operadora-e-motivo");
  });

  test("o aviso não fala a língua do sistema com o corretor", async ({ page }) => {
    // A mesma trava que o gate de vocabulário interno aplica ao cliente vale para a
    // Central: quem lê é dono de negócio, não quem escreveu o runtime. "gate",
    // "guardrail" e "lastro" são palavras nossas, não dele.
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/ai/inbox");
    await expect(page.getByText(/o cliente perguntou/i).first()).toBeVisible({ timeout: 30_000 });

    const texto = (await page.locator("body").innerText()).toLowerCase();
    for (const jargao of ["guardrail", "gate", "grounding", "chunk", "embedding", "rag_must_hit"]) {
      expect(texto, `jargão na tela do corretor: ${jargao}`).not.toContain(jargao);
    }
  });

  test("a conversa saiu do automático e está esperando uma pessoa", async ({ page }) => {
    // O outro lado de FR-012: recusar e deixar a conversa com a IA seria abandonar o
    // cliente com um robô que já disse que não sabe.
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${creds.assistencia_sem_lastro!.conversation_id}`);

    // `pending` é o estado que a fila humana lê. A asserção é sobre o que a TELA diz,
    // não sobre a coluna: o corretor precisa VER que o automático parou.
    await expect(page.getByText(/aguardando|pendente|automático pausado/i).first()).toBeVisible({
      timeout: 30_000,
    });

    await captura(page, "conversa-de-volta-para-a-fila-humana");
  });
});
