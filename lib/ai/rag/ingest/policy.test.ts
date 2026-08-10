/**
 * O que o ingest de documento tem de FAZER com o texto que extraiu (spec 002, T076/T083).
 *
 * O defeito que este arquivo vigia não dá erro nenhum: `ingestPolicyFile` extraía o texto do
 * PDF/Markdown, contava os caracteres, devolvia a contagem e **jogava o texto fora**. O
 * corretor subia o manual da operadora, a tela dizia "pronto", e nenhum trecho buscável
 * passava a existir. É o silêncio que FR-004 proíbe: material aceito e descartado sem que
 * ninguém veja.
 *
 * Três coisas são medidas aqui, e cada uma corresponde a um jeito diferente de o ingest
 * parecer certo e estar errado:
 *
 *   1. **O texto persiste.** Sem linha em `ai_source_passages`, o indexador não tem o que
 *      ler e o material morre entre o upload e a busca.
 *   2. **Reprocessar substitui, não empilha.** Subir o mesmo manual duas vezes não pode
 *      dobrar as passagens — nem deixar a cauda do documento antigo viva dentro da fonte
 *      nova, que é o modo de falha que só o corte de posições excedentes pega.
 *   3. **O tenant e o escopo vêm da FONTE, nunca do argumento.** O client admin bypassa a
 *      RLS; se o `organization_id` viesse do que o chamador afirma, uma chamada errada
 *      gravaria material de um cliente dentro do acervo de outro.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ admin: null as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => h.admin,
}));

const { ingestPolicyFile, dividirEmPassagens, resolverExtensao } = await import(
  "@/lib/ai/rag/ingest/policy"
);

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENTE = "22222222-2222-4222-8222-222222222222";
const FONTE = "33333333-3333-4333-8333-333333333333";
const ESCOPO = "44444444-4444-4444-8444-444444444444";

interface Chamada {
  tabela: string;
  op: "select" | "upsert" | "delete";
  filtros: Record<string, unknown>;
  valores?: unknown;
  opcoes?: unknown;
}

interface LinhaDaFonte {
  id: string;
  organization_id: string;
  scope_id: string | null;
  applies_to_all: boolean;
}

interface Cenario {
  /** Conteúdo do arquivo no bucket. */
  arquivo: string;
  /** A linha de `ai_knowledge_sources`, ou `null` para "ainda não existe". */
  fonte: LinhaDaFonte | null;
  erroAoBaixar?: string;
  erroNoUpsert?: string;
  erroNoCorte?: string;
}

/**
 * Dublê mínimo do client admin. Método não previsto não existe — assim o teste não passa
 * por engano sobre um caminho que ele não modela.
 */
function duble(cenario: Cenario) {
  const chamadas: Chamada[] = [];

  function from(tabela: string) {
    const filtros: Record<string, unknown> = {};
    let op: Chamada["op"] = "select";
    let valores: unknown;
    let opcoes: unknown;

    function resolver(): unknown {
      chamadas.push({ tabela, op, filtros, valores, opcoes });

      if (tabela === "ai_knowledge_sources" && op === "select") {
        return { data: cenario.fonte, error: null };
      }
      if (tabela === "ai_source_passages" && op === "upsert") {
        return { data: null, error: cenario.erroNoUpsert ? { message: cenario.erroNoUpsert } : null };
      }
      if (tabela === "ai_source_passages" && op === "delete") {
        return { data: null, error: cenario.erroNoCorte ? { message: cenario.erroNoCorte } : null };
      }
      throw new Error(`dublê não modela ${op} em ${tabela}`);
    }

    const cadeia: Record<string, unknown> = {
      select() {
        return cadeia;
      },
      upsert(v: unknown, o?: unknown) {
        op = "upsert";
        valores = v;
        opcoes = o;
        return cadeia;
      },
      delete() {
        op = "delete";
        return cadeia;
      },
      eq(coluna: string, valor: unknown) {
        filtros[`eq:${coluna}`] = valor;
        return cadeia;
      },
      gte(coluna: string, valor: unknown) {
        filtros[`gte:${coluna}`] = valor;
        return cadeia;
      },
      maybeSingle() {
        return Promise.resolve(resolver());
      },
      then(resolve: (r: unknown) => unknown) {
        return Promise.resolve(resolve(resolver()));
      },
    };
    return cadeia;
  }

  const storage = {
    from() {
      return {
        download: async () => {
          if (cenario.erroAoBaixar) {
            return { data: null, error: { message: cenario.erroAoBaixar } };
          }
          const bytes = new TextEncoder().encode(cenario.arquivo);
          return { data: { arrayBuffer: async () => bytes.buffer }, error: null };
        },
      };
    },
  };

  return { admin: { from, storage }, chamadas };
}

function preparar(cenario: Cenario) {
  const { admin, chamadas } = duble(cenario);
  h.admin = admin;
  return chamadas;
}

function fonteReal(over?: Partial<LinhaDaFonte>): LinhaDaFonte {
  return {
    id: FONTE,
    organization_id: ORG,
    scope_id: ESCOPO,
    applies_to_all: false,
    ...over,
  };
}

const MANUAL = [
  "# Carências",
  "A carência para consultas é de 30 dias.",
  "",
  "# Reembolso",
  "O reembolso é solicitado pelo aplicativo em até 60 dias.",
].join("\n");

const gravacoes = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "ai_source_passages" && c.op === "upsert");
const cortes = (chamadas: Chamada[]) =>
  chamadas.filter((c) => c.tabela === "ai_source_passages" && c.op === "delete");

function chamar(over?: Partial<Parameters<typeof ingestPolicyFile>[0]>) {
  return ingestPolicyFile({
    organizationId: ORG,
    agentId: AGENTE,
    knowledgeSourceId: FONTE,
    blobPath: `${ORG}/manual.md`,
    ext: "md",
    ...over,
  });
}

beforeEach(() => {
  h.admin = null;
});

// ---------------------------------------------------------------------------
// T083 · o texto persiste
// ---------------------------------------------------------------------------

describe("ingestPolicyFile · o texto extraído PERSISTE (T083, FR-004)", () => {
  it("grava as passagens do documento em ai_source_passages, em ordem", async () => {
    const chamadas = preparar({ arquivo: MANUAL, fonte: fonteReal() });

    const r = await chamar();

    expect(r.naoPersistidoPorque).toBeNull();
    expect(r.chunkCount).toBe(2);

    const linhas = gravacoes(chamadas)[0]?.valores as Record<string, unknown>[];
    expect(
      linhas,
      "sem linha em ai_source_passages o indexador não tem o que ler — o manual morre entre o upload e a busca",
    ).toHaveLength(2);
    expect(linhas[0]?.["position"]).toBe(0);
    expect(linhas[1]?.["position"]).toBe(1);
    expect(String(linhas[0]?.["content"])).toContain("carência para consultas");
    expect(String(linhas[1]?.["content"])).toContain("reembolso é solicitado");
  });

  it("o texto devolvido é o mesmo que foi ao banco — quem chamou pode indexar sem reler", async () => {
    const chamadas = preparar({ arquivo: MANUAL, fonte: fonteReal() });

    const r = await chamar();

    const linhas = gravacoes(chamadas)[0]?.valores as Record<string, unknown>[];
    expect(r.passagens.map((p) => p.content)).toEqual(linhas.map((l) => l["content"]));
    expect(r.passagens.map((p) => p.position)).toEqual([0, 1]);
  });

  it("FR-022 · a passagem carrega o título da seção — é a âncora que o corretor confere", async () => {
    const chamadas = preparar({ arquivo: MANUAL, fonte: fonteReal() });

    await chamar();

    const linhas = gravacoes(chamadas)[0]?.valores as Record<string, unknown>[];
    expect(
      linhas.map((l) => l["section_title"]),
      "sem o título da seção a citação vira 'trecho 47', que o corretor não consegue conferir",
    ).toEqual(["Carências", "Reembolso"]);
  });

  it("documento sem seção nenhuma ainda persiste — só sem âncora a oferecer", async () => {
    const chamadas = preparar({
      arquivo: "Texto corrido, sem título nenhum, mas que é material de verdade.",
      fonte: fonteReal(),
    });

    const r = await chamar();

    expect(r.chunkCount).toBe(1);
    const linhas = gravacoes(chamadas)[0]?.valores as Record<string, unknown>[];
    expect(linhas[0]?.["section_title"]).toBeNull();
    expect(linhas[0]?.["page_number"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reprocessar substitui, não empilha
// ---------------------------------------------------------------------------

describe("ingestPolicyFile · reprocessar o mesmo documento substitui (T083)", () => {
  it("a gravação usa o índice único (knowledge_source_id, position)", async () => {
    const chamadas = preparar({ arquivo: MANUAL, fonte: fonteReal() });

    await chamar();

    expect(
      (gravacoes(chamadas)[0]?.opcoes as { onConflict: string })?.onConflict,
      "sem o alvo de conflito, subir o mesmo manual de novo dobra as passagens",
    ).toBe("knowledge_source_id,position");
  });

  it("documento novo MENOR corta as posições que sobraram do anterior", async () => {
    const chamadas = preparar({
      arquivo: "# Carências\nAgora o manual só fala de carência.",
      fonte: fonteReal(),
    });

    await chamar();

    const corte = cortes(chamadas)[0];
    expect(
      corte,
      "sem o corte, a cauda do manual ANTIGO continua buscável dentro da fonte nova",
    ).toBeDefined();
    expect(corte?.filtros["gte:position"]).toBe(1);
    expect(corte?.filtros["eq:knowledge_source_id"]).toBe(FONTE);
    expect(corte?.filtros["eq:organization_id"]).toBe(ORG);
  });

  it("escreve ANTES de cortar — a fonte nunca fica sem passagem nenhuma (FR-006)", async () => {
    const chamadas = preparar({ arquivo: MANUAL, fonte: fonteReal() });

    await chamar();

    const iGravacao = chamadas.findIndex((c) => c.tabela === "ai_source_passages" && c.op === "upsert");
    const iCorte = chamadas.findIndex((c) => c.tabela === "ai_source_passages" && c.op === "delete");
    expect(iGravacao).toBeGreaterThan(-1);
    expect(
      iCorte,
      "apagar antes de escrever abre a janela em que o material do corretor some da busca",
    ).toBeGreaterThan(iGravacao);
  });
});

// ---------------------------------------------------------------------------
// O tenant vem da fonte
// ---------------------------------------------------------------------------

describe("ingestPolicyFile · tenant e escopo vêm da FONTE (CLAUDE.md §multi-tenancy)", () => {
  it("copia organization_id, scope_id e applies_to_all da linha da fonte", async () => {
    const chamadas = preparar({
      arquivo: MANUAL,
      fonte: fonteReal({ scope_id: ESCOPO, applies_to_all: false }),
    });

    await chamar();

    const linha = (gravacoes(chamadas)[0]?.valores as Record<string, unknown>[])[0]!;
    expect(linha["organization_id"]).toBe(ORG);
    expect(linha["scope_id"]).toBe(ESCOPO);
    expect(linha["applies_to_all"]).toBe(false);
  });

  it("material 'vale para todos' chega assim à passagem, não como escopo nulo mudo", async () => {
    const chamadas = preparar({
      arquivo: MANUAL,
      fonte: fonteReal({ scope_id: null, applies_to_all: true }),
    });

    await chamar();

    const linha = (gravacoes(chamadas)[0]?.valores as Record<string, unknown>[])[0]!;
    expect(linha["applies_to_all"]).toBe(true);
    expect(linha["scope_id"]).toBeNull();
  });

  it("argumento que discorda da fonte NÃO grava — seria material de um cliente no acervo de outro", async () => {
    const chamadas = preparar({
      arquivo: MANUAL,
      fonte: fonteReal({ organization_id: OUTRA_ORG }),
    });

    await expect(chamar()).rejects.toThrow(/não confere/i);
    expect(
      gravacoes(chamadas),
      "o client admin bypassa a RLS: aqui não há rede embaixo, a checagem é a rede",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Falhar em voz alta
// ---------------------------------------------------------------------------

describe("ingestPolicyFile · falha nunca passa por sucesso (FR-004)", () => {
  it("erro ao gravar as passagens estoura — não devolve contagem como se tivesse gravado", async () => {
    preparar({ arquivo: MANUAL, fonte: fonteReal(), erroNoUpsert: "deadlock detected" });

    await expect(chamar()).rejects.toThrow(/falha ao gravar passagens/i);
  });

  it("erro ao cortar as passagens excedentes estoura — sobra material velho invisível", async () => {
    preparar({ arquivo: MANUAL, fonte: fonteReal(), erroNoCorte: "permission denied" });

    await expect(chamar()).rejects.toThrow(/passagens excedentes/i);
  });

  it("fonte inexistente (UUID que não resolve) estoura em vez de gravar linha órfã", async () => {
    const chamadas = preparar({ arquivo: MANUAL, fonte: null });

    await expect(chamar()).rejects.toThrow(/não encontrada/i);
    expect(gravacoes(chamadas)).toEqual([]);
  });

  it("validação pré-insert (id que não é UUID) não grava e DIZ por quê", async () => {
    // É como a rota de upload chama: extrai só para poder recusar o arquivo antes de criar
    // registro. Sem linha de fonte não há `organization_id` confiável, e inventar um a
    // partir do argumento é a violação que o CLAUDE.md nomeia. Quem fecha o ciclo depois é
    // o rag-indexer, com a fonte já existindo.
    const chamadas = preparar({ arquivo: MANUAL, fonte: null });

    const r = await chamar({ knowledgeSourceId: "pre-insert-validation" });

    expect(r.naoPersistidoPorque).toBe("fonte_ainda_nao_existe");
    expect(r.chunkCount).toBe(2);
    expect(r.passagens).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// O corte em passagens
// ---------------------------------------------------------------------------

describe("dividirEmPassagens · o corte e a âncora", () => {
  it("todas as fatias de uma seção herdam o título dela", async () => {
    const longo = `# Carências\n\n${"Parágrafo sobre carência. ".repeat(120)}\n\n${"Outro parágrafo. ".repeat(120)}`;
    const passagens = dividirEmPassagens(longo);
    expect(passagens.length).toBeGreaterThan(1);
    expect(passagens.every((p) => p.sectionTitle === "Carências")).toBe(true);
  });

  it("texto antes do primeiro título fica sem âncora, e não herda a do título seguinte", async () => {
    const passagens = dividirEmPassagens("Introdução do manual.\n\n# Carências\nRegra.");
    expect(passagens[0]?.sectionTitle).toBeNull();
    expect(passagens[1]?.sectionTitle).toBe("Carências");
  });

  it("reconhece o formato pelo caminho do arquivo", () => {
    expect(resolverExtensao("org/abc.pdf")).toBe("pdf");
    expect(resolverExtensao("org/abc.md")).toBe("md");
    expect(resolverExtensao("org/abc.docx")).toBeNull();
    expect(resolverExtensao("org/abc")).toBeNull();
  });
});
