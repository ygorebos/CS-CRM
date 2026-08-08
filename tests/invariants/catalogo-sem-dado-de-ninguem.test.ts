import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * TRAVA 2 — o catálogo curado não carrega dado de ninguém (SC-020, Princípio X).
 *
 * Spec 002 (RAG por operadora), tarefa T035. Migration 0117 criou a única partição do
 * sistema que NÃO tem `organization_id`: `catalog_scopes`, `catalog_materials`,
 * `catalog_chunks`. Isso é uma exceção deliberada ao Princípio I, e a constituição só a
 * aceita sob sete travas. A trava 2 é a que este arquivo vigia: se dado pessoal ou
 * identificador de organização entrar ali, a partição deixa de estar fora do alcance da
 * LGPD e do isolamento — e a exceção inteira cai junto.
 *
 * ═══ POR QUE A VARREDURA É DERIVADA DO CATÁLOGO DO POSTGRES ═══
 *
 * Uma lista fixa com as três tabelas de hoje ficaria VERDE no dia em que alguém criasse
 * `catalog_faq` com `organization_id` — que é exatamente o dia em que este teste precisa
 * ficar vermelho. Por isso tudo aqui parte de `information_schema` / `pg_catalog`
 * filtrando `like 'catalog%'`: tabela nova entra na varredura sozinha, sem ninguém
 * lembrar de editar este arquivo.
 *
 * ═══ DUAS EXCEÇÕES, DECLARADAS EM VEZ DE SILENCIADAS ═══
 *
 * · `catalog_materials.adopted_by -> auth.users` (migration 0120). É auditoria de
 *   curadoria da PRÓPRIA instalação: quem, aqui dentro, adotou localmente aquele
 *   material. Não é dado de cliente e não é identificador de organização — `auth.users`
 *   é a tabela de operadores do sistema, não de leads. Sem essa marca, ninguém sabe a
 *   quem cobrar a correção de uma edição local (trava 5, responsabilidade editorial).
 *
 * · `catalog_scopes.display_name`. O nome bate com o campo de PII de `contacts`, mas o
 *   conteúdo é o nome COMERCIAL do escopo ("Unimed", "Amil") — a etiqueta que o corretor
 *   lê na tela. É o oposto de dado pessoal: é o dado mais público que existe no catálogo.
 *
 * As duas são cobradas nos dois sentidos: nada além delas pode aparecer, e elas próprias
 * precisam continuar existindo — lista de exceção que sobrevive à coluna que a motivou
 * vira permissão silenciosa para a próxima violação.
 *
 * ═══ O QUE ESTE ARQUIVO NÃO COBRE ═══
 *
 * · Não prova a trava 1 (escrita só de plataforma) — isso é
 *   `catalogo-escrita-so-plataforma.test.ts`.
 * · Não prova a trava 3 (consulta cruzando as duas camadas) — isso é
 *   `busca-escopo-nao-vaza.test.ts`.
 * · A varredura de CONTEÚDO só enxerga o que está no banco neste momento. Material
 *   curado que ainda não foi semeado não passa por aqui; o portão daquele conteúdo é a
 *   revisão de curadoria antes de ele virar apêndice do `baseline.sql`.
 * · Nome de pessoa escrito em prosa ("fale com o Dr. João") não casa com padrão nenhum e
 *   não é detectável estruturalmente. Este arquivo pega o que tem forma — e-mail, CPF,
 *   CNPJ, telefone —, não o que tem semântica.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

/** O padrão que DEFINE a partição curada. Toda varredura deste arquivo parte daqui. */
const PARTICAO = "catalog%";
/**
 * O controle. `contacts` é tenant-aware e é a tabela mais cheia de PII do repositório
 * (`organization_id`, `email`, `phone_number`, `cpf_encrypted`, `birthdate`,
 * `display_name`). Toda varredura é rodada contra ela também: varredura que volta vazia
 * por bug de query passaria como "está limpo", e esse é o defeito mais comum deste tipo
 * de teste.
 */
const CONTROLE = "contacts";

/** Identificador de dono: coluna que amarraria a linha a uma organização. */
const RE_TENANT = "(organization|organizacao|tenant|(^|_)org_id$)";
/** Nomes de coluna que, em qualquer tabela deste repo, carregam dado pessoal. */
const RE_PII =
  "(email|phone|telefone|celular|whatsapp|msisdn|cpf|cnpj|birth|nascimento|endereco|address|document|display_name|full_name|first_name|last_name|given_name)";

/** FKs que provariam que a partição aponta para o mundo do tenant. */
const ALVOS_DE_DONO = ["public.organizations", "auth.users"];

const FK_DECLARADA = "catalog_materials.adopted_by -> auth.users";
const PII_DECLARADA = "catalog_scopes.display_name";

interface Coluna {
  tabela: string;
  coluna: string;
}
interface Fk extends Coluna {
  alvo: string;
}

const chaveColuna = (c: Coluna): string => `${c.tabela}.${c.coluna}`;
const chaveFk = (f: Fk): string => `${f.tabela}.${f.coluna} -> ${f.alvo}`;

/** Colunas de `public` cujo NOME casa com `regex`, em toda relação que casa com `padrao`. */
async function varrerColunas(padrao: string, regex: string): Promise<Coluna[]> {
  const { rows } = await pool.query<Coluna>(
    `select c.table_name as tabela, c.column_name as coluna
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public'
        and t.table_type in ('BASE TABLE', 'VIEW')
        and c.table_name like $1
        and c.column_name ~ $2
      order by 1, 2`,
    [padrao, regex],
  );
  return rows;
}

/** Toda relação de `public` que casa com `padrao`, com quantas colunas tem. */
async function relacoesDaVarredura(padrao: string): Promise<{ tabela: string; colunas: number }[]> {
  const { rows } = await pool.query<{ tabela: string; colunas: string }>(
    `select c.table_name as tabela, count(*)::text as colunas
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public'
        and t.table_type in ('BASE TABLE', 'VIEW')
        and c.table_name like $1
      group by 1 order by 1`,
    [padrao],
  );
  return rows.map((r) => ({ tabela: r.tabela, colunas: Number(r.colunas) }));
}

/** FKs saindo de `padrao` para qualquer um dos `alvos` (`schema.tabela`). */
async function varrerFksPara(padrao: string, alvos: string[]): Promise<Fk[]> {
  const { rows } = await pool.query<Fk>(
    `select src.relname as tabela, att.attname as coluna,
            tns.nspname || '.' || tgt.relname as alvo
       from pg_constraint con
       join pg_class     src on src.oid = con.conrelid
       join pg_namespace sns on sns.oid = src.relnamespace
       join pg_class     tgt on tgt.oid = con.confrelid
       join pg_namespace tns on tns.oid = tgt.relnamespace
       cross join lateral unnest(con.conkey) as k(attnum)
       join pg_attribute att on att.attrelid = src.oid and att.attnum = k.attnum
      where con.contype = 'f'
        and sns.nspname = 'public'
        and src.relname like $1
        and (tns.nspname || '.' || tgt.relname) = any($2)
      order by 1, 2`,
    [padrao, alvos],
  );
  return rows;
}

/**
 * FKs saindo de `padrao` para qualquer tabela TENANT-AWARE — definida como "tem coluna
 * `organization_id`", que é a definição do Princípio I. Mais forte que a lista de alvos
 * acima: pega `contact_id`, `lead_id`, `conversation_id` e qualquer outro ponteiro para
 * o mundo do tenant que alguém invente amanhã.
 */
async function varrerFksParaTenantAware(padrao: string): Promise<Fk[]> {
  const { rows } = await pool.query<Fk>(
    `select src.relname as tabela, att.attname as coluna,
            tns.nspname || '.' || tgt.relname as alvo
       from pg_constraint con
       join pg_class     src on src.oid = con.conrelid
       join pg_namespace sns on sns.oid = src.relnamespace
       join pg_class     tgt on tgt.oid = con.confrelid
       join pg_namespace tns on tns.oid = tgt.relnamespace
       cross join lateral unnest(con.conkey) as k(attnum)
       join pg_attribute att on att.attrelid = src.oid and att.attnum = k.attnum
      where con.contype = 'f'
        and sns.nspname = 'public'
        and src.relname like $1
        and exists (
          select 1 from pg_attribute a
           where a.attrelid = tgt.oid
             and a.attname  = 'organization_id'
             and a.attnum > 0 and not a.attisdropped
        )
      order by 1, 2`,
    [padrao],
  );
  return rows;
}

/** Só identificador simples — nada aqui é interpolado antes de passar por isto. */
const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Lê TODO o texto guardado na partição. Colunas de texto/jsonb apenas: `embedding` é
 * `vector(1536)` e, serializado, é uma fita de dígitos capaz de casar com qualquer padrão
 * numérico por acidente.
 */
async function varrerConteudo(padrao: string): Promise<{ origem: string; valor: string }[]> {
  const { rows: cols } = await pool.query<Coluna>(
    `select c.table_name as tabela, c.column_name as coluna
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public'
        and t.table_type = 'BASE TABLE'
        and c.table_name like $1
        and c.data_type in ('text', 'character varying', 'character', 'jsonb', 'json')
      order by 1, 2`,
    [padrao],
  );
  if (cols.length === 0) return [];

  const partes = cols.map(({ tabela, coluna }) => {
    if (!IDENT.test(tabela) || !IDENT.test(coluna)) {
      throw new Error(`identificador fora do padrão, recuso interpolar: ${tabela}.${coluna}`);
    }
    return `select '${tabela}.${coluna}'::text as origem, t.${coluna}::text as valor
              from public.${tabela} t where t.${coluna} is not null`;
  });
  const { rows } = await pool.query<{ origem: string; valor: string }>(partes.join(" union all "));
  return rows;
}

/**
 * Padrões ancorados em caractere não-alfanumérico (`@`, `.`, `/`, `+`) de propósito: um
 * padrão de "11 dígitos seguidos" casaria com hash md5 por sorte e este teste passaria a
 * reprovar sem motivo. Precisão acima de recall — o falso-vermelho aqui custaria a
 * confiança no arquivo inteiro.
 */
const PADROES_DE_PII: { nome: string; re: RegExp }[] = [
  { nome: "e-mail", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { nome: "CPF formatado", re: /\d{3}\.\d{3}\.\d{3}-\d{2}/ },
  { nome: "CNPJ formatado", re: /\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/ },
  { nome: "telefone com DDI/DDD", re: /\+\d{2}\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}/ },
];

const acharPii = (linhas: { origem: string; valor: string }[]): string[] =>
  linhas.flatMap(({ origem, valor }) =>
    PADROES_DE_PII.filter((p) => p.re.test(valor)).map((p) => `${origem}: ${p.nome}`),
  );

const MATERIAL_DE_CONTROLE = "t035-pii-plantada";

afterAll(async () => {
  // Nenhum escopo é criado aqui, então não há a ordem `materials` antes de `scopes` a
  // respeitar (a FK `catalog_materials -> catalog_scopes` é `on delete restrict`).
  await pool.query("delete from catalog_materials where slug = $1", [MATERIAL_DE_CONTROLE]);
  await pool.end();
});

describe("trava 2 — a partição curada não guarda dado de ninguém", () => {
  it("a varredura enxerga a partição (sem isto, todo o resto é verde por vacuidade)", async () => {
    const rels = await relacoesDaVarredura(PARTICAO);
    const nomes = rels.map((r) => r.tabela);
    // Não é a lista que define a varredura — é o piso que prova que ela achou algo. As
    // três são as da migration 0117; tabela `catalog_*` nova entra sozinha nas asserções
    // abaixo, sem passar por aqui.
    expect(nomes).toEqual(expect.arrayContaining(["catalog_chunks", "catalog_materials", "catalog_scopes"]));
    expect(rels.every((r) => r.colunas > 0)).toBe(true);
  });

  it("nenhuma tabela da partição tem coluna de organização/tenant", async () => {
    const achados = await varrerColunas(PARTICAO, RE_TENANT);
    expect(achados.map(chaveColuna)).toEqual([]);
  });

  it("CONTROLE — a mesma varredura acha `organization_id` em contacts", async () => {
    const achados = await varrerColunas(CONTROLE, RE_TENANT);
    expect(achados.map(chaveColuna)).toContain("contacts.organization_id");
  });

  it("nenhuma FK da partição aponta para organizations ou auth.users, fora a auditoria de curadoria", async () => {
    const achados = await varrerFksPara(PARTICAO, ALVOS_DE_DONO);
    expect(achados.map(chaveFk)).toEqual([FK_DECLARADA]);
    // O alvo `organizations` não tem exceção nenhuma: FK para lá amarraria material
    // curado a um dono, que é o oposto do que a partição é.
    expect(achados.filter((f) => f.alvo === "public.organizations")).toEqual([]);
  });

  it("nenhuma FK da partição aponta para tabela tenant-aware", async () => {
    const achados = await varrerFksParaTenantAware(PARTICAO);
    expect(achados.map(chaveFk)).toEqual([]);
  });

  it("CONTROLE — a mesma varredura de FK acha os dois casos em contacts", async () => {
    // contacts -> organizations, e contacts.is_merged_into -> contacts (tenant-aware).
    expect((await varrerFksPara(CONTROLE, ALVOS_DE_DONO)).map(chaveFk)).toContain(
      "contacts.organization_id -> public.organizations",
    );
    expect((await varrerFksParaTenantAware(CONTROLE)).map(chaveFk)).toContain(
      "contacts.is_merged_into -> public.contacts",
    );
  });

  it("nenhum nome de coluna de PII na partição, fora o nome comercial do escopo", async () => {
    const achados = await varrerColunas(PARTICAO, RE_PII);
    expect(achados.map(chaveColuna)).toEqual([PII_DECLARADA]);
  });

  it("CONTROLE — a mesma varredura acha a PII de contacts", async () => {
    const achados = (await varrerColunas(CONTROLE, RE_PII)).map(chaveColuna);
    for (const esperada of [
      "contacts.email",
      "contacts.phone_number",
      "contacts.cpf_encrypted",
      "contacts.birthdate",
      "contacts.display_name",
    ]) {
      expect(achados, `a varredura de PII não achou ${esperada}`).toContain(esperada);
    }
  });

  it("as duas exceções declaradas ainda existem — lista de exceção não pode apodrecer", async () => {
    // Se a coluna que motivou a exceção sumir e a exceção ficar, ela vira permissão
    // silenciosa para a próxima violação com o mesmo nome.
    expect((await varrerFksPara(PARTICAO, ALVOS_DE_DONO)).map(chaveFk)).toContain(FK_DECLARADA);
    expect((await varrerColunas(PARTICAO, RE_PII)).map(chaveColuna)).toContain(PII_DECLARADA);
  });

  it("nenhum TEXTO guardado na partição casa com e-mail, CPF, CNPJ ou telefone", async () => {
    expect(acharPii(await varrerConteudo(PARTICAO))).toEqual([]);
  });

  it("CONTROLE — a varredura de conteúdo acha o dado pessoal plantado", async () => {
    // Sem este caso, a asserção acima ficaria verde num banco com a partição vazia — que
    // é exatamente o estado deste arquivo rodando sozinho.
    try {
      await pool.query(
        `insert into catalog_materials (applies_to_all, slug, version, title, body)
         values (true, $1, 1, 'Controle da varredura de conteúdo', $2)`,
        [MATERIAL_DE_CONTROLE, "titular cliente@exemplo.invalid, CPF 000.000.000-00, fone +55 11 91234-5678"],
      );
      const achados = acharPii(await varrerConteudo(PARTICAO));
      expect(achados).toContain("catalog_materials.body: e-mail");
      expect(achados).toContain("catalog_materials.body: CPF formatado");
      expect(achados).toContain("catalog_materials.body: telefone com DDI/DDD");
    } finally {
      await pool.query("delete from catalog_materials where slug = $1", [MATERIAL_DE_CONTROLE]);
    }
  });
});
