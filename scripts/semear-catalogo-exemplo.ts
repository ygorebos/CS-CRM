/**
 * Semeia o CATÁLOGO DE EXEMPLO na instalação de curadoria — spec 002, F3, decisão A-19.
 *
 * ═══ POR QUE O CATÁLOGO NASCE COM EXEMPLO, E NÃO COM CONTEÚDO REAL ═══
 *
 * Conteúdo real de operadora tem dono, tem data de validade e erra caro: um procedimento
 * de boleto desatualizado embarcado no produto vira o agente afirmando com convicção uma
 * coisa que a operadora mudou mês passado. Exemplo declarado como exemplo não tem esse
 * risco e resolve o problema que o catálogo existe para resolver — provar que a instalação
 * NASCE sabendo, com escopo ligável em um clique, antes de o corretor carregar qualquer
 * material seu (FR-030, SC-017).
 *
 * Por isso **cada material diz no próprio corpo que é exemplo**. Não num comentário do
 * SQL, não numa coluna de metadado: no texto que o cliente pode acabar lendo. Se o corretor
 * publicar o agente sem trocar nada, a pior consequência possível é o cliente ler que
 * aquilo é conteúdo de demonstração — nunca acreditar num procedimento inventado.
 *
 * Conteúdo real entra depois, por release, sem tocar em estrutura.
 *
 * ═══ COMO USAR ═══
 *
 *   pnpm exec tsx --env-file=.env.local scripts/semear-catalogo-exemplo.ts
 *
 * Idempotente: `on conflict do nothing` em tudo. Rodar duas vezes não duplica e não
 * sobrescreve — é a mesma regra da semeadura do `baseline.sql` (trava 6).
 *
 * Alvo: `SUPABASE_DB_URL`, ou `--db-url=<connection string>`. NUNCA aponte para produção
 * de outro produto — confira o host antes (ver docs/doctrine/armadilhas-de-execucao.md,
 * entrada 13).
 */
import pg from "pg";

import { embedText } from "@/lib/ai/embed";
import { DEFAULT_EMBEDDING_MODEL } from "@/lib/ai/gateway";

interface MaterialExemplo {
  slug: string;
  titulo: string;
  /** `null` = vale para todos os escopos. */
  escopo: string | null;
  corpo: string;
}

const AVISO_DE_EXEMPLO =
  "Este é um material de EXEMPLO que acompanha a instalação, para demonstrar como o " +
  "conhecimento por operadora funciona. Substitua-o pelo procedimento real da sua " +
  "operadora antes de usar em atendimento.";

const ESCOPOS: { slug: string; nome: string }[] = [
  { slug: "operadora-exemplo-a", nome: "Operadora Exemplo A" },
  { slug: "operadora-exemplo-b", nome: "Operadora Exemplo B" },
];

const MATERIAIS: MaterialExemplo[] = [
  {
    slug: "exemplo-o-que-e-carencia",
    titulo: "O que é carência",
    escopo: null,
    corpo:
      "Carência é o período que o beneficiário precisa aguardar, contado da data de início " +
      "do contrato, antes de poder usar determinado procedimento. Cada tipo de atendimento " +
      "costuma ter um prazo próprio: consultas e exames simples costumam ter carência curta, " +
      "internações e cirurgias costumam ter carência mais longa, e parto tem prazo próprio. " +
      "O prazo exato depende do contrato e da operadora — quem informa o número é o contrato " +
      "assinado, não uma regra geral.\n\n" +
      AVISO_DE_EXEMPLO,
  },
  {
    slug: "exemplo-portabilidade-de-carencias",
    titulo: "Portabilidade de carências",
    escopo: null,
    corpo:
      "Portabilidade de carências é a possibilidade de mudar de plano levando junto o tempo " +
      "de carência já cumprido, sem recomeçar a contagem. Em geral depende de o plano de " +
      "destino ser compatível em faixa de preço e cobertura, de o contrato atual estar em dia " +
      "e de um tempo mínimo de permanência no plano anterior. As condições exatas e os prazos " +
      "são definidos pela regulamentação vigente e pela operadora de destino.\n\n" +
      AVISO_DE_EXEMPLO,
  },
  {
    slug: "exemplo-segunda-via-de-boleto",
    titulo: "Segunda via de boleto — orientação geral",
    escopo: null,
    corpo:
      "A segunda via do boleto costuma ser obtida pelo aplicativo ou pelo portal do " +
      "beneficiário, na área financeira, e também pela central de atendimento da operadora. " +
      "O caminho exato, os canais disponíveis e o prazo de compensação variam por operadora. " +
      "Boleto vencido pode exigir emissão de nova data, com atualização de valor.\n\n" +
      AVISO_DE_EXEMPLO,
  },
  {
    slug: "exemplo-a-rede-credenciada",
    titulo: "Como consultar a rede credenciada",
    escopo: "operadora-exemplo-a",
    corpo:
      "A consulta à rede credenciada é feita pelo buscador de rede, filtrando por " +
      "especialidade, cidade e tipo de plano. É importante conferir se o prestador atende ao " +
      "produto específico do beneficiário: um mesmo hospital pode atender uma linha de " +
      "produto e não atender outra. Em caso de divergência entre o buscador e o atendimento " +
      "presencial, vale o que a operadora confirmar por escrito.\n\n" +
      AVISO_DE_EXEMPLO,
  },
  {
    slug: "exemplo-b-reembolso",
    titulo: "Como funciona o pedido de reembolso",
    escopo: "operadora-exemplo-b",
    corpo:
      "O pedido de reembolso costuma exigir a nota fiscal do atendimento, o relatório do " +
      "profissional e os dados bancários do titular, enviados pelo aplicativo ou pelo portal. " +
      "O valor devolvido segue a tabela de reembolso do contrato e raramente equivale ao valor " +
      "pago — a diferença é a parte que fica com o beneficiário. O prazo de análise é contado " +
      "a partir do envio da documentação completa.\n\n" +
      AVISO_DE_EXEMPLO,
  },
];

function connectionString(): string {
  const arg = process.argv.find((a) => a.startsWith("--db-url="));
  const url = arg ? arg.slice("--db-url=".length) : process.env.SUPABASE_DB_URL;
  if (!url) {
    throw new Error("defina SUPABASE_DB_URL ou passe --db-url=<connection string>");
  }
  return url;
}

async function main(): Promise<void> {
  const url = connectionString();
  // O host aparece no log para que quem roda VEJA em que banco está escrevendo antes de o
  // script terminar. Credencial nunca é logada.
  process.stdout.write(`alvo: ${new URL(url).host}\n`);

  const db = new pg.Client({
    connectionString: url,
    ssl: url.includes("127.0.0.1") || url.includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    for (const escopo of ESCOPOS) {
      await db.query(
        `insert into public.catalog_scopes (slug, display_name)
         values ($1, $2) on conflict (slug) do nothing`,
        [escopo.slug, escopo.nome],
      );
    }

    let criados = 0;
    let jaExistiam = 0;

    for (const material of MATERIAIS) {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.catalog_materials
           (catalog_scope_id, applies_to_all, slug, version, title, body, origin)
         select
           case when $1::text is null then null
                else (select id from public.catalog_scopes where slug = $1) end,
           $1::text is null,
           $2, 1, $3, $4, 'seed'
         on conflict (slug, version) do nothing
         returning id`,
        [material.escopo, material.slug, material.titulo, material.corpo],
      );

      if (!rows[0]) {
        jaExistiam += 1;
        continue;
      }

      // Um trecho por material: os textos são curtos e coesos, e partir um procedimento de
      // 5 linhas em pedaços só piora a recuperação — o trecho perderia justamente a frase
      // que diz de que operadora ele fala.
      const conteudo = `${material.titulo}\n\n${material.corpo}`;
      const { embedding } = await embedText(conteudo, { organizationId: "catalogo-curado" });

      await db.query(
        `insert into public.catalog_chunks
           (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
         values ($1, 0, $2, md5($2), $3, $4::vector, $5)`,
        [
          rows[0].id,
          conteudo,
          Math.ceil(conteudo.length / 4),
          `[${embedding.join(",")}]`,
          DEFAULT_EMBEDDING_MODEL,
        ],
      );
      criados += 1;
    }

    // Espelhos para toda organização existente — sem isto a semeadura escreveria no
    // catálogo e nenhum corretor veria diferença (evento sem consumidor).
    const { rows: orgs } = await db.query<{ n: string }>(
      "select coalesce(sum(public.fn_sincronizar_escopos_do_catalogo(o.id)), 0)::text n from public.organizations o",
    );

    process.stdout.write(
      `materiais criados: ${criados} | já existiam: ${jaExistiam} | espelhos novos: ${orgs[0]?.n ?? 0}\n`,
    );
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`falhou: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
