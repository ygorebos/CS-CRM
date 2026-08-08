/**
 * Material curado — projeção, versionamento e a gravação que marca a adoção local.
 *
 * Spec 002 (RAG por operadora), T063/T065. Contrato: `contracts/rotas-http.md`.
 *
 * ═══ TRAVA 6 · MATERIAL CURADO NUNCA É REESCRITO ═══
 *
 * Editar cria `version + 1` e a anterior permanece (FR-037, migration 0117). É isso que
 * torna SC-018 mensurável — "zero edições sobrescritas" é uma contagem de linhas, não
 * uma promessa.
 *
 * ═══ A METADE QUE NÃO É ÓBVIA: A ADOÇÃO ═══
 *
 * Só criar `version + 1` NÃO faz a correção local vencer. A versão que chega na próxima
 * release é sempre a mais recente, e o desempate de FR-035 é por recência: a semeada
 * ganharia da correção **no comportamento**, com o banco intacto e o SC-018 verde. É
 * exatamente o defeito que a migration 0124 fecha, e o gatilho dela
 * (`fn_versao_semeada_sobre_adotado_nasce_inerte`) só dispara se ALGUMA versão daquele
 * `slug` tiver `adopted_at` preenchido.
 *
 * Por isso toda escrita local grava `adopted_at = now()` e `adopted_by = <curador>`:
 * quem escreve aqui é o dono da instalação, e a partir desse instante o slug é dele. Sem
 * essas duas colunas, o release seguinte apaga a correção sem tocar em uma linha sequer.
 *
 * A adoção vale também para material NASCIDO local (slug novo, sem semeadura anterior):
 * se um dia a semeadura trouxer o mesmo slug, ela chega inerte em vez de disputar com o
 * conteúdo que aquela instalação escreveu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/**
 * `slug` é a chave da semeadura (`on conflict (slug, version) do nothing`). Formato
 * fechado pelo mesmo motivo do escopo: duas grafias do mesmo assunto fariam o
 * `on conflict` não reconhecer nada, e cada `update.sh` de clone duplicaria o material.
 */
const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Corpo aceito na CRIAÇÃO de material curado — nas duas rotas do XOR de FR-001. */
export const criarMaterialSchema = z.strictObject({
  slug: z
    .string()
    .min(2)
    .max(120)
    .regex(SLUG_RX, "Use minúsculas, números e hífen (ex.: carencia-consulta-eletiva)."),
  title: z.string().min(2).max(200),
  body: z.string().min(1).max(200_000),
  // Validade é OPCIONAL (FR-025): datar não pode travar quem está com pressa. Formato
  // fechado porque a coluna é `date` — string livre viraria erro do Postgres com
  // mensagem que ninguém entende.
  valid_until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
    .nullish(),
});

/**
 * Corpo aceito na EDIÇÃO. Sem `slug` de propósito, e `strict` para que mandá-lo volte
 * 422 em vez de ser ignorado em silêncio: trocar o slug de um material não o renomeia —
 * faz a próxima semeadura deixar de reconhecê-lo e inserir uma segunda cópia, com a
 * correção local órfã na primeira.
 */
export const editarMaterialSchema = z
  .strictObject({
    title: z.string().min(2).max(200).optional(),
    body: z.string().min(1).max(200_000).optional(),
    valid_until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD.")
      .nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo: title, body ou valid_until.",
  });

// Uma única literal, sem concatenação: o supabase-js PARSEIA a string do `select` no
// tipo, e string montada em runtime vira `GenericStringError` — o `data` deixa de ser a
// linha e o cast quebra o typecheck. Quebrar a linha em duas aqui custa um erro de tipo.
export const CAMPOS_MATERIAL =
  "id, catalog_scope_id, applies_to_all, slug, version, title, body, valid_until, published_at, origin, inert, adopted_at, adopted_by, created_at, updated_at";

export interface MaterialRow {
  id: string;
  catalog_scope_id: string | null;
  applies_to_all: boolean;
  slug: string;
  version: number;
  title: string;
  body: string;
  valid_until: string | null;
  published_at: string;
  origin: string;
  inert: boolean;
  adopted_at: string | null;
  adopted_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Projeção de lista: sem `body`.
 *
 * Mesmo motivo pelo qual o contrato proíbe devolver `embedding` — é peso na resposta e
 * ruído na tela. Quem precisa do texto abre o material (`GET /catalog/materials/{id}`).
 * `body_chars` fica para a lista poder mostrar "material vazio" sem baixar o material.
 */
export function resumirMaterial(m: MaterialRow) {
  return {
    id: m.id,
    catalog_scope_id: m.catalog_scope_id,
    applies_to_all: m.applies_to_all,
    slug: m.slug,
    version: m.version,
    title: m.title,
    body_chars: m.body?.length ?? 0,
    valid_until: m.valid_until,
    published_at: m.published_at,
    origin: m.origin,
    inert: m.inert,
    adopted_at: m.adopted_at,
    adopted_by: m.adopted_by,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

/**
 * A maior `version` já existente para o slug — inclusive as inertes.
 *
 * Inertes CONTAM aqui de propósito: `unique (slug, version)` não sabe o que é inércia, e
 * ignorá-las produziria colisão exatamente na instalação que recebeu uma versão semeada
 * depois de adotar o slug — isto é, na única que já provou que edita o catálogo.
 */
export async function maiorVersao(
  db: SupabaseClient,
  slug: string,
): Promise<{ versao: number | null; erro: string | null }> {
  const { data, error } = await db
    .from("catalog_materials")
    .select("version")
    .eq("slug", slug)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { versao: null, erro: error.message };
  const linha = data as { version: number } | null;
  return { versao: linha ? linha.version : 0, erro: null };
}

export interface EntradaDeVersaoLocal {
  slug: string;
  version: number;
  catalog_scope_id: string | null;
  applies_to_all: boolean;
  title: string;
  body: string;
  valid_until: string | null;
  /** O curador desta instalação. Vira `adopted_by` — autor da adoção, não do arquivo. */
  actorUserId: string;
}

/**
 * INSERT — nunca UPDATE. Todo caminho de escrita de material curado passa por aqui, e é
 * por isso que a trava 6 não depende de ninguém se lembrar dela em três rotas.
 */
export async function inserirVersaoLocal(db: SupabaseClient, entrada: EntradaDeVersaoLocal) {
  const agora = new Date().toISOString();
  return db
    .from("catalog_materials")
    .insert({
      slug: entrada.slug,
      version: entrada.version,
      catalog_scope_id: entrada.catalog_scope_id,
      applies_to_all: entrada.applies_to_all,
      title: entrada.title,
      body: entrada.body,
      valid_until: entrada.valid_until,
      // `local` separa o que a instalação escreveu do que a semeadura trouxe. É o que
      // permite provar SC-018: a semeadura só pode tocar em linha `seed`.
      origin: "local",
      published_at: agora,
      adopted_at: agora,
      adopted_by: entrada.actorUserId,
      // Explícito, apesar do default: quem lê esta linha precisa ver que a versão local
      // nasce ativa. Só a semeada sobre slug adotado nasce inerte, e quem decide isso é
      // o trigger da 0124, não esta rota.
      inert: false,
    })
    .select(CAMPOS_MATERIAL)
    .single();
}
