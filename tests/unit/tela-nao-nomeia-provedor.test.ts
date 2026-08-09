/**
 * A tela não nomeia provedor, e não manda o usuário rodar comando
 * (spec 004, T064 / SC-007).
 *
 * ## O que a varredura achou, e por que era pior do que parecia
 *
 * Medido em 2026-08-08 nas telas de conexão e onboarding: **4 ocorrências**, e
 * as duas famílias eram defeitos diferentes.
 *
 * A primeira é o nome do provedor ("WAHA não está configurado", "Aguardando WAHA
 * gerar o QR Code"). Para quem lê, isso não significa nada — e depois da migração
 * significaria menos ainda, porque o número dele pode estar num provedor cujo
 * nome a tela nem cita. `getAdapter` já impede a FEATURE de perguntar identidade
 * de canal; a cópia escapava por não ser código de decisão.
 *
 * A segunda é pior e o `lint-channels` nunca pegaria: **"suba o Docker
 * (`docker compose up -d waha`)"**. Isso é doutrina de self-host viva numa tela
 * de um produto que hoje é **SaaS operado por nós**. Quem lê não tem container
 * para subir; a instrução transfere ao usuário uma tarefa que é nossa, e o deixa
 * parado esperando executar algo que ele não pode executar.
 *
 * ## Por que a varredura olha TEXTO VISÍVEL, e não o arquivo inteiro
 *
 * O `lint-channels` já cobra o arquivo inteiro por nome de provider — e por isso
 * estes dois arquivos estão na `KNOWN_DEBT` dele: leem `WAHA_API_BASE_URL` do
 * env para decidir se mostram o aviso, o que é legítimo. Reprovar o arquivo aqui
 * de novo não diria nada novo. O que interessa é o que **chega aos olhos** de
 * quem usa: literal de JSX, prop de cópia, mensagem de toast.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** As telas que o corretor vê ao conectar um número. */
const TELAS = ["app/app/connections", "app/onboarding", "components/connections"];

/** Nome de provedor como o USUÁRIO o leria. */
const NOME_DE_PROVEDOR = /\b(WAHA|waha|uazapi|UAZAPI|Baileys|WEBJS|NOWEB|Meta Cloud|graph\.facebook)\b/;

/**
 * Instrução de terminal na cópia. Vive aqui e não no `lint-channels` porque não
 * é sobre canal: é sobre o produto ter deixado de ser self-host e a tela não ter
 * sido avisada.
 */
const COMANDO_DE_TERMINAL = /\b(docker\s+compose|docker\s+run|npm\s+run|pnpm\s+\w+|sudo\s)/;

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
    });
  } catch {
    return [];
  }
}

/**
 * O que vira TEXTO na tela: literal entre tags JSX, prop de cópia, toast.
 *
 * Deliberadamente aproximado. Um extrator perfeito exigiria parsear JSX, e o que
 * se quer aqui é uma rede que pegue a cópia de verdade — não um analisador.
 */
function textoVisivel(src: string): string[] {
  const achados: string[] = [];
  for (const m of src.matchAll(/>([^<>{}]{4,})</g)) achados.push(m[1]!);
  for (const m of src.matchAll(
    /(?:title|label|placeholder|description|alt|aria-label)=\{?["'`]([^"'`]+)/g,
  )) {
    achados.push(m[1]!);
  }
  for (const m of src.matchAll(/toast\.\w+\(\s*["'`]([^"'`]+)/g)) achados.push(m[1]!);
  return achados;
}

function varrer(padrao: RegExp): string[] {
  const ofensas: string[] = [];
  for (const raiz of TELAS) {
    for (const arquivo of walk(raiz)) {
      for (const trecho of textoVisivel(readFileSync(arquivo, "utf8"))) {
        if (padrao.test(trecho)) ofensas.push(`${arquivo}: ${trecho.trim().slice(0, 80)}`);
      }
    }
  }
  return ofensas;
}

describe("as telas de conexão não nomeiam provedor (SC-007)", () => {
  it("zero nomes de provedor em texto visível", () => {
    expect(
      varrer(NOME_DE_PROVEDOR),
      "Nome de provedor na cópia. Para quem lê não significa nada — e depois da\n" +
        "migração significa menos ainda, porque o número dele pode estar num provedor\n" +
        "cujo nome a tela nem cita. Diga o EFEITO (\"o serviço de conexão está\n" +
        "indisponível\"), não o fornecedor.",
    ).toEqual([]);
  });

  it("zero instruções de terminal — o produto não é mais self-host", () => {
    expect(
      varrer(COMANDO_DE_TERMINAL),
      "Comando de terminal na cópia. O produto é SaaS operado por nós: quem lê esta\n" +
        "tela não tem container para subir, e a instrução transfere a ele uma tarefa\n" +
        "que é nossa — deixando-o parado esperando executar algo que não pode.",
    ).toEqual([]);
  });
});
