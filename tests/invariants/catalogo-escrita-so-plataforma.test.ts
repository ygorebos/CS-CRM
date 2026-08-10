import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * TRAVA 1 — escrever no catálogo curado é privilégio de plataforma (SC-021, migration 0117).
 *
 * `admin` é o papel mais alto DENTRO de um tenant, e é justamente por isso que este
 * arquivo existe: o reflexo de quem lê "admin" é supor que ele pode tudo. Não pode. O
 * catálogo é conteúdo do fabricante, compartilhado por todas as organizações da
 * instalação — uma escrita indevida ali não estraga um tenant, estraga todos.
 *
 * ═══ POR QUE PELO PAPEL DO BANCO, E NÃO PELA ROTA ═══
 *
 * Testar só a rota provaria que AQUELA rota confere `is_platform_admin`. A trava tem de
 * valer para todo caminho — PostgREST com a anon key, PostgREST com token de tenant, uma
 * rota futura que alguém escreva sem lembrar da guarda. Por isso a asserção é feita como
 * o Supabase realmente executa: `set role authenticated` + `request.jwt.claims`.
 *
 * A leitura, ao contrário, é aberta a qualquer autenticado — o catálogo existe para o
 * corretor ler. Um teste que barrasse a leitura estaria testando o produto errado, e por
 * isso o caso de leitura está aqui ao lado do de escrita.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

/**
 * `ON_ERROR_STOP=1` não é detalhe: sem ele o psql segue depois do erro e sai com código 0,
 * `execFileSync` não levanta nada, e um teste que espera "a escrita foi barrada" recebe
 * `null` e conclui que a escrita PASSOU. Foi exatamente assim que este arquivo nasceu
 * vermelho em 5 casos — e o modo de falha oposto (barrar de verdade e o teste não ver)
 * seria pior: passaria verde com o catálogo aberto.
 */
function sql(script: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-f",
      "-",
    ],
    { input: script, encoding: "utf8" },
  ).trim();
}

const ORG = "ca7a0000-0000-4000-8000-000000000001";
const SCOPE = "ca7a0000-3333-4000-8000-000000000001";
/** Um usuário por papel de tenant — inclusive o mais alto. */
const USUARIOS = {
  viewer: "ca7a0000-1111-4000-8000-000000000001",
  agent: "ca7a0000-1111-4000-8000-000000000002",
  manager: "ca7a0000-1111-4000-8000-000000000003",
  admin: "ca7a0000-1111-4000-8000-000000000004",
} as const;

/** Executa como o Supabase executa: papel de sessão + claims do JWT. */
function comoUsuario(userId: string, corpo: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${corpo}
  `);
}

/** Devolve a mensagem de erro se a escrita foi barrada, ou null se ela passou. */
function tentarEscrever(userId: string, comando: string): string | null {
  try {
    comoUsuario(userId, comando);
    return null;
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message: string };
    return String(err.stderr ?? err.message);
  }
}

beforeAll(() => {
  const linhas = Object.entries(USUARIOS)
    .map(
      ([papel, id]) => `
      insert into auth.users (id, email) values ('${id}', 'catalogo-${papel}@invariant.test')
        on conflict (id) do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${id}', '${ORG}', '${papel}', now()) on conflict do nothing;`,
    )
    .join("\n");

  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'catalogo-trava1', 'Catalogo LTDA', 'Catalogo') on conflict (id) do nothing;
    ${linhas}
    insert into public.catalog_scopes (id, slug, display_name)
      values ('${SCOPE}', 'trava1-escopo', 'Escopo da Trava 1') on conflict (id) do nothing;
  `);
});

/**
 * Limpar não é higiene: é correção de OUTROS arquivos. Este Postgres é compartilhado por
 * toda a suíte de invariantes, e `fn_sincronizar_escopos_do_catalogo` espelha TODO
 * `catalog_scope` ativo. Um escopo esquecido aqui vira espelho a mais no arquivo de
 * semeadura, que passa a falhar por um motivo que não tem nada a ver com ele.
 */
afterAll(() => {
  sql(`
    delete from public.organizations where id = '${ORG}';
    delete from public.catalog_scopes where slug = 'trava1-escopo';
  `);
});

describe("trava 1 — nenhum papel de tenant escreve no catálogo", () => {
  for (const [papel, id] of Object.entries(USUARIOS)) {
    it(`${papel} não cria escopo curado`, () => {
      const erro = tentarEscrever(
        id,
        `insert into public.catalog_scopes (slug, display_name) values ('invasao-${papel}', 'Invasão');`,
      );
      expect(erro, `${papel} conseguiu criar escopo no catálogo`).toMatch(/row-level security/i);
    });

    it(`${papel} não edita escopo curado`, () => {
      const erro = tentarEscrever(
        id,
        `update public.catalog_scopes set display_name = 'renomeado por ${papel}' where id = '${SCOPE}';`,
      );
      // UPDATE barrado por RLS não levanta erro: ele simplesmente não encontra a linha.
      // Por isso a asserção que vale aqui é sobre o ESTADO, não sobre a exceção.
      void erro;
      const nome = sql(`select display_name from public.catalog_scopes where id = '${SCOPE}';`);
      expect(nome).toBe("Escopo da Trava 1");
    });

    it(`${papel} não apaga escopo curado`, () => {
      tentarEscrever(id, `delete from public.catalog_scopes where id = '${SCOPE}';`);
      const n = sql(`select count(*) from public.catalog_scopes where id = '${SCOPE}';`);
      expect(n).toBe("1");
    });
  }

  it("mas TODOS eles leem o catálogo — é para isso que ele existe", () => {
    for (const [papel, id] of Object.entries(USUARIOS)) {
      const n = comoUsuario(id, `select count(*) from public.catalog_scopes where id = '${SCOPE}';`)
        .split("\n")
        .pop();
      expect(n, `${papel} não conseguiu LER o catálogo`).toBe("1");
    }
  });

  it("a anon key não enxerga o catálogo nem para ler", () => {
    // Duas trancas: `revoke all ... from anon` (privilégio) e a ausência de policy para
    // `anon` (RLS). A primeira é a que sobrevive a alguém reescrever a segunda.
    let barrado = false;
    try {
      sql(`set role anon; select count(*) from public.catalog_scopes;`);
    } catch (e) {
      barrado = /permission denied|row-level security/i.test(
        String((e as { stderr?: Buffer | string }).stderr ?? ""),
      );
    }
    expect(barrado).toBe(true);
  });
});
