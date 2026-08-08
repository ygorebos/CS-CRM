/**
 * Exporta o catálogo curado da instalação de curadoria para o apêndice do
 * `supabase/baseline.sql` — spec 002, T058, contrato `semeadura-do-catalogo.md`.
 *
 * ═══ O QUE ESTE SCRIPT É ═══
 *
 * O caminho pelo qual conteúdo curado sai da NOSSA instalação e chega a todo clone. O
 * administrador de plataforma escreve pela tela; quando o conteúdo está bom, este script
 * o transforma no bloco SQL que o `install.sh` e o `update.sh` aplicam.
 *
 * Exporta **apenas** linhas `origin = 'seed'`. Material `origin = 'local'` é do dono
 * daquela instalação e não pertence a release nenhum — exportá-lo publicaria a correção
 * particular de alguém para todos os clones.
 *
 * ═══ AS TRÊS COISAS QUE O SQL GERADO TEM DE FAZER ═══
 *
 * 1. **`on conflict do nothing`, nunca `do update`.** As duas formas são idempotentes; só
 *    uma é não-destrutiva. Um `do update` reaplicado apagaria a correção que o dono da
 *    instalação fez num procedimento errado — é a trava 6, e SC-018 mede exatamente isso.
 *
 * 2. **Embeddings viajam prontos**, como literal `vector(1536)`, com `embedding_model`
 *    ao lado. SQL não chama API de embedding: sem isto a instalação fresca só responderia
 *    depois que um worker rodasse com chave de IA válida, e "a instalação nasce sabendo"
 *    (FR-030, SC-017) falharia no minuto zero. Custo declarado: ~12 KB por trecho.
 *
 * 3. **Referências por `slug`, nunca por `id`.** Os UUIDs são de ESTA instalação; num
 *    clone eles não existem. Escopo e material são resolvidos por `slug` dentro do próprio
 *    insert — é o que permite o mesmo bloco rodar em banco novo e em banco de seis meses.
 *
 * O bloco termina chamando `fn_sincronizar_escopos_do_catalogo` para toda organização
 * existente. Sem essa linha a semeadura serviria só a instalação nova, e o `update.sh` de
 * quem já rodava entregaria escopo curado que ninguém enxerga.
 *
 * ═══ COMO USAR ═══
 *
 *   pnpm exec tsx --env-file=.env.local scripts/exportar-catalogo-para-baseline.ts > bloco.sql
 *
 * A saída vai para stdout, de propósito: quem revisa o release lê o bloco antes de
 * anexá-lo. Um script que editasse o `baseline.sql` sozinho transformaria "publicar
 * conteúdo" em operação sem revisão.
 */
import pg from "pg";

interface LinhaEscopo {
  slug: string;
  display_name: string;
  official_code: string | null;
}

interface LinhaMaterial {
  slug: string;
  version: number;
  title: string;
  body: string;
  valid_until: string | null;
  escopo_slug: string | null;
  applies_to_all: boolean;
}

interface LinhaTrecho {
  material_slug: string;
  material_version: number;
  position: number;
  content: string;
  token_count: number;
  embedding: string;
  embedding_model: string;
}

/**
 * Dollar-quoting em vez de escapar aspas: o corpo de um material tem quebras de linha e
 * apóstrofos, e duplicar aspas num texto de 2 KB é onde nasce o erro de sintaxe que só
 * aparece no `install.sh` de um clone.
 */
function citar(texto: string): string {
  let tag = "sem";
  while (texto.includes(`$${tag}$`)) tag += "x";
  return `$${tag}$${texto}$${tag}$`;
}

function citarOuNulo(texto: string | null): string {
  return texto === null ? "null" : citar(texto);
}

/**
 * O embedding vem do Postgres como `[0.1,-0.2,…]`. Seis casas decimais bastam: a
 * diferença em similaridade de cosseno é da ordem de 1e-6, muito abaixo de qualquer
 * limiar do produto, e o arquivo fica menor. Precisão total aqui seria peso sem efeito.
 */
function embeddingLiteral(bruto: string): string {
  const nums = bruto
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((n) => Number.parseFloat(n).toFixed(6));
  return `'[${nums.join(",")}]'::vector`;
}

function connectionString(): string {
  const arg = process.argv.find((a) => a.startsWith("--db-url="));
  const url = arg ? arg.slice("--db-url=".length) : process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("defina SUPABASE_DB_URL ou passe --db-url=<connection string>");
  return url;
}

async function main(): Promise<void> {
  const url = connectionString();
  const db = new pg.Client({
    connectionString: url,
    ssl: url.includes("127.0.0.1") || url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    const escopos = (
      await db.query<LinhaEscopo>(
        `select slug, display_name, official_code
           from public.catalog_scopes
          where is_active
            and exists (
              select 1 from public.catalog_materials m
               where m.catalog_scope_id = catalog_scopes.id and m.origin = 'seed'
            )
          order by slug`,
      )
    ).rows;

    const materiais = (
      await db.query<LinhaMaterial>(
        `select m.slug, m.version, m.title, m.body, m.valid_until::text, m.applies_to_all,
                cs.slug as escopo_slug
           from public.catalog_materials m
           left join public.catalog_scopes cs on cs.id = m.catalog_scope_id
          where m.origin = 'seed'
          order by m.slug, m.version`,
      )
    ).rows;

    const trechos = (
      await db.query<LinhaTrecho>(
        `select m.slug as material_slug, m.version as material_version,
                c.position, c.content, c.token_count,
                c.embedding::text as embedding, c.embedding_model
           from public.catalog_chunks c
           join public.catalog_materials m on m.id = c.catalog_material_id
          where m.origin = 'seed'
          order by m.slug, m.version, c.position`,
      )
    ).rows;

    const out: string[] = [];
    const kb = Math.round(trechos.reduce((n, t) => n + t.embedding.length, 0) / 1024);

    out.push("");
    out.push("");
    out.push("-- ---- catálogo curado de exemplo (semeadura, spec 002 F3) ----");
    out.push("--");
    out.push(`-- GERADO por scripts/exportar-catalogo-para-baseline.ts. Não edite à mão: a próxima`);
    out.push("-- exportação sobrescreve. Para mudar conteúdo, mude na instalação de curadoria e");
    out.push("-- exporte de novo.");
    out.push("--");
    out.push(`-- ${escopos.length} escopos, ${materiais.length} materiais, ${trechos.length} trechos.`);
    out.push(`-- Custo declarado: ~${kb} KB só de embeddings — é dívida assumida, não detalhe. Ela`);
    out.push("-- existe para que a instalação fresca responda no minuto zero, SEM chave de IA");
    out.push("-- configurada (FR-030, SC-017, research D6).");
    out.push("--");
    out.push("-- CONTEÚDO DE EXEMPLO (A-19): cada material diz no PRÓPRIO CORPO que é exemplo, e");
    out.push("-- não num comentário daqui. Se o corretor publicar o agente sem trocar nada, a pior");
    out.push("-- consequência é o cliente ler que aquilo é demonstração — nunca acreditar num");
    out.push("-- procedimento inventado. Conteúdo real entra por release, sem tocar em estrutura.");
    out.push("--");
    out.push("-- `do nothing`, NUNCA `do update`: as duas formas são idempotentes, só uma é");
    out.push("-- não-destrutiva. Um `do update` reaplicado apagaria a correção local (trava 6).");
    out.push("");

    for (const e of escopos) {
      out.push(
        `insert into public.catalog_scopes (slug, display_name, official_code)\n` +
          `values (${citar(e.slug)}, ${citar(e.display_name)}, ${citarOuNulo(e.official_code)})\n` +
          `on conflict (slug) do nothing;`,
      );
    }
    out.push("");

    for (const m of materiais) {
      // Escopo e material resolvidos por slug: o UUID desta instalação não existe no clone.
      const escopoExpr = m.escopo_slug
        ? `(select id from public.catalog_scopes where slug = ${citar(m.escopo_slug)})`
        : "null";
      out.push(
        `insert into public.catalog_materials\n` +
          `  (catalog_scope_id, applies_to_all, slug, version, title, body, valid_until, origin)\n` +
          `select ${escopoExpr}, ${m.applies_to_all}, ${citar(m.slug)}, ${m.version},\n` +
          `       ${citar(m.title)}, ${citar(m.body)}, ${m.valid_until ? `'${m.valid_until}'::date` : "null"}, 'seed'\n` +
          `on conflict (slug, version) do nothing;`,
      );
    }
    out.push("");

    for (const t of trechos) {
      // `where not exists` em vez de `on conflict`: catalog_chunks não tem chave natural, e
      // sem esta guarda cada `update.sh` acrescentaria uma cópia do mesmo trecho — o acervo
      // curado cresceria a cada atualização e a busca passaria a devolver duplicata.
      out.push(
        `insert into public.catalog_chunks\n` +
          `  (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)\n` +
          `select m.id, ${t.position}, ${citar(t.content)}, md5(${citar(t.content)}), ${t.token_count},\n` +
          `       ${embeddingLiteral(t.embedding)}, ${citar(t.embedding_model)}\n` +
          `  from public.catalog_materials m\n` +
          ` where m.slug = ${citar(t.material_slug)} and m.version = ${t.material_version}\n` +
          `   and not exists (\n` +
          `     select 1 from public.catalog_chunks c\n` +
          `      where c.catalog_material_id = m.id and c.position = ${t.position}\n` +
          `   );`,
      );
    }

    out.push("");
    out.push("-- Espelhos para TODA organização existente. É esta linha que faz escopo curado novo");
    out.push("-- alcançar quem instalou há seis meses e roda o update.sh — sem ela a semeadura");
    out.push("-- serviria só a instalação nova, e a atualização entregaria escopo que ninguém vê.");
    out.push("select public.fn_sincronizar_escopos_do_catalogo(o.id) from public.organizations o;");
    out.push("");
    out.push("notify pgrst, 'reload schema';");

    process.stdout.write(`${out.join("\n")}\n`);
    process.stderr.write(
      `exportados: ${escopos.length} escopos, ${materiais.length} materiais, ${trechos.length} trechos (~${kb} KB de embeddings)\n`,
    );
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`falhou: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
