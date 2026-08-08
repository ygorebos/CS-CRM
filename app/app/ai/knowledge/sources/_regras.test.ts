import { describe, expect, it } from "vitest";

import {
  AVISO_ORFAO,
  CHAVE_ORFA,
  CHAVE_TODAS,
  LIMITE_DA_PERGUNTA,
  LIMITE_DA_RESPOSTA,
  LIMITE_DE_PERGUNTAS,
  LIMITE_DO_NOME,
  MINUTOS_ATE_ESTRANHAR,
  TEXTO_FIXO_DA_TELA,
  agruparPorEscopo,
  caminhoDeNovaTentativa,
  caminhoDoNovoMaterial,
  corpoDoNovoMaterial,
  explicacaoDoGrupo,
  fraseDoResumo,
  podeTentarDeNovo,
  resumoDaTela,
  situacaoDoMaterial,
  subtitulo,
  tituloDeOrfaos,
  tituloDeTodas,
  type EscopoNaTela,
  type MaterialDoCorretor,
} from "./_regras";

/**
 * As decisões da tela de materiais (spec 002, T090 e T118).
 *
 * O caso que dá razão a este arquivo é o de `chunks_count: 0` com `status: "ready"`. Ele é o
 * defeito medido na spec (seção 5): o material sobe, a tela diz que salvou, e nada dele
 * vira conteúdo buscável. Nenhum teste de renderização pegaria isso — a tela desenharia o
 * card bonito do mesmo jeito. Por isso a regra é função pura, e por isso ela é testada
 * aqui antes de qualquer JSX.
 */

const AGORA = new Date("2026-08-08T12:00:00Z");

function material(sobre: Partial<MaterialDoCorretor> = {}): MaterialDoCorretor {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Manual da Amil",
    scope_id: "aaaaaaaa-1111-4111-8111-111111111111",
    applies_to_all: false,
    status: "ready",
    chunks_count: 12,
    last_index_status: "success",
    last_index_error: null,
    last_indexed_at: "2026-08-08T11:59:00Z",
    valid_until: null,
    is_active: true,
    // Recente de propósito: o padrão é um material que acabou de chegar, para o caso
    // "esperando há tempo demais" precisar dizer isso explicitamente no teste dele.
    created_at: "2026-08-08T11:58:00Z",
    ...sobre,
  };
}

function escopo(sobre: Partial<EscopoNaTela> = {}): EscopoNaTela {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    display_name: "Amil",
    origin: "catalogo",
    is_active: true,
    ...sobre,
  };
}

const ROTULO = { singular: "Operadora", plural: "Operadoras" };

// ---------------------------------------------------------------------------

describe("situacaoDoMaterial — FR-004: nada é aceito e descartado em silêncio", () => {
  it("material ACEITO que não virou nenhum trecho é PROBLEMA, não sucesso", () => {
    // O defeito medido na spec: 201 Created, tela verde, zero conteúdo buscável.
    const d = situacaoDoMaterial(material({ chunks_count: 0 }), AGORA);

    expect(d.estado).toBe("sem-trecho");
    expect(d.ehProblema).toBe(true);
    expect(d.respondeHoje).toBe(false);
    expect(d.tom).toBe("error");
    // E a frase precisa dizer a consequência, não só o sintoma.
    expect(d.explicacao).toContain("não responde nada");
    expect(d.oQueFazer).not.toBeNull();
  });

  it("material com trechos responde, e a tela diz QUANTOS (FR-005)", () => {
    const d = situacaoDoMaterial(material({ chunks_count: 12 }), AGORA);

    expect(d.estado).toBe("pronto");
    expect(d.respondeHoje).toBe(true);
    expect(d.ehProblema).toBe(false);
    expect(d.explicacao).toContain("12 trechos");
  });

  it("um trecho só não sai capenga", () => {
    expect(situacaoDoMaterial(material({ chunks_count: 1 }), AGORA).explicacao).toContain(
      "1 trecho ",
    );
  });

  it("falha carrega o motivo que o processamento gravou, como detalhe", () => {
    const d = situacaoDoMaterial(
      material({ status: "failed", last_index_status: "failed", last_index_error: "embed_failed@3" }),
      AGORA,
    );

    expect(d.estado).toBe("falhou");
    expect(d.ehProblema).toBe(true);
    expect(d.explicacao).toContain("embed_failed@3");
    expect(d.oQueFazer).toContain("Tente de novo");
  });

  it("a rodada que terminou marcando falha também conta como falha, mesmo com status 'ready'", () => {
    // É o que `workers/rag-indexer.ts` grava quando uma fonte não produz trecho nenhum:
    // `last_index_status: 'failed'` sem mexer no `status`. Ler só o `status` mostraria
    // "respondendo" para um material que não responde.
    const d = situacaoDoMaterial(
      material({ status: "ready", last_index_status: "failed", chunks_count: 0 }),
      AGORA,
    );
    expect(d.ehProblema).toBe(true);
    expect(d.respondeHoje).toBe(false);
  });

  it("recém-carregado está PREPARANDO, e isso não é problema de ninguém", () => {
    const d = situacaoDoMaterial(
      material({ chunks_count: 0, last_indexed_at: null, last_index_status: null, status: "building" }),
      AGORA,
    );

    expect(d.estado).toBe("processando");
    expect(d.ehProblema).toBe(false);
    expect(d.respondeHoje).toBe(false);
  });

  it("carregado há tempo demais e ainda sem nada VIRA problema — 'preparando' eterno é falha silenciosa", () => {
    const velho = new Date(AGORA.getTime() - (MINUTOS_ATE_ESTRANHAR + 1) * 60_000).toISOString();
    const d = situacaoDoMaterial(
      material({
        chunks_count: 0,
        last_indexed_at: null,
        last_index_status: null,
        status: "building",
        created_at: velho,
      }),
      AGORA,
    );

    expect(d.estado).toBe("parado");
    expect(d.ehProblema).toBe(true);
  });

  it("guardado pelo corretor não é problema: foi decisão dele", () => {
    const arquivado = situacaoDoMaterial(material({ status: "archived" }), AGORA);
    const desligado = situacaoDoMaterial(material({ is_active: false }), AGORA);

    for (const d of [arquivado, desligado]) {
      expect(d.estado).toBe("guardado");
      expect(d.ehProblema).toBe(false);
      expect(d.respondeHoje).toBe(false);
      expect(d.explicacao).toContain("Continua salvo");
    }
  });
});

describe("podeTentarDeNovo", () => {
  it("oferece nova tentativa onde repetir pode mudar o resultado", () => {
    expect(podeTentarDeNovo("falhou")).toBe(true);
    expect(podeTentarDeNovo("sem-trecho")).toBe(true);
    expect(podeTentarDeNovo("parado")).toBe(true);
  });

  it("NÃO oferece onde repetir não muda nada — botão inútil ensina a ignorar botão", () => {
    expect(podeTentarDeNovo("vencido")).toBe(false);
    expect(podeTentarDeNovo("pronto")).toBe(false);
    expect(podeTentarDeNovo("guardado")).toBe(false);
    expect(podeTentarDeNovo("processando")).toBe(false);
  });
});

describe("validade — FR-025 e FR-026", () => {
  it("SEM validade declarada, o material responde normalmente (datar é opcional)", () => {
    const d = situacaoDoMaterial(material({ valid_until: null }), AGORA);
    expect(d.estado).toBe("pronto");
    expect(d.respondeHoje).toBe(true);
  });

  it("validade vencida tira o material do ar e explica por quê", () => {
    const d = situacaoDoMaterial(material({ valid_until: "2026-07-01" }), AGORA);

    expect(d.estado).toBe("vencido");
    expect(d.respondeHoje).toBe(false);
    expect(d.ehProblema).toBe(true);
    expect(d.rotulo).toContain("Venceu em 01/07/2026");
    expect(d.oQueFazer).not.toBeNull();
  });

  it("perto de vencer ainda responde, mas avisa (FR-027)", () => {
    const d = situacaoDoMaterial(material({ valid_until: "2026-08-20" }), AGORA);

    expect(d.estado).toBe("pronto");
    expect(d.respondeHoje).toBe(true);
    expect(d.explicacao).toContain("Vence em 12 dias");
  });

  it("validade só é olhada depois do conteúdo: vencido E sem trecho aparece como sem trecho", () => {
    // A ordem importa para a ação: "carregue a versão nova" não resolve material que
    // nunca virou conteúdo nenhum.
    const d = situacaoDoMaterial(material({ chunks_count: 0, valid_until: "2026-01-01" }), AGORA);
    expect(d.estado).toBe("sem-trecho");
  });
});

describe("agruparPorEscopo — FR-003: N operadoras, N materiais, nenhum sumindo", () => {
  const amil = escopo({ id: "esc-a", display_name: "Amil" });
  const unimed = escopo({ id: "esc-u", display_name: "Unimed", origin: "proprio" });

  it("nenhum material desaparece da tela, aconteça o que acontecer", () => {
    const materiais = [
      material({ id: "m1", scope_id: "esc-a" }),
      material({ id: "m2", scope_id: "esc-u" }),
      material({ id: "m3", scope_id: null, applies_to_all: true }),
      // Operadora que não veio na leitura: o banco não deveria produzir isto, e mesmo
      // assim o material não pode sumir.
      material({ id: "m4", scope_id: "esc-fantasma" }),
    ];

    const grupos = agruparPorEscopo(materiais, [amil, unimed], ROTULO, AGORA);
    const ids = grupos.flatMap((g) => g.materiais.map((m) => m.material.id)).sort();

    expect(ids).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("material que vale para qualquer operadora tem card próprio", () => {
    const grupos = agruparPorEscopo(
      [material({ id: "m3", scope_id: null, applies_to_all: true })],
      [amil],
      ROTULO,
      AGORA,
    );
    const todas = grupos.find((g) => g.chave === CHAVE_TODAS);

    expect(todas?.titulo).toBe("Vale para qualquer operadora");
    expect(todas?.materiais).toHaveLength(1);
  });

  it("material sem dono conhecido cai no card de segurança, com nome que se entende", () => {
    const grupos = agruparPorEscopo([material({ scope_id: "sumiu" })], [], ROTULO, AGORA);
    const orfaos = grupos.find((g) => g.chave === CHAVE_ORFA);

    expect(orfaos?.titulo).toBe("Sem operadora");
    expect(orfaos?.materiais).toHaveLength(1);
  });

  it("operadora ligada sem material aparece — é o convite a carregar o primeiro", () => {
    const grupos = agruparPorEscopo([], [amil], ROTULO, AGORA);

    expect(grupos).toHaveLength(1);
    expect(grupos[0]?.materiais).toEqual([]);
    expect(explicacaoDoGrupo(grupos[0]!)).toContain("ainda sem material");
  });

  it("operadora desligada e sem material NÃO enche a tela", () => {
    expect(agruparPorEscopo([], [{ ...amil, is_active: false }], ROTULO, AGORA)).toEqual([]);
  });

  it("operadora desligada COM material aparece, e nada dela responde hoje (FR-008)", () => {
    const grupos = agruparPorEscopo(
      [material({ scope_id: "esc-a", chunks_count: 30 })],
      [{ ...amil, is_active: false }],
      ROTULO,
      AGORA,
    );

    expect(grupos[0]?.ligado).toBe(false);
    expect(grupos[0]?.respondemHoje).toBe(0);
    expect(explicacaoDoGrupo(grupos[0]!)).toContain("Desligado");
  });

  it("quem precisa de atenção vem primeiro — material quebrado no fim da página não é consertado", () => {
    const grupos = agruparPorEscopo(
      [
        material({ id: "ok", scope_id: "esc-a" }),
        material({ id: "quebrado", scope_id: "esc-u", chunks_count: 0 }),
      ],
      [amil, unimed],
      ROTULO,
      AGORA,
    );

    expect(grupos[0]?.titulo).toBe("Unimed");
    expect(grupos[0]?.problemas).toBe(1);
  });

  it("não há teto de quantas operadoras cabem (US4 cenário 3)", () => {
    const muitos = Array.from({ length: 120 }, (_, i) =>
      escopo({ id: `esc-${i}`, display_name: `Operadora ${String(i).padStart(3, "0")}` }),
    );
    const materiais = muitos.map((e, i) => material({ id: `m${i}`, scope_id: e.id }));

    const grupos = agruparPorEscopo(materiais, muitos, ROTULO, AGORA);
    expect(grupos).toHaveLength(120);
  });
});

describe("os números do topo", () => {
  it("somam por grupo e distinguem 'responde' de 'precisa de atenção'", () => {
    const grupos = agruparPorEscopo(
      [
        material({ id: "a", scope_id: "esc-a" }),
        material({ id: "b", scope_id: "esc-a", chunks_count: 0 }),
        material({ id: "c", scope_id: "esc-a", status: "archived" }),
      ],
      [escopo({ id: "esc-a" })],
      ROTULO,
      AGORA,
    );

    expect(resumoDaTela(grupos)).toEqual({ materiais: 3, respondemHoje: 1, problemas: 1 });
    expect(fraseDoResumo(resumoDaTela(grupos))).toBe("1 responde hoje, e 1 precisa da sua atenção.");
  });

  it("sem pendência, a frase diz isso em vez de somir com o número", () => {
    expect(fraseDoResumo({ materiais: 2, respondemHoje: 2, problemas: 0 })).toBe(
      "2 respondem hoje. Nada esperando por você.",
    );
  });
});

describe("corpoDoNovoMaterial — T118, e o requisito de não travar quem tem pressa", () => {
  const AGENTE = "agente-1";
  const base = {
    escopoId: "esc-a",
    nome: "Segunda via do boleto",
    pares: [{ pergunta: "Como tiro a segunda via?", resposta: "Pelo aplicativo, em Financeiro." }],
  };

  it("SEM validade o material passa, e a data vai nula (FR-025)", () => {
    const r = corpoDoNovoMaterial({ ...base, validade: "" }, AGENTE);

    expect(r.ok).toBe(true);
    expect(r.ok && r.corpo).toEqual({
      agent_id: AGENTE,
      name: "Segunda via do boleto",
      source_type: "faq",
      items: [{ question: "Como tiro a segunda via?", answer: "Pelo aplicativo, em Financeiro." }],
      valid_until: null,
    });
  });

  it("com validade, a data viaja no formato que a coluna aceita", () => {
    const r = corpoDoNovoMaterial({ ...base, validade: "2026-12-31" }, AGENTE);
    expect(r.ok && r.corpo.valid_until).toBe("2026-12-31");
  });

  it("espaço em branco no campo de data é 'sem validade', não erro", () => {
    const r = corpoDoNovoMaterial({ ...base, validade: "   " }, AGENTE);
    expect(r.ok && r.corpo.valid_until).toBeNull();
  });

  it("data mal formada é recusada AQUI, com frase de gente", () => {
    const r = corpoDoNovoMaterial({ ...base, validade: "31/12/2026" }, AGENTE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erro).toContain("dia/mês/ano");
  });

  it("nome e conteúdo continuam obrigatórios — o opcional é só a data", () => {
    expect(corpoDoNovoMaterial({ ...base, nome: " ", validade: "" }, AGENTE).ok).toBe(false);
    expect(corpoDoNovoMaterial({ ...base, pares: [], validade: "" }, AGENTE).ok).toBe(false);
  });

  it("linha em branco no fim do formulário não vira erro — ela é só descartada", () => {
    const r = corpoDoNovoMaterial(
      { ...base, pares: [...base.pares, { pergunta: "  ", resposta: "" }], validade: "" },
      AGENTE,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.corpo.items).toHaveLength(1);
  });

  it("par PELA METADE é recusado, não descartado em silêncio", () => {
    // Descartar salvaria um material que responde menos do que quem o escreveu acredita —
    // a versão pequena do defeito que FR-004 proíbe.
    const semResposta = corpoDoNovoMaterial(
      { ...base, pares: [{ pergunta: "E a carteirinha?", resposta: "  " }], validade: "" },
      AGENTE,
    );
    expect(semResposta.ok).toBe(false);
    expect(!semResposta.ok && semResposta.erro).toContain("E a carteirinha?");

    const semPergunta = corpoDoNovoMaterial(
      { ...base, pares: [{ pergunta: "", resposta: "Está no aplicativo." }], validade: "" },
      AGENTE,
    );
    expect(semPergunta.ok).toBe(false);
  });

  it("tamanho é declarado e conferido ANTES do envio (FR-007)", () => {
    const r = corpoDoNovoMaterial(
      {
        ...base,
        pares: [{ pergunta: "Cabe?", resposta: "x".repeat(LIMITE_DA_RESPOSTA + 1) }],
        validade: "",
      },
      AGENTE,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.erro).toContain("Divida em duas perguntas");
  });

  it("os tetos são os mesmos que a rota aplica — divergir é recusa depois de digitar", () => {
    // Espelho de `itemDeFaqSchema` e `materialColadoSchema`, em
    // `app/api/v1/knowledge-scopes/_escopos.ts`.
    expect([LIMITE_DO_NOME, LIMITE_DA_PERGUNTA, LIMITE_DA_RESPOSTA, LIMITE_DE_PERGUNTAS]).toEqual([
      120, 2_000, 20_000, 500,
    ]);
  });

  it("o agente vai no corpo porque a rota o exige — sem ele o pedido é recusado", () => {
    const r = corpoDoNovoMaterial({ ...base, validade: "" }, "agente-7");
    expect(r.ok && r.corpo.agent_id).toBe("agente-7");
  });
});

describe("os caminhos são os do contrato", () => {
  it("material novo vai para a rota da operadora", () => {
    expect(caminhoDoNovoMaterial("esc-a")).toBe("/api/v1/knowledge-scopes/esc-a/materials");
  });

  it("nova tentativa usa a rota de reprocessamento que já existe", () => {
    expect(caminhoDeNovaTentativa("m1")).toBe("/api/v1/ai/knowledge/sources/m1/reindex");
  });
});

describe("o texto da tela não fala a nossa língua", () => {
  /** Palavras do desenho interno. Nenhuma delas pode chegar à tela do corretor. */
  const JARGAO = [
    /\bchunks?\b/i,
    /\bembeddings?\b/i,
    /\bindexa\w*\b/i,
    /\breindexa\w*\b/i,
    /\bgrounding\b/i,
    /\bguardrails?\b/i,
    /\blastro\b/i,
    /\bescopos?\b/i,
    /\brag\b/i,
    /\bvetor(?:es|ial)?\b/i,
    /\btenants?\b/i,
    /\bendpoints?\b/i,
    /\bpayloads?\b/i,
    /\bupload\b/i,
    /\bdeploy\b/i,
  ];

  const frases = [
    ...TEXTO_FIXO_DA_TELA,
    subtitulo(ROTULO),
    tituloDeTodas(ROTULO),
    tituloDeOrfaos(ROTULO),
    AVISO_ORFAO,
    ...(
      [
        material(),
        material({ chunks_count: 0 }),
        material({ status: "failed", last_index_error: "embed_failed@3" }),
        material({ status: "archived" }),
        material({ valid_until: "2026-01-01" }),
        material({ chunks_count: 0, last_indexed_at: null, last_index_status: null, status: "building" }),
      ] as MaterialDoCorretor[]
    ).flatMap((m) => {
      const d = situacaoDoMaterial(m, AGORA);
      return [d.rotulo, d.explicacao, d.oQueFazer ?? ""];
    }),
  ].filter((f) => f !== "");

  it.each(frases)("«%s» não usa jargão do produto", (frase) => {
    const achados = JARGAO.filter((r) => r.test(frase)).map((r) => r.source);
    expect(achados, `jargão em: "${frase}"`).toEqual([]);
  });

  it("nenhuma frase concorda em gênero com o rótulo configurável", () => {
    // Mesma regra da tela vizinha: "Operadora" é feminino, "Convênio" e "Fornecedor" não.
    const proibidos = /\b(esta|essa|aquela|ligada|desligada|ativada|desativada|inativa)\b/i;
    expect(frases.filter((f) => proibidos.test(f))).toEqual([]);
  });

  it("o rótulo da entidade vem do vocabulário, e não cravado no texto", () => {
    expect(tituloDeTodas({ singular: "Convênio", plural: "Convênios" })).toBe(
      "Vale para qualquer convênio",
    );
    expect(subtitulo({ singular: "Fornecedor", plural: "Fornecedores" })).toContain(
      "por fornecedor",
    );
  });
});
