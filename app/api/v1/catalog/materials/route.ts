/**
 * GET  /api/v1/catalog/materials — lista o material curado da instalação, com filtros
 * POST /api/v1/catalog/materials — cria material que vale para TODAS as operadoras
 *
 * Spec 002 (RAG por operadora), T063. Só `is_platform_admin` (trava 1).
 *
 * ═══ POR QUE O `applies_to_all` NASCE AQUI E NÃO EM `/scopes/{id}/materials` ═══
 *
 * O CHECK `catalog_materials_scope_xor_all` (0117) exige exatamente um dos dois: ou o
 * material pertence a um escopo, ou vale para todos. Material "para todos" não tem
 * escopo a que se pendurar, então não cabe numa rota cujo escopo vem do path. As duas
 * rotas são os dois lados do XOR — não dois caminhos para a mesma coisa.
 *
 * ═══ A LISTA MOSTRA A VERSÃO INERTE, DE PROPÓSITO ═══
 *
 * FR-037: a versão semeada que chegou depois da adoção local "fica visível para ser
 * aceita". Estado que só existe dentro de um `where` não tem como aparecer na tela — por
 * isso `inert` vem no payload em vez de a rota filtrar por ele.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  CAMPOS_MATERIAL,
  type MaterialRow,
  criarMaterialSchema,
  inserirVersaoLocal,
  maiorVersao,
  resumirMaterial,
} from "../_materiais";
import {
  ACOES_DO_CATALOGO,
  TETO_ESCRITA,
  TETO_LEITURA,
  aplicarTeto,
  auditarCatalogo,
  exigirAdminDePlataforma,
  lerJson,
} from "../_plataforma";

export const dynamic = "force-dynamic";

const RECURSO = "catalog_materials";
const TETO_DE_LINHAS = 500;

const listarSchema = z.strictObject({
  scope_id: z.string().uuid().optional(),
  slug: z.string().min(1).max(120).optional(),
  origin: z.enum(["seed", "local"]).optional(),
  applies_to_all: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(TETO_DE_LINHAS).optional(),
});

/**
 * `applies_to_all: true` é obrigatório e literal — não default. Criar material sem
 * escopo por OMISSÃO é a diferença entre "escrevi um material geral" e "esqueci de
 * escolher a operadora", e as duas mãos digitam o mesmo corpo. FR-001 quer a declaração
 * explícita.
 */
const criarParaTodosSchema = criarMaterialSchema.extend({
  applies_to_all: z.literal(true),
});

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_LEITURA, requestId);
  if (teto.excedido) return teto.excedido;

  const params = listarSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!params.success) {
    return fail("validation_failed", "Parâmetros inválidos.", 422, {
      requestId,
      details: params.error.flatten(),
      headers: teto.headers,
    });
  }
  const limite = params.data.limit ?? TETO_DE_LINHAS;

  const db = createAdminClient();
  let query = db
    .from("catalog_materials")
    .select(CAMPOS_MATERIAL)
    .order("slug", { ascending: true })
    .order("version", { ascending: false })
    .limit(limite);

  if (params.data.scope_id) query = query.eq("catalog_scope_id", params.data.scope_id);
  if (params.data.slug) query = query.eq("slug", params.data.slug);
  if (params.data.origin) query = query.eq("origin", params.data.origin);
  if (params.data.applies_to_all) query = query.eq("applies_to_all", params.data.applies_to_all === "true");

  const { data, error } = await query;
  if (error) {
    logger.error("[catalog/materials] leitura falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", "Não consegui ler os materiais do catálogo.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const linhas = (data ?? []) as MaterialRow[];
  return ok(linhas.map(resumirMaterial), {
    requestId,
    headers: teto.headers,
    meta: { total: linhas.length, has_more: linhas.length === limite },
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_ESCRITA, requestId);
  if (teto.excedido) return teto.excedido;

  const parsed = criarParaTodosSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
      headers: teto.headers,
    });
  }

  const db = createAdminClient();

  const { versao, erro } = await maiorVersao(db, parsed.data.slug);
  if (erro !== null || versao === null) {
    logger.error("[catalog/materials] leitura de versão falhou", { error: erro, request_id: requestId });
    return fail("internal_error", "Não consegui calcular a versão do material.", 500, {
      requestId,
      headers: teto.headers,
    });
  }
  if (versao > 0) {
    return fail(
      "state_conflict",
      `Já existe material com o slug "${parsed.data.slug}". Para corrigi-lo, edite o material ` +
        "(a edição cria uma versão nova e preserva a anterior).",
      409,
      { requestId, headers: teto.headers },
    );
  }

  const { data, error } = await inserirVersaoLocal(db, {
    slug: parsed.data.slug,
    version: 1,
    catalog_scope_id: null,
    applies_to_all: true,
    title: parsed.data.title,
    body: parsed.data.body,
    valid_until: parsed.data.valid_until ?? null,
    actorUserId: guarda.user.id,
  });

  if (error || !data) {
    if (error?.code === "23505") {
      return fail("state_conflict", "Outra edição criou essa versão primeiro. Recarregue e tente de novo.", 409, {
        requestId,
        headers: teto.headers,
      });
    }
    logger.error("[catalog/materials] insert falhou", { error: error?.message, request_id: requestId });
    return fail("internal_error", "Não consegui criar o material.", 500, { requestId, headers: teto.headers });
  }

  const material = data as MaterialRow;
  auditarCatalogo({
    acao: ACOES_DO_CATALOGO.materialCriado,
    actorUserId: guarda.user.id,
    resourceType: RECURSO,
    resourceId: material.id,
    requestId,
    metadata: { slug: material.slug, version: material.version, applies_to_all: true, origin: material.origin },
  });

  return ok(resumirMaterial(material), { status: 201, requestId, headers: teto.headers });
}
