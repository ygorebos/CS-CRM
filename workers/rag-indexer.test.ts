/**
 * A REGRA do worker `rag-indexer` (spec 002, T077/T095).
 *
 * Este arquivo guarda três coisas que, quando erradas, não dão erro nenhum — dão resposta
 * errada com ar de certeza:
 *
 *   1. **O eixo de escopo tem de viajar da fonte ao trecho** (T085). `fn_buscar_lastro`
 *      (migration 0123) filtra por `ai_chunks.scope_id` e `ai_chunks.applies_to_all`.
 *      Trecho gravado sem eixo ou some da busca, ou — pior — vira material "que vale para
 *      todos" e responde pergunta da operadora errada. É o defeito central que a spec
 *      inteira existe para evitar. `tags` e `locale` do item vêm junto: sem eles, ninguém
 *      consegue dizer de onde o trecho veio depois que ele virou vetor.
 *
 *   2. **A ativação é tudo-ou-nada** (T095, FR-006). A versão nova só entra em vigor
 *      quando TODOS os trechos entraram. Ativar com parte deles troca uma base íntegra por
 *      uma base pela metade: a base velha recusa a pergunta que não sabe responder; a base
 *      pela metade a responde errado.
 *
 *   3. **Carregar material não pode destruir material não relacionado** (T097, FR-003).
 *      Fonte que não participou da rodada não é tocada — nem para dizer que "falhou", nem
 *      para zerar a contagem que a tela mostra.
 *
 * O dublê do client PostgREST modela só a fatia que o worker usa, e registra as chamadas
 * NA ORDEM. É a ordem que prova o item 2: `activate_kb_version` tem de vir depois do
 * último `ai_chunks`, ou não vir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";

// ---------------------------------------------------------------------------
// Dublês
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  cliente: null as unknown,
  provedorConfigurado: true,
  debounce: true,
  embedar: null as null | ((texto: string, indice: number) => number[]),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => h.cliente,
}));
vi.mock("@/lib/ai/gateway", () => ({
  isEmbeddingProviderConfigured: () => h.provedorConfigurado,
}));
vi.mock("@/lib/ai/rag/debounce", () => ({
  acquireDebounce: async () => h.debounce,
  releaseDebounce: async () => {},
}));

let chamadasDeEmbed = 0;
vi.mock("@/lib/ai/embed", () => ({
  embedText: async (texto: string) => {
    const indice = chamadasDeEmbed++;
    const vetor = h.embedar ? h.embedar(texto, indice) : new Array(1536).fill(0.01);
    return { embedding: vetor, model: "openai/text-embedding-3-small", tokens: 1 };
  },
}));

// Importado DEPOIS dos mocks — o worker resolve `createAdminClient` na importação.
const { processRagIndexer } = await import("@/workers/rag-indexer");

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENTE = "22222222-2222-4222-8222-222222222222";
const VERSAO_NOVA = "33333333-3333-4333-8333-333333333333";
const ESCOPO_A = "44444444-4444-4444-8444-444444444444";

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update" | "upsert" | "rpc";
  colunas?: string;
  filtros: Record<string, unknown>;
  valores?: unknown;
  opcoes?: unknown;
}

interface Fonte {
  id: string;
  source_type: string;
  name: string;
  scope_id: string | null;
  applies_to_all: boolean;
}

interface Item {
  knowledge_source_id: string;
  question: string;
  answer: string;
  tags: string[];
  locale: string;
}

interface Cenario {
  fontes: Fonte[];
  itens: Item[];
  /** Erro por posição de trecho: `null`/ausente = gravou. */
  erroAoGravarTrecho?: (posicao: number) => string | null;
}

/**
 * Dublê mínimo do client. Método não previsto simplesmente não existe, para o teste não
 * passar por engano sobre um caminho que ele não modela.
 */
function clienteDuble(cenario: Cenario) {
  const chamadas: Chamada[] = [];
  let trechosGravados = 0;

  function from(tabela: string) {
    const filtros: Record<string, unknown> = {};
    let op: Chamada["op"] = "select";
    let colunas: string | undefined;
    let valores: unknown;
    let opcoes: unknown;

    function resolver(): unknown {
      chamadas.push({ tabela, op, colunas, filtros, valores, opcoes });

      if (tabela === "ai_agents") {
        return { data: { id: AGENTE, active_kb_version_id: "versao-anterior" }, error: null };
      }
      if (tabela === "ai_knowledge_sources" && op === "select") {
        return { data: cenario.fontes, error: null };
      }
      if (tabela === "ai_knowledge_sources" && op === "update") {
        return { data: null, error: null };
      }
      if (tabela === "ai_faq_items") {
        return { data: cenario.itens, error: null };
      }
      if (tabela === "ai_knowledge_versions" && op === "select") {
        // `createKnowledgeVersion` pergunta o maior `version_number`; `activateVersion`
        // pergunta o `id` para a pré-checagem de tenant. Distinguir pelas colunas.
        if (colunas?.includes("version_number")) {
          return { data: { version_number: 7 }, error: null };
        }
        return { data: { id: VERSAO_NOVA }, error: null };
      }
      if (tabela === "ai_knowledge_versions" && op === "insert") {
        return { data: { id: VERSAO_NOVA, version_number: 8 }, error: null };
      }
      if (tabela === "ai_knowledge_versions" && op === "update") {
        return { data: null, error: null };
      }
      if (tabela === "ai_chunks" && op === "upsert") {
        const posicao = trechosGravados++;
        const erro = cenario.erroAoGravarTrecho?.(posicao) ?? null;
        return { data: null, error: erro ? { message: erro } : null };
      }
      throw new Error(`dublê não modela ${op} em ${tabela}`);
    }

    const cadeia: Record<string, unknown> = {
      select(c?: string, o?: unknown) {
        colunas = c ?? colunas;
        opcoes = o ?? opcoes;
        return cadeia;
      },
      insert(v: unknown) {
        op = "insert";
        valores = v;
        return cadeia;
      },
      update(v: unknown) {
        op = "update";
        valores = v;
        return cadeia;
      },
      upsert(v: unknown, o?: unknown) {
        op = "upsert";
        valores = v;
        opcoes = o;
        return cadeia;
      },
      eq(coluna: string, valor: unknown) {
        filtros[`eq:${coluna}`] = valor;
        return cadeia;
      },
      in(coluna: string, valor: unknown) {
        filtros[`in:${coluna}`] = valor;
        return cadeia;
      },
      order(coluna: string) {
        filtros["order"] = coluna;
        return cadeia;
      },
      limit(n: number) {
        filtros["limit"] = n;
        return cadeia;
      },
      maybeSingle() {
        return Promise.resolve(resolver());
      },
      single() {
        return Promise.resolve(resolver());
      },
      then(resolve: (r: unknown) => unknown) {
        return Promise.resolve(resolve(resolver()));
      },
    };
    return cadeia;
  }

  function rpc(nome: string, args: unknown) {
    chamadas.push({ tabela: `rpc:${nome}`, op: "rpc", filtros: {}, valores: args });
    return Promise.resolve({ data: null, error: null });
  }

  return { cliente: { from, rpc } as never, chamadas };
}

function evento(): EventRow {
  return {
    id: "99999999-9999-4999-8999-999999999999",
    organization_id: ORG,
    event_type: "knowledge_source.updated",
    entity_kind: "ai_knowledge_source",
    entity_id: null,
    payload: { created_at: new Date().toISOString() },
    metadata: {},
    consumed_by: [],
    attempts: 0,
  };
}

/** Fonte com escopo declarado (a operadora A). */
function fonteComEscopo(id: string, scopeId: string): Fonte {
  return { id, source_type: "faq", name: `fonte ${id}`, scope_id: scopeId, applies_to_all: false };
}

function item(fonteId: string, n: number, extras?: Partial<Item>): Item {
  return {
    knowledge_source_id: fonteId,
    question: `pergunta ${n}`,
    answer: `resposta ${n}`,
    tags: ["carencia"],
    locale: "pt-BR",
    ...extras,
  };
}

function preparar(cenario: Cenario) {
  const { cliente, chamadas } = clienteDuble(cenario);
  h.cliente = cliente;
  return chamadas;
}

const trechosDe = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "ai_chunks" && c.op === "upsert");
const ativacoes = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "rpc:activate_kb_version");
const carimbosDeFonte = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "ai_knowledge_sources" && c.op === "update");
const versaoAtualizada = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "ai_knowledge_versions" && c.op === "update");

beforeEach(() => {
  h.provedorConfigurado = true;
  h.debounce = true;
  h.embedar = null;
  chamadasDeEmbed = 0;
});

// ---------------------------------------------------------------------------
// T085 · o que morria entre a fonte e o trecho
// ---------------------------------------------------------------------------

describe("rag-indexer · o eixo de escopo viaja da fonte ao trecho (T085)", () => {
  it("grava scope_id e applies_to_all da fonte no trecho — é por eles que a busca filtra", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1)],
    });

    const r = await processRagIndexer(evento());
    expect(r.status).toBe("ok");

    const trechos = trechosDe(chamadas);
    expect(trechos).toHaveLength(1);
    const linha = trechos[0]?.valores as Record<string, unknown>;
    // Os nomes são os que `fn_buscar_lastro` filtra (migration 0123, linhas 100-106).
    expect(
      linha["scope_id"],
      "trecho sem scope_id nunca casa com o escopo resolvido — o material do corretor some da busca",
    ).toBe(ESCOPO_A);
    expect(
      linha["applies_to_all"],
      "applies_to_all indevido faz o material de UMA operadora responder pergunta de outra",
    ).toBe(false);
  });

  it("material 'vale para todos' chega ao trecho como tal, não como escopo nulo mudo", async () => {
    const chamadas = preparar({
      fontes: [
        { id: "fonte-geral", source_type: "faq", name: "geral", scope_id: null, applies_to_all: true },
      ],
      itens: [item("fonte-geral", 1)],
    });

    await processRagIndexer(evento());

    const linha = trechosDe(chamadas)[0]?.valores as Record<string, unknown>;
    expect(linha["applies_to_all"]).toBe(true);
    expect(linha["scope_id"]).toBeNull();
  });

  it("leva tags e locale do item ao trecho — hoje morriam na ingestão", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1, { tags: ["carencia", "reembolso"], locale: "es-PY" })],
    });

    await processRagIndexer(evento());

    const linha = trechosDe(chamadas)[0]?.valores as { metadata: Record<string, unknown> };
    expect(linha.metadata["tags"]).toEqual(["carencia", "reembolso"]);
    expect(linha.metadata["locale"]).toBe("es-PY");
    // `source_type` continua onde estava — nada foi trocado, só acrescentado.
    expect(linha.metadata["source_type"]).toBe("faq");
  });

  it("a consulta às fontes PEDE o eixo — sem ele no select, não há o que propagar", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1)],
    });

    await processRagIndexer(evento());

    const busca = chamadas.find((c) => c.tabela === "ai_knowledge_sources" && c.op === "select");
    expect(busca?.colunas).toContain("scope_id");
    expect(busca?.colunas).toContain("applies_to_all");

    const itens = chamadas.find((c) => c.tabela === "ai_faq_items");
    expect(itens?.colunas).toContain("tags");
    expect(itens?.colunas).toContain("locale");
  });

  it("cada operadora carrega o SEU escopo — duas fontes na mesma rodada não se misturam", async () => {
    const ESCOPO_B = "55555555-5555-4555-8555-555555555555";
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A), fonteComEscopo("fonte-b", ESCOPO_B)],
      itens: [item("fonte-a", 1), item("fonte-b", 2)],
    });

    await processRagIndexer(evento());

    const porEscopo = trechosDe(chamadas).map((c) => {
      const v = c.valores as Record<string, unknown>;
      return { fonte: v["knowledge_source_id"], escopo: v["scope_id"] };
    });
    expect(porEscopo).toEqual([
      { fonte: "fonte-a", escopo: ESCOPO_A },
      { fonte: "fonte-b", escopo: ESCOPO_B },
    ]);
  });
});

// ---------------------------------------------------------------------------
// T095 / T098 · a ativação é tudo-ou-nada
// ---------------------------------------------------------------------------

describe("rag-indexer · a versão nova só entra em vigor inteira (T095, FR-006)", () => {
  it("ativa depois do ÚLTIMO trecho, nunca antes", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1), item("fonte-a", 2), item("fonte-a", 3)],
    });

    const r = await processRagIndexer(evento());
    expect(r.status).toBe("ok");

    const ativacao = chamadas.findIndex((c) => c.tabela === "rpc:activate_kb_version");
    const ultimoTrecho = chamadas.map((c) => c.tabela).lastIndexOf("ai_chunks");
    expect(ativacao).toBeGreaterThan(-1);
    expect(
      ativacao,
      "ativar antes do último trecho abre uma janela em que o agente responde com base pela metade",
    ).toBeGreaterThan(ultimoTrecho);
    expect((ativacoes(chamadas)[0]?.valores as { p_version_id: string }).p_version_id).toBe(
      VERSAO_NOVA,
    );
  });

  it("falha ao gravar UM trecho no meio ⇒ nada é ativado, a versão anterior segue inteira", async () => {
    // O caso que passava verde: 2 de 3 trechos entravam, `gravados > 0`, e a versão pela
    // metade era ativada. O agente passa a responder ERRADO onde a base velha recusaria.
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1), item("fonte-a", 2), item("fonte-a", 3)],
      erroAoGravarTrecho: (p) => (p === 1 ? "duplicate key value violates unique constraint" : null),
    });

    const r = await processRagIndexer(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toBe("base_parcial");
    expect(
      ativacoes(chamadas),
      "base pela metade NÃO pode ser ativada — a anterior tem de continuar valendo por inteiro",
    ).toEqual([]);

    // E a versão pela metade fica marcada como falha, não como pronta.
    const marcacoes = versaoAtualizada(chamadas).map((c) => (c.valores as { status: string }).status);
    expect(marcacoes).toContain("failed");
    expect(marcacoes).not.toContain("ready");
  });

  it("falha do provedor de embedding no meio ⇒ para na hora e não ativa nada", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1), item("fonte-a", 2), item("fonte-a", 3)],
    });
    h.embedar = (_texto, indice) => {
      if (indice === 1) throw new Error("429 rate limit do provedor");
      return new Array(1536).fill(0.01);
    };

    const r = await processRagIndexer(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toContain("embed_failed at chunk 1");
    expect(ativacoes(chamadas)).toEqual([]);
    // Só o trecho anterior à falha foi tentado — nada de martelar o lote inteiro.
    expect(trechosDe(chamadas)).toHaveLength(1);
    expect(
      versaoAtualizada(chamadas).map((c) => (c.valores as { status: string }).status),
    ).toEqual(["failed"]);
  });

  it("todos os trechos falhando ⇒ versão vazia jamais ativada", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1), item("fonte-a", 2)],
      erroAoGravarTrecho: () => "erro de escrita",
    });

    const r = await processRagIndexer(evento());

    expect(r.status).toBe("error");
    expect(r.detail).toBe("no_chunks_written");
    expect(ativacoes(chamadas)).toEqual([]);
  });

  it("a contagem que vai para a versão é a dos trechos REALMENTE gravados", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1), item("fonte-a", 2)],
    });

    await processRagIndexer(evento());

    const pronta = versaoAtualizada(chamadas).find(
      (c) => (c.valores as { status: string }).status === "ready",
    );
    expect((pronta?.valores as { total_chunks: number }).total_chunks).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T097 · carregar não pode destruir
// ---------------------------------------------------------------------------

describe("rag-indexer · carregar material não toca material não relacionado (T097, FR-003)", () => {
  it("fonte que não participou da rodada NÃO é marcada como falha nem tem a contagem zerada", async () => {
    // `fonte-pdf` é uma fonte `ready` que o indexador ainda não sabe ler (T084 pendente):
    // ela produz zero trechos SEMPRE. No laço antigo, carregar o FAQ da operadora A
    // carimbava `last_index_status='failed'` e `chunks_count=0` nela — o corretor via o
    // manual da operadora B "falhar" por ter carregado material da A.
    const chamadas = preparar({
      fontes: [
        fonteComEscopo("fonte-a", ESCOPO_A),
        { id: "fonte-pdf", source_type: "policy", name: "manual B", scope_id: ESCOPO_A, applies_to_all: false },
      ],
      itens: [item("fonte-a", 1)],
    });

    const r = await processRagIndexer(evento());
    expect(r.status).toBe("ok");

    const carimbos = carimbosDeFonte(chamadas);
    expect(carimbos.map((c) => c.filtros["eq:id"])).toEqual(["fonte-a"]);
    expect(
      carimbos.some((c) => c.filtros["eq:id"] === "fonte-pdf"),
      "fonte que não entrou na rodada não pode ser tocada — nem para dizer que falhou",
    ).toBe(false);
  });

  it("na falha, a contagem de trechos das fontes NÃO é reescrita — ela descreve o acervo que continua ativo", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1), item("fonte-a", 2)],
      erroAoGravarTrecho: (p) => (p === 1 ? "erro de escrita" : null),
    });

    await processRagIndexer(evento());

    const carimbos = carimbosDeFonte(chamadas);
    expect(carimbos).toHaveLength(1);
    const valores = carimbos[0]?.valores as Record<string, unknown>;
    expect(valores["last_index_status"]).toBe("failed");
    expect(
      "chunks_count" in valores,
      "zerar a contagem numa falha mente sobre o acervo anterior, que continua ativo por inteiro",
    ).toBe(false);
    expect("last_indexed_at" in valores).toBe(false);
    // A falha continua VISÍVEL (FR-004): motivo em português, dizendo o tamanho do buraco.
    expect(String(valores["last_index_error"])).toContain("1 de 2");
  });

  it("no sucesso, cada fonte recebe a contagem DELA — não a da rodada inteira", async () => {
    const ESCOPO_B = "55555555-5555-4555-8555-555555555555";
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A), fonteComEscopo("fonte-b", ESCOPO_B)],
      itens: [item("fonte-a", 1), item("fonte-a", 2), item("fonte-b", 3)],
    });

    await processRagIndexer(evento());

    const porFonte = new Map(
      carimbosDeFonte(chamadas).map((c) => [
        c.filtros["eq:id"],
        (c.valores as { chunks_count: number }).chunks_count,
      ]),
    );
    expect(porFonte.get("fonte-a")).toBe(2);
    expect(porFonte.get("fonte-b")).toBe(1);
  });

  it("toda escrita em fonte carrega o filtro de organização (service role bypassa RLS)", async () => {
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1)],
    });

    await processRagIndexer(evento());

    for (const c of carimbosDeFonte(chamadas)) {
      expect(c.filtros["eq:organization_id"]).toBe(ORG);
    }
  });

  it("nenhum trecho é apagado antes de escrever — o worker não emite delete", async () => {
    // "Nada de apagar antes de escrever" (FR-006). O dublê não modela `delete`: se o
    // worker passar a emitir um, ele estoura em vez de passar em silêncio.
    const chamadas = preparar({
      fontes: [fonteComEscopo("fonte-a", ESCOPO_A)],
      itens: [item("fonte-a", 1)],
    });

    await processRagIndexer(evento());

    expect(chamadas.every((c) => c.op !== "rpc" || c.tabela === "rpc:activate_kb_version")).toBe(
      true,
    );
    expect(chamadas.filter((c) => c.tabela === "ai_chunks" && c.op !== "upsert")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T077 · material que não é par pergunta/resposta
// ---------------------------------------------------------------------------

describe("rag-indexer · material que não é par pergunta/resposta (T077)", () => {
  it("hoje, material que não é par pergunta/resposta é descartado em silêncio", async () => {
    // Este é o estado ATUAL, não o desejado. Uma fonte `ready` cujo conteúdo não está em
    // `ai_faq_items` (um PDF de política, por exemplo) faz o indexador encerrar com
    // `no_content_to_index` — e a fonte fica `ready` na tela, sem nenhum trecho buscável.
    // É exatamente o que FR-004 proíbe. O teste existe para que a correção (T084) tenha um
    // ponto de partida medido, e para que ninguém confunda "passa verde" com "funciona".
    const chamadas = preparar({
      fontes: [
        { id: "fonte-pdf", source_type: "policy", name: "manual", scope_id: ESCOPO_A, applies_to_all: false },
      ],
      itens: [],
    });

    const r = await processRagIndexer(evento());

    expect(r.status).toBe("skipped");
    expect(r.detail).toBe("no_content_to_index");
    expect(trechosDe(chamadas)).toEqual([]);
    // E o silêncio é total: a fonte não recebe carimbo nenhum, então a tela continua
    // dizendo o que dizia antes.
    expect(carimbosDeFonte(chamadas)).toEqual([]);
  });

  /**
   * ⚠️ BLOQUEADO POR T140/T084 — não há tabela onde o texto de um documento mora.
   *
   * `ingestPolicyFile` (`lib/ai/rag/ingest/policy.ts`) extrai o texto do PDF/Markdown só
   * para validar e o devolve sem gravar; o indexador lê exclusivamente `ai_faq_items`. A
   * decisão de modelagem (T140: tabela nova `ai_source_passages` versus afrouxar
   * `ai_faq_items.question`) precede a migration, e a migration precede este teste.
   *
   * O que este teste vai exigir quando destravar: uma fonte cujo material seja texto
   * corrido (sem pergunta) vira trecho buscável, com `scope_id`/`applies_to_all` da fonte
   * — a mesma regra de T085 —, e o resultado é `ok`, não `skipped`.
   *
   * Escrevê-lo agora contra uma tabela inventada produziria o falso verde que o Princípio
   * XI nomeia: um teste que passa exercitando um dublê de algo que não existe.
   */
  it.todo(
    "aceita material que não é par pergunta/resposta e o torna buscável (destrava com T140+T084)",
  );
});
