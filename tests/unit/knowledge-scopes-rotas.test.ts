/**
 * As rotas de `/api/v1/knowledge-scopes` (spec 002, T067/T087) — com o banco dublado.
 *
 * Estes testes vigiam três coisas que, se quebrarem, quebram em silêncio:
 *
 * 1. **A lista é UMA.** Espelho do catálogo e escopo próprio saem juntos, com `origin` em
 *    cada linha. Separá-los faria o corretor cadastrar a duplicata do que já veio pronto.
 * 2. **Ligar custa UM PATCH.** É o passo que SC-011 cronometra dentro do teto de 10
 *    minutos, e o corpo da resposta já traz o escopo projetado — a tela não precisa de um
 *    GET atrás para reidratar a linha.
 * 3. **A trava 4 deixa rastro.** Ligar/desligar tem ação de auditoria PRÓPRIA. Quem
 *    investigar "por que o agente parou de falar da Unimed" procura por isso, não por um
 *    `updated` genérico.
 *
 * O que NÃO está aqui, e por quê: isolamento entre organizações de verdade (é RLS, exige
 * `pnpm test:db`) e a prova pela tela (doutrina de QA Visual, spec Playwright de T068).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
// O teto de escrita entrou nestas rotas depois que este arquivo nasceu. Sem o mock, e
// com `UPSTASH_REDIS_REST_URL` no `.env.local`, cada execução gasta ~16 fichas de um
// balde REAL de 30/min: rodar duas vezes no mesmo minuto deixava o arquivo vermelho por
// motivo nenhum. No CI não aparecia (sem Upstash, o contador é de memória e reseta por
// arquivo) — falha que só existe na máquina de quem desenvolve é a pior de diagnosticar.
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, limit: 100, reset: 0 })),
}));

import { GET, POST } from "@/app/api/v1/knowledge-scopes/route";
import { PATCH } from "@/app/api/v1/knowledge-scopes/[id]/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const ESPELHO = "33333333-3333-4333-8333-333333333333";
const PROPRIO = "44444444-4444-4444-8444-444444444444";

function sessao(papel: Role) {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG, organization_name: "Corretora", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Corretora", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update";
  filtros: Record<string, unknown>;
  payload?: unknown;
}

type Responder = (c: Chamada) => { data: unknown; error: unknown };

/** Dublê do client de sessão: encadeia como o supabase-js e registra cada chamada. */
function fazerSupabase(responder: Responder) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, op: "select", filtros: {} };
    chamadas.push(chamada);
    const resolver = () => Promise.resolve(responder(chamada));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: (v: unknown) => {
        chamada.op = "insert";
        chamada.payload = v;
        return chain;
      },
      update: (v: unknown) => {
        chamada.op = "update";
        chamada.payload = v;
        return chain;
      },
      eq: (coluna: string, valor: unknown) => {
        chamada.filtros[coluna] = valor;
        return chain;
      },
      neq: () => chain,
      in: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      single: resolver,
      maybeSingle: resolver,
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        resolver().then(ok, err),
    };
    return chain;
  };
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return chamadas;
}

const linhaEspelho = {
  id: ESPELHO,
  organization_id: ORG,
  catalog_scope_id: "cs-unimed",
  display_name: "Unimed",
  official_code: "339679",
  is_active: false,
  created_at: "2026-08-08T10:00:00.000Z",
};

const linhaPropria = {
  id: PROPRIO,
  organization_id: ORG,
  catalog_scope_id: null,
  display_name: "Amil",
  official_code: null,
  is_active: true,
  created_at: "2026-08-08T11:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  sessao("manager");
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

describe("GET /api/v1/knowledge-scopes", () => {
  it("t1: espelho e próprio saem na MESMA lista, com origin explícito", async () => {
    fazerSupabase(({ tabela }) => {
      if (tabela === "knowledge_scopes") return { data: [linhaEspelho, linhaPropria], error: null };
      if (tabela === "ai_knowledge_sources") return { data: [{ scope_id: PROPRIO }], error: null };
      if (tabela === "catalog_materials") {
        return {
          data: [
            { catalog_scope_id: "cs-unimed", slug: "carencia" },
            { catalog_scope_id: "cs-unimed", slug: "carencia" },
            { catalog_scope_id: "cs-unimed", slug: "rede" },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    });

    const res = await GET(new NextRequest("http://localhost/api/v1/knowledge-scopes"));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: { id: string; origin: string; is_active: boolean; materials_count: number }[];
      meta: { has_more: boolean; cursor: string | null };
    };

    expect(corpo.data.map((e) => [e.id, e.origin])).toEqual([
      [ESPELHO, "catalogo"],
      [PROPRIO, "proprio"],
    ]);
    // O espelho do catálogo chega DESLIGADO (A-20) e já com material — é o estado que
    // FR-042 usa para dizer ao corretor que a resposta existe e está a um clique.
    expect(corpo.data[0]).toMatchObject({
      is_active: false,
      materials_count: 2,
      own_materials_count: 0,
    });
    expect(corpo.data[1]).toMatchObject({ is_active: true, own_materials_count: 1 });
    expect(corpo.meta.has_more).toBe(false);
  });

  it("t2: filtra organization_id explicitamente, além da RLS", async () => {
    const chamadas = fazerSupabase(() => ({ data: [], error: null }));
    await GET(new NextRequest("http://localhost/api/v1/knowledge-scopes"));
    expect(chamadas[0]).toMatchObject({
      tabela: "knowledge_scopes",
      filtros: { organization_id: ORG },
    });
  });

  it("t3: página cheia devolve cursor e has_more", async () => {
    fazerSupabase(({ tabela }) =>
      tabela === "knowledge_scopes"
        ? { data: [linhaEspelho, linhaPropria], error: null }
        : { data: [], error: null },
    );
    const res = await GET(new NextRequest("http://localhost/api/v1/knowledge-scopes?limit=1"));
    const corpo = (await res.json()) as { data: unknown[]; meta: { has_more: boolean; cursor: string } };
    expect(corpo.data).toHaveLength(1);
    expect(corpo.meta.has_more).toBe(true);
    expect(JSON.parse(Buffer.from(corpo.meta.cursor, "base64url").toString("utf8"))).toEqual({
      created_at: linhaEspelho.created_at,
      id: ESPELHO,
    });
  });

  it("t4: cursor forjado é 400, não 500", async () => {
    fazerSupabase(() => ({ data: [], error: null }));
    const res = await GET(
      new NextRequest("http://localhost/api/v1/knowledge-scopes?cursor=nao-e-cursor"),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
  });

  it("t5: viewer LÊ (a lista não é privilégio de gestor)", async () => {
    sessao("viewer");
    fazerSupabase(() => ({ data: [], error: null }));
    expect((await GET(new NextRequest("http://localhost/api/v1/knowledge-scopes"))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

function pedidoDeCriacao(corpo: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/v1/knowledge-scopes", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/v1/knowledge-scopes", () => {
  it("t6: cria escopo PRÓPRIO — sem catalog_scope_id no insert, ligado, e auditado", async () => {
    const chamadas = fazerSupabase(({ tabela, op }) => {
      if (tabela === "knowledge_scopes" && op === "select") return { data: [], error: null };
      if (tabela === "knowledge_scopes" && op === "insert") {
        return { data: { ...linhaPropria, display_name: "Hapvida" }, error: null };
      }
      return { data: null, error: null };
    });

    const res = await POST(pedidoDeCriacao({ display_name: "Hapvida" }));
    expect(res.status).toBe(201);
    const corpo = (await res.json()) as { data: { origin: string; materials_count: number } };
    expect(corpo.data.origin).toBe("proprio");
    expect(corpo.data.materials_count).toBe(0);

    const insert = chamadas.find((c) => c.op === "insert" && c.tabela === "knowledge_scopes");
    expect(insert?.payload).toEqual({
      organization_id: ORG,
      display_name: "Hapvida",
      official_code: null,
    });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "knowledge_scope.created", organizationId: ORG }),
    );
  });

  it("t7: 409 quando o nome colide com um ESPELHO do catálogo, e a mensagem manda LIGAR", async () => {
    fazerSupabase(({ tabela }) =>
      tabela === "knowledge_scopes"
        ? { data: [linhaEspelho], error: null }
        : { data: { settings: {} }, error: null },
    );

    const res = await POST(pedidoDeCriacao({ display_name: "  unimed  " }));
    expect(res.status).toBe(409);
    const erro = (await res.json()) as { error: { code: string; message: string } };
    expect(erro.error.code).toBe("escopo_ja_existe");
    // Dizer só "já existe" mandaria o corretor procurar uma linha que ele nem sabia que
    // estava lá: a mensagem tem de nomear o catálogo E o gesto que resolve.
    expect(erro.error.message).toMatch(/catálogo/i);
    expect(erro.error.message).toMatch(/interruptor/i);
    expect(erro.error.message).toContain("Unimed");
  });

  it("t7b: a mensagem usa o rótulo configurado e não concorda em gênero com ele", async () => {
    // "Operadora" é feminino; "Convênio" é masculino. Uma frase com "ligue-a"/"desligada"
    // vira erro de português na instalação de quem trocou o rótulo (FR-033/FR-041).
    fazerSupabase(({ tabela }) =>
      tabela === "knowledge_scopes"
        ? { data: [linhaEspelho], error: null }
        : { data: { settings: { knowledge_scope_label: "Convênio" } }, error: null },
    );
    const res = await POST(pedidoDeCriacao({ display_name: "Unimed" }));
    const { error } = (await res.json()) as { error: { message: string } };
    expect(error.message).toMatch(/^Convênio /);
    expect(error.message).not.toMatch(/-a\b|ligada|desligada|outra\b|esta operadora/i);
  });

  it("t8: organization_id no body é 422 — nunca fonte de tenancy", async () => {
    fazerSupabase(() => ({ data: [], error: null }));
    const res = await POST(pedidoDeCriacao({ display_name: "Amil", organization_id: "outra" }));
    expect(res.status).toBe(422);
  });

  it("t9: escrever exige manager (agent é recusado)", async () => {
    sessao("agent");
    fazerSupabase(() => ({ data: [], error: null }));
    expect((await POST(pedidoDeCriacao({ display_name: "Amil" }))).status).toBe(403);
  });

  it("t10: Idempotency-Key repetida devolve o mesmo escopo sem criar outro", async () => {
    const guardado = {
      request_hash: null as string | null,
      response_body: { id: PROPRIO, display_name: "Hapvida", origin: "proprio" },
    };
    // 1ª passada: grava a chave. 2ª: encontra-a e responde por ela.
    const chamadas = fazerSupabase(({ tabela, op, payload }) => {
      if (tabela === "idempotency_keys" && op === "select") {
        return { data: guardado.request_hash ? guardado : null, error: null };
      }
      if (tabela === "idempotency_keys" && op === "insert") {
        guardado.request_hash = (payload as { request_hash: string }).request_hash;
        return { data: null, error: null };
      }
      if (tabela === "knowledge_scopes" && op === "select") return { data: [], error: null };
      if (tabela === "knowledge_scopes" && op === "insert") {
        return { data: { ...linhaPropria, display_name: "Hapvida" }, error: null };
      }
      return { data: null, error: null };
    });

    const cabecalho = { "idempotency-key": "9f1c8b0e-0000-4000-8000-000000000001" };
    const primeira = await POST(pedidoDeCriacao({ display_name: "Hapvida" }, cabecalho));
    expect(primeira.status).toBe(201);
    expect(guardado.request_hash).toBeTruthy();

    const segunda = await POST(pedidoDeCriacao({ display_name: "Hapvida" }, cabecalho));
    expect(segunda.status).toBe(201);
    expect(chamadas.filter((c) => c.tabela === "knowledge_scopes" && c.op === "insert")).toHaveLength(
      1,
    );
  });

  it("t11: mesma chave com outro conteúdo é 409 idempotency_conflict", async () => {
    fazerSupabase(({ tabela, op }) =>
      tabela === "idempotency_keys" && op === "select"
        ? { data: { request_hash: "impressao-de-outro-pedido", response_body: {} }, error: null }
        : { data: [], error: null },
    );
    const res = await POST(
      pedidoDeCriacao({ display_name: "Hapvida" }, { "idempotency-key": "chave-1" }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_conflict",
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH — a trava 4
// ---------------------------------------------------------------------------

function pedidoDePatch(corpo: unknown) {
  return new NextRequest(`http://localhost/api/v1/knowledge-scopes/${ESPELHO}`, {
    method: "PATCH",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /api/v1/knowledge-scopes/{id}", () => {
  it("t12: ligar o espelho do catálogo custa UM update e já devolve o escopo projetado", async () => {
    let ligado = false;
    const chamadas = fazerSupabase(({ tabela, op }) => {
      if (tabela === "knowledge_scopes" && op === "select") {
        return { data: { ...linhaEspelho, is_active: ligado }, error: null };
      }
      if (tabela === "knowledge_scopes" && op === "update") {
        ligado = true;
        return { data: { ...linhaEspelho, is_active: true }, error: null };
      }
      if (tabela === "catalog_materials") {
        return { data: [{ catalog_scope_id: "cs-unimed", slug: "carencia" }], error: null };
      }
      return { data: [], error: null };
    });

    const res = await PATCH(pedidoDePatch({ is_active: true }), {
      params: Promise.resolve({ id: ESPELHO }),
    });

    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      data: { is_active: boolean; origin: string; materials_count: number };
    };
    // O corpo já é a linha da lista: a tela troca o item no lugar, sem um GET atrás.
    expect(corpo.data).toMatchObject({ is_active: true, origin: "catalogo", materials_count: 1 });
    expect(chamadas.filter((c) => c.op === "update")).toHaveLength(1);
    expect(chamadas.find((c) => c.op === "update")?.payload).toEqual({ is_active: true });
  });

  it("t13: ligar e desligar têm ação de auditoria PRÓPRIA (a trava 4 deixa rastro)", async () => {
    const responder = (ativoAntes: boolean, ativoDepois: boolean) =>
      fazerSupabase(({ tabela, op }) => {
        if (tabela === "knowledge_scopes" && op === "select") {
          return { data: { ...linhaEspelho, is_active: ativoAntes }, error: null };
        }
        if (tabela === "knowledge_scopes" && op === "update") {
          return { data: { ...linhaEspelho, is_active: ativoDepois }, error: null };
        }
        return { data: [], error: null };
      });

    responder(false, true);
    await PATCH(pedidoDePatch({ is_active: true }), { params: Promise.resolve({ id: ESPELHO }) });
    expect(vi.mocked(audit)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "knowledge_scope.activated",
        resourceType: "knowledge_scope",
        resourceId: ESPELHO,
      }),
    );

    responder(true, false);
    await PATCH(pedidoDePatch({ is_active: false }), { params: Promise.resolve({ id: ESPELHO }) });
    const ultima = vi.mocked(audit).mock.calls.at(-1)?.[0];
    expect(ultima?.action).toBe("knowledge_scope.deactivated");
    expect(ultima?.metadata).toMatchObject({
      origin: "catalogo",
      is_active_before: true,
      is_active_after: false,
    });
  });

  it("t14: renomear um espelho é permitido (é meia razão de knowledge_scopes existir)", async () => {
    let jaLeuOAlvo = false;
    const chamadas = fazerSupabase(({ tabela, op }) => {
      if (tabela === "knowledge_scopes" && op === "select") {
        if (!jaLeuOAlvo) {
          jaLeuOAlvo = true;
          return { data: linhaEspelho, error: null };
        }
        // 2ª leitura: os nomes já usados, para o 409 de rename.
        return { data: [], error: null };
      }
      if (tabela === "knowledge_scopes" && op === "update") {
        return { data: { ...linhaEspelho, display_name: "Unimed BH" }, error: null };
      }
      return { data: [], error: null };
    });
    const res = await PATCH(pedidoDePatch({ display_name: "Unimed BH" }), {
      params: Promise.resolve({ id: ESPELHO }),
    });
    expect(res.status).toBe(200);
    expect(chamadas.find((c) => c.op === "update")?.payload).toEqual({ display_name: "Unimed BH" });
    expect(vi.mocked(audit)).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "knowledge_scope.updated" }),
    );
  });

  it("t15: mexer no official_code de um ESPELHO é 403 escopo_do_catalogo_nao_editavel", async () => {
    const chamadas = fazerSupabase(({ tabela }) =>
      tabela === "knowledge_scopes"
        ? { data: linhaEspelho, error: null }
        : { data: { settings: {} }, error: null },
    );
    const res = await PATCH(pedidoDePatch({ official_code: "000000" }), {
      params: Promise.resolve({ id: ESPELHO }),
    });
    expect(res.status).toBe(403);
    const erro = (await res.json()) as { error: { code: string; details: { fields: string[] } } };
    expect(erro.error.code).toBe("escopo_do_catalogo_nao_editavel");
    expect(erro.error.details.fields).toEqual(["official_code"]);
    // Recusa ANTES de escrever: nada foi alterado.
    expect(chamadas.filter((c) => c.op === "update")).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("t16: o mesmo official_code num escopo PRÓPRIO passa — o dono é o corretor", async () => {
    fazerSupabase(({ tabela, op }) => {
      if (tabela === "knowledge_scopes" && op === "select") return { data: linhaPropria, error: null };
      if (tabela === "knowledge_scopes" && op === "update") {
        return { data: { ...linhaPropria, official_code: "000000" }, error: null };
      }
      return { data: [], error: null };
    });
    const res = await PATCH(pedidoDePatch({ official_code: "000000" }), {
      params: Promise.resolve({ id: PROPRIO }),
    });
    expect(res.status).toBe(200);
  });

  it("t17: escopo de outra organização é 404 (o filtro de org não devolve linha)", async () => {
    fazerSupabase(() => ({ data: null, error: null }));
    const res = await PATCH(pedidoDePatch({ is_active: true }), {
      params: Promise.resolve({ id: PROPRIO }),
    });
    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("t18: id fora do formato é 404, não 500 vindo do Postgres", async () => {
    const chamadas = fazerSupabase(() => ({ data: null, error: null }));
    const res = await PATCH(pedidoDePatch({ is_active: true }), {
      params: Promise.resolve({ id: "nao-e-uuid" }),
    });
    expect(res.status).toBe(404);
    expect(chamadas).toHaveLength(0);
  });

  it("t19: PATCH vazio é 422 — mutação sem mudança não vira auditoria", async () => {
    fazerSupabase(() => ({ data: linhaPropria, error: null }));
    const res = await PATCH(pedidoDePatch({}), { params: Promise.resolve({ id: PROPRIO }) });
    expect(res.status).toBe(422);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("t20: renomear para o nome de outro escopo é 409 (o 409 do POST não é contornável em dois passos)", async () => {
    let jaLeuOAlvo = false;
    fazerSupabase(({ tabela, op }) => {
      if (tabela === "knowledge_scopes" && op === "select") {
        if (!jaLeuOAlvo) {
          jaLeuOAlvo = true;
          return { data: linhaPropria, error: null };
        }
        return { data: [linhaEspelho], error: null };
      }
      return { data: { settings: {} }, error: null };
    });
    const res = await PATCH(pedidoDePatch({ display_name: "unimed" }), {
      params: Promise.resolve({ id: PROPRIO }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("escopo_ja_existe");
  });
});
