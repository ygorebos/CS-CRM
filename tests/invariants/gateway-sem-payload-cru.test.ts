/**
 * FR-005 com vigia: o caminho novo só conhece o ENVELOPE (T011a).
 *
 * ## O invariante, e por que ele precisava de dono
 *
 * A feature inteira se paga em uma frase: *canal novo chega ao inbox sem código
 * de ingestão novo*. Isso só é verdade enquanto o caminho novo não souber nada
 * de provedor nenhum. No dia em que alguém "só dá uma olhada" no payload cru
 * para resolver um caso específico — um campo que o envelope ainda não carrega,
 * um jeitinho do WhatsApp —, o acoplamento volta pela porta dos fundos e o SC-008
 * (zero linhas por canal) deixa de valer sem ninguém decidir isso.
 *
 * O FR-005 dizia isso em prosa e **não tinha vigia**. Pelo Princípio XI,
 * invariante que só existe em prosa deixou de ser invariante.
 *
 * ## Por que varredura de arquivo, e não teste de comportamento
 *
 * Não há entrada que faça o defeito aparecer: um `import` a mais compila, passa
 * em todos os testes e só se manifesta como dívida de arquitetura, meses depois,
 * quando o segundo canal custar o que o primeiro custou. O que se cobra aqui é
 * uma propriedade do CÓDIGO, e a única forma honesta de cobrá-la é lendo o
 * código.
 *
 * Mora em `tests/invariants/` — e não num script de lint solto — porque essa
 * suíte roda no job `invariants`, obrigatório na branch protection. Regra que
 * não reprova merge é documentação com aparência de portão.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Quem PODE conhecer payload de provedor — são os adaptadores, é o trabalho deles. */
const FRONTEIRAS_DO_PROVEDOR = [
  "lib/waha/",
  "lib/channels/meta/",
  "lib/channels/adapters/",
  // As rotas legadas dos provedores: elas RECEBEM o payload cru por definição.
  "app/api/v1/webhooks/waha/",
  "app/api/v1/webhooks/meta/",
];

/** O caminho novo. Aqui dentro, envelope e nada mais. */
const CAMINHO_DO_GATEWAY = [
  "lib/gateway/",
  "app/api/v1/webhooks/gateway/",
  "app/api/v1/cron/gateway-inbound-drain/",
  "lib/messaging/media/gateway-source.ts",
];

const RAIZES = ["app", "lib", "components", "workers"];

function arquivosDeCodigo(raiz: string): string[] {
  const out: string[] = [];
  const anda = (dir: string): void => {
    let entradas: string[];
    try {
      entradas = readdirSync(dir);
    } catch {
      return;
    }
    for (const nome of entradas) {
      if (nome === "node_modules" || nome === ".next") continue;
      const caminho = join(dir, nome);
      const st = statSync(caminho);
      if (st.isDirectory()) anda(caminho);
      else if (/\.tsx?$/.test(nome) && !/\.test\.tsx?$/.test(nome)) out.push(caminho);
    }
  };
  anda(raiz);
  return out;
}

const TODOS = RAIZES.flatMap(arquivosDeCodigo);

function ehDoGateway(caminho: string): boolean {
  return CAMINHO_DO_GATEWAY.some((p) => caminho.startsWith(p));
}

function ehFronteira(caminho: string): boolean {
  return FRONTEIRAS_DO_PROVEDOR.some((p) => caminho.startsWith(p));
}

/** `import ... from "@/lib/x"` e `from "../x"` — o que basta para achar dependência. */
function importesDe(conteudo: string): string[] {
  const out: string[] = [];
  const rx = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(conteudo)) !== null) out.push(m[1]!);
  return out;
}

describe("o caminho novo só conhece o envelope (T011a / FR-005)", () => {
  it("nenhum arquivo do gateway importa módulo de provedor", () => {
    const violacoes: string[] = [];

    for (const arquivo of TODOS.filter(ehDoGateway)) {
      const conteudo = readFileSync(arquivo, "utf8");
      for (const imp of importesDe(conteudo)) {
        const alvo = imp.replace(/^@\//, "");
        if (
          alvo.startsWith("lib/waha/") ||
          alvo.startsWith("lib/channels/meta/") ||
          alvo.startsWith("lib/channels/adapters/")
        ) {
          violacoes.push(`${arquivo} importa ${imp}`);
        }
      }
    }

    // Um import destes é o começo do fim do SC-008: a partir dele, o canal novo
    // volta a custar código novo — e a conta chega meses depois, longe daqui.
    expect(violacoes).toEqual([]);
  });

  it("nenhum arquivo do gateway lê campo cru de payload de canal", () => {
    // Campos que só existem no payload de provedor. Se um deles aparece no
    // caminho novo, alguém está lendo o formato do canal em vez do envelope.
    const CAMPOS_CRUS = [
      "_data", // WAHA
      "fromMe",
      "notifyName",
      "chatId",
      "entry[0]", // Meta
      "changes[0]",
      "messaging_product",
      "BaseMessage", // uazapi
    ];
    const violacoes: string[] = [];

    for (const arquivo of TODOS.filter(ehDoGateway)) {
      const conteudo = readFileSync(arquivo, "utf8");
      // Comentário citando o campo é legítimo (explicar de onde a coisa veio é
      // metade da doutrina deste repo). O que se caça é leitura em CÓDIGO.
      const semComentarios = conteudo
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const campo of CAMPOS_CRUS) {
        if (semComentarios.includes(campo)) violacoes.push(`${arquivo} lê "${campo}"`);
      }
    }

    expect(violacoes).toEqual([]);
  });

  it("a fronteira do provedor existe e está povoada — senão este teste passaria por vazio", () => {
    // Caso de controle. Sem ele, um refactor que apagasse `lib/waha/` deixaria
    // os dois testes acima verdes por não haver o que violar, e o verde seria
    // lido como "a arquitetura está limpa".
    const fronteiras = TODOS.filter(ehFronteira);
    expect(fronteiras.length).toBeGreaterThan(5);

    const doGateway = TODOS.filter(ehDoGateway);
    expect(doGateway.length).toBeGreaterThan(5);
  });
});
