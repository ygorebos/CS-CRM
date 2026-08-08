/**
 * Peças compartilhadas da superfície `/api/v1/knowledge-scopes` (spec 002, T067).
 *
 * Arquivo `_`-prefixado porque o Next só roteia `route.ts`/`page.tsx` — o resto da pasta
 * é módulo comum, como `app/api/v1/pipelines/_handler.ts`. Aqui vive tudo que é PURO
 * (projeção, comparação de nome, cursor, schemas) para poder ser testado sem banco, mais
 * a contagem de materiais, que a lista e o PATCH devolvem com a mesma regra.
 *
 * ## As duas camadas, e por que `origin` é campo e não inferência
 *
 * `knowledge_scopes` (migration 0118) guarda TODO escopo que um tenant enxerga — o que ele
 * criou e o espelho do que veio no catálogo curado. `catalog_scope_id` preenchido é a
 * única diferença estrutural entre os dois, e ela não pode vazar crua para o cliente: o id
 * do catálogo não significa nada para a tela e amarraria o contrato à partição do
 * fabricante. Sai projetado em `origin`, que é o que FR-039 pede — o corretor precisa saber
 * a quem cobrar a correção de um material, e são pessoas diferentes nas duas camadas.
 */
import { createHash } from "node:crypto";
import type { NextResponse } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, type ApiError } from "@/lib/api/wrappers";
import type { AuditAction } from "@/lib/audit/actions";
import {
  ROTULO_PADRAO,
  resolverRotuloDoEscopo,
  type RotuloDoEscopo,
} from "@/lib/vocabulary/knowledge-scope";

// ---------------------------------------------------------------------------
// Vocabulário do contrato
// ---------------------------------------------------------------------------

/**
 * Valores de `origin` em `contracts/rotas-http.md`. São do CONTRATO, não da tela: o
 * rótulo que o corretor lê ("Operadora") vem de `lib/vocabulary/knowledge-scope.ts` e pode
 * mudar por instalação; estes dois não mudam nunca, porque quebrar contrato publicado é
 * caro e trocar rótulo é configuração (FR-033/FR-041).
 */
export const ORIGEM = {
  /** Espelho de um `catalog_scopes` — curado pelo fabricante, corrigido por ele. */
  catalogo: "catalogo",
  /** Criado pelo corretor nesta organização (FR-002) — corrigido por ele. */
  proprio: "proprio",
} as const;

export type OrigemDoEscopo = (typeof ORIGEM)[keyof typeof ORIGEM];

/**
 * Os quatro códigos vivem na união canônica de `lib/audit/actions.ts`. A anotação
 * `AuditAction` é o que segura isso: inventar um código aqui que não exista lá reprova o
 * `typecheck`, em vez de gravar uma trilha que ninguém consegue consultar depois.
 *
 * (Nasceram com `as AuditAction` porque a união estava fora do conjunto de escrita do
 * agente que escreveu esta rota — arquivo compartilhado é do orquestrador. O cast durou
 * uma integração.)
 */
export const ACAO_CRIADO: AuditAction = "knowledge_scope.created";
export const ACAO_ATUALIZADO: AuditAction = "knowledge_scope.updated";
/** Trava 4 (FR-008): o escopo passou a valer para as respostas deste tenant. */
export const ACAO_ATIVADO: AuditAction = "knowledge_scope.activated";
/** Trava 4 (FR-008): o material daquele escopo ficou inerte para este tenant. */
export const ACAO_DESATIVADO: AuditAction = "knowledge_scope.deactivated";
/**
 * Material próprio carregado (T088, FR-004).
 *
 * ⚠️ `as AuditAction` pelo MESMO motivo declarado acima, e é dívida com prazo: o literal
 * ainda não está na união de `lib/audit/actions.ts`, que é arquivo compartilhado e está
 * fora do conjunto de escrita desta rota. Quem integrar acrescenta a linha lá e apaga o
 * cast. A coluna `api_audit_log.action` é `text` sem CHECK, então a trilha É gravada
 * enquanto isso — o que falta é a união reconhecer o código, não o banco aceitá-lo.
 *
 * Ação PRÓPRIA, e não um `knowledge_scope.updated` com o material escondido no metadata:
 * quem for investigar "de onde saiu essa resposta" procura pelo material que entrou, e um
 * código genérico somaria isso a "renomearam o escopo" no mesmo balde.
 */
export const ACAO_MATERIAL_CRIADO: AuditAction = "knowledge_scope.material_added";

// ---------------------------------------------------------------------------
// Formas
// ---------------------------------------------------------------------------

/** Colunas lidas de `knowledge_scopes`. Uma string só, para lista e PATCH não divergirem. */
export const COLUNAS_DO_ESCOPO =
  "id, organization_id, catalog_scope_id, display_name, official_code, is_active, created_at";

/** A linha como o banco a devolve. */
export interface LinhaDeEscopo {
  id: string;
  organization_id: string;
  catalog_scope_id: string | null;
  display_name: string;
  official_code: string | null;
  is_active: boolean;
  created_at: string;
}

/** O objeto do contrato (`contracts/rotas-http.md`, `GET /api/v1/knowledge-scopes`). */
export interface EscopoDoTenant {
  id: string;
  display_name: string;
  official_code: string | null;
  origin: OrigemDoEscopo;
  is_active: boolean;
  /** Tudo que ancora resposta sobre este escopo — catálogo + próprio. */
  materials_count: number;
  /** Só o que o corretor carregou: é o que ELE pode corrigir sozinho (FR-039). */
  own_materials_count: number;
}

/** Quantos materiais cada camada tem para um escopo. */
export interface ContagemDeMateriais {
  proprios: number;
  catalogo: number;
}

const SEM_MATERIAL: ContagemDeMateriais = { proprios: 0, catalogo: 0 };

/**
 * Linha do banco → objeto do contrato.
 *
 * `catalog_scope_id` e `organization_id` NÃO saem: o primeiro é a costura interna entre as
 * camadas (e vira `origin`), o segundo o cliente já conhece — devolvê-lo só daria a
 * impressão de que dá para escolhê-lo, que é exatamente o que o Princípio I proíbe.
 */
export function projetarEscopo(
  linha: LinhaDeEscopo,
  contagem: ContagemDeMateriais = SEM_MATERIAL,
): EscopoDoTenant {
  return {
    id: linha.id,
    display_name: linha.display_name,
    official_code: linha.official_code,
    origin: linha.catalog_scope_id === null ? ORIGEM.proprio : ORIGEM.catalogo,
    is_active: linha.is_active,
    materials_count: contagem.proprios + contagem.catalogo,
    own_materials_count: contagem.proprios,
  };
}

// ---------------------------------------------------------------------------
// Nome comparável (o 409 de FR-002)
// ---------------------------------------------------------------------------

/**
 * Forma canônica de um nome de escopo, só para DETECTAR duplicata — o nome exibido é
 * sempre o que o usuário digitou.
 *
 * Dobra caixa, acento e espaço repetido porque a duplicata que o contrato quer impedir é a
 * humana: "Amil Saúde" ao lado de "amil saude" são a mesma operadora para o corretor e
 * dois acervos separados para a busca, e ninguém descobre isso olhando a lista. Comparação
 * exata (`=` no banco) deixaria as duas passarem.
 */
export function nomeComparavel(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** O escopo já visível cujo nome colide, ou `null`. Espelho do catálogo entra na conta. */
export function acharColisaoDeNome<T extends { display_name: string }>(
  existentes: readonly T[],
  candidato: string,
): T | null {
  const alvo = nomeComparavel(candidato);
  return existentes.find((e) => nomeComparavel(e.display_name) === alvo) ?? null;
}

// ---------------------------------------------------------------------------
// Espelho do catálogo: o que o tenant pode mexer
// ---------------------------------------------------------------------------

/**
 * Os DOIS campos que um espelho aceita, e o motivo de cada um:
 *
 * - `is_active` é a **trava 4** (FR-008). Desligar torna o material daquele escopo inerte
 *   só para este tenant; o catálogo e as outras organizações não sentem nada.
 * - `display_name` existe local justamente para o corretor renomear sem tocar no catálogo
 *   (é meia razão de `knowledge_scopes` existir — ver o cabeçalho da migration 0118).
 *
 * `official_code` fica de fora: num espelho ele é a identidade que o fabricante mantém
 * (registro na ANS, no nicho de saúde) e a chave estável de uma importação futura. Deixar
 * o tenant reescrevê-lo dessincronizaria a identidade sem que ninguém percebesse — é ele
 * que dispara o `403 escopo_do_catalogo_nao_editavel` do contrato. Em escopo próprio,
 * `official_code` é do corretor e é editável.
 */
export const CAMPOS_EDITAVEIS_NO_ESPELHO: readonly string[] = ["display_name", "is_active"];

/** Campos pedidos que um espelho do catálogo não aceita. Vazio = pode seguir. */
export function camposBloqueadosNoEspelho(camposPedidos: readonly string[]): string[] {
  return camposPedidos.filter((campo) => !CAMPOS_EDITAVEIS_NO_ESPELHO.includes(campo));
}

const NOME_AMIGAVEL_DO_CAMPO: Record<string, string> = {
  display_name: "o nome",
  official_code: "o código oficial",
  is_active: "o interruptor",
};

/**
 * Nome de campo → como o corretor o chama. A mensagem de erro é lida por quem nunca viu o
 * schema; devolver `official_code` cru transforma uma recusa explicável em jargão. O
 * `details.fields` da resposta continua com o nome técnico, para quem integra.
 */
export function descreverCampos(campos: readonly string[]): string {
  return campos.map((c) => NOME_AMIGAVEL_DO_CAMPO[c] ?? `o campo "${c}"`).join(", ");
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorDaLista {
  created_at: string;
  id: string;
}

/**
 * Ordenação e cursor são por `(created_at, id)`, não por `display_name`.
 *
 * O nome seria a ordem mais natural na tela, mas o cursor do PostgREST viaja dentro do DSL
 * do `.or(...)`, onde vírgula e parênteses são delimitadores — uma operadora chamada
 * "Amil, S.A." injetaria uma condição a mais no filtro. Timestamp e UUID não têm nenhum
 * caractere hostil. A tela ordena como quiser; o cursor não precisa concordar com ela.
 */
export function codificarCursor(c: CursorDaLista): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodificarCursor(bruto: string): CursorDaLista | null {
  try {
    const parsed = JSON.parse(Buffer.from(bruto, "base64url").toString("utf8")) as CursorDaLista;
    if (typeof parsed?.id !== "string" || typeof parsed?.created_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Schemas (Zod em todo input externo — Princípio VI)
// ---------------------------------------------------------------------------

/** Teto alto de propósito: o corretor tem de ver o catálogo inteiro numa página (SC-011). */
export const LIMITE_PADRAO = 100;
export const LIMITE_MAXIMO = 200;

export const queryDaListaSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITE_MAXIMO).default(LIMITE_PADRAO),
});

const nomeDoEscopo = z.string().trim().min(1).max(120);
const codigoOficial = z.string().trim().min(1).max(40);

/**
 * FR-002: criar operadora custa informar o nome. `official_code` é opcional porque exigi-lo
 * transformaria "digite o nome" em "vá procurar o registro na ANS" — que é o passo que o
 * requisito existe para não haver.
 *
 * `strictObject`: chave desconhecida no body é erro, não é ignorada em silêncio. É o que
 * faz `organization_id` e `catalog_scope_id` no body baterem em 422 em vez de passarem
 * despercebidos (Princípio I).
 */
export const criarEscopoSchema = z.strictObject({
  display_name: nomeDoEscopo,
  official_code: codigoOficial.nullish(),
});

export const atualizarEscopoSchema = z
  .strictObject({
    display_name: nomeDoEscopo.optional(),
    official_code: codigoOficial.nullish(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo para alterar.",
  });

export type CriarEscopo = z.infer<typeof criarEscopoSchema>;
export type AtualizarEscopo = z.infer<typeof atualizarEscopoSchema>;

// ---------------------------------------------------------------------------
// Teto de requisições (Definition of Done, item 6)
// ---------------------------------------------------------------------------

export interface TetoDoEscopo {
  /** Prefixo do balde no Redis. A organização é acrescentada a ele em `aplicarTeto`. */
  balde: string;
  limite: number;
  janelaSeg: number;
}

/**
 * Escrita de escopo: criar e renomear/ligar/desligar. 30/min é largo para o gesto humano
 * (o corretor liga um punhado de operadoras e para) e estreito para laço de script.
 */
export const TETO_DE_ESCRITA: TetoDoEscopo = {
  balde: "knowledge_scopes:write",
  limite: 30,
  janelaSeg: 60,
};

/**
 * Carga de material é mais apertada que o resto da escrita porque cada pedido pode trazer
 * até 20 MB e disparar extração de PDF — o custo de um pedido aqui não se compara ao de um
 * PATCH de interruptor, e um teto único obrigaria a escolher entre proteger o servidor e
 * estorvar quem só está ligando escopo.
 */
export const TETO_DE_MATERIAL: TetoDoEscopo = {
  balde: "knowledge_scopes:material",
  limite: 12,
  janelaSeg: 60,
};

export interface ResultadoDoTeto {
  /** Resposta 429 pronta quando o teto estourou; `null` quando pode seguir. */
  excedido: NextResponse<ApiError> | null;
  /** `X-RateLimit-*` para acompanhar TODA resposta da mutação, estourando ou não. */
  headers: Record<string, string>;
}

/**
 * Aplica `checkRateLimit` (`lib/ai/dispatcher/rate-limit.ts`) às MUTAÇÕES desta superfície.
 *
 * ## O balde é por ORGANIZAÇÃO, e isso não é detalhe
 *
 * Global faria uma corretora movimentada calar as outras — num banco compartilhado por
 * todos os clientes, é vazamento de disponibilidade entre tenants. Por IP não separa nada:
 * duas pessoas da mesma empresa saem pelo mesmo NAT, e um usuário atrás de proxy rotativo
 * escaparia. A organização vem de `requireRole` (cookie validado com `getUser()`), **nunca
 * do body** — é a mesma fonte confiável que o Princípio I exige para `organization_id`.
 *
 * ## Por que não reusar `aplicarTeto` de `app/api/v1/catalog/_plataforma.ts`
 *
 * Aquele conta por USUÁRIO, porque o catálogo é da instalação e não tem tenant onde
 * contar, e a frase do 429 dele fala do catálogo. Contar por usuário aqui deixaria a
 * organização com dez gestores comprando dez vezes o orçamento. A peça compartilhada de
 * verdade — o contador — é `checkRateLimit`, e ela é a mesma nos dois lados.
 */
export async function aplicarTetoDaOrganizacao(
  organizationId: string,
  teto: TetoDoEscopo,
  requestId: string,
): Promise<ResultadoDoTeto> {
  const resultado = await checkRateLimit(
    `${teto.balde}:${organizationId}`,
    teto.limite,
    teto.janelaSeg,
  );

  // Janela FIXA (`INCR` + `EXPIRE`): o reset é o início da PRÓXIMA janela, não
  // "agora + janela". Dizer o segundo errado no `Retry-After` faz o cliente bem-comportado
  // voltar cedo demais e levar outro 429 — que é como um teto ensina a ignorar o teto.
  const agoraSeg = Math.floor(Date.now() / 1000);
  const resetSeg = (Math.floor(agoraSeg / teto.janelaSeg) + 1) * teto.janelaSeg;

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(teto.limite),
    "X-RateLimit-Remaining": String(Math.max(0, teto.limite - resultado.count)),
    "X-RateLimit-Reset": String(resetSeg),
  };

  if (resultado.allowed) return { excedido: null, headers };

  return {
    excedido: fail(
      "rate_limited",
      "Muitas alterações seguidas nesta conta. Aguarde alguns instantes e tente de novo.",
      429,
      { requestId, headers: { ...headers, "Retry-After": String(Math.max(1, resetSeg - agoraSeg)) } },
    ),
    headers,
  };
}

// ---------------------------------------------------------------------------
// Idempotência (Princípio V)
// ---------------------------------------------------------------------------

export const ENDPOINT_DA_CRIACAO = "/api/v1/knowledge-scopes";

/** Impressão do pedido: mesma chave com corpo diferente é conflito, não repetição. */
export function impressaoDoPedido(corpo: CriarEscopo): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        display_name: corpo.display_name,
        official_code: corpo.official_code ?? null,
      }),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Leituras auxiliares
// ---------------------------------------------------------------------------

/** Só o que estas funções precisam do client — mantém o dublê do teste pequeno. */
type ClienteDeLeitura = {
  from: (tabela: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: (colunas: string) => any;
  };
};

/**
 * O rótulo do escopo desta organização ("Operadora", por padrão), para as MENSAGENS de
 * erro — só elas.
 *
 * A mensagem é o que o corretor lê quando algo dá errado, e "escopo de conhecimento já
 * existe" não é uma frase que alguém entenda no meio de um cadastro. O contrato (`origin`,
 * `knowledge-scopes`) continua neutro; quem carrega vocabulário é o texto (FR-033).
 *
 * ⚠️ Ao escrever a frase, o rótulo entra SÓ como substantivo antes do nome — nunca com
 * adjetivo ou pronome concordando com ele. O padrão é "Operadora" (feminino), mas outro
 * nicho configura "Convênio" ou "Fornecedor", e uma mensagem com "ligue-a"/"desligada"
 * viraria erro de português na instalação de quem trocou o rótulo.
 *
 * Falha de leitura cai no padrão em vez de derrubar a resposta: um rótulo errado numa
 * mensagem de erro é infinitamente menos grave que um 500 no lugar de um 409 explicativo.
 */
export async function rotuloDoTenant(
  supabase: ClienteDeLeitura,
  organizationId: string,
): Promise<RotuloDoEscopo> {
  try {
    const { data } = await supabase
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    return resolverRotuloDoEscopo((data as { settings?: unknown } | null)?.settings);
  } catch {
    return ROTULO_PADRAO;
  }
}

// ---------------------------------------------------------------------------
// Contagem de materiais
// ---------------------------------------------------------------------------

/**
 * Quantos materiais cada escopo da página tem, nas duas camadas.
 *
 * Duas consultas por página, nunca uma por linha: N+1 numa lista que a tela abre a cada
 * visita é o tipo de custo que ninguém vê crescer.
 *
 * O lado do catálogo NÃO leva filtro de `organization_id` — e isso é desenho, não
 * esquecimento (Princípio X, trava 2): `catalog_materials` não tem essa coluna, o conteúdo
 * é do fabricante e vale para a instalação inteira. O que impede vazamento é a origem dos
 * ids: `catalog_scope_id` só chega aqui vindo de linhas de `knowledge_scopes` já filtradas
 * pela organização do chamador.
 */
export async function contarMateriais(
  supabase: ClienteDeLeitura,
  organizationId: string,
  linhas: readonly LinhaDeEscopo[],
): Promise<Map<string, ContagemDeMateriais>> {
  const contagens = new Map<string, ContagemDeMateriais>(
    linhas.map((l) => [l.id, { proprios: 0, catalogo: 0 }]),
  );
  if (linhas.length === 0) return contagens;

  // ── camada do tenant ──
  const { data: proprios } = await supabase
    .from("ai_knowledge_sources")
    .select("scope_id")
    .eq("organization_id", organizationId)
    .in(
      "scope_id",
      linhas.map((l) => l.id),
    )
    .eq("is_active", true);

  for (const linha of (proprios ?? []) as { scope_id: string | null }[]) {
    const alvo = linha.scope_id ? contagens.get(linha.scope_id) : undefined;
    if (alvo) alvo.proprios += 1;
  }

  // ── camada do catálogo ──
  const idsDeCatalogo = linhas
    .map((l) => l.catalog_scope_id)
    .filter((id): id is string => id !== null);
  if (idsDeCatalogo.length === 0) return contagens;

  const { data: curados } = await supabase
    .from("catalog_materials")
    .select("catalog_scope_id, slug")
    .in("catalog_scope_id", idsDeCatalogo)
    .eq("inert", false);

  // Por `slug`, não por linha: material curado é VERSIONADO (trava 6) e editar cria
  // `version + 1` sem apagar a anterior. Contar linhas diria "8 materiais" para um
  // catálogo de 3 que foi corrigido cinco vezes — número que só assusta.
  const slugsPorCatalogo = new Map<string, Set<string>>();
  for (const linha of (curados ?? []) as { catalog_scope_id: string | null; slug: string }[]) {
    if (!linha.catalog_scope_id) continue;
    const slugs = slugsPorCatalogo.get(linha.catalog_scope_id) ?? new Set<string>();
    slugs.add(linha.slug);
    slugsPorCatalogo.set(linha.catalog_scope_id, slugs);
  }

  for (const linha of linhas) {
    if (!linha.catalog_scope_id) continue;
    const alvo = contagens.get(linha.id);
    if (alvo) alvo.catalogo = slugsPorCatalogo.get(linha.catalog_scope_id)?.size ?? 0;
  }

  return contagens;
}

// ---------------------------------------------------------------------------
// Material próprio (T088) — a declaração de FR-001
// ---------------------------------------------------------------------------

/**
 * A palavra reservada que, no lugar do id do escopo, declara "vale para TODAS".
 *
 * ⚠️ Ela é um segmento de URL, **não** uma linha em `knowledge_scopes`. O `data-model.md`
 * recusou o "escopo fictício todos" porque ele apareceria na lista do corretor e no filtro
 * do contato, e alguém acabaria vinculando um cliente a ele — uma palavra na rota não tem
 * esse caminho. O banco continua guardando a declaração onde ela mora: a coluna
 * `applies_to_all`, sob o CHECK `ai_knowledge_sources_scope_xor_all`.
 */
export const ESCOPO_TODAS = "todas";

export type DeclaracaoDeEscopo =
  | { readonly tipo: "escopo"; readonly id: string }
  | { readonly tipo: "todas" };

const FORMA_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O segmento `{id}` da rota de materiais → a declaração de FR-001, ou `null` quando não
 * declara nada.
 *
 * **A declaração vive no PATH, nunca no corpo** — mesma regra que faz `organization_id`
 * chegar do cookie: o identificador que decide a que conjunto o conteúdo pertence não pode
 * vir por onde o cliente escolhe. O corpo é `strictObject` sem `scope_id` nem
 * `applies_to_all`, então tentar declará-lo ali é 422, não é ignorado em silêncio.
 *
 * `null` é o caso que FR-001 manda recusar, e ele é REAL: a tela monta a URL com a
 * operadora escolhida, e sem escolha o segmento vira `undefined`/vazio. O CHECK do banco
 * também barraria — mas com "new row violates check constraint
 * ai_knowledge_sources_scope_xor_all", que não diz ao corretor o que fazer em seguida.
 */
export function declararEscopo(segmento: string): DeclaracaoDeEscopo | null {
  const bruto = decodeURIComponent(segmento ?? "").trim();
  if (bruto.toLowerCase() === ESCOPO_TODAS) return { tipo: "todas" };
  if (FORMA_DE_UUID.test(bruto)) return { tipo: "escopo", id: bruto };
  return null;
}

/** As colunas que a declaração vira na linha — o lado do XOR que o banco entende. */
export function colunasDaDeclaracao(d: DeclaracaoDeEscopo): {
  scope_id: string | null;
  applies_to_all: boolean;
} {
  return d.tipo === "todas"
    ? { scope_id: null, applies_to_all: true }
    : { scope_id: d.id, applies_to_all: false };
}

// ---------------------------------------------------------------------------
// FR-007 — o que cabe, dito ANTES do envio
// ---------------------------------------------------------------------------

/** 20 MB, o mesmo teto de `POST /api/v1/ai/knowledge/sources/upload`. */
export const TAMANHO_MAXIMO_BYTES = 20 * 1024 * 1024;

/** Teto do texto colado. Igual ao do material curado, para as duas telas não divergirem. */
export const TEXTO_MAXIMO_CARACTERES = 200_000;

/**
 * Os formatos que o ingest LÊ de verdade (`lib/ai/rag/extractors/`), não os que seria
 * simpático aceitar. Declarar `.docx` aqui e recusá-lo depois é pior que não declarar.
 */
export const FORMATOS_ACEITOS = ["pdf", "md"] as const;

export const MIMES_ACEITOS: readonly string[] = [
  "application/pdf",
  "text/markdown",
  "text/x-markdown",
  // Sistema operacional que não conhece `.md` manda `text/plain`; a extensão desempata.
  "text/plain",
];

/**
 * O anúncio de FR-007: "quais formatos e qual tamanho máximo são aceitos", entregue ANTES
 * do envio.
 *
 * Viaja no `meta` do GET da lista de materiais — que é a tela em que o corretor está quando
 * decide arrastar o arquivo — e no `details` de toda recusa, para quem integra pela API
 * descobrir o teto pela primeira resposta em vez de por tentativa. Sem isto o requisito
 * viraria uma frase no HTML, que nenhum cliente de API enxerga e que ninguém consegue
 * verificar mecanicamente.
 */
export function declaracaoDeAceite(): {
  accepted_formats: readonly string[];
  accepted_mime_types: readonly string[];
  max_bytes: number;
  max_chars: number;
} {
  return {
    accepted_formats: FORMATOS_ACEITOS,
    accepted_mime_types: MIMES_ACEITOS,
    max_bytes: TAMANHO_MAXIMO_BYTES,
    max_chars: TEXTO_MAXIMO_CARACTERES,
  };
}

/** Extensão canônica do arquivo, ou `null` quando não é um formato que o ingest lê. */
export function formatoDoArquivo(nome: string, mime: string): "pdf" | "md" | null {
  const ext = nome.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  // Sem extensão utilizável, o MIME desempata — mas só os dois que temos extrator.
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "md";
  return null;
}

// ---------------------------------------------------------------------------
// Material próprio — corpo, linha e projeção
// ---------------------------------------------------------------------------

const itemDeFaqSchema = z.strictObject({
  question: z.string().trim().min(1).max(2_000),
  answer: z.string().trim().min(1).max(20_000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  locale: z.string().trim().min(2).max(20).optional(),
});

/**
 * Texto colado (FR-004): ou pares pergunta/resposta prontos, ou o markdown que os contém.
 *
 * `strictObject` sem `scope_id`, sem `applies_to_all` e sem `organization_id`: as três
 * coisas que o cliente não escolhe. O `refine` recusa o pedido que não traz conteúdo
 * nenhum — aceitar e deixar o indexador descobrir depois é exatamente o "aceitar e
 * descartar em silêncio" que FR-004 proíbe.
 */
export const materialColadoSchema = z
  .strictObject({
    agent_id: z.string().uuid(),
    name: z.string().trim().min(2).max(120),
    source_type: z.enum(["faq", "policy"]).optional(),
    items: z.array(itemDeFaqSchema).min(1).max(500).optional(),
    markdown_blob: z.string().trim().min(1).max(TEXTO_MAXIMO_CARACTERES).optional(),
    valid_until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
      .nullish(),
  })
  .refine((v) => (v.items?.length ?? 0) > 0 || (v.markdown_blob ?? "").length > 0, {
    message: "Envie o conteúdo em `items` (pergunta/resposta) ou em `markdown_blob`.",
  });

export type MaterialColado = z.infer<typeof materialColadoSchema>;

/** A linha de `ai_knowledge_sources` como esta superfície a lê. */
export const COLUNAS_DO_MATERIAL =
  "id, agent_id, scope_id, applies_to_all, source_type, name, status, chunks_count, last_index_status, last_index_error, last_indexed_at, valid_until, is_active, source_metadata, created_at, updated_at";

export interface LinhaDeMaterial {
  id: string;
  agent_id: string;
  scope_id: string | null;
  applies_to_all: boolean;
  source_type: string;
  name: string;
  status: string;
  chunks_count: number;
  last_index_status: string | null;
  last_index_error: string | null;
  last_indexed_at: string | null;
  valid_until: string | null;
  is_active: boolean;
  source_metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** Os quatro estados que FR-005 exige por material. */
export const ESTADO_DO_MATERIAL = {
  building: "building",
  ready: "ready",
  failed: "failed",
  archived: "archived",
} as const;

export type EstadoDoMaterial = (typeof ESTADO_DO_MATERIAL)[keyof typeof ESTADO_DO_MATERIAL];

/**
 * O estado que o corretor lê — DERIVADO, não copiado da coluna `status`.
 *
 * As duas coisas se chamam "status" e são grandezas diferentes, e confundi-las é o defeito
 * que este mapeamento existe para impedir:
 *
 * - `ai_knowledge_sources.status` diz se a FONTE está viva. `workers/rag-indexer.ts` só
 *   enxerga `ready`, então gravar `building` ali tiraria o material da fila do indexador —
 *   ele ficaria eternamente "processando" sem ninguém processando.
 * - `last_index_status` diz o que aconteceu na última rodada de indexação, e é isso que
 *   FR-005 pede que a tela mostre.
 *
 * `partial` sai como `ready` porque parte do conteúdo ENTROU e a busca já o alcança; a
 * nuance continua legível em `last_index_status`, que a projeção também devolve. Chamá-lo
 * de `failed` esconderia acervo que está funcionando.
 */
export function estadoDoMaterial(linha: {
  status: string;
  last_index_status: string | null;
}): EstadoDoMaterial {
  if (linha.status === "archived") return ESTADO_DO_MATERIAL.archived;
  if (linha.status === "failed" || linha.last_index_status === "failed") {
    return ESTADO_DO_MATERIAL.failed;
  }
  if (linha.last_index_status === "success" || linha.last_index_status === "partial") {
    return ESTADO_DO_MATERIAL.ready;
  }
  // Sem rodada de indexação ainda: aceito e a caminho. É o estado com que todo material
  // nasce, e é o que a resposta 202 do POST devolve.
  return ESTADO_DO_MATERIAL.building;
}

/** O objeto do contrato para `GET /api/v1/knowledge-scopes/{id}/materials` (FR-005). */
export interface MaterialDoTenant {
  id: string;
  agent_id: string;
  name: string;
  source_type: string;
  /** `building | ready | failed | archived` — o estado que a tela traduz (FR-005). */
  status: EstadoDoMaterial;
  /** Só faz sentido quando `status === "ready"`; fora disso é o que já entrou. */
  chunks_count: number;
  last_index_status: string | null;
  /** Em português, vindo do indexador. É o "motivo acionável" de FR-005. */
  last_index_error: string | null;
  last_indexed_at: string | null;
  scope_id: string | null;
  applies_to_all: boolean;
  valid_until: string | null;
  is_active: boolean;
  /** Nome do arquivo, quando veio por upload. `null` para texto colado. */
  filename: string | null;
  created_at: string;
  updated_at: string;
}

export function projetarMaterial(linha: LinhaDeMaterial): MaterialDoTenant {
  const meta = (linha.source_metadata ?? {}) as Record<string, unknown>;
  return {
    id: linha.id,
    agent_id: linha.agent_id,
    name: linha.name,
    source_type: linha.source_type,
    status: estadoDoMaterial(linha),
    chunks_count: linha.chunks_count,
    last_index_status: linha.last_index_status,
    last_index_error: linha.last_index_error,
    last_indexed_at: linha.last_indexed_at,
    scope_id: linha.scope_id,
    applies_to_all: linha.applies_to_all,
    valid_until: linha.valid_until,
    is_active: linha.is_active,
    // `source_metadata` inteiro NÃO sai: guarda o caminho do blob no Storage, e devolvê-lo
    // entregaria ao cliente um endereço interno que ele não tem por que conhecer.
    filename: typeof meta.filename === "string" ? meta.filename : null,
    created_at: linha.created_at,
    updated_at: linha.updated_at,
  };
}
