import { describe, expect, it } from "vitest";

import { DEFAULT_SENTRY_DSN, isCommunityDsn, resolveSentryDsn } from "@/lib/sentry/dsn";

/**
 * O opt-out do Sentry tem um modo de falha que passa despercebido: devolver
 * `undefined` para "desligado" NÃO desliga — reabre o fallback do SDK.
 *
 * `@sentry/node-core/build/cjs/sdk/index.js:127` faz
 * `dsn: options.dsn ?? process.env.SENTRY_DSN`, e `@sentry/vercel-edge` tem o
 * equivalente em `index.js:3508`. Como `??` só cai no fallback em nullish,
 * `undefined` fazia o SDK reler a env crua (`SENTRY_DSN=off`) e cuspir
 * `Invalid Sentry Dsn: off` em todo boot — telemetria desligada pelo caminho do
 * erro, não pelo desenho.
 *
 * Por isso o teste é sobre o TIPO do retorno, não só sobre "é falsy": string
 * vazia não é nullish e mata o fallback; `undefined` o ressuscita.
 */
describe("resolveSentryDsn — opt-out não pode devolver nullish", () => {
  for (const desligado of ["off", "OFF", " Off ", "false", "0"]) {
    it(`"${desligado}" desliga devolvendo string vazia, nunca undefined`, () => {
      const dsn = resolveSentryDsn(desligado);
      expect(dsn).toBe("");
      // O ponto do bug: `dsn ?? process.env.SENTRY_DSN` não pode escapar daqui.
      expect(dsn ?? "fallback-do-sdk").toBe("");
    });
  }

  it("vazio ou ausente cai no Sentry da comunidade", () => {
    expect(resolveSentryDsn("")).toBe(DEFAULT_SENTRY_DSN);
    expect(resolveSentryDsn("   ")).toBe(DEFAULT_SENTRY_DSN);
    expect(resolveSentryDsn(undefined)).toBe(DEFAULT_SENTRY_DSN);
    expect(resolveSentryDsn(null)).toBe(DEFAULT_SENTRY_DSN);
  });

  it("DSN próprio passa intacto e não é tratado como o da comunidade", () => {
    const meu = "https://abc123@o1.ingest.us.sentry.io/42";
    expect(resolveSentryDsn(` ${meu} `)).toBe(meu);
    expect(isCommunityDsn(resolveSentryDsn(meu))).toBe(false);
    expect(isCommunityDsn(resolveSentryDsn(""))).toBe(true);
  });

  it("desligado não conta como Sentry da comunidade", () => {
    expect(isCommunityDsn(resolveSentryDsn("off"))).toBe(false);
  });
});
