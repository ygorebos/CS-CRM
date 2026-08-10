import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O app sob teste e o redirect do link de e-mail apontam para a MESMA porta.
 *
 * ═══ O DEFEITO MEDIDO (CI, 2026-08-08) ═══
 *
 * `scripts/gerar-env-e2e.sh` não escrevia `NEXT_PUBLIC_APP_URL`, então valia o default
 * de `lib/env.ts` — `http://localhost:3000`. Só que `playwright.config.ts` sobe o
 * `next start` na **3001**.
 *
 * `app/auth/confirm/route.ts` monta o redirect a partir dessa var DE PROPÓSITO: ler
 * `Host`/`X-Forwarded-Host` deixaria quem controla o cabeçalho escolher o destino, e isso
 * é open redirect de phishing dentro do fluxo de recuperação de senha. A escolha está
 * certa; o que faltava era a configuração acompanhá-la.
 *
 * Resultado: o link do e-mail estabelecia a sessão e mandava o browser para a porta 3000,
 * onde não havia nada. `ERR_CONNECTION_REFUSED` — e o Playwright reporta a URL do `goto`
 * ORIGINAL, não a do redirect, então a falha parecia "servidor fora do ar". As outras 37
 * specs do shard passavam (nenhuma redireciona por configuração), o que fazia o sintoma
 * parecer instabilidade de infra. Três specs vermelhas por dois commits seguidos:
 * `password-recovery`, `reset-password-mfa` e `signup-journey` — esta última é P0 da
 * doutrina de QA Visual, a primeira impressão de todo mundo que se cadastra.
 *
 * ═══ POR QUE UM TESTE, E NÃO SÓ O CONSERTO ═══
 *
 * A porta vive em dois arquivos que ninguém lê junto: um script de shell e um config de
 * TypeScript. Nada os obrigava a concordar, e a divergência não aparece como erro — aparece
 * como três specs de auth vermelhas com uma mensagem que aponta para o lugar errado. Este
 * arquivo é a costura: se as duas redações voltarem a divergir, ele reprova ANTES do CI
 * gastar 7 minutos produzindo um diagnóstico enganoso.
 *
 * Lê o FONTE dos dois lados de propósito — o `.env.e2e` gerado não é versionado, e um teste
 * que dependesse dele não rodaria em máquina limpa nem no `verify`.
 */

const RAIZ = process.cwd();
const GERADOR = fs.readFileSync(path.join(RAIZ, "scripts/gerar-env-e2e.sh"), "utf8");
const CONFIG = fs.readFileSync(path.join(RAIZ, "playwright.config.ts"), "utf8");

/** A porta default que cada lado declara. */
function portaDoPlaywright(): string {
  const m = CONFIG.match(/process\.env\.E2E_PORT\s*\?\?\s*"(\d+)"/);
  expect(m, "playwright.config.ts deixou de declarar a porta como `E2E_PORT ?? \"NNNN\"`").not.toBeNull();
  return m![1]!;
}

function portaDoGerador(): string {
  const m = GERADOR.match(/PORTA_APP="\$\{E2E_PORT:-(\d+)\}"/);
  expect(m, "gerar-env-e2e.sh deixou de declarar PORTA_APP com o mesmo default").not.toBeNull();
  return m![1]!;
}

describe("o .env.e2e aponta o app para a porta em que o Playwright o sobe", () => {
  it("o gerador ESCREVE NEXT_PUBLIC_APP_URL — ausente, vale o default 3000 de lib/env.ts", () => {
    // Esta é a asserção que estava faltando e custou 3 specs. Sem a linha no arquivo, o
    // servidor sobe na 3001 e redireciona para a 3000, e nada no CI diz isso.
    expect(GERADOR).toMatch(/^NEXT_PUBLIC_APP_URL=/m);
  });

  it("os dois lados declaram a MESMA porta default", () => {
    expect(portaDoGerador()).toBe(portaDoPlaywright());
  });

  it("NEXT_PUBLIC_APP_URL usa a variável, não um número digitado à mão", () => {
    // Repetir o número aqui deixaria o teste acima verde e a divergência voltaria pela
    // porta de trás: `E2E_PORT=3002` moveria o servidor e não o redirect.
    const linha = GERADOR.match(/^NEXT_PUBLIC_APP_URL=(.+)$/m);
    expect(linha).not.toBeNull();
    expect(linha![1]).toBe("http://localhost:$PORTA_APP");
  });

  it("o host é `localhost`, o mesmo do baseURL — cookie é por HOST", () => {
    // `127.0.0.1` e `localhost` são hosts DIFERENTES para cookie. O `verifyOtp` grava a
    // sessão no Set-Cookie do redirect; mandar o browser para o outro host entregaria a
    // tela seguinte a um usuário deslogado — e o sintoma seria "o link de e-mail não
    // funciona", não "a porta está errada".
    expect(CONFIG).toMatch(/const BASE_URL = `http:\/\/localhost:\$\{PORT\}`/);
    expect(GERADOR).toMatch(/^NEXT_PUBLIC_APP_URL=http:\/\/localhost:/m);
  });

  it("nenhuma outra URL do gerador fixa a porta do app à mão", () => {
    // `WAHA_WEBHOOK_BASE_URL` fixava `3001` literal. Enquanto o default não mudasse ela
    // acertava por coincidência, e com `E2E_PORT` sobrescrito o webhook voltaria para uma
    // porta vazia — o mesmo defeito, em outro fluxo, esperando a vez.
    const porta = portaDoPlaywright();
    const bloco = GERADOR.slice(GERADOR.indexOf("cat > .env.e2e"));
    const fixas = bloco
      .split("\n")
      .filter((l) => l.includes(`:${porta}`) && !l.includes("$PORTA_APP") && !l.trimStart().startsWith("#"));
    expect(fixas, `porta ${porta} digitada à mão em: ${fixas.join(" | ")}`).toEqual([]);
  });
});
