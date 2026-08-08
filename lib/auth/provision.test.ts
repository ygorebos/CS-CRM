import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { ensureTenantForUser } from "./provision";

/**
 * O tenant recém-provisionado enxerga o catálogo curado (T056).
 *
 * ## O buraco que estes casos vigiam
 *
 * O catálogo é semeado no `baseline.sql`, e o bloco de semeadura termina chamando
 * `fn_sincronizar_escopos_do_catalogo` para **as organizações que existiam naquele
 * momento** (T055). Toda organização criada DEPOIS — que é toda organização de usuário
 * self-service, sem exceção — nasceria sem espelho nenhum.
 *
 * O sintoma não é um erro: é a tela de Operadoras **vazia**, numa instalação que tem
 * catálogo. O corretor conclui que o produto não sabe nada, quando ele sabe e ninguém
 * ligou o fio. É o mesmo modo de falha que FR-042 existe para evitar um passo adiante,
 * e aqui ele apareceria antes, na primeira tela.
 */

const USER = { id: "44444444-0000-4000-8000-000000000004", email: "corretora@exemplo.com" };
const ORG = "11111111-0000-4000-8000-000000000001";

type Cenario = {
  /** Membership já existente — quando presente, a função não provisiona nada. */
  membership?: { organization_id: string } | null;
  /** Erro devolvido pela sincronização do catálogo. */
  erroDeSync?: { message: string } | null;
};

function stubAdmin(c: Cenario) {
  const rpc = vi.fn(async () => ({ data: null, error: c.erroDeSync ?? null }));
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "is", "not", "order", "limit", "insert", "update"]) {
      chain[m] = vi.fn(self);
    }
    chain["maybeSingle"] = vi.fn(async () => ({
      data: table === "user_organizations" ? (c.membership ?? null) : null,
      error: null,
    }));
    chain["single"] = vi.fn(async () => ({ data: { id: ORG, slug: "exemplo" }, error: null }));
    chain["then"] = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null });
    return chain;
  };
  return { client: { from, rpc } as unknown as SupabaseClient, rpc };
}

describe("provisionamento do tenant · espelhos do catálogo (T056)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("organização nova sincroniza os escopos do catálogo, com o id dela", async () => {
    const { client, rpc } = stubAdmin({});
    vi.mocked(createAdminClient).mockReturnValue(client);

    const r = await ensureTenantForUser(USER);

    expect(r.provisioned).toBe(true);
    expect(rpc).toHaveBeenCalledWith("fn_sincronizar_escopos_do_catalogo", {
      p_organization_id: ORG,
    });
  });

  it("a sincronização falhar NÃO impede o cadastro — mas não vira silêncio", async () => {
    // O usuário entrar no produto vale mais que a lista de operadoras vir preenchida no
    // primeiro segundo: os espelhos nascem inativos de qualquer forma (A-20), e quem
    // não consegue entrar não liga escopo nenhum. Mas falha muda tem de aparecer —
    // Princípio II: falta de funcionamento não vira `return` mudo.
    const { client } = stubAdmin({ erroDeSync: { message: "deadlock detected" } });
    vi.mocked(createAdminClient).mockReturnValue(client);

    const r = await ensureTenantForUser(USER);

    expect(r.provisioned).toBe(true);
    expect(r.organizationId).toBe(ORG);
    const acoes = vi.mocked(audit).mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(acoes).toContain("tenant.catalog_sync_failed");
  });

  it("usuário que já tem organização não dispara sincronização — a idempotência é preservada", async () => {
    const { client, rpc } = stubAdmin({ membership: { organization_id: ORG } });
    vi.mocked(createAdminClient).mockReturnValue(client);

    const r = await ensureTenantForUser(USER);

    expect(r.provisioned).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
