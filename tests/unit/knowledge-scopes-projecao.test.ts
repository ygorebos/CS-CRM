/**
 * As peças puras de `/api/v1/knowledge-scopes` (spec 002, T067).
 *
 * O que estes testes prendem, e por que cada um existe:
 *
 * - **`origin`** é o campo que FR-039 exige. Ele não é digitado por ninguém: é derivado de
 *   `catalog_scope_id`. Inverter essa derivação faria a tela dizer ao corretor que o
 *   catálogo é material dele — e ele iria "corrigir" o que não é dele corrigir, ou cobrar
 *   correção de quem não pode fazê-la. Nada quebraria; só ficaria errado.
 * - **A contagem** some no meio da tela se contar linha em vez de material: catálogo é
 *   versionado (trava 6) e uma operadora de 3 materiais corrigida cinco vezes apareceria
 *   com 8.
 * - **O 409 de nome** só serve se dobrar acento e caixa. Comparação exata deixa "Amil
 *   Saúde" e "amil saude" conviverem como duas operadoras, com acervos separados, e isso
 *   ninguém diagnostica olhando a lista.
 * - **`strictObject`** é o que faz `organization_id` no body ser 422 em vez de ser ignorado
 *   em silêncio (Princípio I).
 */
import { describe, expect, it } from "vitest";

import {
  ORIGEM,
  acharColisaoDeNome,
  atualizarEscopoSchema,
  camposBloqueadosNoEspelho,
  codificarCursor,
  contarMateriais,
  criarEscopoSchema,
  decodificarCursor,
  impressaoDoPedido,
  nomeComparavel,
  projetarEscopo,
  queryDaListaSchema,
  type LinhaDeEscopo,
} from "@/app/api/v1/knowledge-scopes/_escopos";

const ORG = "22222222-2222-4222-8222-222222222222";

function linha(over: Partial<LinhaDeEscopo> = {}): LinhaDeEscopo {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organization_id: ORG,
    catalog_scope_id: null,
    display_name: "Amil",
    official_code: null,
    is_active: true,
    created_at: "2026-08-08T10:00:00.000Z",
    ...over,
  };
}

describe("projeção do escopo", () => {
  it("t1: catalog_scope_id preenchido vira origin=catalogo; nulo vira origin=proprio", () => {
    expect(projetarEscopo(linha({ catalog_scope_id: "cs-1" })).origin).toBe(ORIGEM.catalogo);
    expect(projetarEscopo(linha({ catalog_scope_id: null })).origin).toBe(ORIGEM.proprio);
  });

  it("t2: a costura interna (catalog_scope_id, organization_id) não sai no corpo", () => {
    const saida = projetarEscopo(linha({ catalog_scope_id: "cs-1" }));
    expect(Object.keys(saida).sort()).toEqual([
      "display_name",
      "id",
      "is_active",
      "materials_count",
      "official_code",
      "origin",
      "own_materials_count",
    ]);
  });

  it("t3: materials_count soma as duas camadas; own_materials_count só a do corretor", () => {
    const saida = projetarEscopo(linha({ catalog_scope_id: "cs-1" }), {
      proprios: 1,
      catalogo: 3,
    });
    expect(saida.materials_count).toBe(4);
    expect(saida.own_materials_count).toBe(1);
  });

  it("t4: escopo sem contagem informada não inventa material", () => {
    const saida = projetarEscopo(linha());
    expect(saida.materials_count).toBe(0);
    expect(saida.own_materials_count).toBe(0);
  });
});

describe("nome comparável (o 409 de FR-002)", () => {
  it("t5: dobra caixa, acento e espaço repetido", () => {
    expect(nomeComparavel("  Amil   Saúde ")).toBe("amil saude");
    expect(nomeComparavel("AMIL SAUDE")).toBe(nomeComparavel("amil saúde"));
  });

  it("t6: acha a colisão contra ESPELHO do catálogo, não só contra escopo próprio", () => {
    const existentes = [
      { id: "a", display_name: "Unimed", catalog_scope_id: "cs-9" },
      { id: "b", display_name: "Porto", catalog_scope_id: null },
    ];
    expect(acharColisaoDeNome(existentes, "unimed")?.id).toBe("a");
    expect(acharColisaoDeNome(existentes, "PORTO")?.id).toBe("b");
    expect(acharColisaoDeNome(existentes, "Bradesco")).toBeNull();
  });
});

describe("o que um espelho do catálogo aceita", () => {
  it("t7: ligar/desligar e renomear passam; official_code é o que dispara o 403", () => {
    expect(camposBloqueadosNoEspelho(["is_active"])).toEqual([]);
    expect(camposBloqueadosNoEspelho(["display_name", "is_active"])).toEqual([]);
    expect(camposBloqueadosNoEspelho(["official_code"])).toEqual(["official_code"]);
    expect(camposBloqueadosNoEspelho(["display_name", "official_code"])).toEqual(["official_code"]);
  });
});

describe("cursor", () => {
  it("t8: ida e volta preserva o par de ordenação", () => {
    const c = { created_at: "2026-08-08T10:00:00.000Z", id: "abc" };
    expect(decodificarCursor(codificarCursor(c))).toEqual(c);
  });

  it("t9: cursor forjado ou truncado devolve null (a rota responde 400, não 500)", () => {
    expect(decodificarCursor("nao-e-base64-de-json")).toBeNull();
    expect(decodificarCursor(Buffer.from('{"id":1}', "utf8").toString("base64url"))).toBeNull();
  });
});

describe("schemas", () => {
  it("t10: criar exige só o nome — official_code é opcional (FR-002)", () => {
    expect(criarEscopoSchema.safeParse({ display_name: "Amil" }).success).toBe(true);
    expect(criarEscopoSchema.safeParse({ display_name: "  " }).success).toBe(false);
  });

  it("t11: organization_id e catalog_scope_id no body são REJEITADOS, não ignorados", () => {
    expect(criarEscopoSchema.safeParse({ display_name: "Amil", organization_id: ORG }).success).toBe(
      false,
    );
    expect(
      criarEscopoSchema.safeParse({ display_name: "Amil", catalog_scope_id: "cs-1" }).success,
    ).toBe(false);
  });

  it("t12: PATCH vazio é recusado — mutação sem mudança não é mutação", () => {
    expect(atualizarEscopoSchema.safeParse({}).success).toBe(false);
    expect(atualizarEscopoSchema.safeParse({ is_active: false }).success).toBe(true);
  });

  it("t13: a query da lista tem teto — limit absurdo não vira varredura", () => {
    expect(queryDaListaSchema.parse({}).limit).toBe(100);
    expect(queryDaListaSchema.parse({ limit: "5" }).limit).toBe(5);
    expect(queryDaListaSchema.safeParse({ limit: "100000" }).success).toBe(false);
  });

  it("t14: a impressão do pedido separa corpos diferentes e iguala repetição", () => {
    const a = criarEscopoSchema.parse({ display_name: "Amil" });
    const b = criarEscopoSchema.parse({ display_name: "Amil", official_code: null });
    const c = criarEscopoSchema.parse({ display_name: "Unimed" });
    expect(impressaoDoPedido(a)).toBe(impressaoDoPedido(b));
    expect(impressaoDoPedido(a)).not.toBe(impressaoDoPedido(c));
  });
});

// ---------------------------------------------------------------------------
// contagem
// ---------------------------------------------------------------------------

/** Dublê mínimo: devolve por tabela, e registra o que foi consultado. */
function clienteDeLeitura(porTabela: Record<string, unknown[]>) {
  const tabelasConsultadas: string[] = [];
  const from = (tabela: string) => {
    tabelasConsultadas.push(tabela);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: porTabela[tabela] ?? [], error: null }).then(res),
    };
    return chain;
  };
  return { cliente: { from }, tabelasConsultadas };
}

describe("contagem de materiais", () => {
  const espelho = linha({ id: "esc-cat", catalog_scope_id: "cs-1", display_name: "Unimed" });
  const proprio = linha({ id: "esc-loc", catalog_scope_id: null, display_name: "Amil" });

  it("t15: conta o próprio pelo escopo e o curado por slug distinto (versão não infla)", async () => {
    const { cliente } = clienteDeLeitura({
      ai_knowledge_sources: [
        { scope_id: "esc-loc" },
        { scope_id: "esc-loc" },
        { scope_id: "esc-cat" },
      ],
      catalog_materials: [
        { catalog_scope_id: "cs-1", slug: "carencia" },
        { catalog_scope_id: "cs-1", slug: "carencia" }, // version 2 do MESMO material
        { catalog_scope_id: "cs-1", slug: "reembolso" },
      ],
    });

    const contagens = await contarMateriais(cliente, ORG, [espelho, proprio]);
    expect(contagens.get("esc-cat")).toEqual({ proprios: 1, catalogo: 2 });
    expect(contagens.get("esc-loc")).toEqual({ proprios: 2, catalogo: 0 });
  });

  it("t16: página só de escopos próprios não vai ao catálogo (uma consulta a menos)", async () => {
    const { cliente, tabelasConsultadas } = clienteDeLeitura({ ai_knowledge_sources: [] });
    await contarMateriais(cliente, ORG, [proprio]);
    expect(tabelasConsultadas).toEqual(["ai_knowledge_sources"]);
  });

  it("t17: página vazia não consulta nada", async () => {
    const { cliente, tabelasConsultadas } = clienteDeLeitura({});
    const contagens = await contarMateriais(cliente, ORG, []);
    expect(contagens.size).toBe(0);
    expect(tabelasConsultadas).toEqual([]);
  });
});
