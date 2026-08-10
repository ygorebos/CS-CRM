/**
 * Superfície de plataforma do catálogo curado (spec 002, T063/T065).
 *
 * O que estes testes provam SEM banco:
 *  - trava 1: quem não é `is_platform_admin` não passa, nem para ler;
 *  - trava 6: editar material NUNCA emite UPDATE — emite INSERT de `version + 1`;
 *  - FR-037: a versão nova nasce `origin='local'` com `adopted_at`/`adopted_by`, que é o
 *    que faz a próxima semeada daquele slug nascer inerte;
 *  - `slug` é imutável na edição (é a chave da semeadura) e o corpo `strict` diz isso;
 *  - `checkRateLimit` é REALMENTE chamado, e o 429 sai com `Retry-After` + `X-RateLimit-*`.
 *
 * O que eles NÃO provam: RLS, o trigger de inércia da 0124 e o efeito na busca. Isso é
 * banco, e mora nos invariantes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { loadAuthUser } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MATERIAL_ID = "33333333-3333-4333-8333-333333333333";
const ESCOPO_ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// Dublê do client admin: registra a cadeia de chamadas por tabela
// ---------------------------------------------------------------------------

interface Op {
  metodo: string;
  args: unknown[];
}
interface Registro {
  tabela: string;
  ops: Op[];
}
interface Resposta {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
}

const METODOS = ["select", "insert", "update", "delete", "eq", "in", "gte", "lte", "order", "limit"];

function fabricarDb(filas: Record<string, Resposta[]>, registro: Registro[]) {
  return {
    from(tabela: string) {
      const reg: Registro = { tabela, ops: [] };
      registro.push(reg);
      const resolver = () => {
        const fila = filas[tabela] ?? [];
        const r = fila.shift() ?? {};
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
      };
      const b: Record<string, unknown> = {
        then: (ok: unknown, err: unknown) =>
          resolver().then(ok as never, err as never),
        single: resolver,
        maybeSingle: resolver,
      };
      for (const m of METODOS) {
        b[m] = (...args: unknown[]) => {
          reg.ops.push({ metodo: m, args });
          return b;
        };
      }
      return b;
    },
  };
}

function opsDe(registro: Registro[], tabela: string): Op[] {
  return registro.filter((r) => r.tabela === tabela).flatMap((r) => r.ops);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function usuario(platformAdmin: boolean): AuthUser {
  return {
    id: USER_ID,
    email: "curador@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: platformAdmin,
    organizations: [],
  };
}

function comCurador() {
  vi.mocked(loadAuthUser).mockResolvedValue(usuario(true));
}

function ctx(id = MATERIAL_ID) {
  return { params: Promise.resolve({ id }) };
}

const MATERIAL_BASE = {
  id: MATERIAL_ID,
  catalog_scope_id: ESCOPO_ID,
  applies_to_all: false,
  slug: "carencia-consulta-eletiva",
  version: 2,
  title: "Carência para consulta eletiva",
  body: "Texto antigo, com o erro.",
  valid_until: null,
  published_at: "2026-01-01T00:00:00.000Z",
  origin: "seed",
  inert: false,
  adopted_at: null,
  adopted_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: teto liberado. Cada teste que quer estourar sobrescreve.
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 30, window_sec: 60 });
});

// ---------------------------------------------------------------------------
// Trava 1 — só administrador de plataforma
// ---------------------------------------------------------------------------

describe("trava 1 — a superfície de catálogo é só de is_platform_admin", () => {
  it("sem sessão devolve 401 unauthenticated e não toca no banco", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(null);
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { GET } = await import("@/app/api/v1/catalog/scopes/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/scopes"));

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "unauthenticated" } });
    expect(registro).toHaveLength(0);
  });

  it("admin de ORGANIZAÇÃO (não de plataforma) leva 403 e a tentativa é auditada", async () => {
    const membro = usuario(false);
    membro.organizations = [
      { organization_id: "22222222-2222-4222-8222-222222222222", organization_name: "Corretora", role: "admin" },
    ];
    vi.mocked(loadAuthUser).mockResolvedValue(membro);
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { POST } = await import("@/app/api/v1/catalog/scopes/route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/catalog/scopes", {
        method: "POST",
        body: JSON.stringify({ slug: "unimed-nacional", display_name: "Unimed Nacional" }),
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(registro).toHaveLength(0);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "authz.denied", actorUserId: membro.id }),
    );
  });

  it("a guarda barra ANTES de gastar o teto — negado não consome cota", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue(usuario(false));
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, []) as never);

    const { GET } = await import("@/app/api/v1/catalog/materials/route");
    await GET(new NextRequest("http://localhost/api/v1/catalog/materials"));

    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rate limit — T063/T064 o cobram na própria rota
// ---------------------------------------------------------------------------

describe("teto de requisições", () => {
  it("chama checkRateLimit com balde por usuário", async () => {
    comCurador();
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({ catalog_scopes: [{ data: [] }] }, []) as never,
    );

    const { GET } = await import("@/app/api/v1/catalog/scopes/route");
    await GET(new NextRequest("http://localhost/api/v1/catalog/scopes"));

    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`catalog:read:${USER_ID}`, 120, 60);
  });

  it("estourado devolve 429 com Retry-After e X-RateLimit-*, sem tocar no banco", async () => {
    comCurador();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 31, limit: 30, window_sec: 60 });
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { PATCH } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/catalog/materials/${MATERIAL_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "Texto corrigido." }),
      }),
      ctx(),
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
    expect(registro).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Trava 6 — editar cria versão nova; nada é reescrito
// ---------------------------------------------------------------------------

describe("trava 6 — PATCH de material curado insere version + 1", () => {
  function filasDaEdicao(maiorVersao: number, nova: Record<string, unknown>) {
    return {
      catalog_materials: [
        { data: MATERIAL_BASE }, // leitura do material base
        { data: { version: maiorVersao } }, // maior versão do slug
        { data: nova }, // insert da versão nova
      ],
    };
  }

  it("não emite UPDATE, emite INSERT com version+1, origin local e adoção gravada", async () => {
    comCurador();
    const registro: Registro[] = [];
    const nova = { ...MATERIAL_BASE, id: "55555555-5555-4555-8555-555555555555", version: 4, origin: "local" };
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb(filasDaEdicao(3, nova), registro) as never);

    const { PATCH } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/catalog/materials/${MATERIAL_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ body: "Texto corrigido pelo curador." }),
      }),
      ctx(),
    );

    expect(res.status).toBe(201);

    const ops = opsDe(registro, "catalog_materials");
    expect(ops.some((o) => o.metodo === "update")).toBe(false);
    expect(ops.some((o) => o.metodo === "delete")).toBe(false);

    const insert = ops.find((o) => o.metodo === "insert");
    expect(insert).toBeDefined();
    const payload = insert!.args[0] as Record<string, unknown>;
    // A versão sai do TOPO da pilha do slug (3), não da linha aberta (2).
    expect(payload.version).toBe(4);
    expect(payload.slug).toBe(MATERIAL_BASE.slug);
    expect(payload.origin).toBe("local");
    expect(payload.inert).toBe(false);
    expect(payload.adopted_by).toBe(USER_ID);
    expect(typeof payload.adopted_at).toBe("string");
    // O eixo acompanha o material — trocar de operadora não é corrigir.
    expect(payload.catalog_scope_id).toBe(ESCOPO_ID);
    expect(payload.applies_to_all).toBe(false);
    // Campo não enviado é herdado, não zerado.
    expect(payload.title).toBe(MATERIAL_BASE.title);
    expect(payload.body).toBe("Texto corrigido pelo curador.");

    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data.replaces).toEqual({ id: MATERIAL_ID, version: 2 });
    // A versão nova ainda não tem trecho: a indexação não roda dentro do request.
    expect(corpo.data.chunks_count).toBe(0);

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "catalog.material_version_created",
        organizationId: null,
        actingAsPlatformAdmin: true,
      }),
    );
  });

  it("colisão em (slug, version) vira 409 state_conflict, não 500", async () => {
    comCurador();
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb(
        {
          catalog_materials: [
            { data: MATERIAL_BASE },
            { data: { version: 3 } },
            { data: null, error: { code: "23505", message: "duplicate key" } },
          ],
        },
        registro,
      ) as never,
    );

    const { PATCH } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/catalog/materials/${MATERIAL_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Outro título" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "state_conflict" } });
  });

  it("material inexistente devolve 404 e não insere nada", async () => {
    comCurador();
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({ catalog_materials: [{ data: null }] }, registro) as never,
    );

    const { PATCH } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/catalog/materials/${MATERIAL_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "Novo" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(404);
    expect(opsDe(registro, "catalog_materials").some((o) => o.metodo === "insert")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validação de entrada
// ---------------------------------------------------------------------------

describe("Zod na entrada", () => {
  it("PATCH com `slug` no corpo é recusado (a chave da semeadura não se edita)", async () => {
    comCurador();
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { PATCH } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/catalog/materials/${MATERIAL_ID}`, {
        method: "PATCH",
        body: JSON.stringify({ slug: "outro-slug", title: "Novo" }),
      }),
      ctx(),
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(registro).toHaveLength(0);
  });

  it("PATCH com corpo vazio é recusado em vez de virar UPDATE sem colunas", async () => {
    comCurador();
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, []) as never);

    const { PATCH } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/catalog/materials/${MATERIAL_ID}`, {
        method: "PATCH",
        body: JSON.stringify({}),
      }),
      ctx(),
    );

    expect(res.status).toBe(422);
  });

  it("id fora do formato UUID não chega ao banco", async () => {
    comCurador();
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { GET } = await import("@/app/api/v1/catalog/materials/[id]/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/materials/nao-e-uuid"), ctx("nao-e-uuid"));

    expect(res.status).toBe(400);
    expect(registro).toHaveLength(0);
  });

  it("slug de escopo com espaço/maiúscula é recusado — a semeadura depende do formato", async () => {
    comCurador();
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { POST } = await import("@/app/api/v1/catalog/scopes/route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/catalog/scopes", {
        method: "POST",
        body: JSON.stringify({ slug: "Unimed Nacional", display_name: "Unimed Nacional" }),
      }),
    );

    expect(res.status).toBe(422);
    expect(registro).toHaveLength(0);
  });

  it("slug de escopo já existente vira 409 escopo_ja_existe", async () => {
    comCurador();
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb(
        { catalog_scopes: [{ data: null, error: { code: "23505", message: "duplicate key" } }] },
        [],
      ) as never,
    );

    const { POST } = await import("@/app/api/v1/catalog/scopes/route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/catalog/scopes", {
        method: "POST",
        body: JSON.stringify({ slug: "unimed-nacional", display_name: "Unimed Nacional" }),
      }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "escopo_ja_existe" } });
  });

  it("POST de material com slug já usado manda editar em vez de criar versão por outra porta", async () => {
    comCurador();
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb(
        {
          catalog_scopes: [{ data: { id: ESCOPO_ID, slug: "unimed-nacional" } }],
          catalog_materials: [{ data: { version: 2 } }],
        },
        [],
      ) as never,
    );

    const { POST } = await import("@/app/api/v1/catalog/scopes/[id]/materials/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/v1/catalog/scopes/${ESCOPO_ID}/materials`, {
        method: "POST",
        body: JSON.stringify({ slug: "carencia-consulta-eletiva", title: "Carência", body: "Texto." }),
      }),
      ctx(ESCOPO_ID),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "state_conflict" } });
  });

  it("material 'vale para todos' exige applies_to_all explícito (FR-001)", async () => {
    comCurador();
    const registro: Registro[] = [];
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}, registro) as never);

    const { POST } = await import("@/app/api/v1/catalog/materials/route");
    const res = await POST(
      new NextRequest("http://localhost/api/v1/catalog/materials", {
        method: "POST",
        body: JSON.stringify({ slug: "regra-geral", title: "Regra geral", body: "Texto." }),
      }),
    );

    expect(res.status).toBe(422);
    expect(registro).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Projeção da resposta
// ---------------------------------------------------------------------------

describe("forma da resposta", () => {
  it("a lista de materiais não devolve o corpo do material nem embedding", async () => {
    comCurador();
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({ catalog_materials: [{ data: [MATERIAL_BASE] }] }, []) as never,
    );

    const { GET } = await import("@/app/api/v1/catalog/materials/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/materials"));
    const corpo = (await res.json()) as { data: Array<Record<string, unknown>>; meta: Record<string, unknown> };

    expect(res.status).toBe(200);
    const primeiro = corpo.data[0]!;
    expect(primeiro).not.toHaveProperty("body");
    expect(primeiro).not.toHaveProperty("embedding");
    expect(primeiro.body_chars).toBe(MATERIAL_BASE.body.length);
    // FR-037: a versão inerte precisa APARECER para poder ser aceita.
    expect(primeiro).toHaveProperty("inert");
    expect(corpo.meta).toMatchObject({ has_more: false });
  });
});
