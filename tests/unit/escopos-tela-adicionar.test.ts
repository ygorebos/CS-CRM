import { describe, expect, it } from "vitest";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";
import {
  ADICIONAR_AJUDA,
  ADICIONAR_TITULO,
  NOME_REPETIDO,
  ORIGEM_PROPRIA,
  VAZIO_TEXTO,
  avisoDeCriacao,
  nomeJaExiste,
  podeAdicionar,
} from "@/app/app/ai/knowledge/scopes/_regras";

/**
 * A porta que faltava — FR-002 pela tela.
 *
 * ═══ O DEFEITO, E POR QUE ELE ERA INVISÍVEL ═══
 *
 * `POST /api/v1/knowledge-scopes` existia, era testada e cumpria FR-002 ("criar custa
 * informar o nome"). O que não existia era **um botão que chegasse até ela**: a tela de
 * Operadoras listava, ligava, desligava e removia — tudo sobre o que a instalação já tinha
 * trazido. O corretor conseguia mexer no que veio pronto e não conseguia adicionar o que
 * ele mesmo vende. Medido em 2026-08-09, varrendo a tela.
 *
 * Rota sem porta e tela inexistente são a mesma coisa para quem usa. É por isso que este
 * arquivo mede a REGRA da tela, e o e2e mede o gesto: um teste de rota jamais notaria a
 * ausência de um botão.
 *
 * ═══ O BECO QUE O ESTADO VAZIO CRIAVA ═══
 *
 * A cópia do estado vazio mandava "comece carregando um material em Conhecimento". Só que
 * a tela de Conhecimento exige um nome LIGADO para carregar material — e o corretor sem
 * nome nenhum voltava para cá. Duas telas apontando uma para a outra é pior que uma tela
 * sem saída, porque parece caminho.
 */
function escopo(nome: string): EscopoDoTenant {
  return {
    id: `id-${nome}`,
    display_name: nome,
    official_code: null,
    origin: ORIGEM_PROPRIA,
    is_active: true,
    materials_count: 0,
    own_materials_count: 0,
  };
}

describe("adicionar operadora pelo nome (FR-002)", () => {
  it("o nome é o único requisito — é isso que FR-002 quer dizer", () => {
    expect(podeAdicionar("Amil")).toBe(true);
    // Sem código oficial, sem categoria, sem nada: a função só olha o nome.
    expect(podeAdicionar("Plano da esquina")).toBe(true);
  });

  it("nome vazio ou só espaço não passa — e o espaço é o caso que escapa", () => {
    expect(podeAdicionar("")).toBe(false);
    expect(podeAdicionar("   ")).toBe(false);
    expect(podeAdicionar("\n\t ")).toBe(false);
  });

  it("respeita o teto de 120 do schema da rota — o botão não promete o que o 422 recusa", () => {
    // Deixar o botão habilitado até 121 caracteres transformaria um limite conhecido numa
    // ida à rede que volta como erro de validação. O teto vive nos dois lados de propósito.
    expect(podeAdicionar("a".repeat(120))).toBe(true);
    expect(podeAdicionar("a".repeat(121))).toBe(false);
  });

  it("nome repetido é dito ANTES da ida — o 409 da rota continua valendo", () => {
    const lista = [escopo("Amil"), escopo("Bradesco Saúde")];
    expect(nomeJaExiste(lista, "Amil")).toBe(true);
    // Caixa e espaço não fazem dois nomes diferentes para quem lê a lista.
    expect(nomeJaExiste(lista, "  amil ")).toBe(true);
    expect(nomeJaExiste(lista, "AMIL")).toBe(true);
    expect(nomeJaExiste(lista, "Unimed")).toBe(false);
  });

  it("a checagem local NÃO substitui o 409 — ela só evita a ida óbvia", () => {
    // A lista do browser é um retrato; outra aba (ou outra pessoa da mesma organização)
    // pode ter criado o nome no meio. Por isso a regra é "diz antes quando dá para saber",
    // e nunca "a rota pode confiar que o cliente conferiu".
    expect(nomeJaExiste([], "Amil")).toBe(false);
  });

  it("o aviso diz o estado E o próximo passo — nome sozinho não responde a cliente nenhum", () => {
    const aviso = avisoDeCriacao("Amil");
    expect(aviso).toContain("Amil");
    expect(aviso).toContain("ligada");
    // Sem material, ligar não muda o que o agente sabe. O aviso que para em "criada com
    // sucesso" deixa o corretor achando que terminou.
    expect(aviso).toMatch(/carregue um material/i);
  });

  it("o estado vazio não manda mais para o beco", () => {
    expect(VAZIO_TEXTO).not.toMatch(/comece carregando um material/i);
    expect(VAZIO_TEXTO).toMatch(/nome/i);
  });

  it("o texto do formulário explica o campo opcional em vez de só marcá-lo", () => {
    expect(ADICIONAR_TITULO).toMatch(/nome/i);
    // "opcional" sem dizer para que serve vira campo que todo mundo preenche por via das
    // dúvidas — e aí ele deixou de ser opcional na prática.
    expect(ADICIONAR_AJUDA).toMatch(/opcional/i);
    expect(ADICIONAR_AJUDA).toMatch(/diferenciar/i);
  });

  it("a mensagem de repetido fala do que o corretor vê, não de constraint", () => {
    expect(NOME_REPETIDO).not.toMatch(/unique|constraint|409|conflict/i);
  });
});
