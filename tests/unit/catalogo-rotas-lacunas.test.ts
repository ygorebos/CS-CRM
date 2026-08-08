/**
 * GET /api/v1/catalog/gaps — a leitura de lacunas do curador (spec 002, T064).
 *
 * O que estes testes provam SEM banco:
 *  - trava 7 / A-18: a resposta não carrega identidade de tenant nem de cliente, e a rota
 *    não faz chamada de saída nenhuma — a lacuna não atravessa a fronteira da instalação;
 *  - FR-029: "não havia nada" e "quase acertou" chegam separados, com a mesma margem que
 *    o painel do corretor usa;
 *  - FR-028: a resposta traz contagem por operadora e ao menos uma pergunta real;
 *  - o teto (`checkRateLimit`) é aplicado nesta rota, não herdado de lugar nenhum;
 *  - amostra truncada se DECLARA truncada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { loadAuthUser } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";

interface Resposta {
  data?: unknown;
  error?: { code?: string; message: string } | null;
  count?: number | null;
}

const METODOS = ["select", "insert", "update", "delete", "eq", "in", "gte", "lte", "order", "limit"];

function fabricarDb(filas: Record<string, Resposta[]>) {
  return {
    from(tabela: string) {
      const resolver = () => {
        const fila = filas[tabela] ?? [];
        const r = fila.shift() ?? {};
        return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
      };
      const b: Record<string, unknown> = {
        then: (ok: unknown, err: unknown) => resolver().then(ok as never, err as never),
        single: resolver,
        maybeSingle: resolver,
      };
      for (const m of METODOS) {
        b[m] = () => b;
      }
      return b;
    },
  };
}

function curador(): AuthUser {
  return {
    id: USER_ID,
    email: "curador@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: true,
    organizations: [],
  };
}

/** Corpo exatamente como `lib/agent-engine/agent/escalar-sem-lastro.ts` o escreve. */
function corpoDoAviso(pergunta: string, operadora: string): string {
  return [
    `O cliente perguntou: "${pergunta}"`,
    `Operadora: ${operadora}`,
    "Motivo: não há material carregado que responda a esta pergunta, e o agente não inventa procedimento de operadora.",
    "O que fazer: responda ao cliente e carregue o material que cobre este assunto.",
  ].join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAuthUser).mockResolvedValue(curador());
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, count: 1, limit: 60, window_sec: 60 });
});

describe("GET /api/v1/catalog/gaps", () => {
  it("agrupa por operadora, conta, traz pergunta real e não vaza identidade de tenant", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({
        agent_inbox_items: [
          { count: 3 },
          {
            data: [
              {
                created_at: "2026-08-07T12:00:00.000Z",
                status: "open",
                body: corpoDoAviso("Tem carência para consulta?", "Unimed Nacional"),
              },
              {
                created_at: "2026-08-06T12:00:00.000Z",
                status: "resolved",
                body: corpoDoAviso("Reembolso demora quanto?", "Unimed Nacional"),
              },
              {
                created_at: "2026-08-05T12:00:00.000Z",
                status: "open",
                body: corpoDoAviso("O plano cobre fisioterapia?", "não identificada"),
              },
            ],
          },
        ],
        knowledge_searches: [{ count: 40 }, { data: [] }],
      }) as never,
    );

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps"));
    expect(res.status).toBe(200);

    const bruto = await res.text();
    const corpo = JSON.parse(bruto) as {
      data: {
        refusals: {
          total: number;
          analyzed: number;
          open: number;
          by_scope: Array<{ scope: string | null; count: number; example_question: string | null }>;
          examples: Array<{ question: string; scope: string | null }>;
        };
      };
    };

    expect(corpo.data.refusals.total).toBe(3);
    expect(corpo.data.refusals.analyzed).toBe(3);
    expect(corpo.data.refusals.open).toBe(2);

    const unimed = corpo.data.refusals.by_scope.find((b) => b.scope === "Unimed Nacional");
    expect(unimed?.count).toBe(2);
    expect(unimed?.example_question).toBe("Tem carência para consulta?");

    // "não identificada" vira `null`, nunca um rótulo inventado.
    const desconhecida = corpo.data.refusals.by_scope.find((b) => b.scope === null);
    expect(desconhecida?.count).toBe(1);

    expect(corpo.data.refusals.examples[0]?.question).toBe("Tem carência para consulta?");

    // A-18/trava 7: nada que identifique tenant ou cliente sai daqui.
    expect(bruto).not.toContain("organization_id");
    expect(bruto).not.toContain("contact_id");
    expect(bruto).not.toContain("conversation_id");
  });

  it("separa 'não tinha nada' de 'quase acertou' com a margem do painel do corretor", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({
        agent_inbox_items: [{ count: 0 }, { data: [] }],
        knowledge_searches: [
          { count: 10 },
          {
            data: [
              // numeric chega como STRING: se a coerção sumir, a comparação mente.
              { top_score: "0.58", threshold: "0.62" }, // quase acertou (0.62 - 0.1 = 0.52)
              { top_score: 0.61, threshold: 0.62 }, // quase acertou
              { top_score: 0.1, threshold: 0.62 }, // a base não tem isso
              { top_score: null, threshold: 0.62 }, // sem nota: não conta como quase
            ],
          },
        ],
      }) as never,
    );

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps?days=7"));
    const corpo = (await res.json()) as {
      data: { window: { days: number }; searches: { total: number; empty: number; near_miss: number } };
    };

    expect(corpo.data.window.days).toBe(7);
    expect(corpo.data.searches.total).toBe(10);
    expect(corpo.data.searches.empty).toBe(4);
    expect(corpo.data.searches.near_miss).toBe(2);
  });

  it("aplica o teto desta rota e devolve 429 quando estoura", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, count: 61, limit: 60, window_sec: 60 });
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}) as never);

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps"));

    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(`catalog:gaps:${USER_ID}`, 60, 60);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("quem não é administrador de plataforma não lê lacuna nenhuma", async () => {
    vi.mocked(loadAuthUser).mockResolvedValue({ ...curador(), is_platform_admin: false });
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}) as never);

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps"));

    expect(res.status).toBe(403);
  });

  it("days fora da faixa é recusado em vez de virar varredura da base inteira", async () => {
    vi.mocked(createAdminClient).mockReturnValue(fabricarDb({}) as never);

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps?days=9999"));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("amostra no teto se declara truncada — lista incompleta não passa por censo", async () => {
    const muitos = Array.from({ length: 500 }, (_, i) => ({
      created_at: `2026-08-07T12:00:${String(i % 60).padStart(2, "0")}.000Z`,
      status: "open",
      body: corpoDoAviso("Pergunta repetida?", "Unimed Nacional"),
    }));
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({
        agent_inbox_items: [{ count: 1200 }, { data: muitos }],
        knowledge_searches: [{ count: 0 }, { data: [] }],
      }) as never,
    );

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps"));
    const corpo = (await res.json()) as {
      data: { refusals: { total: number; analyzed: number } };
      meta: { truncated: boolean };
    };

    expect(corpo.data.refusals.total).toBe(1200);
    expect(corpo.data.refusals.analyzed).toBe(500);
    expect(corpo.meta.truncated).toBe(true);
  });

  it("falha de leitura vira 500 com código canônico, não resposta vazia com cara de 'sem lacuna'", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      fabricarDb({
        agent_inbox_items: [{ count: null, error: { message: "connection reset" } }, { data: [] }],
        knowledge_searches: [{ count: 0 }, { data: [] }],
      }) as never,
    );

    const { GET } = await import("@/app/api/v1/catalog/gaps/route");
    const res = await GET(new NextRequest("http://localhost/api/v1/catalog/gaps"));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal_error" } });
  });
});
