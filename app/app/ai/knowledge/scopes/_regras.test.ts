import { describe, expect, it } from "vitest";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";

import {
  CAMINHOS_DO_CATALOGO,
  ORIGEM_CATALOGO,
  ORIGEM_PROPRIA,
  TAMANHO_DA_LEITURA,
  TETO_DE_SEGURANCA,
  acaoDeMaterial,
  deveLerMais,
  faixaDaLeitura,
} from "./_regras";

/**
 * O que T091 e T100 acrescentaram à tela de operadoras.
 *
 * As regras que já existiam (filtro, origem, as quatro frases de estado) são testadas em
 * `tests/unit/escopos-tela-regras.test.ts`, junto do varredor de jargão — que passa a
 * cobrir `CAMINHOS_DO_CATALOGO` de graça, porque ela entrou em `TEXTO_FIXO_DA_TELA`.
 * Aqui ficam só as duas coisas novas: os caminhos que o corretor tem sobre o que veio
 * pronto, e o fim do teto de leitura.
 */

function escopo(sobre: Partial<EscopoDoTenant> = {}): EscopoDoTenant {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    display_name: "Amil",
    official_code: null,
    origin: ORIGEM_CATALOGO,
    is_active: true,
    materials_count: 4,
    own_materials_count: 0,
    ...sobre,
  };
}

describe("T091 — os dois caminhos sobre o que veio pronto", () => {
  it("a frase diz que não dá para editar E as duas saídas, antes de qualquer clique", () => {
    // A rota responde `403 escopo_do_catalogo_nao_editavel`. Descobrir isso pelo 403 é
    // descobrir depois de já ter tentado — e sem as saídas o corretor conclui que está
    // preso ao conteúdo errado.
    expect(CAMINHOS_DO_CATALOGO).toMatch(/não altera nem apaga/i);
    expect(CAMINHOS_DO_CATALOGO).toMatch(/desligar/i);
    expect(CAMINHOS_DO_CATALOGO).toMatch(/carregar material seu/i);
    // E diz quem vence, que é a razão de a sobreposição resolver o problema (FR-035).
    expect(CAMINHOS_DO_CATALOGO).toMatch(/vale o seu/i);
  });

  it("o segundo caminho tem porta: quem veio do catálogo sempre pode receber material próprio", () => {
    const acao = acaoDeMaterial(escopo({ materials_count: 4 }));
    expect(acao.texto).toBe("Carregar material seu sobre Amil");
    expect(acao.href).toContain("/app/ai/knowledge/sources");
  });

  it("mesmo desligado, o caminho de sobrepor continua à mão", () => {
    expect(acaoDeMaterial(escopo({ is_active: false })).texto).toBe(
      "Carregar material seu sobre Amil",
    );
  });

  it("ligado e sem material nenhum: o convite é seco, porque é o estado mais urgente", () => {
    expect(acaoDeMaterial(escopo({ is_active: true, materials_count: 0 })).texto).toBe(
      "Carregar material",
    );
  });

  it("operadora do próprio corretor não recebe o texto de sobreposição — não há o que sobrepor", () => {
    const acao = acaoDeMaterial(escopo({ origin: ORIGEM_PROPRIA, materials_count: 2 }));
    expect(acao.texto).toBe("Carregar mais material sobre Amil");
    expect(acao.texto).not.toContain("seu sobre");
  });

  it("o link leva a operadora junto, para o formulário do outro lado já vir com ela", () => {
    const acao = acaoDeMaterial(escopo({ id: "esc-42" }));
    expect(acao.href).toBe("/app/ai/knowledge/sources?escopo=esc-42");
  });
});

describe("T100 — a leitura não tem teto de produto", () => {
  it("lote cheio significa que pode haver mais: continua lendo", () => {
    // É esta linha que faz a operadora nº 201 existir na tela. Com a leitura única de
    // antes, ela não chegava ao browser — e a busca da tela, que filtra o que já veio,
    // também não a alcançava.
    expect(deveLerMais(TAMANHO_DA_LEITURA, TAMANHO_DA_LEITURA)).toBe(true);
  });

  it("lote incompleto é o fim da lista", () => {
    expect(deveLerMais(TAMANHO_DA_LEITURA - 1, TAMANHO_DA_LEITURA - 1)).toBe(false);
    expect(deveLerMais(0, TAMANHO_DA_LEITURA)).toBe(false);
  });

  it("o teto de segurança encerra, e existe só para a página não ser infinita", () => {
    expect(deveLerMais(TAMANHO_DA_LEITURA, TETO_DE_SEGURANCA)).toBe(false);
    expect(TETO_DE_SEGURANCA).toBeGreaterThan(TAMANHO_DA_LEITURA * 10);
  });

  it("as faixas são contíguas e não se sobrepõem — nenhuma linha lida duas vezes nem pulada", () => {
    const primeira = faixaDaLeitura(0);
    const segunda = faixaDaLeitura(1);

    expect(primeira).toEqual({ de: 0, ate: TAMANHO_DA_LEITURA - 1 });
    expect(segunda.de).toBe(primeira.ate + 1);
    expect(segunda.ate - segunda.de + 1).toBe(TAMANHO_DA_LEITURA);
  });
});
