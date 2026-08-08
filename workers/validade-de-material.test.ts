/**
 * A REGRA do worker `validade-de-material` (spec 002, T120, FR-025/FR-026/FR-027).
 *
 * Este arquivo guarda quatro coisas que, quando erradas, não dão erro nenhum — dão
 * silêncio, que é o defeito que a feature inteira existe para não deixar acontecer:
 *
 *   1. **Datar é opcional** (FR-025). Material sem `valid_until` nunca vira alarme. Um
 *      worker que avisasse "sem validade declarada" transformaria o caminho apressado —
 *      subir o documento e voltar a vender — numa fila de avisos, e a Central inteira
 *      viraria ruído no primeiro dia de uso.
 *
 *   2. **"Vai vencer" e "venceu" são avisos diferentes.** Material já vencido não pode ser
 *      anunciado como se ainda desse tempo: quem lê agiria como se pudesse evitar o corte
 *      que já aconteceu. A borda é `>= hoje`, a MESMA do `where valid_until >=
 *      current_date` de `fn_buscar_lastro` — material que vence hoje ainda ancora, então
 *      ainda é "vai vencer".
 *
 *   3. **Idempotência com data na chave.** Um cron diário que reabre o mesmo aviso todo
 *      dia ensina o corretor a ignorar a Central. Deduplicar só por material erraria para
 *      o outro lado: tabela de operadora é anual, e a renovação precisa avisar de novo um
 *      ano depois.
 *
 *   4. **Só a versão vigente do catálogo.** Avisar sobre a v1 vencida quando a v2 é que
 *      responde é alarme sobre um texto que já não ancora nada (FR-037).
 *
 * O dublê do client PostgREST modela só a fatia que o worker usa e REGISTRA as chamadas,
 * inclusive os filtros — é o que permite provar que o corte de data existe também no
 * TypeScript, e não só no `where` (o teste alimenta linha vencida pelo dublê, como se o
 * banco a tivesse devolvido, e exige que ela seja descartada mesmo assim).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DIAS_DE_ANTECEDENCIA,
  KIND_DO_AVISO,
  REF_KIND_BASE,
  avisarValidadeDeMaterial,
  dentroDaJanela,
  vigentePorSlug,
} from "./validade-de-material";

const erros: { msg: string; ctx: unknown }[] = [];
vi.mock("@/lib/logger", () => ({
  logger: {
    info: () => {},
    warn: () => {},
    error: (msg: string, ctx: unknown) => {
      erros.push({ msg, ctx });
    },
    debug: () => {},
  },
}));

// ---------------------------------------------------------------------------
// Dublê do client PostgREST
// ---------------------------------------------------------------------------

const HOJE = "2026-08-08";
const AGORA = new Date(`${HOJE}T12:00:00.000Z`);
const LIMITE = "2026-09-07"; // HOJE + 30

const ORG_A = "0a5e0000-0000-4000-8000-00000000000a";
const ORG_B = "0a5e0000-0000-4000-8000-00000000000b";

interface Op {
  m: string;
  args: unknown[];
}

interface Acervo {
  id: string;
  organization_id: string;
  name: string;
  scope_id: string | null;
  valid_until: string | null;
}
interface Escopo {
  id: string;
  organization_id: string;
  display_name: string;
  catalog_scope_id: string | null;
  is_active: boolean;
}
interface Curado {
  id: string;
  slug: string;
  version: number;
  title: string;
  catalog_scope_id: string | null;
  valid_until: string | null;
  inert: boolean;
}
interface AvisoExistente {
  organization_id: string;
  ref_kind: string;
  ref_id: string;
}

interface Mundo {
  acervo?: Acervo[];
  escopos?: Escopo[];
  catalogo?: Curado[];
  avisos?: AvisoExistente[];
  /** Liga a falha do `insert` para provar que ela não derruba a rodada. */
  insertFalha?: string;
}

interface Duble {
  cliente: unknown;
  inseridos: Record<string, unknown>[];
  consultas: { tabela: string; ops: Op[] }[];
}

function criarDuble(mundo: Mundo): Duble {
  const inseridos: Record<string, unknown>[] = [];
  const consultas: { tabela: string; ops: Op[] }[] = [];

  const acervo = mundo.acervo ?? [];
  const escopos = mundo.escopos ?? [];
  const catalogo = mundo.catalogo ?? [];
  const avisos = mundo.avisos ?? [];

  function resolver(tabela: string, ops: Op[]): { data: unknown; error: unknown } {
    consultas.push({ tabela, ops });
    const tem = (m: string, col: string): boolean =>
      ops.some((o) => o.m === m && o.args[0] === col);

    if (tabela === "ai_knowledge_sources") {
      // O dublê devolve TUDO de propósito, sem aplicar `gte`/`lte`: quem tem de barrar a
      // linha vencida é a regra em TypeScript. Um dublê que filtrasse esconderia
      // exatamente o defeito que este arquivo vigia.
      return { data: acervo, error: null };
    }
    if (tabela === "knowledge_scopes") {
      // Duas consultas distintas na mesma tabela: por id (nome da operadora do acervo do
      // corretor) e por espelho ativo (fan-out do catálogo).
      if (tem("in", "id")) {
        const ids = (ops.find((o) => o.m === "in" && o.args[0] === "id")?.args[1] ?? []) as string[];
        return { data: escopos.filter((e) => ids.includes(e.id)), error: null };
      }
      return { data: escopos.filter((e) => e.is_active && e.catalog_scope_id), error: null };
    }
    if (tabela === "catalog_materials") {
      return { data: catalogo.filter((m) => !m.inert), error: null };
    }
    if (tabela === "agent_inbox_items") {
      const refKinds = (ops.find((o) => o.m === "in" && o.args[0] === "ref_kind")?.args[1] ??
        []) as string[];
      const refIds = (ops.find((o) => o.m === "in" && o.args[0] === "ref_id")?.args[1] ??
        []) as string[];
      return {
        data: avisos.filter((a) => refKinds.includes(a.ref_kind) && refIds.includes(a.ref_id)),
        error: null,
      };
    }
    throw new Error(`dublê não modela a tabela ${tabela}`);
  }

  function construtor(aoResolver: (ops: Op[]) => { data: unknown; error: unknown }): unknown {
    const ops: Op[] = [];
    const proxy: unknown = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (typeof prop !== "string") return undefined;
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) => Promise.resolve(aoResolver(ops)).then(ok);
          }
          return (...args: unknown[]) => {
            ops.push({ m: prop, args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  }

  const cliente = {
    from(tabela: string) {
      return {
        select: (..._cols: unknown[]) => construtor((ops) => resolver(tabela, ops)),
        insert: (linhas: Record<string, unknown>[]) => {
          if (mundo.insertFalha) return Promise.resolve({ error: { message: mundo.insertFalha } });
          inseridos.push(...linhas);
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  return { cliente, inseridos, consultas };
}

async function rodar(mundo: Mundo, dias = DIAS_DE_ANTECEDENCIA) {
  const d = criarDuble(mundo);
  const resultado = await avisarValidadeDeMaterial(d.cliente as never, {
    agora: AGORA,
    diasDeAntecedencia: dias,
    requestId: "req-de-teste",
  });
  return { ...d, resultado };
}

const fonte = (over: Partial<Acervo> = {}): Acervo => ({
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: ORG_A,
  name: "Tabela de reajuste 2026",
  scope_id: "aaaa1111-1111-4111-8111-111111111111",
  valid_until: "2026-08-20",
  ...over,
});

const escopoDoCorretor = (over: Partial<Escopo> = {}): Escopo => ({
  id: "aaaa1111-1111-4111-8111-111111111111",
  organization_id: ORG_A,
  display_name: "Amil",
  catalog_scope_id: null,
  is_active: true,
  ...over,
});

beforeEach(() => {
  erros.length = 0;
});

// ---------------------------------------------------------------------------

describe("a janela de aviso — a borda é a MESMA do corte da busca", () => {
  it("material que vence HOJE ainda está na janela (espelha `>= current_date`)", () => {
    expect(dentroDaJanela(HOJE, HOJE, LIMITE)).toBe(true);
  });

  it("material que venceu ONTEM está fora — já venceu, não 'vai vencer'", () => {
    expect(dentroDaJanela("2026-08-07", HOJE, LIMITE)).toBe(false);
  });

  it("o último dia da antecedência entra; o seguinte, não", () => {
    expect(dentroDaJanela(LIMITE, HOJE, LIMITE)).toBe(true);
    expect(dentroDaJanela("2026-09-08", HOJE, LIMITE)).toBe(false);
  });

  it("sem validade declarada nunca entra (FR-025 — datar é opcional)", () => {
    expect(dentroDaJanela(null, HOJE, LIMITE)).toBe(false);
  });
});

describe("acervo do corretor", () => {
  it("abre UM aviso dizendo material, operadora e data (FR-027)", async () => {
    const { inseridos, resultado } = await rodar({
      acervo: [fonte()],
      escopos: [escopoDoCorretor()],
    });

    expect(resultado.materiais_do_corretor).toBe(1);
    expect(resultado.avisos_abertos).toBe(1);
    expect(resultado.organizacoes).toBe(1);
    expect(inseridos).toHaveLength(1);

    const aviso = inseridos[0]!;
    expect(aviso.organization_id).toBe(ORG_A);
    expect(aviso.kind).toBe(KIND_DO_AVISO);
    expect(aviso.ref_kind).toBe(`${REF_KIND_BASE}:2026-08-20`);
    expect(aviso.ref_id).toBe(fonte().id);

    // As três informações que FR-027 exige, no texto que o corretor lê.
    expect(aviso.title).toContain("Tabela de reajuste 2026");
    expect(aviso.title).toContain("Amil");
    expect(aviso.title).toContain("vence em 12 dias");
    expect(aviso.body).toContain("20/08/2026");
    // E o que fazer — sem jargão, na língua de quem vende plano.
    expect(aviso.body).toContain("suba a versão nova do documento");
  });

  it("material SEM validade declarada não vira aviso (FR-025)", async () => {
    const { inseridos, resultado } = await rodar({
      acervo: [fonte({ valid_until: null })],
      escopos: [escopoDoCorretor()],
    });
    expect(resultado.materiais_do_corretor).toBe(0);
    expect(inseridos).toEqual([]);
  });

  it("material JÁ VENCIDO não é anunciado como 'vai vencer'", async () => {
    // O dublê entrega a linha vencida como se o banco a tivesse devolvido — é assim que
    // este teste vigia a regra em TypeScript, e não o `where` da consulta.
    const { inseridos, resultado } = await rodar({
      acervo: [fonte({ valid_until: "2026-07-01" })],
      escopos: [escopoDoCorretor()],
    });
    expect(resultado.materiais_do_corretor).toBe(0);
    expect(inseridos).toEqual([]);
  });

  it("material que vence depois da janela ainda não incomoda ninguém", async () => {
    const { inseridos } = await rodar({
      acervo: [fonte({ valid_until: "2027-01-01" })],
      escopos: [escopoDoCorretor()],
    });
    expect(inseridos).toEqual([]);
  });

  it("material que vence HOJE avisa, e o texto diz 'vence hoje'", async () => {
    const { inseridos } = await rodar({
      acervo: [fonte({ valid_until: HOJE })],
      escopos: [escopoDoCorretor()],
    });
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]!.title).toContain("vence hoje");
  });

  it("material sem operadora ('vale para todas') avisa sem inventar nome de escopo", async () => {
    const { inseridos } = await rodar({ acervo: [fonte({ scope_id: null })], escopos: [] });
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]!.title).toBe('O material "Tabela de reajuste 2026" vence em 12 dias');
    expect(inseridos[0]!.body).toContain("vale para todas as operadoras");
  });

  it("o corte de data também viaja no `where` — payload do acervo inteiro não é aceitável", async () => {
    const { consultas } = await rodar({ acervo: [fonte()], escopos: [escopoDoCorretor()] });
    const q = consultas.find((c) => c.tabela === "ai_knowledge_sources")!;
    expect(q.ops).toContainEqual({ m: "gte", args: ["valid_until", HOJE] });
    expect(q.ops).toContainEqual({ m: "lte", args: ["valid_until", LIMITE] });
  });
});

describe("idempotência — a chave é (material, data de validade)", () => {
  it("não avisa duas vezes o mesmo material com a mesma data", async () => {
    const { inseridos, resultado } = await rodar({
      acervo: [fonte()],
      escopos: [escopoDoCorretor()],
      avisos: [
        {
          organization_id: ORG_A,
          ref_kind: `${REF_KIND_BASE}:2026-08-20`,
          ref_id: fonte().id,
        },
      ],
    });
    expect(resultado.ja_avisados).toBe(1);
    expect(resultado.avisos_abertos).toBe(0);
    expect(inseridos).toEqual([]);
  });

  it("aviso RESOLVIDO também segura — resolver é o corretor dizendo 'já sei'", async () => {
    // A consulta de deduplicação não filtra por status de propósito. Se filtrasse por
    // `open`, o cron do dia seguinte reabriria o que a pessoa acabou de fechar.
    const { consultas } = await rodar({
      acervo: [fonte()],
      escopos: [escopoDoCorretor()],
    });
    const q = consultas.find((c) => c.tabela === "agent_inbox_items")!;
    expect(q.ops.some((o) => o.m === "eq" && o.args[0] === "status")).toBe(false);
  });

  it("validade RENOVADA gera aviso novo — chave nova, não o mesmo alarme", async () => {
    const { inseridos, resultado } = await rodar({
      acervo: [fonte({ valid_until: "2026-09-01" })],
      escopos: [escopoDoCorretor()],
      // O aviso do ano passado, para a data antiga, continua no histórico.
      avisos: [
        {
          organization_id: ORG_A,
          ref_kind: `${REF_KIND_BASE}:2026-08-20`,
          ref_id: fonte().id,
        },
      ],
    });
    expect(resultado.avisos_abertos).toBe(1);
    expect(inseridos[0]!.ref_kind).toBe(`${REF_KIND_BASE}:2026-09-01`);
  });
});

describe("catálogo curado", () => {
  const CS = "cccc1111-1111-4111-8111-111111111111";
  const curado = (over: Partial<Curado> = {}): Curado => ({
    id: "22222222-2222-4222-8222-222222222222",
    slug: "carencia",
    version: 1,
    title: "Carência da Bradesco",
    catalog_scope_id: CS,
    valid_until: "2026-08-20",
    inert: false,
    ...over,
  });

  it("avisa só as organizações com o espelho daquele escopo LIGADO (trava 4)", async () => {
    const { inseridos } = await rodar({
      catalogo: [curado()],
      escopos: [
        escopoDoCorretor({ id: "e-a", organization_id: ORG_A, catalog_scope_id: CS, is_active: true, display_name: "Bradesco" }),
        escopoDoCorretor({ id: "e-b", organization_id: ORG_B, catalog_scope_id: CS, is_active: false }),
      ],
    });
    expect(inseridos).toHaveLength(1);
    expect(inseridos[0]!.organization_id).toBe(ORG_A);
    // O nome que vai no aviso é o do ESPELHO — é o que o corretor lê na tela dele.
    expect(inseridos[0]!.title).toContain("Bradesco");
    // E o texto não manda o corretor "subir a versão nova": material curado não é dele.
    expect(inseridos[0]!.body).toContain("catálogo que acompanha o produto");
  });

  it("instalação onde ninguém ligou operadora nenhuma não recebe nada", async () => {
    const { inseridos, resultado } = await rodar({ catalogo: [curado()], escopos: [] });
    expect(inseridos).toEqual([]);
    expect(resultado.avisos_abertos).toBe(0);
  });

  it("só a versão VIGENTE do slug entra (FR-037)", async () => {
    const { inseridos } = await rodar({
      catalogo: [
        curado({ id: "v1", version: 1, valid_until: "2026-08-20" }),
        curado({ id: "v2", version: 2, valid_until: null }),
      ],
      escopos: [escopoDoCorretor({ id: "e-a", catalog_scope_id: CS })],
    });
    // A v2 é quem responde e não tem validade declarada. Avisar sobre a v1 seria alarme
    // sobre um texto que já não ancora nada.
    expect(inseridos).toEqual([]);
  });

  it("versão INERTE não conta como vigente", () => {
    // A inerte nem chega aqui (a consulta filtra `inert = false`), e por isso a regra de
    // vigência opera sobre o que sobrou — a mesma ordem do CTE `material_vigente`.
    const vigentes = vigentePorSlug([
      { id: "v1", slug: "s", version: 1, title: "a", catalog_scope_id: null, valid_until: null },
      { id: "v3", slug: "s", version: 3, title: "c", catalog_scope_id: null, valid_until: null },
      { id: "v2", slug: "s", version: 2, title: "b", catalog_scope_id: null, valid_until: null },
    ]);
    expect(vigentes.map((m) => m.id)).toEqual(["v3"]);
  });

  it("material curado que vale para TODAS alcança toda organização que depende do catálogo", async () => {
    const { inseridos } = await rodar({
      catalogo: [curado({ catalog_scope_id: null })],
      escopos: [
        escopoDoCorretor({ id: "e-a", organization_id: ORG_A, catalog_scope_id: CS }),
        escopoDoCorretor({ id: "e-b", organization_id: ORG_B, catalog_scope_id: CS }),
      ],
    });
    expect(inseridos.map((l) => l.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
  });
});

describe("quando escrever o aviso falha", () => {
  it("registra no logger estruturado e não derruba a rodada", async () => {
    const { resultado } = await rodar({
      acervo: [fonte()],
      escopos: [escopoDoCorretor()],
      insertFalha: "permission denied",
    });
    expect(resultado.avisos_abertos).toBe(0);
    expect(erros).toHaveLength(1);
    expect(erros[0]!.msg).toContain("aviso na Central falhou");
  });
});
