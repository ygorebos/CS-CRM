/**
 * Nenhum caminho de envio escapa das travas (spec 004, T062 / SC-005).
 *
 * ## O que esta varredura prova, e o que ela NÃO prova
 *
 * A outra metade da T062 é medição ao vivo — rajada de 50, espaçamento medido,
 * janela de horário respeitada. Isso precisa de ambiente e está na Fase 6 como
 * execução.
 *
 * **Esta metade é mecânica, e é a que sobrevive ao tempo.** Uma rajada medida
 * hoje prova o código de hoje; a varredura reprova o atalho de amanhã. O risco
 * real não é a trava estar errada — é alguém acrescentar um caminho de envio que
 * não passa por ela, e a trava continuar perfeita e irrelevante.
 *
 * ## Qual é a trava, e onde ela mora
 *
 * `adapter.send()` é a única porta para a rede do canal. Quem chama tem de estar
 * **atrás** da cadeia que aplica janela de horário, limite diário por sessão e
 * espaçamento com jitter (`lib/automation/throttle.ts`), e essa cadeia roda em
 * `sendMessageHandler`. Então a regra é simples de verificar: **fora de
 * `lib/channels/`, ninguém chama `adapter.send` a não ser o handler**.
 *
 * O watchdog é a exceção declarada, e tem razão escrita: ele reenvia mensagem
 * que JÁ passou pela cadeia e ficou presa em `queued` — aplicar o limite diário
 * de novo contaria a mesma mensagem duas vezes contra o teto do número. Ele tem
 * espaçamento próprio (`redriveSpacingMs` + jitter).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZES = ["app", "lib", "components", "workers"];

/** O seam é o dono da chamada; ele não passa por trava nenhuma por definição. */
const DENTRO_DO_SEAM = [/^lib\/channels\//];

/**
 * Exceções DECLARADAS, cada uma com o porquê. Lista que cresce sem razão escrita
 * é anistia disfarçada — o mesmo mecanismo da `KNOWN_DEBT` do `lint-channels`.
 */
const FORA_DA_CADEIA_COM_MOTIVO: { arquivo: string; motivo: string }[] = [
  {
    arquivo: "app/api/v1/messages/_handler.ts",
    motivo:
      "É o handler. A cadeia de vazão roda ANTES dele, em quem o chama " +
      "(lib/automation/actions/send-whatsapp.ts) — é este arquivo que a trava protege.",
  },
  {
    arquivo: "lib/agent-engine/edge/crm/session-reconciler.ts",
    motivo:
      "Redrive do watchdog: reenvia mensagem que JÁ passou pela cadeia e ficou presa em " +
      "`queued`. Aplicar o limite diário de novo contaria a mesma mensagem duas vezes contra " +
      "o teto do número. Tem espaçamento próprio (redriveSpacingMs + jitter).",
  },
];

function walk(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  } catch {
    return [];
  }
}

const CHAMA_SEND = /\badapter\.send\s*\(/;

describe("nenhum caminho de envio escapa das travas (SC-005)", () => {
  const declarados = new Set(FORA_DA_CADEIA_COM_MOTIVO.map((e) => e.arquivo));

  const chamadores = RAIZES.flatMap(walk)
    .filter((f) => !DENTRO_DO_SEAM.some((re) => re.test(f)))
    .filter((f) => CHAMA_SEND.test(readFileSync(f, "utf8")));

  it("quem chama o envio do canal está na cadeia — ou está DECLARADO com motivo", () => {
    const novos = chamadores.filter((f) => !declarados.has(f));
    expect(
      novos.sort(),
      "Caminho de envio novo fora da cadeia de vazão. Ou ele passa por\n" +
        "`sendMessageHandler` (que roda atrás de janela + limite diário + espaçamento),\n" +
        "ou entra na lista deste arquivo COM o motivo escrito. Um envio que escapa das\n" +
        "travas não falha: ele funciona, e o número é banido semanas depois.",
    ).toEqual([]);
  });

  it("a lista de exceções só ENCOLHE — declarado que ficou limpo reprova", () => {
    // Mesmo mecanismo da catraca do `lint-channels`: exceção que ninguém remove
    // é dívida que envelhece em silêncio.
    const obsoletos = [...declarados].filter((f) => !chamadores.includes(f));
    expect(obsoletos.sort(), "Exceções que já não chamam o envio — apague-as daqui.").toEqual([]);
  });

  it("toda exceção tem motivo escrito, não só o caminho do arquivo", () => {
    for (const e of FORA_DA_CADEIA_COM_MOTIVO) {
      expect(e.motivo.length, `${e.arquivo} sem motivo`).toBeGreaterThan(60);
    }
  });
});
