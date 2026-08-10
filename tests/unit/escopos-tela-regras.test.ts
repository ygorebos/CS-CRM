import { describe, expect, it } from "vitest";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";
import {
  ORIGEM_CATALOGO,
  ORIGEM_PROPRIA,
  TEXTO_FIXO_DA_TELA,
  avisoDeAlternancia,
  explicacaoDoEstado,
  filtrarEscopos,
  rotuloDaOrigem,
  rotuloDoInterruptor,
} from "@/app/app/ai/knowledge/scopes/_regras";

/**
 * As decisões de texto e de filtro da tela de escopos (spec 002, T068).
 *
 * O teste que mais importa aqui é o do JARGÃO. O corretor de plano de saúde não sabe o que
 * é "lastro", "chunk", "embedding" nem "escopo de conhecimento" — essas são palavras
 * NOSSAS, do desenho interno, e uma tela que as usa não fica difícil: fica fechada. Como
 * cópia é a coisa que mais muda depois do merge (e a que menos gente revisa), a proibição
 * precisa ser mecânica.
 */

function escopo(sobre: Partial<EscopoDoTenant> = {}): EscopoDoTenant {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    display_name: "Amil",
    official_code: null,
    origin: ORIGEM_CATALOGO,
    is_active: false,
    materials_count: 0,
    own_materials_count: 0,
    ...sobre,
  };
}

/** Palavras do desenho interno. Nenhuma delas pode chegar à tela do corretor. */
const JARGAO = [
  /\bchunks?\b/i,
  /\bembeddings?\b/i,
  /\bgrounding\b/i,
  /\bguardrails?\b/i,
  /\blastro\b/i,
  /\bescopos?\b/i,
  /\brag\b/i,
  /\bvetor(?:es|ial)?\b/i,
  /\btenants?\b/i,
  /\bendpoints?\b/i,
  /\bpayloads?\b/i,
];

describe("o texto da tela não fala a nossa língua", () => {
  const frases = [
    ...TEXTO_FIXO_DA_TELA,
    rotuloDaOrigem(ORIGEM_CATALOGO),
    rotuloDaOrigem(ORIGEM_PROPRIA),
    rotuloDoInterruptor(escopo()),
    rotuloDoInterruptor(escopo({ is_active: true })),
    avisoDeAlternancia("Amil", true),
    avisoDeAlternancia("Amil", false),
    explicacaoDoEstado(escopo()),
    explicacaoDoEstado(escopo({ materials_count: 1 })),
    explicacaoDoEstado(escopo({ is_active: true })),
    explicacaoDoEstado(escopo({ is_active: true, materials_count: 12 })),
  ];

  it.each(frases)("«%s» não usa jargão do produto", (frase) => {
    const achados = JARGAO.filter((r) => r.test(frase)).map((r) => r.source);
    expect(achados, `jargão em: "${frase}"`).toEqual([]);
  });

  it("nenhuma frase concorda em gênero com o rótulo configurável", () => {
    // "Operadora" é feminino, mas outra instalação configura "Convênio" ou "Fornecedor"
    // (FR-033/FR-041). Uma frase com "esta"/"ligada"/"desativada" viraria erro de português
    // lá — por isso as frases falam do NOME, nunca do rótulo com pronome ou adjetivo colado.
    const proibidos = /\b(esta|essa|aquela|ligada|desligada|ativada|desativada|inativa)\b/i;
    const comConcordancia = frases.filter((f) => proibidos.test(f));
    expect(comConcordancia).toEqual([]);
  });
});

describe("explicacaoDoEstado", () => {
  it("ligado e com material: diz o que o agente faz, e com quanta coisa", () => {
    expect(explicacaoDoEstado(escopo({ is_active: true, materials_count: 12 }))).toBe(
      "O agente responde sobre Amil usando 12 materiais.",
    );
  });

  it("ligado e SEM material: avisa que o interruptor sozinho não resolve", () => {
    // O estado mais traiçoeiro dos quatro — está do jeito certo e mesmo assim não funciona.
    expect(explicacaoDoEstado(escopo({ is_active: true }))).toBe(
      "Ligado, mas ainda sem material: o agente não tem o que responder sobre Amil.",
    );
  });

  it("desligado: diz a consequência de atendimento E que nada foi perdido (FR-008)", () => {
    const frase = explicacaoDoEstado(escopo({ materials_count: 3 }));
    expect(frase).toContain("o agente não responde sobre Amil");
    expect(frase).toContain("continuam salvos");
  });

  it("singular de 1 material não sai capenga", () => {
    expect(explicacaoDoEstado(escopo({ is_active: true, materials_count: 1 }))).toContain(
      "1 material.",
    );
    expect(explicacaoDoEstado(escopo({ materials_count: 1 }))).toContain(
      "O material continua salvo",
    );
  });
});

describe("rotuloDaOrigem — FR-039, a quem cobrar a correção", () => {
  it("distingue o que veio pronto do que o corretor adicionou", () => {
    expect(rotuloDaOrigem(ORIGEM_CATALOGO)).toBe("Já vem no sistema");
    expect(rotuloDaOrigem(ORIGEM_PROPRIA)).toBe("Você adicionou");
    expect(rotuloDaOrigem(ORIGEM_CATALOGO)).not.toBe(rotuloDaOrigem(ORIGEM_PROPRIA));
  });

  it("os dois valores de origin são os do contrato, em português", () => {
    // `contracts/rotas-http.md`. Trocar por "catalog"/"own" quebraria a projeção da rota
    // sem quebrar nenhuma renderização — o tipo de defeito que só aparece em produção.
    expect(ORIGEM_CATALOGO).toBe("catalogo");
    expect(ORIGEM_PROPRIA).toBe("proprio");
  });
});

describe("filtrarEscopos", () => {
  const lista = [
    escopo({ id: "a", display_name: "São Francisco Saúde" }),
    escopo({ id: "b", display_name: "Amil", official_code: "326305" }),
    escopo({ id: "c", display_name: "Unimed" }),
  ];

  it("ignora acento e caixa — quem digita rápido não digita acento", () => {
    expect(filtrarEscopos(lista, "sao").map((e) => e.id)).toEqual(["a"]);
    expect(filtrarEscopos(lista, "UNIMED").map((e) => e.id)).toEqual(["c"]);
  });

  it("acha pelo código oficial, não só pelo nome comercial", () => {
    expect(filtrarEscopos(lista, "326305").map((e) => e.id)).toEqual(["b"]);
  });

  it("termo vazio devolve tudo, sem reordenar", () => {
    expect(filtrarEscopos(lista, "  ").map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("sem resultado devolve lista vazia, não a lista inteira", () => {
    expect(filtrarEscopos(lista, "bradesco")).toEqual([]);
  });
});
