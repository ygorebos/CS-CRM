/**
 * O link do e-mail, COMPOSTO, ainda é uma URL com todos os parâmetros?
 *
 * ─── Por que este teste existe ──────────────────────────────────────────────
 *
 * Em 2026-08-09 o `redirectTo` das server actions ganhou um carimbo `?type=…`
 * (o GoTrue não informa o fluxo no PKCE). Os templates de e-mail do repo
 * compunham o link com `{{ .RedirectTo }}?token_hash=…`. Os dois lados estavam
 * certos sozinhos e o produto do encontro tinha DOIS `?`:
 *
 *     /auth/confirm?type=recovery?token_hash=XXX&type=recovery
 *
 * O segundo `?` é literal: `token_hash` some como parâmetro e o link morre.
 * Redefinir senha e confirmar cadastro pararam de funcionar no ambiente de
 * teste — e não no de nuvem, que não usa estes templates, o que fez a mudança
 * parecer boa em produção enquanto quebrava no gate.
 *
 * Só o e2e viu, e o e2e NÃO gateia merge (`e2e.yml` é não-obrigatório). Por
 * isso a rede tem de estar aqui, no `verify`: um contrato entre dois arquivos
 * que ninguém abre junto precisa de um teste que os abra.
 *
 * O teste lê os TEMPLATES DE VERDADE do disco — dublê de template provaria
 * apenas que eu sei escrever a string que eu mesmo esperava.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { urlDeCallbackDeEmail, type TipoDeLinkDeEmail } from "@/lib/auth/link-de-email";

const ORIGIN = "http://localhost:3000";
const TOKEN = "pkce_naoimporta_o_valor_1234567890";

const TEMPLATES: Array<{ arquivo: string; tipo: TipoDeLinkDeEmail }> = [
  { arquivo: "recovery.html", tipo: "recovery" },
  { arquivo: "confirmation.html", tipo: "signup" },
];

/** O href do template, com os placeholders do GoTrue substituídos. */
function comporLink(arquivo: string, tipo: TipoDeLinkDeEmail): string {
  const html = readFileSync(join(process.cwd(), "supabase/templates", arquivo), "utf8");
  const m = html.match(/href="([^"]+)"/);
  if (!m) throw new Error(`${arquivo}: nenhum href encontrado`);
  return m[1]!
    .replace(/\{\{\s*\.RedirectTo\s*\}\}/g, urlDeCallbackDeEmail(ORIGIN, tipo))
    .replace(/\{\{\s*\.TokenHash\s*\}\}/g, TOKEN)
    .replace(/&amp;/g, "&");
}

describe("o link de e-mail composto (redirectTo + template)", () => {
  it.each(TEMPLATES)("$arquivo entrega token_hash E type legíveis", ({ arquivo, tipo }) => {
    const url = new URL(comporLink(arquivo, tipo));

    expect(url.pathname).toBe("/auth/confirm");
    // O que quebrou: com dois `?`, `token_hash` deixa de ser parâmetro.
    expect(url.searchParams.get("token_hash")).toBe(TOKEN);
    // E `type` vinha contaminado com o resto da query.
    expect(url.searchParams.get("type")).toBe(tipo);
  });

  it.each(TEMPLATES)("$arquivo não tem um segundo '?' na query", ({ arquivo, tipo }) => {
    const link = comporLink(arquivo, tipo);
    // Asserção direta sobre a causa, não só sobre o sintoma: quem mexer no
    // template ou no carimbo vê o motivo no nome do caso.
    expect(link.split("?").length - 1, `link com mais de uma '?': ${link}`).toBe(1);
  });

  it("o construtor do redirectTo sempre termina com query — é o que torna o '&' do template correto", () => {
    for (const { tipo } of TEMPLATES) {
      const url = new URL(urlDeCallbackDeEmail(ORIGIN, tipo));
      expect(url.search, `redirectTo de '${tipo}' sem query`).not.toBe("");
      expect(url.searchParams.get("type")).toBe(tipo);
    }
  });

  it("os templates compõem com '&', nunca com '?'", () => {
    for (const { arquivo } of TEMPLATES) {
      const html = readFileSync(join(process.cwd(), "supabase/templates", arquivo), "utf8");
      expect(
        html,
        `${arquivo} usa '?' depois de .RedirectTo — o redirectTo já traz query`,
      ).not.toMatch(/\{\{\s*\.RedirectTo\s*\}\}\?/);
    }
  });
});
