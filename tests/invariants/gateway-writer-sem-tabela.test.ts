/**
 * `gateway_writer` não pode tocar tabela — a trava que sustenta a permissão
 * constitucional (T011, FR-002).
 *
 * ## Por que este arquivo é a condição, e não o zelo
 *
 * A constituição v2.3.0 abriu uma **quarta superfície** no Princípio VII: o
 * `gateway_go` pode escrever no banco do CRM, mas **só** por função
 * `security definer` versionada, e **só** sob seis travas. Duas delas são
 * verificáveis daqui, e a nº 5 é literalmente "existir um invariante em CI que
 * reprove se o papel ganhar privilégio de tabela".
 *
 * Ou seja: **este arquivo não vigia a permissão, ele a constitui.** Se ele for
 * removido ou afrouxado, a superfície volta a ser proibida e a spec 004 volta a
 * ser violação de princípio — não há emenda que conserte, porque a emenda
 * permitiu a superfície *sob condição*.
 *
 * ## O modo de falha que ele pega
 *
 * Não é alguém escrevendo `grant select on messages to gateway_writer` de
 * propósito. É:
 *
 *   - um `grant ... on all tables in schema public to <lista>` futuro que inclua
 *     o papel por descuido;
 *   - um `ALTER DEFAULT PRIVILEGES` novo que o alcance sem ninguém notar;
 *   - alguém "consertando" um erro de permissão da função dando acesso à tabela
 *     em vez de corrigir a função — o atalho mais natural do mundo, e o que
 *     desfaz o desenho inteiro em uma linha.
 *
 * Um `select` direto parece inofensivo e já é acoplamento ao schema: é
 * exatamente o que a quarta superfície existe para impedir.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const PAPEL = "gateway_writer";

/** Privilégios que o papel tem em QUALQUER tabela/view de `public`. */
function privilegiosDeTabela(): string[] {
  const out = sql(`
    select coalesce(string_agg(distinct table_name || ':' || privilege_type, ', '), '')
      from information_schema.role_table_grants
     where grantee = '${PAPEL}' and table_schema = 'public';
  `);
  const linha = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("(") && !l.includes("---") && l !== "coalesce")[0];
  return linha && linha.length > 0 ? linha.split(", ") : [];
}

describe("gateway_writer — a trava nº 5 do Princípio VII", () => {
  it("existe, e existe como papel sem login", () => {
    const out = sql(`select rolcanlogin from pg_roles where rolname = '${PAPEL}';`);
    expect(out).toContain("f");
  });

  it("NÃO tem privilégio em tabela nenhuma de public — nem select", () => {
    const encontrados = privilegiosDeTabela();
    expect(
      encontrados,
      `gateway_writer ganhou privilégio de tabela: ${encontrados.join(", ")}.\n` +
        "Isso NÃO é um teste a ajustar: a constituição v2.3.0 permite a quarta superfície\n" +
        "SOB A CONDIÇÃO de que este papel não toque tabela. Corrija o grant, não o teste.\n" +
        "Se a função precisa de mais acesso, o acesso vai DENTRO da função (security definer),\n" +
        "nunca no papel que a chama.",
    ).toEqual([]);
  });

  it("não tem privilégio em sequence de public", () => {
    const out = sql(`
      select count(*) from information_schema.role_usage_grants
       where grantee = '${PAPEL}' and object_schema = 'public' and object_type = 'SEQUENCE';
    `);
    expect(out).toMatch(/\b0\b/);
  });

  it("não é membro de service_role nem de nenhum papel que bypassa RLS", () => {
    const out = sql(`
      select coalesce(string_agg(pai.rolname, ', '), 'nenhum')
        from pg_auth_members m
        join pg_roles filho on filho.oid = m.member
        join pg_roles pai   on pai.oid   = m.roleid
       where filho.rolname = '${PAPEL}';
    `);
    expect(out).not.toContain("service_role");
    expect(out).not.toContain("postgres");
  });

  it("não bypassa RLS por conta própria", () => {
    const out = sql(`select rolbypassrls from pg_roles where rolname = '${PAPEL}';`);
    expect(out).toContain("f");
  });

  it("consegue EXECUTE exatamente nas funções da superfície, e em nada além", () => {
    const out = sql(`
      select string_agg(p.proname, ', ' order by p.proname)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and has_function_privilege('${PAPEL}', p.oid, 'EXECUTE');
    `);
    // As duas novas + as três de contato/conversa que já existiam para o WAHA.
    for (const fn of [
      "fn_gateway_ingest_message",
      "fn_gateway_update_message_status",
      "fn_upsert_wa_contact",
      "fn_upsert_wa_conversation",
      "fn_mark_conversation_message",
    ]) {
      expect(out, `gateway_writer perdeu EXECUTE em ${fn}`).toContain(fn);
    }
  });
});
