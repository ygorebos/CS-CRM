import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FR-031 / SC-011 — nenhuma tela da spec 002 é pré-requisito para publicar o agente.
 *
 * ## Por que isto é um teste, e não uma promessa no plano
 *
 * O princípio VIII dá dez minutos entre o login e o primeiro atendimento. A spec 002
 * declara, no cabeçalho, que fica **fora** desse cronômetro por desenho: carregar operadora
 * é caminho de aprofundamento, nunca de entrada. Uma instalação sem acervo nenhum tem de
 * continuar publicando o agente e vendendo — o que ela não faz é **assistir** sem lastro.
 *
 * O risco é de erosão, não de erro: nada quebra no dia em que alguém acrescenta a tela de
 * Operadoras ao onboarding "porque faz sentido pedir isso logo". A suíte segue verde, a
 * tela fica bonita, e o teto de dez minutos morre em silêncio — medido só quando um
 * corretor real desistir no meio.
 *
 * Este teste é a régua mecânica disso: o fluxo de onboarding não pode nem MENCIONAR as
 * superfícies da feature. Se um dia a decisão mudar, que mude explicitamente — apagando
 * este teste e assumindo o custo no cronômetro, não por acidente de refatoração.
 */

const RAIZ = path.resolve(__dirname, "..", "..");
const ONBOARDING = path.join(RAIZ, "app", "onboarding");

/** Superfícies criadas pela spec 002. Nenhuma pode aparecer no caminho de entrada. */
const SUPERFICIES_DA_FEATURE = [
  "ai/knowledge/scopes",
  "admin/catalogo",
  "knowledge-scopes",
  "catalog/materials",
  "catalog/scopes",
];

function arquivosDe(dir: string): string[] {
  const saida: string[] = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const alvo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...arquivosDe(alvo));
    else if (/\.(ts|tsx)$/.test(entrada.name)) saida.push(alvo);
  }
  return saida;
}

describe("FR-031 · a spec 002 fica fora do caminho crítico dos 10 minutos", () => {
  it("o fluxo de onboarding não menciona nenhuma superfície da feature", () => {
    const arquivos = arquivosDe(ONBOARDING);
    // Guarda da guarda: se o diretório mudar de lugar, o teste passaria vazio e não
    // vigiaria nada — que é o modo de falha clássico de teste que varre arquivo.
    expect(arquivos.length).toBeGreaterThan(0);

    const ofensas: string[] = [];
    for (const arquivo of arquivos) {
      const conteudo = fs.readFileSync(arquivo, "utf8");
      for (const superficie of SUPERFICIES_DA_FEATURE) {
        if (conteudo.includes(superficie)) {
          ofensas.push(`${path.relative(RAIZ, arquivo)} → ${superficie}`);
        }
      }
    }

    expect(ofensas).toEqual([]);
  });

  it("as ações de onboarding também não puxam as rotas da feature", () => {
    const arquivos = arquivosDe(path.join(RAIZ, "app", "actions", "onboarding"));
    expect(arquivos.length).toBeGreaterThan(0);

    const ofensas = arquivos.filter((arquivo) => {
      const conteudo = fs.readFileSync(arquivo, "utf8");
      return SUPERFICIES_DA_FEATURE.some((s) => conteudo.includes(s));
    });

    expect(ofensas.map((a) => path.relative(RAIZ, a))).toEqual([]);
  });
});
