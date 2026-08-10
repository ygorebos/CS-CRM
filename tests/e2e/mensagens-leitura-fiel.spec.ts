/**
 * A conversa mostra TUDO que o cliente fez — pela tela (spec 006, US1 / SC-001).
 *
 * ## O que esta spec prova, e por que não pode ser `curl`
 *
 * O defeito que a US1 conserta é INVISÍVEL na API: os dados sempre chegaram e
 * sempre foram gravados. O que faltava era a tela lê-los. Uma chamada de API
 * devolveria `metadata.reply_to_external_id` preenchido e diria que está tudo
 * certo — enquanto o corretor olha uma bolha em branco.
 *
 * Por isso a asserção é sobre o que se VÊ: a citação visível, o emoji preso à
 * bolha certa, a marca de apagada, o cartão de localização, e **zero** bolhas
 * vazias na conversa inteira.
 *
 * ## Âncora de lugar ANTES de qualquer asserção negativa
 *
 * `expect(corpo).not.toMatch(...)` passa em qualquer página que não contenha o
 * termo — inclusive na tela de login. A doutrina de medição (regra 3) custou uma
 * rodada inteira para aprender isso. Aqui todo caso afirma primeiro que está NA
 * conversa, e só então mede o que ela mostra.
 *
 * ## Pré-condições
 *
 *   - banco zerado do `baseline.sql` num Supabase local **pg17**;
 *   - primeiro usuário por `scripts/bootstrap-owner.ts` — conta NOVA, estado
 *     VAZIO;
 *   - app em produção (`next build` + `next start`), nunca `next dev`;
 *   - `SUPABASE_SERVICE_ROLE_KEY` no `.env.local` para semear a conversa.
 *
 * ## Limitação DECLARADA, e não escondida (research R2)
 *
 * O apagamento de mensagem **não chega pelo canal não-oficial** — a normalização
 * daquele canal não tem o caso (`gateway_go/internal/normalizer/uazapi.go`). O
 * caso de apagamento aqui semeia o EVENTO diretamente no banco, na forma exata em
 * que o envelope o entrega, e prova a LEITURA. Ele não prova que o canal manda —
 * e não deve ser lido como se provasse. A cobertura de ponta a ponta desse caso
 * depende de trabalho na porta de tráfego, fora do escopo desta spec (FR-022), e
 * está declarada em `docs/testing/user-journey-map.md`.
 */
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const URL_SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/** Ids fixos: a re-execução reaproveita e o `on conflict` do seed não duplica. */
const EXT_PERGUNTA = "wamid.E2E006.PERGUNTA";
const EXT_PROPOSTA = "wamid.E2E006.PROPOSTA";
const EXT_RESPOSTA = "wamid.E2E006.RESPOSTA";
const EXT_APAGADA = "wamid.E2E006.APAGADA";
const EXT_LOCAL = "wamid.E2E006.LOCAL";
const EXT_CONTATO = "wamid.E2E006.CONTATO";
const EXT_ESTRANHA = "wamid.E2E006.ESTRANHA";

test.describe.configure({ mode: "serial" });

/**
 * Semeia uma conversa com um exemplar de CADA forma.
 *
 * Escreve pelo service role, na forma EXATA em que o ingest do gateway grava —
 * `metadata.reply_to_external_id` para citação, reação e apagamento. Inventar
 * outro formato aqui mediria um caminho que a produção não percorre.
 */
async function semearConversa(): Promise<{ conversationId: string } | null> {
  if (!URL_SUPABASE || !SERVICE_ROLE) return null;
  const admin = createClient(URL_SUPABASE, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const { data: org } = await admin.from("organizations").select("id").limit(1).maybeSingle();
  if (!org) return null;
  const orgId = (org as { id: string }).id;

  const { data: sessao } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1)
    .maybeSingle();
  if (!sessao) return null;
  const sessaoId = (sessao as { id: string }).id;

  const { data: contato } = await admin
    .from("contacts")
    .upsert(
      {
        organization_id: orgId,
        phone_number: "+5511900060001",
        source: "whatsapp",
        display_name: "Cliente da spec 006",
      },
      { onConflict: "organization_id,phone_number" },
    )
    .select("id")
    .maybeSingle();
  if (!contato) return null;
  const contatoId = (contato as { id: string }).id;

  const { data: conv } = await admin
    .from("conversations")
    .insert({
      organization_id: orgId,
      contact_id: contatoId,
      channel_session_id: sessaoId,
    })
    .select("id")
    .maybeSingle();
  if (!conv) return null;
  const conversationId = (conv as { id: string }).id;

  const base = {
    organization_id: orgId,
    conversation_id: conversationId,
    channel_session_id: sessaoId,
    contact_id: contatoId,
    status: "received",
  };
  const t = (min: number) => new Date(Date.UTC(2026, 7, 9, 12, min)).toISOString();

  await admin.from("messages").insert([
    // 1. pergunta do cliente
    {
      ...base,
      external_id: EXT_PERGUNTA,
      type: "text",
      direction: "inbound",
      body: "Qual o valor da coparticipação?",
      sent_at: t(0),
    },
    // 2. proposta nossa
    {
      ...base,
      external_id: EXT_PROPOSTA,
      type: "text",
      direction: "outbound",
      body: "Segue a proposta do plano familiar",
      sent_at: t(1),
    },
    // 3. resposta do cliente CITANDO a pergunta
    {
      ...base,
      external_id: EXT_RESPOSTA,
      type: "text",
      direction: "inbound",
      body: "é essa mesma",
      sent_at: t(2),
      metadata: { reply_to_external_id: EXT_PERGUNTA },
    },
    // 4. reação do cliente à PROPOSTA
    {
      ...base,
      external_id: "wamid.E2E006.REACAO",
      type: "reaction",
      direction: "inbound",
      body: "👍",
      sent_at: t(3),
      metadata: { reply_to_external_id: EXT_PROPOSTA, reaction_emoji: "👍" },
    },
    // 5. mensagem que o cliente vai apagar
    {
      ...base,
      external_id: EXT_APAGADA,
      type: "text",
      direction: "inbound",
      body: "consigo pagar 480",
      sent_at: t(4),
    },
    // 6. o evento de apagamento, na forma do envelope
    {
      ...base,
      external_id: "wamid.E2E006.REVOKE",
      type: "system",
      direction: "inbound",
      body: null,
      sent_at: t(5),
      metadata: { reply_to_external_id: EXT_APAGADA, original_type: "revoke" },
    },
    // 7. localização
    {
      ...base,
      external_id: EXT_LOCAL,
      type: "location",
      direction: "inbound",
      body: null,
      sent_at: t(6),
      metadata: {
        location: { lat: -23.5613, lng: -46.6565, nome: "Clínica São Lucas", endereco: "Av. Paulista, 1000" },
      },
    },
    // 8. cartão de contato
    {
      ...base,
      external_id: EXT_CONTATO,
      type: "contact",
      direction: "inbound",
      body: null,
      sent_at: t(7),
      metadata: { contacts: [{ name: "Dra. Ana Ribeiro", phones: ["+5511999998888"] }] },
    },
    // 9. forma que esta versão não sabe exibir — o mecanismo anti-morte
    {
      ...base,
      external_id: EXT_ESTRANHA,
      type: "system",
      direction: "inbound",
      body: null,
      sent_at: t(8),
      metadata: { original_type: "carousel" },
    },
  ]);

  return { conversationId };
}

test.describe("a conversa não esconde o que o cliente fez", () => {
  let conversationId: string | null = null;

  test.beforeAll(async () => {
    const r = await semearConversa();
    conversationId = r?.conversationId ?? null;
  });

  test.beforeEach(async ({ page }) => {
    // Login UMA vez por arquivo (`mode: serial`): código TOTP vale uma vez só, e
    // dois casos logando na mesma janela de 30 s reusariam o mesmo código.
    await loginComoAdmin(page, lerCreds());
  });

  test("pré-condição: a conversa de teste existe", () => {
    // Afirmada, não assumida. Sem ela, TODOS os casos abaixo passariam medindo
    // uma tela vazia — o falso-verde mais caro que esta spec pode produzir.
    expect(
      conversationId,
      "sem NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, ou sem canal conectado, " +
        "não há o que medir. Rode o ambiente fresco do quickstart.",
    ).not.toBeNull();
  });

  test("zero bolhas em branco, e cada forma tem representação própria", async ({ page }) => {
    test.skip(!conversationId, "conversa de teste não semeada");
    await page.goto(`/app/inbox/${conversationId}`);

    // ── ÂNCORA DE LUGAR, antes de qualquer asserção ────────────────────────
    await expect(page).toHaveURL(new RegExp(`/app/inbox/${conversationId}`));
    const bolhas = page.getByTestId("bolha-de-mensagem");
    await expect(bolhas.first()).toBeVisible();

    // A citação está visível e diz de quem era o original.
    await expect(page.getByTestId("citacao-de-mensagem").first()).toBeVisible();
    await expect(page.getByText("Qual o valor da coparticipação?").first()).toBeVisible();

    // A reação está PRESA a uma bolha — e não é um item da linha do tempo.
    const reacao = page.getByTestId("reacao").first();
    await expect(reacao).toHaveText("👍");
    const bolhasComReacao = page.getByTestId("bolha-de-mensagem").filter({
      has: page.getByTestId("reacoes-da-mensagem"),
    });
    await expect(bolhasComReacao).toHaveCount(1);

    // A mensagem apagada está marcada — E o conteúdo continua legível (FR-005).
    await expect(page.getByTestId("marca-de-apagada")).toBeVisible();
    await expect(page.getByText("consigo pagar 480")).toBeVisible();

    // Localização e contato têm cartão próprio.
    await expect(page.getByTestId("cartao-de-localizacao")).toBeVisible();
    await expect(page.getByText("Clínica São Lucas")).toBeVisible();
    await expect(page.getByTestId("cartao-de-contato")).toBeVisible();
    await expect(page.getByText("+5511999998888")).toBeVisible();

    // A forma desconhecida vira RÓTULO — nunca some, nunca fica em branco.
    await expect(page.getByTestId("mensagem-nao-suportada")).toBeVisible();

    // ── SC-001: nenhuma bolha vazia ────────────────────────────────────────
    //
    // Medido por FERRAMENTA, não a olho: cada bolha tem de ter texto além do
    // relógio e dos indicadores de entrega.
    const vazias = await bolhas.evaluateAll((nos) =>
      nos.filter((n) => {
        const t = (n.textContent ?? "")
          .replace(/\d{2}:\d{2}/g, "")
          .replace(/Lida|Entregue|Enviada|Falhou/g, "")
          .trim();
        return t === "";
      }).length,
    );
    expect(vazias, "bolha em branco é o corretor perdendo o que o cliente disse").toBe(0);
  });

  test("a reação NÃO aparece como mensagem própria na linha do tempo", async ({ page }) => {
    test.skip(!conversationId, "conversa de teste não semeada");
    await page.goto(`/app/inbox/${conversationId}`);
    await expect(page).toHaveURL(new RegExp(`/app/inbox/${conversationId}`));
    await expect(page.getByTestId("bolha-de-mensagem").first()).toBeVisible();

    // Semeamos 9 linhas; 2 delas são EVENTOS (a reação e o apagamento) e não
    // podem virar bolha. Contar é o que separa "some da tela" de "está lá e eu
    // não reparei".
    await expect(page.getByTestId("bolha-de-mensagem")).toHaveCount(7);
  });

  test("o gesto de responder citando existe na mensagem", async ({ page }) => {
    test.skip(!conversationId, "conversa de teste não semeada");
    await page.goto(`/app/inbox/${conversationId}`);
    await expect(page).toHaveURL(new RegExp(`/app/inbox/${conversationId}`));

    const primeira = page.getByTestId("bolha-de-mensagem").first();
    await primeira.hover();
    await expect(page.getByTestId("responder-citando").first()).toBeVisible();
  });
});
