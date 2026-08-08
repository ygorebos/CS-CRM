/**
 * O teto de requisições de `POST /api/v1/knowledge-scopes` (spec 002, T086).
 *
 * A rota já tinha `Idempotency-Key`, `409 escopo_ja_existe`, papel e auditoria — o que
 * faltava era o item 6 do Definition of Done. Estes testes falham inteiros sem
 * `aplicarTetoDaOrganizacao`: sem ele nenhuma chamada é recusada, por mais que se repita.
 *
 * O que eles vigiam, e por que cada um importa:
 *
 * 1. **O balde existe.** Estourado, a resposta é `429 rate_limited` com `Retry-After`, e a
 *    recusa acontece ANTES de qualquer escrita.
 * 2. **O balde é por ORGANIZAÇÃO.** Global faria uma corretora movimentada calar as
 *    outras — num banco compartilhado por todos os clientes isso é indisponibilidade
 *    vazando entre tenants. Este é o teste que reprova essa regressão.
 * 3. **A chave vem de fonte confiável.** `requireRole` resolve a organização do cookie
 *    validado; se um dia alguém a tirar do corpo, a chave do balde muda e o teste cai.
 *
 * O contador real (`checkRateLimit`, Upstash com queda para memória) é dublado por um
 * contador em memória do próprio teste: a máquina de quem roda pode ter Upstash
 * configurado no `.env.local` e o CI não tem, e um teste que depende disso mede a
 * infraestrutura, não a rota.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

import { POST } from "./route";
import { TETO_DE_ESCRITA } from "./_escopos";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "77777777-7777-4777-8777-777777777777";
const ANA = "11111111-1111-4111-8111-111111111111";
const PROPRIO = "44444444-4444-4444-8444-444444444444";

const linhaPropria = {
  id: PROPRIO,
  organization_id: ORG_A,
  catalog_scope_id: null,
  display_name: "Amil",
  official_code: null,
  is_active: true,
  created_at: "2026-08-08T11:00:00.000Z",
};

function sessao(orgId: string, papel: Role = "manager") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: orgId, organization_name: "Corretora", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId, name: "Corretora", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update";
}

/** Dublê mínimo do client de sessão: registra a operação por tabela. */
function fazerSupabase(): Chamada[] {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, op: "select" };
    chamadas.push(chamada);
    const resolver = () =>
      Promise.resolve(
        chamada.op === "insert"
          ? { data: linhaPropria, error: null }
          : { data: [], error: null },
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: () => {
        chamada.op = "insert";
        return chain;
      },
      update: () => {
        chamada.op = "update";
        return chain;
      },
      eq: () => chain,
      neq: () => chain,
      in: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      single: resolver,
      maybeSingle: resolver,
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => resolver().then(ok, err),
    };
    return chain;
  };
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return chamadas;
}

/** Contador determinístico por balde — é o que torna "org A não afeta org B" observável. */
const baldes = new Map<string, number>();

beforeEach(() => {
  vi.clearAllMocks();
  baldes.clear();
  vi.mocked(checkRateLimit).mockImplementation(async (balde, limite, janelaSeg) => {
    const contagem = (baldes.get(balde) ?? 0) + 1;
    baldes.set(balde, contagem);
    return { allowed: contagem <= limite, count: contagem, limit: limite, window_sec: janelaSeg };
  });
  sessao(ORG_A);
  fazerSupabase();
});

function criar(nome: string) {
  return new NextRequest("http://localhost/api/v1/knowledge-scopes", {
    method: "POST",
    body: JSON.stringify({ display_name: nome }),
    headers: { "content-type": "application/json" },
  });
}

/** Consome o orçamento inteiro da janela — sem passar do limite. */
async function gastarOOrcamento(): Promise<void> {
  for (let i = 0; i < TETO_DE_ESCRITA.limite; i += 1) {
    const res = await POST(criar(`Operadora ${i}`));
    // Guarda da guarda: se o teto encolher e alguma destas já vier 429, o resto do teste
    // passaria pelo motivo errado.
    expect(res.status).toBe(201);
  }
}

describe("POST /api/v1/knowledge-scopes · teto de requisições (T086)", () => {
  it("estourado, devolve 429 rate_limited com Retry-After e sem tocar no banco", async () => {
    await gastarOOrcamento();
    // Registrador zerado logo antes do pedido que DEVE ser barrado: o que interessa é que
    // ELE não escreveu, não a soma dos 30 legítimos.
    const chamadas = fazerSupabase();
    const res = await POST(criar("A que passa do teto"));

    expect(res.status).toBe(429);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("rate_limited");
    // A frase é lida por quem está na tela: sem jargão, e dizendo o que fazer.
    expect(corpo.error.message).toMatch(/aguarde/i);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");

    // A recusa acontece antes de escrever: o pedido barrado não deixou insert nenhum.
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("o balde é por ORGANIZAÇÃO — org A estourar não recusa a org B", async () => {
    await gastarOOrcamento();
    expect((await POST(criar("A que passa do teto"))).status).toBe(429);

    sessao(ORG_B);
    fazerSupabase();
    const daOutraCorretora = await POST(criar("Hapvida"));

    expect(daOutraCorretora.status).toBe(201);
    expect(daOutraCorretora.headers.get("X-RateLimit-Remaining")).toBe(
      String(TETO_DE_ESCRITA.limite - 1),
    );
  });

  it("a chave do balde carrega a organização resolvida do requireRole", async () => {
    await POST(criar("Amil"));
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(
      `${TETO_DE_ESCRITA.balde}:${ORG_A}`,
      TETO_DE_ESCRITA.limite,
      TETO_DE_ESCRITA.janelaSeg,
    );
  });

  it("papel insuficiente não gasta orçamento de quem pode escrever", async () => {
    sessao(ORG_A, "agent");
    const res = await POST(criar("Amil"));
    expect(res.status).toBe(403);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("a resposta bem-sucedida também carrega X-RateLimit-*", async () => {
    const res = await POST(criar("Amil"));
    expect(res.status).toBe(201);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(TETO_DE_ESCRITA.limite));
    expect(Number(res.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
  });
});
