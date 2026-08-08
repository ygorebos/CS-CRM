/**
 * Migrar e voltar UM canal, com trilha (spec 004, T051/T053 / FR-041, FR-043).
 *
 * ## O que estava faltando
 *
 * `channel_sessions.ingest_path` é por conexão desde a migration 0119 — a coluna
 * existe justamente para a virada ser gradual. O que não existia era o **jeito
 * de virá-la**: só `UPDATE` na mão. E mudança de canal aplicada direto no banco
 * não deixa autoria, não deixa data e não aparece para ninguém. Num banco único
 * compartilhado, é a diferença entre "o Fulano migrou a conexão às 14h" e "as
 * mensagens pararam e ninguém sabe por quê".
 *
 * ## O que se cobra aqui
 *
 * Que a virada seja **por canal** (as outras conexões não são tocadas), que ela
 * seja **reversível** pela mesma porta, que **recuse migrar canal sem endereço
 * no gateway** — o que o deixaria mudo —, e que **deixe trilha nos dois
 * sentidos**.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { createClient } from "@/lib/supabase/server";
import type { AuthUser, Role } from "@/lib/auth/types";

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";

interface LinhaFalsa {
  ingest_path: string;
  gateway_connection_id: string | null;
  archived_at?: string | null;
}

/** Guarda o que foi atualizado E com que filtro — o filtro é metade do teste. */
const atualizacoes: { corpo: Record<string, unknown>; filtros: Record<string, string> }[] = [];

function supabaseCom(linha: LinhaFalsa | null) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: linha && { id: CANAL, ...linha }, error: null }) }),
        }),
      }),
      update: (corpo: Record<string, unknown>) => {
        const filtros: Record<string, string> = {};
        const cadeia = {
          eq: (col: string, val: string) => {
            filtros[col] = val;
            return cadeia;
          },
          then: (res: (v: { error: null }) => unknown) => {
            atualizacoes.push({ corpo, filtros });
            return Promise.resolve({ error: null }).then(res);
          },
        };
        return cadeia;
      },
    }),
    rpc: async (fn: string) =>
      fn === "fn_user_role_in_org" ? { data: "admin" as Role, error: null } : { data: null, error: null },
  };
}

function sessao(linha: LinhaFalsa | null) {
  const user: AuthUser = {
    id: USER,
    email: "dono@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: "admin" }],
  };
  vi.mocked(loadAuthUser).mockResolvedValue(user);
  vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG, name: "Org", role: "admin" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createClient).mockResolvedValue(supabaseCom(linha) as any);
}

const pedido = (path: string) =>
  new NextRequest(`http://localhost/api/v1/channel-sessions/${CANAL}/ingest-path`, {
    method: "PATCH",
    body: JSON.stringify({ path }),
  });
const params = { params: Promise.resolve({ id: CANAL }) };

beforeEach(() => {
  vi.clearAllMocks();
  atualizacoes.length = 0;
});

describe("virar a chave de UM canal (FR-041)", () => {
  it("migrar grava o caminho novo, e SÓ nesta conexão", async () => {
    sessao({ ingest_path: "legacy", gateway_connection_id: "conn-1" });
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/ingest-path/route");
    const res = await PATCH(pedido("gateway"), params);

    expect(res.status).toBe(200);
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]!.corpo).toEqual({ ingest_path: "gateway" });
    // O filtro é metade do teste: sem o `id`, a virada de uma conexão levaria
    // junto todas as outras da organização — que é exatamente o oposto de
    // "migrar sem tocar nos demais".
    expect(atualizacoes[0]!.filtros).toMatchObject({ organization_id: ORG, id: CANAL });
  });

  it("voltar usa a MESMA porta — reversível, não caminho só de ida", async () => {
    sessao({ ingest_path: "gateway", gateway_connection_id: "conn-1" });
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/ingest-path/route");
    const res = await PATCH(pedido("legacy"), params);

    expect(res.status).toBe(200);
    expect(atualizacoes[0]!.corpo).toEqual({ ingest_path: "legacy" });
  });

  it("migrar canal SEM endereço no gateway é recusado — ele ficaria mudo", async () => {
    // A rota de recebimento não teria como reconhecê-lo, e nenhuma mensagem
    // entraria por caminho nenhum. Erro legível > canal que para de receber sem
    // ninguém entender.
    sessao({ ingest_path: "legacy", gateway_connection_id: null });
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/ingest-path/route");
    const res = await PATCH(pedido("gateway"), params);

    expect(res.status).toBe(422);
    expect(atualizacoes).toHaveLength(0);
  });

  it("pedir o caminho em que já está não escreve nem audita", async () => {
    // Auditar uma mudança que não houve encheria a trilha de linhas idênticas —
    // e é justamente a trilha que alguém vai ler para descobrir QUANDO a virada
    // aconteceu.
    sessao({ ingest_path: "gateway", gateway_connection_id: "conn-1" });
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/ingest-path/route");
    const res = await PATCH(pedido("gateway"), params);

    expect(res.status).toBe(200);
    expect(atualizacoes).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("a trilha da mudança de canal (FR-043)", () => {
  it("migrar e reverter são ações DISTINTAS, e levam o antes junto", async () => {
    const { PATCH } = await import("@/app/api/v1/channel-sessions/[id]/ingest-path/route");

    sessao({ ingest_path: "legacy", gateway_connection_id: "conn-1" });
    await PATCH(pedido("gateway"), params);
    sessao({ ingest_path: "gateway", gateway_connection_id: "conn-1" });
    await PATCH(pedido("legacy"), params);

    const acoes = vi.mocked(audit).mock.calls.map(([e]) => e.action);
    // Duas ações e não uma com campo: a pergunta que se faz num incidente é
    // "alguém migrou algo hoje?", e ela tem de ser respondível filtrando a ação
    // — não lendo o metadata de cada linha.
    expect(acoes).toEqual(["channel.migrated", "channel.reverted"]);

    const primeira = vi.mocked(audit).mock.calls[0]![0];
    expect(primeira.actorUserId).toBe(USER);
    expect(primeira.resourceId).toBe(CANAL);
    // Saber o destino sem a origem não responde "o que mudou?".
    expect(primeira.metadata).toMatchObject({ de: "legacy", para: "gateway" });
  });
});
