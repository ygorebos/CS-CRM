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
import { z } from "zod";

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
