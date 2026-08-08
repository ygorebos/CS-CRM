import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import {
  gravarEscopoDaConversa,
  type VinculoDeEscopo,
} from "@/lib/agent-engine/agent/escopo-do-contato";

/**
 * PATCH /api/v1/contacts/[id] — o caminho "cadastro" do vínculo cliente↔operadora
 * (spec 002, FR-017 · T089).
 *
 * O que estes testes vigiam não é "a rota aceita mais um campo". É a **precedência**:
 * FR-017 dá duas origens ao vínculo (a ficha e a conversa) e manda a ficha vencer. A
 * regra vive em dois arquivos por desenho — esta rota grava
 * `knowledge_scope_source = 'cadastro'`, e `gravarEscopoDaConversa` recusa rebaixar esse
 * valor. Um teste que só olhasse esta rota provaria metade e passaria verde com a outra
 * metade quebrada; por isso o caso central aqui chama a função do OUTRO lado com o
 * vínculo exatamente como a rota o deixou.
 *
 * O escopo de outra organização é o segundo eixo: `organization_id` sai da sessão
 * validada, nunca do corpo, e um id de operadora alheia não pode virar escrita.
 */

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const AMIL = "55555555-5555-4555-8555-555555555555";
const BRADESCO = "66666666-6666-4666-8666-666666666666";
/** Existe no banco, mas é de OUTRA organização — o caso que não pode virar escrita. */
const HAPVIDA_ALHEIA = "77777777-7777-4777-8777-777777777777";
/** Não existe em lugar nenhum. */
const INEXISTENTE = "88888888-8888-4888-8888-888888888888";

type Linha = Record<string, unknown>;
interface Escrita {
  tabela: string;
  patch: Linha;
  filtros: Array<[string, unknown]>;
}

function contatoRow(over: Linha = {}): Linha {
  return {
    id: CONTATO,
    organization_id: ORG_ID,
    name: "Joana",
    display_name: "Joana",
    email: null,
    email_normalized: null,
    phone_number: "+5511999998888",
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    last_activity_at: null,
    ...over,
  };
}

function escopoRow(id: string, organizationId = ORG_ID, displayName = "Amil"): Linha {
  return { id, organization_id: organizationId, display_name: displayName, is_active: true };
}

/**
 * Duplo do PostgREST: guarda linhas de verdade, respeita `.eq()` e registra cada
 * escrita com os filtros que a acompanharam — é por esses filtros que se prova que a
 * organização veio da sessão e não do corpo.
 */
function makeDb(fixtures: { contacts?: Linha[]; knowledge_scopes?: Linha[] } = {}) {
  const tabelas: Record<string, Linha[]> = {
    contacts: fixtures.contacts ?? [],
    knowledge_scopes: fixtures.knowledge_scopes ?? [],
  };
  const escritas: Escrita[] = [];

  function from(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    let patch: Linha | null = null;

    const resolver = (): Linha[] => {
      const achadas = (tabelas[tabela] ?? []).filter((r) =>
        filtros.every(([coluna, valor]) => r[coluna] === valor),
      );
      if (patch !== null) {
        escritas.push({ tabela, patch, filtros: [...filtros] });
        for (const linha of achadas) Object.assign(linha, patch);
      }
      return achadas;
    };

    const builder = {
      select: () => builder,
      eq: (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return builder;
      },
      is: () => builder,
      update: (p: Linha) => {
        patch = p;
        return builder;
      },
      maybeSingle: async () => ({ data: resolver()[0] ?? null, error: null }),
      single: async () => {
        const achadas = resolver();
        return achadas[0]
          ? { data: achadas[0], error: null }
          : { data: null, error: { message: "no rows" } };
      },
    };
    return builder;
  }

  return {
    cliente: { from, rpc: async () => ({ data: null, error: null }) },
    tabelas,
    escritas,
  };
}

function autorizado() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER_ID } as never,
    org: { orgId: ORG_ID, name: "Corretora", role: "manager" } as never,
  });
}

const ctx = (id = CONTATO) => ({ params: Promise.resolve({ id }) });

function reqPatch(body: unknown, id = CONTATO) {
  return new NextRequest(`http://localhost/api/v1/contacts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function patch(db: ReturnType<typeof makeDb>, body: unknown, id = CONTATO) {
  vi.mocked(createClient).mockResolvedValue(db.cliente as never);
  const { PATCH } = await import("./route");
  return PATCH(reqPatch(body, id), ctx(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  autorizado();
});

describe("PATCH /api/v1/contacts/[id] — vínculo pelo cadastro (FR-017)", () => {
  it("grava a operadora com origem 'cadastro'", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    const res = await patch(db, { knowledge_scope_id: AMIL });

    expect(res.status).toBe(200);
    const linha = db.tabelas.contacts![0]!;
    expect(linha.knowledge_scope_id).toBe(AMIL);
    // O vocabulário é o do CHECK do banco. Qualquer outro valor aqui é `23514` em produção.
    expect(linha.knowledge_scope_source).toBe("cadastro");
    expect(linha.knowledge_scope_confirmed_at).toEqual(expect.any(String));

    const body = (await res.json()) as {
      data: { knowledge_scope_id: string; knowledge_scope_source: string };
    };
    expect(body.data.knowledge_scope_id).toBe(AMIL);
    expect(body.data.knowledge_scope_source).toBe("cadastro");
  });

  /**
   * ⭐ O caso da tarefa: a inferência da conversa NÃO derruba o que veio do cadastro.
   *
   * Roda a rota de verdade e entrega o vínculo resultante à função que o agente usa
   * quando o cliente nomeia uma operadora na conversa. Se esta rota gravasse `'conversa'`
   * (ou nada), aquela função aceitaria a troca e este teste ficaria vermelho — que é
   * exatamente o defeito que FR-017 proíbe.
   */
  it("o que o cliente diz na conversa não derruba o vínculo do cadastro", async () => {
    const db = makeDb({
      contacts: [contatoRow()],
      knowledge_scopes: [escopoRow(AMIL), escopoRow(BRADESCO, ORG_ID, "Bradesco Saúde")],
    });
    expect((await patch(db, { knowledge_scope_id: AMIL })).status).toBe(200);

    const linha = db.tabelas.contacts![0]!;
    const vinculoGravadoPeloCadastro: VinculoDeEscopo = {
      scopeId: linha.knowledge_scope_id as string,
      displayName: "Amil",
      source: linha.knowledge_scope_source as VinculoDeEscopo["source"],
      confirmedAt: new Date(linha.knowledge_scope_confirmed_at as string),
    };

    const pool = { query: vi.fn() };
    const gravou = await gravarEscopoDaConversa(
      pool as never,
      ORG_ID,
      CONTATO,
      BRADESCO,
      vinculoGravadoPeloCadastro,
    );

    expect(gravou).toBe(false);
    // Nem chegou ao banco: a precedência é decidida antes do UPDATE, e de novo no `where`.
    expect(pool.query).not.toHaveBeenCalled();
    expect(linha.knowledge_scope_id).toBe(AMIL);
  });

  it("desvincular pelo cadastro também é decisão de cadastro — a origem continua 'cadastro'", async () => {
    const db = makeDb({
      contacts: [
        contatoRow({
          knowledge_scope_id: AMIL,
          knowledge_scope_source: "conversa",
          knowledge_scope_confirmed_at: "2026-08-02T10:00:00Z",
        }),
      ],
      knowledge_scopes: [escopoRow(AMIL)],
    });
    const res = await patch(db, { knowledge_scope_id: null });

    expect(res.status).toBe(200);
    const linha = db.tabelas.contacts![0]!;
    expect(linha.knowledge_scope_id).toBeNull();
    // "Sem operadora" não é lacuna a preencher: sem esta origem, a próxima conversa
    // gravaria por cima do que o corretor decidiu.
    expect(linha.knowledge_scope_source).toBe("cadastro");
  });

  it("operadora de outra organização → 404, e nada é escrito", async () => {
    const db = makeDb({
      contacts: [contatoRow()],
      knowledge_scopes: [
        escopoRow(AMIL),
        escopoRow(HAPVIDA_ALHEIA, OUTRA_ORG, "Hapvida da concorrente"),
      ],
    });
    const res = await patch(db, { knowledge_scope_id: HAPVIDA_ALHEIA });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/organização/i);
    expect(db.escritas).toEqual([]);
    expect(db.tabelas.contacts![0]!.knowledge_scope_id).toBeUndefined();
  });

  it("operadora inexistente → 404, e nada é escrito", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    const res = await patch(db, { knowledge_scope_id: INEXISTENTE });

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
  });

  it("organization_id no corpo é ignorado — a escrita usa a da sessão", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    await patch(db, { knowledge_scope_id: AMIL, organization_id: OUTRA_ORG });

    const escrita = db.escritas[0]!;
    expect(escrita.filtros).toContainEqual(["organization_id", ORG_ID]);
    expect(escrita.patch).not.toHaveProperty("organization_id");
    expect(db.tabelas.contacts![0]!.organization_id).toBe(ORG_ID);
  });

  it("knowledge_scope_id que não é UUID → 422, e nada é escrito", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    const res = await patch(db, { knowledge_scope_id: "amil" });

    expect(res.status).toBe(422);
    expect(db.escritas).toEqual([]);
  });

  it("contato anonimizado → 403 (LGPD), e nada é escrito", async () => {
    const db = makeDb({
      contacts: [contatoRow({ is_anonymized: true })],
      knowledge_scopes: [escopoRow(AMIL)],
    });
    const res = await patch(db, { knowledge_scope_id: AMIL });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("lgpd_anonymization_irreversible");
    expect(db.escritas).toEqual([]);
  });

  it("contato de outra organização → 404, e nada é escrito", async () => {
    const db = makeDb({
      contacts: [contatoRow({ organization_id: OUTRA_ORG })],
      knowledge_scopes: [escopoRow(AMIL)],
    });
    const res = await patch(db, { knowledge_scope_id: AMIL });

    expect(res.status).toBe(404);
    expect(db.escritas).toEqual([]);
  });

  it("sem auth → repassa a resposta, sem escrever", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401, {}),
    });
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    const res = await patch(db, { knowledge_scope_id: AMIL });

    expect(res.status).toBe(401);
    expect(db.escritas).toEqual([]);
  });

  it("audita a mutação do vínculo, dizendo quais campos mudaram", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    await patch(db, { knowledge_scope_id: AMIL });

    const entrada = vi
      .mocked(audit)
      .mock.calls.map(([e]) => e)
      .find((e) => (e.metadata?.fields as string[] | undefined)?.includes("knowledge_scope_id"));
    expect(entrada).toBeDefined();
    expect(entrada!.organizationId).toBe(ORG_ID);
    expect(entrada!.resourceId).toBe(CONTATO);
    expect(entrada!.metadata?.knowledge_scope_source).toBe("cadastro");
  });

  it("nome e operadora no mesmo corpo: os dois entram", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    const res = await patch(db, { name: "Joana Silva", knowledge_scope_id: AMIL });

    expect(res.status).toBe(200);
    const linha = db.tabelas.contacts![0]!;
    expect(linha.name).toBe("Joana Silva");
    expect(linha.knowledge_scope_id).toBe(AMIL);
    expect(linha.knowledge_scope_source).toBe("cadastro");
  });

  it("corpo vazio continua 400 — o campo novo não abriu porta para PATCH sem nada", async () => {
    const db = makeDb({ contacts: [contatoRow()], knowledge_scopes: [escopoRow(AMIL)] });
    const res = await patch(db, {});

    expect(res.status).toBe(400);
    expect(db.escritas).toEqual([]);
  });
});
