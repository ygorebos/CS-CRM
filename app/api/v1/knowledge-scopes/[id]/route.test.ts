/**
 * O teto de requisições de `PATCH /api/v1/knowledge-scopes/{id}` (spec 002, T087).
 *
 * Esta rota É a trava 4 (FR-008): cada chamada liga ou desliga o acervo de uma operadora
 * para o tenant inteiro, e cada volta emite uma linha de auditoria. Um laço aqui alterna o
 * comportamento do agente dezenas de vezes por segundo e enche o `api_audit_log` de ruído
 * que ninguém consegue investigar depois — é por isso que o teto não é formalidade de
 * Definition of Done.
 *
 * Sem `aplicarTetoDaOrganizacao` na rota, os dois primeiros testes falham: nenhuma chamada
 * é recusada, por mais que se repita.
 *
 * O contador real é dublado por um contador em memória do teste — a máquina de quem roda
 * pode ter Upstash no `.env.local` e o CI não tem; sem o dublê o teste mediria a
 * infraestrutura em vez da rota.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

import { PATCH } from "./route";
import { TETO_DE_ESCRITA } from "../_escopos";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "77777777-7777-4777-8777-777777777777";
const ANA = "11111111-1111-4111-8111-111111111111";
const ESPELHO = "33333333-3333-4333-8333-333333333333";

const linhaEspelho = {
  id: ESPELHO,
  organization_id: ORG_A,
  catalog_scope_id: "cs-unimed",
  display_name: "Unimed",
  official_code: "339679",
  is_active: false,
  created_at: "2026-08-08T10:00:00.000Z",
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

function fazerSupabase(): Chamada[] {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, op: "select" };
    chamadas.push(chamada);
    const resolver = () => {
      // Só `knowledge_scopes` devolve linha; as contagens de material (que a rota faz em
      // `ai_knowledge_sources`/`catalog_materials`) devolvem lista, como o supabase-js.
      if (tabela !== "knowledge_scopes") return Promise.resolve({ data: [], error: null });
      return Promise.resolve(
        chamada.op === "update"
          ? { data: { ...linhaEspelho, is_active: true }, error: null }
          : { data: linhaEspelho, error: null },
      );
    };
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

function interruptor(ligado: boolean) {
  return new NextRequest(`http://localhost/api/v1/knowledge-scopes/${ESPELHO}`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: ligado }),
    headers: { "content-type": "application/json" },
  });
}

const rota = { params: Promise.resolve({ id: ESPELHO }) };

async function gastarOOrcamento(): Promise<void> {
  for (let i = 0; i < TETO_DE_ESCRITA.limite; i += 1) {
    const res = await PATCH(interruptor(i % 2 === 0), {
      params: Promise.resolve({ id: ESPELHO }),
    });
    expect(res.status).toBe(200);
  }
}

describe("PATCH /api/v1/knowledge-scopes/{id} · teto de requisições (T087)", () => {
  it("estourado, devolve 429 com Retry-After — sem UPDATE e sem linha de auditoria", async () => {
    await gastarOOrcamento();
    const chamadas = fazerSupabase();
    vi.mocked(audit).mockClear();

    const res = await PATCH(interruptor(true), rota);

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(chamadas.filter((c) => c.op === "update")).toHaveLength(0);
    // Mutação recusada não vira trilha: `api_audit_log` descreve o que ACONTECEU.
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("o balde é por ORGANIZAÇÃO — org A estourar não trava o interruptor da org B", async () => {
    await gastarOOrcamento();
    expect((await PATCH(interruptor(true), rota)).status).toBe(429);

    sessao(ORG_B);
    fazerSupabase();
    const daOutraCorretora = await PATCH(interruptor(true), {
      params: Promise.resolve({ id: ESPELHO }),
    });

    expect(daOutraCorretora.status).toBe(200);
  });

  it("a chave do balde carrega a organização, e é a mesma da escrita de escopo", async () => {
    await PATCH(interruptor(true), rota);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(
      `${TETO_DE_ESCRITA.balde}:${ORG_A}`,
      TETO_DE_ESCRITA.limite,
      TETO_DE_ESCRITA.janelaSeg,
    );
  });

  it("id fora do formato é 404 e não gasta orçamento", async () => {
    const res = await PATCH(interruptor(true), { params: Promise.resolve({ id: "nao-e-uuid" }) });
    expect(res.status).toBe(404);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("a resposta bem-sucedida carrega X-RateLimit-*", async () => {
    const res = await PATCH(interruptor(true), rota);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(TETO_DE_ESCRITA.limite));
    expect(res.headers.get("X-RateLimit-Remaining")).toBe(String(TETO_DE_ESCRITA.limite - 1));
  });
});
