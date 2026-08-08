/**
 * O aviso que chega ANTES do material vencer — spec 002 (RAG por operadora), T120, FR-027.
 *
 * ═══ O DEFEITO QUE ISTO FECHA ═══
 *
 * `fn_buscar_lastro` (migrations 0123/0124/0125) já corta material vencido: `where
 * valid_until is null or valid_until >= current_date`, nas DUAS camadas. Do ponto de
 * vista da resposta isso está certo — tabela de preço do ano passado ancorando uma
 * afirmação para o cliente é pior que não responder.
 *
 * Só que o corte é **silencioso e instantâneo**. Na véspera o assistente respondia sobre
 * carência da operadora; no dia seguinte ele passa a chamar o corretor, e nada na tela
 * explica por quê. O material continua lá, listado, com ar de saudável. O sintoma que
 * chega é "a IA piorou" — e o diagnóstico verdadeiro ("o documento venceu ontem") não tem
 * nenhum lugar onde apareça.
 *
 * Este worker é a outra metade de FR-026: o corte continua sendo do banco, e o AVISO de
 * que ele vai acontecer é daqui. Sem ele, SC-009 fica pela metade — "ancora zero
 * respostas" é o que já existe; "100% dos materiais com validade declarada geram aviso
 * antes de vencer" é o que faltava.
 *
 * ═══ AS DUAS CAMADAS, E POR QUE AS DUAS ═══
 *
 *   · `ai_knowledge_sources` — o acervo do próprio corretor. Ele carregou, ele datou, ele
 *     é quem sobe a versão nova. Aviso vai para a organização dona da linha.
 *   · `catalog_materials` — o catálogo curado, que não pertence a tenant nenhum
 *     (Princípio X, trava 2). Vencer ali também cala a resposta do corretor, então ele
 *     precisa saber — e a ação dele existe: subir o próprio documento sobre o assunto. O
 *     aviso vai para as organizações que DEPENDEM daquele escopo (espelho ativo em
 *     `knowledge_scopes`), exatamente o mesmo critério do `catalog-reindexer`. Instalação
 *     nova, onde ninguém ligou operadora nenhuma, não recebe nada — e está certo: o
 *     material que ela não consulta não a prejudica ao vencer.
 *
 * No catálogo só a versão VIGENTE de cada slug entra na conta — a maior `version` não
 * inerte, a mesma definição que a busca usa (FR-037). Avisar sobre a v1 vencida quando a
 * v2 é que responde seria alarme sobre um texto que já não ancora nada.
 *
 * ═══ IDEMPOTÊNCIA: A CHAVE É (MATERIAL, DATA), NÃO SÓ O MATERIAL ═══
 *
 * Um cron diário que reabre o mesmo aviso todo dia ensina o corretor a ignorar a Central
 * — e o próximo aviso, o que importava, chega numa tela que ninguém abre mais. Mas
 * deduplicar só por material erraria para o outro lado: tabela de operadora é anual, o
 * corretor renova a validade e, um ano depois, precisa ser avisado de novo.
 *
 * Por isso a chave carrega a DATA: `ref_kind = 'knowledge_material_expiring:<YYYY-MM-DD>'`
 * mais `ref_id = <id do material>`. Enquanto a validade declarada for a mesma, existe no
 * máximo um aviso — em qualquer status, inclusive `resolved`, porque marcar como resolvido
 * é justamente o corretor dizendo "já sei". Renovou a data e ela voltou para a janela?
 * Chave nova, aviso novo.
 *
 * ⚠️ O `kind` usado é `other`, do vocabulário existente. Um `kind` próprio
 * (`material_expiring`) diria a coisa certa no rótulo da Central, mas
 * `agent_inbox_items.kind` TEM check constraint no banco, e valor novo exige migration +
 * apêndice no `baseline.sql` + linha no MANIFEST — os três fora do conjunto de escrita
 * desta tarefa. Mesmo caminho que o `catalog-reindexer` já tinha tomado. `other` rende o
 * rótulo genérico "Aviso do assistente", que é vago e **não é mentira** — enquanto
 * reaproveitar `job_dead` ("uma tarefa falhou e parou de tentar") anunciaria uma falha que
 * não houve. Título e corpo carregam o significado inteiro.
 *
 * ═══ NADA DE AUDITORIA, DE PROPÓSITO DECLARADO ═══
 *
 * Não há `audit()` aqui nem na rota. `lib/audit/actions.ts` é um union fechado e não tem
 * código para esta família; inventar a string reprovaria no `typecheck`, e o arquivo está
 * fora do conjunto de escrita desta tarefa. O registro durável do que a rodada fez é o
 * próprio item na Central — que, ao contrário do `api_audit_log`, é lido por quem precisa
 * agir. Quando o código entrar no union, a chamada é uma linha na rota.
 */
import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Antecedência padrão. 30 dias é o prazo em que uma renovação de material de operadora
 * ainda cabe: pedir o documento novo, receber, conferir e subir. Avisar na véspera seria
 * informar o corretor de um problema que ele já não consegue evitar.
 */
export const DIAS_DE_ANTECEDENCIA = 30;

/**
 * Vocabulário de `agent_inbox_items.kind`. Tipado como `InboxKind` — import só de TIPO,
 * que some no build — para que um valor ausente da constraint do banco vire erro de
 * compilação em vez de um `23514` fire-and-forget que nunca chega à tela.
 */
export const KIND_DO_AVISO: InboxKind = "other";

/**
 * Prefixo do `ref_kind`. A data de validade é concatenada com `:` — ver a seção de
 * idempotência no cabeçalho. `ref_kind` não é usado por nenhum link da Central (medido:
 * nenhum arquivo de `app/app` ou `components` o lê), então a chave composta não quebra
 * navegação nenhuma.
 */
export const REF_KIND_BASE = "knowledge_material_expiring";

/** Quantas linhas por `insert`. Fan-out de catálogo pode alcançar muita organização. */
const LOTE_DE_INSERCAO = 200;

/**
 * Teto de leitura do catálogo curado. A versão vigente por slug precisa ser calculada
 * sobre TODAS as versões não inertes — inclusive as fora da janela de aviso —, então esta
 * consulta não pode ser filtrada por data. O catálogo é conteúdo do fabricante, na ordem
 * de centenas de linhas; o teto existe para o pior caso não travar o tick.
 */
const TETO_DO_CATALOGO = 2000;

export interface DependenciasDaVarredura {
  /** "Hoje" da rodada. Injetável para o teste fixar a data sem depender do relógio. */
  agora?: Date;
  diasDeAntecedencia?: number;
  requestId?: string;
}

export interface ResultadoDaVarredura {
  /** Referência da rodada, em UTC — a mesma que o `current_date` do corte da busca. */
  hoje: string;
  /** Último dia que ainda entra na janela de aviso. */
  limite: string;
  dias_de_antecedencia: number;
  /** Materiais do acervo do corretor dentro da janela. */
  materiais_do_corretor: number;
  /** Materiais do catálogo (versão vigente) dentro da janela. */
  materiais_do_catalogo: number;
  /** Avisos que nasceram nesta rodada. */
  avisos_abertos: number;
  /** Candidatos que já tinham aviso para a MESMA data — a idempotência em números. */
  ja_avisados: number;
  /** Organizações que receberam ao menos um aviso novo. */
  organizacoes: number;
}

/** Um aviso a abrir, já resolvido em organização, nome do material e escopo. */
interface Candidato {
  organizationId: string;
  materialId: string;
  /** Nome que o corretor vê. */
  material: string;
  /** Operadora. `null` = material que vale para todas. */
  operadora: string | null;
  validUntil: string;
  origem: "corretor" | "catalogo";
}

// ---------------------------------------------------------------------------
// Datas — tudo em UTC, sem `Intl`, sem dependência de locale do contêiner
// ---------------------------------------------------------------------------

/** `Date` → `YYYY-MM-DD` em UTC. */
function dataISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function somarDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return dataISO(d);
}

function diasAte(hoje: string, alvo: string): number {
  const a = Date.parse(`${hoje}T00:00:00.000Z`);
  const b = Date.parse(`${alvo}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/** `2026-09-12` → `12/09/2026`. O corretor lê data brasileira, não ISO. */
function porExtenso(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

/**
 * A REGRA da janela, escrita uma vez.
 *
 * O corte também existe no `where` das consultas, para não trazer o acervo inteiro pela
 * rede — mas é ESTA função que manda. Duas razões: ela é o que o teste consegue
 * exercitar sem Postgres, e ela é a rede de segurança se alguém trocar um `gte` por `gt`
 * lá em cima.
 *
 * `>= hoje` na borda de baixo é deliberado e espelha o `>= current_date` da busca:
 * material que vence HOJE ainda ancora, então ainda é "vai vencer", não "venceu". A borda
 * de cima é inclusiva pelo mesmo motivo: o dia exatamente no limite da antecedência é o
 * primeiro dia útil do aviso, não o último a ficar de fora.
 */
export function dentroDaJanela(validUntil: string | null, hoje: string, limite: string): boolean {
  if (!validUntil) return false; // FR-025: datar é opcional, e não datar nunca vira alarme
  return validUntil >= hoje && validUntil <= limite;
}

// ---------------------------------------------------------------------------
// Texto — pt-BR, para corretor de plano de saúde, sem jargão
// ---------------------------------------------------------------------------

function quando(dias: number): string {
  if (dias <= 0) return "vence hoje";
  if (dias === 1) return "vence amanhã";
  return `vence em ${dias} dias`;
}

export function tituloDoAviso(c: Candidato, hoje: string): string {
  const alvo = quando(diasAte(hoje, c.validUntil));
  return c.operadora
    ? `O material "${c.material}" (${c.operadora}) ${alvo}`
    : `O material "${c.material}" ${alvo}`;
}

export function corpoDoAviso(c: Candidato, hoje: string): string {
  const dias = diasAte(hoje, c.validUntil);
  const prazo =
    dias <= 0 ? "é o último dia de validade dele" : dias === 1 ? "falta 1 dia" : `faltam ${dias} dias`;

  const onde = c.operadora
    ? `O material "${c.material}", da operadora ${c.operadora},`
    : `O material "${c.material}", que vale para todas as operadoras,`;

  const consequencia =
    `A partir do dia seguinte o assistente para de usar esse material para responder clientes: ` +
    `ele passa a agir como se o documento não existisse e chama você em vez de arriscar uma resposta. ` +
    `Nada é apagado — o material continua no acervo, só deixa de valer.`;

  const acao =
    c.origem === "corretor"
      ? `O que fazer: suba a versão nova do documento no acervo. Se ele continua valendo como está, ` +
        `basta atualizar a data de validade dele.`
      : `Esse material veio do catálogo que acompanha o produto, então quem o atualiza somos nós. ` +
        `O que fazer do seu lado, se você não puder ficar sem o assunto: suba no seu acervo o seu ` +
        `próprio documento sobre ele — material seu tem preferência sobre o do catálogo.`;

  return `${onde} vale até ${porExtenso(c.validUntil)} (${prazo}). ${consequencia} ${acao}`;
}

// ---------------------------------------------------------------------------
// Coleta
// ---------------------------------------------------------------------------

interface FonteDoCorretor {
  id: string;
  organization_id: string;
  name: string;
  scope_id: string | null;
  valid_until: string | null;
}

/**
 * Materiais do acervo do corretor prestes a vencer.
 *
 * NÃO filtra `is_active`, e isso é deliberado: `fn_buscar_lastro` também não filtra —
 * ela chega ao material pelo trecho da versão ativa da base. Filtrar aqui produziria
 * silêncio justamente sobre um material que ainda ancora resposta.
 */
async function doCorretor(
  admin: Admin,
  hoje: string,
  limite: string,
): Promise<Candidato[]> {
  const { data, error } = await admin
    .from("ai_knowledge_sources")
    .select("id, organization_id, name, scope_id, valid_until")
    .not("valid_until", "is", null)
    .gte("valid_until", hoje)
    .lte("valid_until", limite);

  if (error) throw new Error(`acervo_query_failed: ${error.message}`);

  const fontes = ((data ?? []) as FonteDoCorretor[]).filter((f) =>
    dentroDaJanela(f.valid_until, hoje, limite),
  );
  if (fontes.length === 0) return [];

  // O nome da OPERADORA vem por junção, nunca copiado (doutrina DIRC: Referenciar) — se
  // o corretor renomear o escopo, o aviso do dia seguinte já sai com o nome novo.
  const escopos = [...new Set(fontes.map((f) => f.scope_id).filter((s): s is string => !!s))];
  const nomeDoEscopo = new Map<string, string>();
  if (escopos.length > 0) {
    const { data: linhas, error: erroEscopo } = await admin
      .from("knowledge_scopes")
      .select("id, display_name")
      .in("id", escopos);
    if (erroEscopo) throw new Error(`escopos_query_failed: ${erroEscopo.message}`);
    for (const l of (linhas ?? []) as { id: string; display_name: string }[]) {
      nomeDoEscopo.set(l.id, l.display_name);
    }
  }

  return fontes.map((f) => ({
    organizationId: f.organization_id,
    materialId: f.id,
    material: f.name,
    operadora: f.scope_id ? (nomeDoEscopo.get(f.scope_id) ?? null) : null,
    validUntil: f.valid_until as string,
    origem: "corretor" as const,
  }));
}

interface MaterialCurado {
  id: string;
  slug: string;
  version: number;
  title: string;
  catalog_scope_id: string | null;
  valid_until: string | null;
}

interface EspelhoAtivo {
  organization_id: string;
  catalog_scope_id: string | null;
  display_name: string;
}

/**
 * A versão VIGENTE de cada slug: a maior `version` entre as não inertes. É a mesma
 * definição do CTE `material_vigente` de `fn_buscar_lastro` — se as duas divergirem, o
 * aviso passa a falar de um texto que a busca não usa.
 */
export function vigentePorSlug(materiais: MaterialCurado[]): MaterialCurado[] {
  const porSlug = new Map<string, MaterialCurado>();
  for (const m of materiais) {
    const atual = porSlug.get(m.slug);
    if (!atual || m.version > atual.version) porSlug.set(m.slug, m);
  }
  return [...porSlug.values()];
}

/**
 * Materiais do catálogo curado prestes a vencer, já espalhados pelas organizações que
 * dependem deles.
 */
async function doCatalogo(admin: Admin, hoje: string, limite: string): Promise<Candidato[]> {
  const { data, error } = await admin
    .from("catalog_materials")
    .select("id, slug, version, title, catalog_scope_id, valid_until")
    .eq("inert", false)
    .limit(TETO_DO_CATALOGO);

  if (error) throw new Error(`catalogo_query_failed: ${error.message}`);

  const vencendo = vigentePorSlug((data ?? []) as MaterialCurado[]).filter((m) =>
    dentroDaJanela(m.valid_until, hoje, limite),
  );
  if (vencendo.length === 0) return [];

  // Quem depende do catálogo: espelho com `catalog_scope_id` preenchido e ligado (trava
  // 4). Espelho nasce desligado (A-20), então instalação recém-feita não recebe nada.
  const { data: espelhos, error: erroEspelho } = await admin
    .from("knowledge_scopes")
    .select("organization_id, catalog_scope_id, display_name")
    .eq("is_active", true)
    .not("catalog_scope_id", "is", null);

  if (erroEspelho) throw new Error(`espelhos_query_failed: ${erroEspelho.message}`);

  const ativos = (espelhos ?? []) as EspelhoAtivo[];
  if (ativos.length === 0) return [];

  const porCatalogScope = new Map<string, EspelhoAtivo[]>();
  for (const e of ativos) {
    if (!e.catalog_scope_id) continue;
    porCatalogScope.set(e.catalog_scope_id, [...(porCatalogScope.get(e.catalog_scope_id) ?? []), e]);
  }
  /** Toda organização que depende do catálogo — destinatária do "vale para todos". */
  const dependentes = [...new Set(ativos.map((e) => e.organization_id))];

  const candidatos: Candidato[] = [];
  for (const m of vencendo) {
    if (m.catalog_scope_id) {
      for (const e of porCatalogScope.get(m.catalog_scope_id) ?? []) {
        candidatos.push({
          organizationId: e.organization_id,
          materialId: m.id,
          material: m.title,
          // O nome do ESPELHO, não o do catálogo: é o que o corretor lê na tela dele.
          operadora: e.display_name,
          validUntil: m.valid_until as string,
          origem: "catalogo",
        });
      }
    } else {
      for (const organizationId of dependentes) {
        candidatos.push({
          organizationId,
          materialId: m.id,
          material: m.title,
          operadora: null,
          validUntil: m.valid_until as string,
          origem: "catalogo",
        });
      }
    }
  }
  return candidatos;
}

// ---------------------------------------------------------------------------
// A rodada
// ---------------------------------------------------------------------------

function refKind(validUntil: string): string {
  return `${REF_KIND_BASE}:${validUntil}`;
}

function chave(c: Candidato): string {
  return `${c.organizationId}|${refKind(c.validUntil)}|${c.materialId}`;
}

/**
 * Uma rodada. Separada do handler HTTP para o teste exercitar a REGRA sem montar request
 * nem auth — e para o handler ficar sendo só borda.
 */
export async function avisarValidadeDeMaterial(
  admin: Admin,
  deps: DependenciasDaVarredura = {},
): Promise<ResultadoDaVarredura> {
  const requestId = deps.requestId ?? "sem-request-id";
  const dias = deps.diasDeAntecedencia ?? DIAS_DE_ANTECEDENCIA;
  // UTC dos dois lados: o corte da busca é `current_date` do Postgres e o contêiner do
  // `scheduler` roda com TZ=UTC. Um descasamento de fuso deslocaria o aviso em horas
  // dentro de uma janela de 30 dias — nunca o suprimiria.
  const hoje = dataISO(deps.agora ?? new Date());
  const limite = somarDias(hoje, dias);

  const doAcervo = await doCorretor(admin, hoje, limite);
  const doCurado = await doCatalogo(admin, hoje, limite);
  const candidatos = [...doAcervo, ...doCurado];

  const base: ResultadoDaVarredura = {
    hoje,
    limite,
    dias_de_antecedencia: dias,
    materiais_do_corretor: doAcervo.length,
    materiais_do_catalogo: new Set(doCurado.map((c) => c.materialId)).size,
    avisos_abertos: 0,
    ja_avisados: 0,
    organizacoes: 0,
  };

  if (candidatos.length === 0) return base;

  // Uma consulta para toda a deduplicação. Em regime, é ELA que responde a rodada
  // inteira: no dia seguinte todos os candidatos já têm aviso e nada é escrito.
  const { data: existentes, error: erroExistentes } = await admin
    .from("agent_inbox_items")
    .select("organization_id, ref_kind, ref_id")
    .eq("kind", KIND_DO_AVISO)
    .in("ref_kind", [...new Set(candidatos.map((c) => refKind(c.validUntil)))])
    .in("ref_id", [...new Set(candidatos.map((c) => c.materialId))]);

  if (erroExistentes) throw new Error(`avisos_query_failed: ${erroExistentes.message}`);

  const jaTem = new Set(
    ((existentes ?? []) as { organization_id: string | null; ref_kind: string | null; ref_id: string | null }[])
      .map((r) => `${r.organization_id}|${r.ref_kind}|${r.ref_id}`),
  );

  // Dois candidatos idênticos na mesma rodada (o mesmo material curado alcançando a
  // organização por dois caminhos) viram um aviso só.
  const vistos = new Set<string>();
  const novos: Candidato[] = [];
  let jaAvisados = 0;
  for (const c of candidatos) {
    const k = chave(c);
    if (vistos.has(k)) continue;
    vistos.add(k);
    if (jaTem.has(k)) {
      jaAvisados += 1;
      continue;
    }
    novos.push(c);
  }

  if (novos.length === 0) {
    return { ...base, ja_avisados: jaAvisados };
  }

  const linhas = novos.map((c) => ({
    organization_id: c.organizationId,
    kind: KIND_DO_AVISO,
    severity: "warn",
    title: tituloDoAviso(c, hoje),
    body: corpoDoAviso(c, hoje),
    ref_kind: refKind(c.validUntil),
    ref_id: c.materialId,
  }));

  let abertos = 0;
  const orgsAvisadas = new Set<string>();
  for (let i = 0; i < linhas.length; i += LOTE_DE_INSERCAO) {
    const lote = linhas.slice(i, i + LOTE_DE_INSERCAO);
    const { error: erroInsert } = await admin.from("agent_inbox_items").insert(lote);
    if (erroInsert) {
      // Não interrompe a rodada: o lote seguinte pode ser de outra organização, e trocar
      // N avisos perdidos por 1 é péssimo negócio. O que não pode é sumir em silêncio —
      // o aviso é justamente o mecanismo anti-morte desta feature.
      logger.error("[validade-de-material] aviso na Central falhou", {
        error: erroInsert.message,
        linhas: lote.length,
        requestId,
      });
      continue;
    }
    abertos += lote.length;
    for (const l of lote) orgsAvisadas.add(l.organization_id);
  }

  if (abertos > 0) {
    logger.info("[validade-de-material] avisos abertos", {
      hoje,
      limite,
      avisos_abertos: abertos,
      organizacoes: orgsAvisadas.size,
      requestId,
    });
  }

  return {
    ...base,
    avisos_abertos: abertos,
    ja_avisados: jaAvisados,
    organizacoes: orgsAvisadas.size,
  };
}
