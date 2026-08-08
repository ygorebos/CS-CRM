/**
 * A REGRA do worker `catalog-reindexer` (spec 002, T057).
 *
 * `catalog_chunks.embedding` viaja pronto dentro do `baseline.sql`, e ao lado dele mora
 * `embedding_model`. Vetor só é comparável com vetor do mesmo modelo: no dia em que a
 * instalação trocar de modelo de embedding, a pergunta do cliente será vetorizada por um
 * e o acervo continuará vetorizado por outro. A busca de lastro não dá erro — devolve
 * vizinhos sem sentido, o portão de lastro recusa a afirmação, e o corretor conclui que
 * "a IA não sabe nada".
 *
 * O que se guarda aqui é o COMPORTAMENTO, com um dublê do client que registra as
 * chamadas. Cada caso existe porque errar nele recria um defeito diferente:
 *
 *   1. acervo em dia ⇒ nenhuma chamada de IA, nenhuma escrita — é a rodada NORMAL, que
 *      acontece a cada 15 min para sempre; se ela custasse re-embedagem, uma manutenção
 *      rara viraria custo recorrente sem dono;
 *   2. re-embeda só o que diverge, e o UPDATE carrega `neq embedding_model` como claim —
 *      sem ele, dois ticks sobrepostos pagam duas vezes pelo mesmo trecho;
 *   3. sem chave de IA ⇒ NÃO chama o provedor e abre aviso na Central — travar em
 *      silêncio é o defeito que o worker existe para não cometer;
 *   4. vetor de dimensão diferente ⇒ NÃO grava nada e trava — gravar pela metade deixa
 *      o acervo com dois modelos misturados, que é pior que o estado anterior;
 *   5. provedor falha ⇒ para a rodada no primeiro erro, não martela o lote inteiro;
 *   6. aviso é deduplicado por organização — item repetido a cada 15 min ensina o
 *      corretor a ignorar a Central inteira;
 *   7. quem não ligou nenhuma operadora não é avisado — não é afetado, e alarme sobre
 *      coisa que o usuário nem ligou é a pior primeira impressão possível;
 *   8. quando o acervo converge, os avisos abertos se fecham sozinhos — aviso que não
 *      some quando o problema some vira mentira permanente.
 */
import { describe, expect, it } from "vitest";

import {
  DIMENSAO_DO_CATALOGO,
  KIND_DO_AVISO,
  REF_KIND_DO_AVISO,
  reindexarCatalogo,
} from "@/workers/catalog-reindexer";

const MODELO_NOVO = "openai/text-embedding-3-small";

interface Chamada {
  tabela: string;
  op: "select" | "update" | "insert";
  filtros: Record<string, unknown>;
  valores?: unknown;
  opcoes?: unknown;
  limite?: number;
}

interface Dados {
  /** Quantos trechos divergem do modelo de hoje (resposta do count). */
  divergentes?: number;
  /** Os trechos que a busca do lote devolve. */
  trechos?: { id: string; content: string }[];
  /** `null` = o UPDATE não pegou a linha (corrida perdida). */
  updateAplica?: boolean;
  /** Organizações com espelho de catálogo ATIVO. */
  orgsDependentes?: { organization_id: string }[];
  /** Organizações que já têm aviso aberto. */
  avisosAbertos?: { organization_id: string }[];
  /** Avisos que a auto-cura fecharia. */
  avisosResolviveis?: { id: string }[];
}

/**
 * Dublê mínimo do client: imita só a fatia do PostgREST que a regra usa. Método não
 * previsto simplesmente não existe, para o teste não passar por engano sobre um caminho
 * que ele não modela.
 */
function clientDuble(dados: Dados) {
  const chamadas: Chamada[] = [];

  function from(tabela: string) {
    const filtros: Record<string, unknown> = {};
    let op: Chamada["op"] = "select";
    let valores: unknown;
    let opcoes: unknown;
    let limite: number | undefined;

    function registrar(): void {
      chamadas.push({ tabela, op, filtros, valores, opcoes, limite });
    }

    function resolver(): unknown {
      registrar();

      if (tabela === "catalog_chunks" && op === "select") {
        if ((opcoes as { head?: boolean } | undefined)?.head) {
          return { count: dados.divergentes ?? 0, error: null };
        }
        return { data: (dados.trechos ?? []).slice(0, limite ?? 999), error: null };
      }
      if (tabela === "catalog_chunks" && op === "update") {
        const pegou = dados.updateAplica ?? true;
        return { data: pegou ? [{ id: filtros["eq:id"] }] : [], error: null };
      }
      if (tabela === "knowledge_scopes") {
        return { data: dados.orgsDependentes ?? [], error: null };
      }
      if (tabela === "agent_inbox_items" && op === "select") {
        return { data: dados.avisosAbertos ?? [], error: null };
      }
      if (tabela === "agent_inbox_items" && op === "update") {
        return { data: dados.avisosResolviveis ?? [], error: null };
      }
      throw new Error(`dublê não modela ${op} em ${tabela}`);
    }

    const cadeia: Record<string, unknown> = {
      select(_colunas?: string, o?: unknown) {
        opcoes = o ?? opcoes;
        return cadeia;
      },
      update(v: unknown) {
        op = "update";
        valores = v;
        return cadeia;
      },
      insert(v: unknown) {
        op = "insert";
        valores = v;
        registrar();
        return Promise.resolve({ data: null, error: null });
      },
      eq(coluna: string, valor: unknown) {
        filtros[`eq:${coluna}`] = valor;
        return cadeia;
      },
      neq(coluna: string, valor: unknown) {
        filtros[`neq:${coluna}`] = valor;
        return cadeia;
      },
      in(coluna: string, valor: unknown) {
        filtros[`in:${coluna}`] = valor;
        return cadeia;
      },
      not(coluna: string, operador: string, valor: unknown) {
        filtros[`not:${coluna}:${operador}`] = valor;
        return cadeia;
      },
      order(coluna: string) {
        filtros["order"] = coluna;
        return cadeia;
      },
      limit(n: number) {
        limite = n;
        return cadeia;
      },
      then(resolve: (r: unknown) => unknown) {
        return Promise.resolve(resolve(resolver()));
      },
    };
    return cadeia;
  }

  return { client: { from } as never, chamadas };
}

/** Vetor do tamanho certo, sem depender de provedor nenhum. */
function vetorOk(): number[] {
  return new Array(DIMENSAO_DO_CATALOGO).fill(0.01);
}

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function trecho(id: string) {
  return { id, content: `conteúdo do trecho ${id}` };
}

describe("catalog-reindexer", () => {
  it("acervo em dia ⇒ nenhuma chamada de IA e nenhuma escrita (a rodada normal é grátis)", async () => {
    let chamadasAoProvedor = 0;
    const { client, chamadas } = clientDuble({ divergentes: 0 });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder: async () => {
        chamadasAoProvedor++;
        return vetorOk();
      },
    });

    expect(chamadasAoProvedor).toBe(0);
    expect(r.reembeddados).toBe(0);
    expect(r.divergentes).toBe(0);
    expect(r.travado).toBeNull();
    // Só a contagem e a varredura de auto-cura. Nenhuma escrita em catalog_chunks.
    expect(chamadas.filter((c) => c.tabela === "catalog_chunks" && c.op !== "select")).toEqual([]);
  });

  it("a contagem pergunta pelo que DIVERGE do modelo de hoje, sem baixar o acervo", async () => {
    const { client, chamadas } = clientDuble({ divergentes: 0 });
    await reindexarCatalogo(client, { modelo: MODELO_NOVO, provedorConfigurado: () => true });

    const contagem = chamadas.find((c) => c.tabela === "catalog_chunks");
    expect(contagem?.filtros["neq:embedding_model"]).toBe(MODELO_NOVO);
    // `head: true` — baixar os trechos (com `embedding` junto) só para contá-los pagaria
    // o acervo inteiro em payload a cada tick.
    expect((contagem?.opcoes as { head?: boolean } | undefined)?.head).toBe(true);
  });

  it("re-embeda os divergentes e grava com claim atômico em neq embedding_model", async () => {
    const { client, chamadas } = clientDuble({
      divergentes: 2,
      trechos: [trecho("a"), trecho("b")],
      orgsDependentes: [{ organization_id: ORG_A }],
      avisosResolviveis: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder: async () => vetorOk(),
    });

    const updates = chamadas.filter((c) => c.tabela === "catalog_chunks" && c.op === "update");
    expect(updates).toHaveLength(2);
    expect((updates[0]?.valores as { embedding_model: string }).embedding_model).toBe(MODELO_NOVO);
    // Sem este claim, dois ticks sobrepostos pagariam duas vezes pela mesma re-embedagem.
    expect(
      updates[0]?.filtros["neq:embedding_model"],
      "o UPDATE precisa carregar neq embedding_model — senão duas rodadas simultâneas re-embedam o mesmo trecho",
    ).toBe(MODELO_NOVO);
    expect(r.reembeddados).toBe(2);
    expect(r.restantes).toBe(0);
    expect(r.travado).toBeNull();
  });

  it("o UPDATE que não pegou nada não conta como reprocessado (a corrida perdida é silenciosa)", async () => {
    const { client } = clientDuble({
      divergentes: 1,
      trechos: [trecho("a")],
      updateAplica: false,
      orgsDependentes: [{ organization_id: ORG_A }],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder: async () => vetorOk(),
    });

    expect(r.reembeddados).toBe(0);
    expect(r.restantes).toBe(1);
  });

  it("sem chave de IA ⇒ não chama o provedor e abre aviso na Central", async () => {
    let chamadasAoProvedor = 0;
    const { client, chamadas } = clientDuble({
      divergentes: 3,
      orgsDependentes: [{ organization_id: ORG_A }, { organization_id: ORG_B }],
      avisosAbertos: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => false,
      embedder: async () => {
        chamadasAoProvedor++;
        return vetorOk();
      },
    });

    expect(chamadasAoProvedor).toBe(0);
    expect(r.travado).toBe("embed_indisponivel");
    expect(r.restantes).toBe(3);

    const avisos = chamadas.filter((c) => c.tabela === "agent_inbox_items" && c.op === "insert");
    expect(avisos).toHaveLength(1);
    const linhas = avisos[0]?.valores as { organization_id: string; kind: string; ref_kind: string; body: string }[];
    expect(linhas.map((l) => l.organization_id).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(linhas[0]?.kind).toBe(KIND_DO_AVISO);
    expect(linhas[0]?.ref_kind).toBe(REF_KIND_DO_AVISO);
    // O corpo tem que dizer o que FAZER, não só o que quebrou.
    expect(linhas[0]?.body).toContain("OPENAI_API_KEY");
    expect(r.avisos_abertos).toBe(2);
  });

  it("só avisa quem depende do catálogo — espelho desligado não recebe alarme", async () => {
    // Espelho de catálogo nasce DESLIGADO (A-20). Numa instalação recém-feita ninguém
    // ligou operadora nenhuma, e alarmar sobre acervo que o usuário nem consulta é a pior
    // primeira impressão possível.
    const { client, chamadas } = clientDuble({
      divergentes: 5,
      orgsDependentes: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => false,
    });

    expect(r.travado).toBe("embed_indisponivel");
    expect(r.avisos_abertos).toBe(0);
    expect(chamadas.filter((c) => c.tabela === "agent_inbox_items" && c.op === "insert")).toEqual([]);

    // E a consulta pergunta pelo vínculo certo: espelho de catálogo ATIVO.
    const escopos = chamadas.find((c) => c.tabela === "knowledge_scopes");
    expect(escopos?.filtros["eq:is_active"]).toBe(true);
    expect(escopos?.filtros["not:catalog_scope_id:is"]).toBeNull();
  });

  it("organização que já tem aviso aberto não recebe outro (a Central não vira ruído)", async () => {
    const { client, chamadas } = clientDuble({
      divergentes: 2,
      orgsDependentes: [{ organization_id: ORG_A }, { organization_id: ORG_B }],
      avisosAbertos: [{ organization_id: ORG_A }],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => false,
    });

    const avisos = chamadas.filter((c) => c.tabela === "agent_inbox_items" && c.op === "insert");
    const linhas = avisos[0]?.valores as { organization_id: string }[];
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.organization_id).toBe(ORG_B);
    expect(r.avisos_abertos).toBe(1);
  });

  it("vetor de dimensão diferente ⇒ NÃO grava nada e trava", async () => {
    // Gravar metade do acervo num modelo e metade em outro é pior que o estado anterior:
    // os dois lados deixam de ser comparáveis entre si, e não há como saber qual é qual
    // sem reprocessar tudo.
    const { client, chamadas } = clientDuble({
      divergentes: 4,
      trechos: [trecho("a"), trecho("b")],
      orgsDependentes: [{ organization_id: ORG_A }],
      avisosAbertos: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: "openai/text-embedding-3-large",
      provedorConfigurado: () => true,
      embedder: async () => new Array(3072).fill(0.01),
    });

    expect(r.travado).toBe("dimensao_incompativel");
    expect(r.reembeddados).toBe(0);
    expect(chamadas.filter((c) => c.tabela === "catalog_chunks" && c.op === "update")).toEqual([]);
    expect(r.detalhe).toContain("3072");
    expect(r.avisos_abertos).toBe(1);
  });

  it("provedor falhando ⇒ para no primeiro erro, não martela o lote inteiro", async () => {
    let tentativas = 0;
    const { client } = clientDuble({
      divergentes: 10,
      trechos: [trecho("a"), trecho("b"), trecho("c"), trecho("d")],
      orgsDependentes: [{ organization_id: ORG_A }],
      avisosAbertos: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder: async () => {
        tentativas++;
        throw new Error("429 rate limit do provedor");
      },
    });

    expect(
      tentativas,
      "quando o provedor está fora, as chamadas seguintes vão falhar igual — e cada uma custa tempo do tick",
    ).toBe(1);
    expect(r.travado).toBe("provedor_falhou");
    expect(r.detalhe).toContain("429");
    expect(r.avisos_abertos).toBe(1);
  });

  it("o que já foi regravado antes da falha permanece regravado", async () => {
    let tentativas = 0;
    const { client, chamadas } = clientDuble({
      divergentes: 3,
      trechos: [trecho("a"), trecho("b"), trecho("c")],
      orgsDependentes: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder: async () => {
        tentativas++;
        if (tentativas > 2) throw new Error("provedor caiu no meio");
        return vetorOk();
      },
    });

    expect(chamadas.filter((c) => c.tabela === "catalog_chunks" && c.op === "update")).toHaveLength(2);
    expect(r.reembeddados).toBe(2);
    expect(r.restantes).toBe(1);
    expect(r.travado).toBe("provedor_falhou");
  });

  it("lote maior que o teto não é buscado inteiro — o resto vai na rodada seguinte", async () => {
    const { client, chamadas } = clientDuble({
      divergentes: 500,
      trechos: [trecho("a")],
      orgsDependentes: [],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      lote: 1,
      provedorConfigurado: () => true,
      embedder: async () => vetorOk(),
    });

    const busca = chamadas.find(
      (c) => c.tabela === "catalog_chunks" && c.op === "select" && c.limite !== undefined,
    );
    expect(busca?.limite).toBe(1);
    expect(r.restantes).toBe(499);
    // Ainda falta acervo: o trabalho está ANDANDO, não pronto — nada de fechar aviso.
    expect(r.avisos_resolvidos).toBe(0);
  });

  it("quando o acervo converge, os avisos abertos se fecham sozinhos", async () => {
    // Aviso que não some quando o problema some vira mentira permanente, e ensina o
    // corretor a ignorar a Central inteira.
    const { client, chamadas } = clientDuble({
      divergentes: 0,
      avisosResolviveis: [{ id: "aviso-1" }, { id: "aviso-2" }],
    });

    const r = await reindexarCatalogo(client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
    });

    expect(r.avisos_resolvidos).toBe(2);
    const cura = chamadas.find((c) => c.tabela === "agent_inbox_items" && c.op === "update");
    expect((cura?.valores as { status: string }).status).toBe("resolved");
    expect(cura?.filtros["eq:ref_kind"]).toBe(REF_KIND_DO_AVISO);
    expect(cura?.filtros["eq:status"]).toBe("open");
  });

  it("rodar duas vezes seguidas não refaz trabalho (idempotência)", async () => {
    let chamadasAoProvedor = 0;
    const embedder = async () => {
      chamadasAoProvedor++;
      return vetorOk();
    };

    // 1ª rodada: dois trechos divergem e são convertidos.
    const primeira = clientDuble({
      divergentes: 2,
      trechos: [trecho("a"), trecho("b")],
      orgsDependentes: [],
      avisosResolviveis: [],
    });
    await reindexarCatalogo(primeira.client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder,
    });
    expect(chamadasAoProvedor).toBe(2);

    // 2ª rodada: como os dois convergiram, o conjunto divergente está vazio — e é o
    // PRÓPRIO filtro `neq embedding_model` que os tira da vista, não uma marca de
    // controle que alguém precisaria lembrar de escrever.
    const segunda = clientDuble({ divergentes: 0, avisosResolviveis: [] });
    const r = await reindexarCatalogo(segunda.client, {
      modelo: MODELO_NOVO,
      provedorConfigurado: () => true,
      embedder,
    });

    expect(chamadasAoProvedor).toBe(2);
    expect(r.reembeddados).toBe(0);
    expect(segunda.chamadas.filter((c) => c.tabela === "catalog_chunks" && c.op === "update")).toEqual([]);
  });
});
