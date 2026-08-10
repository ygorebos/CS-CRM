/**
 * GET  /api/v1/catalog/scopes/{id}/materials — materiais curados daquele escopo
 * POST /api/v1/catalog/scopes/{id}/materials — cria material curado com `origin: "local"`
 *
 * Spec 002 (RAG por operadora), T063. Só `is_platform_admin` (trava 1).
 *
 * O escopo vem do PATH, nunca do body — mesmo princípio que proíbe `organization_id` no
 * body no lado do tenant: identificador que decide a que conjunto o conteúdo pertence
 * não pode chegar por onde o cliente escolhe.
 *
 * Material que vale para TODAS as operadoras não nasce aqui (não tem escopo a que
 * pendurar): ele nasce em `POST /api/v1/catalog/materials` com `applies_to_all: true`. O
 * CHECK `catalog_materials_scope_xor_all` (0117) garante que exatamente um dos dois
 * existe — as duas rotas são os dois lados desse XOR, não dois jeitos de fazer a mesma
 * coisa.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

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
} from "../../../_materiais";
import {
  ACOES_DO_CATALOGO,
  TETO_ESCRITA,
  TETO_LEITURA,
  UUID_RX,
  aplicarTeto,
  auditarCatalogo,
  exigirAdminDePlataforma,
  lerJson,
} from "../../../_plataforma";

export const dynamic = "force-dynamic";

const RECURSO = "catalog_materials";

type Ctx = { params: Promise<{ id: string }> };

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_LEITURA, requestId);
  if (teto.excedido) return teto.excedido;

  const db = createAdminClient();
  const { data, error } = await db
    .from("catalog_materials")
    .select(CAMPOS_MATERIAL)
    .eq("catalog_scope_id", id)
    // Slug junto, versão nova em cima: é assim que o curador lê "o que vale hoje e o
    // que veio antes" sem reordenar nada na tela.
    .order("slug", { ascending: true })
    .order("version", { ascending: false })
    .limit(500);

  if (error) {
    logger.error("[catalog/scopes/:id/materials] leitura falhou", {
      error: error.message,
      request_id: requestId,
    });
    return fail("internal_error", "Não consegui ler os materiais do escopo.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const linhas = (data ?? []) as MaterialRow[];
  return ok(linhas.map(resumirMaterial), {
    requestId,
    headers: teto.headers,
    meta: { total: linhas.length, has_more: linhas.length === 500 },
  });
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_ESCRITA, requestId);
  if (teto.excedido) return teto.excedido;

  const parsed = criarMaterialSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
      headers: teto.headers,
    });
  }

  const db = createAdminClient();

  // O escopo tem de existir ANTES do insert. A FK pegaria, mas devolveria 23503 com
  // texto de Postgres; 404 com frase em português é a diferença entre o curador
  // entender que errou o link e achar que o sistema quebrou.
  const { data: escopo, error: escopoErro } = await db
    .from("catalog_scopes")
    .select("id, slug")
    .eq("id", id)
    .maybeSingle();
  if (escopoErro) {
    logger.error("[catalog/scopes/:id/materials] leitura do escopo falhou", {
      error: escopoErro.message,
      request_id: requestId,
    });
    return fail("internal_error", "Não consegui validar o escopo.", 500, { requestId, headers: teto.headers });
  }
  if (!escopo) {
    return fail("not_found", "Escopo do catálogo não encontrado.", 404, { requestId, headers: teto.headers });
  }

  const { versao, erro } = await maiorVersao(db, parsed.data.slug);
  if (erro !== null || versao === null) {
    logger.error("[catalog/scopes/:id/materials] leitura de versão falhou", {
      error: erro,
      request_id: requestId,
    });
    return fail("internal_error", "Não consegui calcular a versão do material.", 500, {
      requestId,
      headers: teto.headers,
    });
  }
  // Slug já existente é EDIÇÃO, e edição tem rota própria (`PATCH /catalog/materials/{id}`)
  // porque precisa carregar o conteúdo anterior. Aceitar aqui criaria uma segunda porta
  // para a versão nova, e uma delas esqueceria a adoção — que é justamente o que faz a
  // correção local sobreviver ao próximo release.
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
    catalog_scope_id: id,
    applies_to_all: false,
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
    logger.error("[catalog/scopes/:id/materials] insert falhou", {
      error: error?.message,
      request_id: requestId,
    });
    return fail("internal_error", "Não consegui criar o material.", 500, { requestId, headers: teto.headers });
  }

  const material = data as MaterialRow;
  auditarCatalogo({
    acao: ACOES_DO_CATALOGO.materialCriado,
    actorUserId: guarda.user.id,
    resourceType: RECURSO,
    resourceId: material.id,
    requestId,
    metadata: { slug: material.slug, version: material.version, catalog_scope_id: id, origin: material.origin },
  });

  return ok(resumirMaterial(material), { status: 201, requestId, headers: teto.headers });
}
