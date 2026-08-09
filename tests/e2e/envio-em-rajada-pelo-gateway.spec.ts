/**
 * Mandar VÁRIAS mensagens seguidas, pela tela, e todas saírem — spec 004.
 *
 * ## O defeito que esta spec existe para impedir de voltar
 *
 * Medido em 2026-08-09, com conta e número reais: de três mensagens enviadas em
 * sequência pela caixa de entrada, só a PRIMEIRA saía de `queued`. As outras
 * ficavam com o relógio para sempre — e a conversa mostrava cada frase duas
 * vezes. As três tinham sido entregues ao cliente.
 *
 * Nada ficava vermelho: a rota respondia 201, o log do servidor não tinha erro,
 * e 3177 asserções unitárias passavam. O erro do UPDATE era descartado
 * (`const { data } =` sem `error`) e escondia um 23505 do índice
 * `messages_org_external_id_unique`: o eco do próprio envio voltava pelo
 * gateway em ~200 ms e tomava o `external_id` antes do carimbo.
 *
 * ## Por que aqui, e por que não bastava teste de unidade
 *
 * A corrida é com um TERCEIRO (o provedor devolvendo o eco) e o intervalo é de
 * milissegundos. Dublê responde no formato e no tempo que o autor escreveu —
 * foi exatamente por isso que a suíte inteira ficou verde enquanto o produto
 * estava mudo. A rede de unidade que acompanha este conserto
 * (`messages-handler-eco-duplicado`) fixa a LÓGICA; só a execução real fixa a
 * corrida.
 *
 * ## O que se afirma, e o que NÃO conta como prova
 *
 * "Apareceu na tela" não prova envio: linha `queued` e linha `failed` também
 * aparecem. O desfecho é lido no banco — `status` de saída **e** `external_id`
 * presente — e a ausência de duplicata é medida contando as linhas com a marca
 * desta execução em TODO o banco, não só na conversa.
 *
 * ## Pré-condições (por isso ela NÃO roda no CI)
 *
 *   - gateway de pé com `STORE_ALVO=crm` e um número REAL pareado;
 *   - `GATEWAY_BASE_URL` e `GATEWAY_INTERNAL_TOKEN` no ambiente do app;
 *   - uma conversa existente com um contato de teste.
 *
 * O `e2e.yml` sobe Supabase local e nenhum provedor — sem gateway não há eco, e
 * sem eco a corrida não existe: a spec passaria sem medir nada, que é o pior
 * desfecho possível. Fica declarada como não-coberta, com este motivo, ao lado
 * de `conexao-pelo-gateway.spec.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect } from "@playwright/test";

const EVIDENCE_DIR = path.join(process.cwd(), ".superpowers/evidence/envio-em-rajada");

const CONVERSA = process.env.E2E_CONVERSATION_ID ?? "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const EMAIL = process.env.E2E_OWNER_EMAIL ?? "";
const SENHA = process.env.E2E_OWNER_PASSWORD ?? "";

/** Quantas e com que folga. 1,2 s é o piso do anti-banimento — abaixo disso o
 *  teste mediria o throttle, não a corrida. */
const QUANTAS = 6;
const INTERVALO_MS = 1200;

const temAmbiente = Boolean(CONVERSA && SUPABASE_URL && SERVICE_KEY && EMAIL && SENHA);

async function rest<T>(caminho: string): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return (await r.json()) as T;
}

interface LinhaDeMensagem {
  body: string | null;
  status: string;
  external_id: string | null;
  conversation_id: string;
}

test.describe("envio em rajada pelo gateway", () => {
  test.skip(
    !temAmbiente,
    "exige gateway de pé com número real: E2E_CONVERSATION_ID, E2E_OWNER_EMAIL, " +
      "E2E_OWNER_PASSWORD, NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY",
  );

  test("seis mensagens seguidas: todas com external_id, nenhuma duplicada", async ({ page }) => {
    test.setTimeout(180_000);
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    await page.goto("/login", { waitUntil: "networkidle" });
    await page.fill("#email", EMAIL);
    await page.fill("#password", SENHA);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45_000 });

    await page.goto(`/app/inbox?id=${CONVERSA}`, { waitUntil: "networkidle" });
    // Âncora de LUGAR antes de qualquer afirmação sobre conteúdo: asserção
    // negativa sem ela passa em qualquer página que não contenha o termo.
    await expect(page).toHaveURL(new RegExp(CONVERSA));

    const marca = `rajada-e2e-${Date.now().toString().slice(-8)}`;
    const campo = page.locator('textarea, [contenteditable="true"]').last();
    for (let i = 1; i <= QUANTAS; i += 1) {
      await campo.click();
      await campo.fill(`${marca} ${i}/${QUANTAS}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(INTERVALO_MS);
    }
    // Folga para o carimbo que precisa da retentativa (uma volta a mais ao banco).
    await page.waitForTimeout(12_000);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, "rajada.png"), fullPage: true });

    const naConversa = await rest<LinhaDeMensagem[]>(
      `messages?conversation_id=eq.${CONVERSA}&body=like.${marca}*` +
        `&select=body,status,external_id,conversation_id&order=created_at.asc`,
    );
    const emTodoOBanco = await rest<LinhaDeMensagem[]>(
      `messages?body=like.${marca}*&select=body,status,external_id,conversation_id`,
    );

    // 1. Todas saíram: status de saída E identificador do provedor. Só o status
    //    não basta — `sent` sem `external_id` é o estado em que o ACK nunca casa.
    expect(naConversa).toHaveLength(QUANTAS);
    for (const linha of naConversa) {
      expect(["sent", "delivered", "read"], `${linha.body} ficou em '${linha.status}'`).toContain(
        linha.status,
      );
      expect(linha.external_id, `${linha.body} saiu sem external_id`).toBeTruthy();
    }

    // 2. Nenhuma duplicata em lugar nenhum — o eco do gateway criava uma segunda
    //    linha, e ela não fica na mesma conversa (ia para uma conversa fantasma,
    //    de um contato duplicado). Contar só na conversa não veria.
    expect(emTodoOBanco, "linha a mais com a mesma marca: o eco sobreviveu").toHaveLength(QUANTAS);
    expect(
      emTodoOBanco.filter((l) => l.conversation_id !== CONVERSA),
      "mensagem gravada fora da conversa em que foi digitada",
    ).toHaveLength(0);
  });
});
