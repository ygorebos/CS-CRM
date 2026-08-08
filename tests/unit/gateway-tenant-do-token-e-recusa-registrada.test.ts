/**
 * Quem decide o tenant, e o que sobra de uma recusa (T042/T043 da spec 001).
 *
 * ## Os dois defeitos que este arquivo congela
 *
 * **T042 — o corpo decidindo o dono.** A versão fail-open da rota antiga deixava
 * quem soubesse a URL injetar mensagem em CRM alheio. A trava é que a organização
 * venha SEMPRE da linha de `channel_sessions` achada pelo token do caminho. Só
 * isso, porém, produz uma trava muda: um corpo com `organization_id` é ignorado e
 * ninguém fica sabendo — e é precisamente essa a assinatura de alguém tentando
 * escrever no CRM de outra pessoa. Aqui se cobram as duas metades: o campo é
 * ignorado para autorização E a tentativa vira linha de auditoria.
 *
 * **T043 (SC-012) — a recusa que só existia no log de aplicação.** Recusar sem
 * gravar deixa a pergunta "quantas entregas forjadas chegaram nesta conexão, e
 * quando" dependente do stdout do contêiner, que num self-host não sobrevive a um
 * `docker compose up`. Pior: o caminho legado gravava `valid_signature: true` em
 * evento não verificado, o que fazia a coluna mentir exatamente no momento em que
 * alguém iria auditá-la.
 *
 * ## Por que o teste chama a ROTA, e não as funções por dentro
 *
 * `parseEnvelope` devolvendo `tenantForcado` não prova nada sozinho: o defeito
 * real é a rota LER esse campo do corpo, ou não registrar o que viu. Esses dois
 * são decisões da rota, e é ela que está sob teste — com o banco, o teto, o
 * segredo e a ingestão dublados, e a AUTENTICAÇÃO real no caminho, porque assinar
 * de verdade é o que separa "recusou por formato" de "recusou por assinatura".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: { GATEWAY_INBOUND_ENABLED: true, GATEWAY_MAX_BODY_BYTES: 1_000_000 },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/gateway/rate-limit", () => ({
  checarTetoDaConexao: vi.fn(async () => ({ permitido: true, cabecalhos: {} })),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => SEGREDO),
}));
vi.mock("@/lib/gateway/ingest", () => ({
  ingerirEnvelope: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/gateway/aviso-de-segredo", () => ({
  avisarSegredoNaoProvisionado: vi.fn(async () => true),
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { assinarEntrega } from "@/lib/gateway/auth";
import { audit } from "@/lib/audit";
import { POST } from "@/app/api/v1/webhooks/gateway/[token]/route";
import { createAdminClient } from "@/lib/supabase/admin";

const SEGREDO = "0123456789abcdef0123456789abcdef";
const TOKEN = "tok_do_dono_legitimo";
const ORG_DONA = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_ALVO = "bbbbbbbb-0000-4000-8000-000000000002";
const SESSAO = "cccccccc-0000-4000-8000-000000000003";

/** Linhas gravadas em `webhook_events_log` durante a requisição. */
let registros: Record<string, unknown>[] = [];
/** A conexão que o token resolve. `ingest_path` varia por caso. */
let sessao: Record<string, unknown> | null = null;

/**
 * Dublê do client de serviço. Modela só as três consultas que a rota faz —
 * resolver a conexão, gravar a entrega e checar duplicidade —, e qualquer outra
 * tabela cai num encadeamento inerte, para o teste não passar por engano sobre
 * um caminho que ele não modela.
 */
function adminDuble() {
  const inerte: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "then") {
          return prop === "then"
            ? (onF: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(onF)
            : async () => ({ data: null, error: null });
        }
        return () => inerte;
      },
    },
  );

  return {
    from(tabela: string) {
      if (tabela === "channel_sessions") {
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: () => cadeia,
          is: () => cadeia,
          maybeSingle: async () => ({ data: sessao, error: null }),
        };
        return cadeia;
      }
      if (tabela === "webhook_events_log") {
        const cadeia: Record<string, unknown> = {
          insert: (linha: Record<string, unknown>) => {
            registros.push(linha);
            return {
              select: () => ({
                maybeSingle: async () => ({ data: { id: "log-1" }, error: null }),
              }),
            };
          },
          update: () => ({ eq: async () => ({ error: null }) }),
        };
        return cadeia;
      }
      return inerte;
    },
  } as unknown as ReturnType<typeof createAdminClient>;
}

/** Requisição assinada de verdade, como o gateway a emitiria. */
function entrega(corpo: unknown, opts?: { assinar?: boolean }) {
  const corpoCru = JSON.stringify(corpo);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = new Headers({ "content-type": "application/json" });
  if (opts?.assinar !== false) {
    headers.set("X-Gateway-Timestamp", ts);
    headers.set("X-Gateway-Signature", assinarEntrega(ts, corpoCru, SEGREDO));
  }
  return {
    headers,
    text: async () => corpoCru,
  } as unknown as NextRequest;
}

const ctx = { params: Promise.resolve({ token: TOKEN }) };

function envelopeValido(extra: Record<string, unknown> = {}) {
  return {
    envelope_version: 1,
    event_id: "01H0000000000000000000T042",
    event_kind: "new_message",
    occurred_at: "2026-08-08T12:00:00Z",
    platform: "whatsapp_uazapi",
    message: {
      external_id: "3EB0T042",
      direction: "inbound",
      type: "text",
      body: "oi",
    },
    participant: { external_id: "5511999990000" },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  registros = [];
  sessao = {
    id: SESSAO,
    organization_id: ORG_DONA,
    webhook_secret_encrypted: "\\xdeadbeef",
    ingest_path: "gateway",
    gateway_connection_id: "conn_1",
  };
  vi.mocked(createAdminClient).mockImplementation(adminDuble);
});

describe("T042 — o corpo nunca decide a organização", () => {
  it("entrega com organization_id de OUTRO tenant é gravada na organização do token", async () => {
    const res = await POST(entrega(envelopeValido({ organization_id: ORG_ALVO })), ctx);

    // A entrega é ACEITA: o campo é ignorado, não é motivo de recusa. Recusar
    // daria ao atacante um oráculo — ele descobriria quais chaves o CRM lê.
    expect(res.status).toBe(202);

    const linha = registros.at(-1)!;
    expect(linha.organization_id).toBe(ORG_DONA);
    expect(linha.organization_id).not.toBe(ORG_ALVO);
  });

  it("a tentativa vira auditoria com as chaves que tentaram decidir o dono", async () => {
    await POST(entrega(envelopeValido({ organization_id: ORG_ALVO, tenant_id: "x" })), ctx);

    const tentativa = vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .find((a) => (a.metadata as Record<string, unknown> | undefined)?.reason === "tenant_no_corpo_ignorado");

    // Ignorar em silêncio perderia o único sinal de que alguém está tentando
    // escrever no CRM de outra pessoa — que é exatamente o ataque que a rota
    // antiga permitia.
    expect(tentativa).toBeDefined();
    expect(tentativa!.organizationId).toBe(ORG_DONA);
    expect(tentativa!.metadata!.chaves).toEqual(
      expect.arrayContaining(["organization_id", "tenant_id"]),
    );
  });

  it("entrega legítima NÃO gera o alarme — senão ele vira ruído e ninguém olha", async () => {
    await POST(entrega(envelopeValido()), ctx);

    const alarmes = vi
      .mocked(audit)
      .mock.calls.map((c) => c[0])
      .filter((a) => (a.metadata as Record<string, unknown> | undefined)?.reason === "tenant_no_corpo_ignorado");

    expect(alarmes).toHaveLength(0);
  });
});

describe("T043 — a recusa é reconstruível pelo banco (SC-012)", () => {
  it("entrega sem assinatura vira linha em error, com valid_signature FALSE", async () => {
    const res = await POST(entrega(envelopeValido(), { assinar: false }), ctx);

    expect(res.status).toBe(401);
    expect(registros).toHaveLength(1);

    const linha = registros[0]!;
    expect(linha.status).toBe("error");
    // A coluna precisa DIZER a verdade. Gravar `true` aqui — como o caminho
    // legado fazia — faria toda linha, inclusive a forjada, alegar assinatura
    // válida para quem fosse auditar o incidente.
    expect(linha.valid_signature).toBe(false);
    // Sem organização e conexão, a linha nasceria invisível no log isolado por
    // tenant, e o corretor dono da conexão nunca a veria.
    expect(linha.organization_id).toBe(ORG_DONA);
    expect(linha.channel_session_id).toBe(SESSAO);
    // O motivo E o corpo cru: sem o corpo não se reconstrói o que chegou; sem o
    // motivo não se sabe por que não entrou.
    expect(String(linha.event_type ?? "")).toMatch(/assinatura|timestamp|segredo/i);
    expect(String(linha.raw_body ?? "")).toContain("3EB0T042");
  });

  it("assinatura FORJADA também vira linha — não só a ausente", async () => {
    const req = entrega(envelopeValido());
    req.headers.set("X-Gateway-Signature", "f".repeat(128));

    const res = await POST(req, ctx);

    expect(res.status).toBe(401);
    expect(registros).toHaveLength(1);
    expect(registros[0]!.valid_signature).toBe(false);
    expect(registros[0]!.status).toBe("error");
  });

  it("conexão não migrada recusa 409 e DEIXA RASTRO, em vez de sumir", async () => {
    sessao = { ...sessao!, ingest_path: "legacy" };

    const res = await POST(entrega(envelopeValido()), ctx);

    expect(res.status).toBe(409);
    // Este é o caso mais fácil de errar: a recusa é "esperada", então parece
    // dispensável registrá-la. Mas é ela que explica um canal que "parou de
    // receber" depois de uma virada de chave feita pela metade.
    expect(registros).toHaveLength(1);
    expect(registros[0]!.event_type).toBe("connection_not_migrated");
    expect(registros[0]!.valid_signature).toBe(false);
  });

  it("entrega VÁLIDA grava valid_signature TRUE — senão a coluna não separa nada", async () => {
    // Sem este caso, gravar `false` em tudo passaria nos casos acima e destruiria
    // a utilidade da coluna pelo outro lado.
    const res = await POST(entrega(envelopeValido()), ctx);

    expect(res.status).toBe(202);
    expect(registros.at(-1)!.valid_signature).toBe(true);
    expect(registros.at(-1)!.status).toBe("received");
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Ler `organization_id` do corpo em vez da linha de `channel_sessions`
 *     → "é gravada na organização do token" cai.
 *  2. Remover o bloco de auditoria de `tenantForcado` (ou esvaziar
 *     `CHAVES_QUE_DECIDIRIAM_TENANT`)
 *     → "a tentativa vira auditoria" cai.
 *  3. Voltar `assinaturaValida` para `true` fixo em `registrarRecebimento`
 *     → os dois casos de assinatura recusada caem.
 *  4. Tirar o `registrarRecebimento` do ramo 401 ou do ramo 409
 *     → "vira linha em error" / "DEIXA RASTRO" caem.
 */
