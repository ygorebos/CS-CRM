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

import { DELETE, PATCH } from "./route";
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
  op: "select" | "insert" | "update" | "delete";
}

/**
 * `linha` decide o que `knowledge_scopes` devolve na LEITURA. O default é o espelho do
 * catálogo, que é o caso do PATCH; o DELETE precisa do escopo PRÓPRIO
 * (`catalog_scope_id: null`), e a diferença entre os dois é justamente o que a rota
 * recusa.
 */
function fazerSupabase(linha: Record<string, unknown> = linhaEspelho): Chamada[] {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, op: "select" };
    chamadas.push(chamada);
    const resolver = () => {
      // Só `knowledge_scopes` devolve linha; as contagens de material (que a rota faz em
      // `ai_knowledge_sources`/`catalog_materials`) devolvem lista, como o supabase-js.
      if (tabela !== "knowledge_scopes") {
        // O `update ... select("id")` que arquiva o acervo devolve as linhas afetadas — é
        // de onde sai `materials_archived`. Duas, para a contagem não poder ser confundida
        // com "0 ou 1" nem com a lista vazia das contagens de material.
        if (tabela === "ai_knowledge_sources" && chamada.op === "update") {
          return Promise.resolve({ data: [{ id: "src-1" }, { id: "src-2" }], error: null });
        }
        return Promise.resolve({ data: [], error: null });
      }

      return Promise.resolve(
        chamada.op === "update"
          ? { data: { ...linha, is_active: true }, error: null }
          : { data: linha, error: null },
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
      delete: () => {
        chamada.op = "delete";
        return chain;
      },
      eq: () => chain,
      // `.is("deleted_at", null)` — o filtro que exclui escopo removido (0135).
      is: () => chain,
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

/**
 * `DELETE /api/v1/knowledge-scopes/{id}` — a outra metade de FR-008 (T099).
 *
 * O que estes casos existem para impedir, em ordem de dano: apagar um espelho do catálogo
 * (que a sincronização recria, produzindo um "sumiu e voltou" que ninguém diagnostica);
 * apagar o escopo ANTES de arquivar o acervo dele (deixando fonte viva, inerte e invisível,
 * sem ponteiro para achá-la); e gravar auditoria de remoção que a RLS barrou.
 */
const PROPRIO = "44444444-4444-4444-8444-444444444444";

const linhaPropria = {
  id: PROPRIO,
  organization_id: ORG_A,
  catalog_scope_id: null,
  display_name: "Operadora do corretor",
  official_code: null,
  is_active: true,
  created_at: "2026-08-09T10:00:00.000Z",
};

function remover(id = PROPRIO) {
  return new NextRequest(`http://localhost/api/v1/knowledge-scopes/${id}`, { method: "DELETE" });
}

const rotaPropria = { params: Promise.resolve({ id: PROPRIO }) };

describe("DELETE /api/v1/knowledge-scopes/{id} · remoção do escopo próprio (T099)", () => {
  it("remove o escopo próprio, arquivando o acervo daquele balde", async () => {
    const chamadas = fazerSupabase(linhaPropria);

    const res = await DELETE(remover(), rotaPropria);

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: { id: string; deleted: boolean; materials_archived: number };
    };
    expect(corpo.data).toEqual({ id: PROPRIO, deleted: true, materials_archived: 2 });
    expect(
      chamadas.some((c) => c.tabela === "knowledge_scopes" && c.op === "update"),
      "o escopo não foi marcado como removido",
    ).toBe(true);
  });

  it("arquiva ANTES de marcar o escopo — depois de `deleted_at` não há caminho até o acervo", async () => {
    // Marcado o escopo primeiro, a listagem por escopo deixa de ser caminho natural até
    // aquelas fontes, e elas ficariam vivas e sem quem as arquive. Esta é a asserção de
    // ORDEM, e é a única que a pega — o corpo da resposta é idêntico nos dois casos.
    const chamadas = fazerSupabase(linhaPropria);
    await DELETE(remover(), rotaPropria);

    const arquivo = chamadas.findIndex(
      (c) => c.tabela === "ai_knowledge_sources" && c.op === "update",
    );
    const marcou = chamadas.findIndex((c) => c.tabela === "knowledge_scopes" && c.op === "update");
    expect(arquivo).toBeGreaterThanOrEqual(0);
    expect(marcou).toBeGreaterThanOrEqual(0);
    expect(arquivo).toBeLessThan(marcou);
  });

  it("emite auditoria PRÓPRIA, com a contagem do que foi arquivado", async () => {
    fazerSupabase(linhaPropria);
    await DELETE(remover(), rotaPropria);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "knowledge_scope.deleted",
        organizationId: ORG_A,
        resourceType: "knowledge_scope",
        resourceId: PROPRIO,
        metadata: expect.objectContaining({ materials_archived: 2, was_active: true }),
      }),
    );
  });

  it("espelho do catálogo é 403 — remover não o faria sumir, a sincronização o recria", async () => {
    const chamadas = fazerSupabase();

    const res = await DELETE(remover(ESPELHO), { params: Promise.resolve({ id: ESPELHO }) });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "escopo_do_catalogo_nao_editavel",
    );
    // Nada foi marcado nem arquivado: a recusa é anterior a qualquer escrita.
    expect(chamadas.filter((c) => c.op === "delete" || c.op === "update")).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("escopo de outra organização é 404 — e sem trilha de remoção", async () => {
    // O supabase-js devolve `null` porque o `.eq("organization_id")` da rota não casa.
    // Sem o segundo filtro, este caso viraria remoção de acervo alheio.
    fazerSupabase();
    vi.mocked(createClient).mockResolvedValue({
      from: () => {
        const resolver = () => Promise.resolve({ data: null, error: null });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {
          select: () => chain,
          delete: () => chain,
          update: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: resolver,
          then: (ok: (v: unknown) => unknown) => resolver().then(ok),
        };
        return chain;
      },
    } as never);

    const res = await DELETE(remover(), rotaPropria);

    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("papel abaixo de gestor não remove (FR-032)", async () => {
    sessao(ORG_A, "agent");
    fazerSupabase(linhaPropria);

    const res = await DELETE(remover(), rotaPropria);

    expect(res.status).toBe(403);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("id fora do formato é 404 e não gasta orçamento", async () => {
    const res = await DELETE(remover("nao-e-uuid"), {
      params: Promise.resolve({ id: "nao-e-uuid" }),
    });
    expect(res.status).toBe(404);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("gasta o MESMO balde do PATCH — o teto é da escrita de escopo, não da rota", async () => {
    // Baldes separados por método deixariam o laço de remoção com orçamento próprio, e o
    // teto da trava 4 passaria a ser contornável alternando PATCH e DELETE.
    fazerSupabase(linhaPropria);
    await DELETE(remover(), rotaPropria);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(
      `${TETO_DE_ESCRITA.balde}:${ORG_A}`,
      TETO_DE_ESCRITA.limite,
      TETO_DE_ESCRITA.janelaSeg,
    );
  });
});
