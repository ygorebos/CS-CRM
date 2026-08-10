/**
 * GET  /api/v1/catalog/scopes — lista os escopos curados da instalação
 * POST /api/v1/catalog/scopes — cria escopo curado
 *
 * Spec 002 (RAG por operadora), T063. Contrato: `contracts/rotas-http.md`.
 * Só `is_platform_admin` (FR-036, trava 1) — inclusive na LEITURA, apesar de a RLS da
 * migration 0117 liberar select a qualquer autenticado. Não é contradição: a RLS existe
 * para o RUNTIME do agente e para o espelho do tenant enxergarem o conteúdo; esta rota é
 * a superfície de CURADORIA, e o corretor tem a dele (`/api/v1/knowledge-scopes`), que
 * mostra o catálogo já traduzido para a camada dele (`origin`, `is_active` do espelho).
 * Duas portas para a mesma tabela com públicos diferentes.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

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

const RECURSO = "catalog_scopes";

/**
 * `slug` é a chave que a semeadura reconhece (`on conflict (slug, version) do nothing`,
 * contrato `semeadura-do-catalogo.md`). Formato fechado de propósito: espaço, acento ou
 * maiúscula fariam o mesmo escopo chegar com duas grafias em duas releases, e o
 * `on conflict` não teria em que se apoiar — o clone ganharia um escopo duplicado a cada
 * atualização.
 */
const SLUG_RX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const criarEscopoSchema = z.strictObject({
  slug: z.string().min(2).max(80).regex(SLUG_RX, "Use minúsculas, números e hífen (ex.: unimed-nacional)."),
  display_name: z.string().min(2).max(120),
  official_code: z.string().min(1).max(40).nullish(),
  is_active: z.boolean().optional(),
});

const listarSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  // Default INCLUI os desativados (só `?include_inactive=false` os esconde). É tela de
  // curadoria: esconder por padrão o escopo que o próprio curador desligou faria a lista
  // mentir sobre o que existe, e ele não teria como religá-lo.
  include_inactive: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false"),
});

interface EscopoRow {
  id: string;
  slug: string;
  display_name: string;
  official_code: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

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
  const limite = params.data.limit ?? 200;

  const db = createAdminClient();
  let query = db
    .from("catalog_scopes")
    .select("id, slug, display_name, official_code, is_active, created_at, updated_at")
    .order("display_name", { ascending: true })
    .limit(limite + 1);
  if (!params.data.include_inactive) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) {
    logger.error("[catalog/scopes] leitura de escopos falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", "Não consegui ler os escopos do catálogo.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const linhas = (data ?? []) as EscopoRow[];
  const temMais = linhas.length > limite;
  const pagina = temMais ? linhas.slice(0, limite) : linhas;

  const contagem = await contarMateriaisPorEscopo(
    pagina.map((e) => e.id),
    requestId,
  );

  return ok(
    pagina.map((e) => ({
      id: e.id,
      slug: e.slug,
      display_name: e.display_name,
      official_code: e.official_code,
      is_active: e.is_active,
      materials_count: contagem.get(e.id) ?? 0,
      created_at: e.created_at,
      updated_at: e.updated_at,
    })),
    {
      requestId,
      headers: teto.headers,
      // Sem cursor assinado, e é decisão, não esquecimento: o catálogo curado é uma
      // lista de dezenas de escopos mantida à mão. Cursor HMAC aqui seria cerimônia
      // sobre carga que cabe numa tela. `has_more` existe para a lista dizer quando
      // essa premissa deixar de valer.
      meta: { has_more: temMais, total: pagina.length },
    },
  );
}

/**
 * Quantos materiais VIGENTES cada escopo tem — contados por `slug` distinto, não por
 * linha: material versionado tem N linhas para o mesmo conteúdo (trava 6), e contar
 * linha faria a tela dizer "12 materiais" para um escopo com 3 assuntos e 4 correções.
 * Versão inerte (FR-037) não conta: ela não ancora resposta nenhuma.
 */
async function contarMateriaisPorEscopo(
  escopoIds: string[],
  requestId: string,
): Promise<Map<string, number>> {
  const contagem = new Map<string, number>();
  if (escopoIds.length === 0) return contagem;

  const db = createAdminClient();
  const { data, error } = await db
    .from("catalog_materials")
    .select("catalog_scope_id, slug")
    .in("catalog_scope_id", escopoIds)
    .eq("inert", false);

  if (error) {
    // Contagem é enfeite; a lista de escopos é o conteúdo. Falhar a rota inteira por
    // causa dela trocaria uma tela incompleta por nenhuma tela.
    logger.warn("[catalog/scopes] contagem de materiais falhou", {
      error: error.message,
      request_id: requestId,
    });
    return contagem;
  }

  const vistos = new Map<string, Set<string>>();
  for (const linha of (data ?? []) as Array<{ catalog_scope_id: string | null; slug: string }>) {
    if (!linha.catalog_scope_id) continue;
    const conjunto = vistos.get(linha.catalog_scope_id) ?? new Set<string>();
    conjunto.add(linha.slug);
    vistos.set(linha.catalog_scope_id, conjunto);
  }
  for (const [escopo, slugs] of vistos) contagem.set(escopo, slugs.size);
  return contagem;
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

  const parsed = criarEscopoSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
      headers: teto.headers,
    });
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("catalog_scopes")
    .insert({
      slug: parsed.data.slug,
      display_name: parsed.data.display_name,
      official_code: parsed.data.official_code ?? null,
      is_active: parsed.data.is_active ?? true,
    })
    .select("id, slug, display_name, official_code, is_active, created_at, updated_at")
    .single();

  if (error) {
    // `slug` é UNIQUE (0117). Colisão é estado de negócio ("esse escopo já existe"),
    // não falha de infraestrutura — e o curador precisa da diferença para saber se
    // repete o pedido ou abre o que já está lá.
    if (error.code === "23505") {
      return fail("escopo_ja_existe", `Já existe um escopo com o slug "${parsed.data.slug}".`, 409, {
        requestId,
        headers: teto.headers,
      });
    }
    logger.error("[catalog/scopes] insert falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", "Não consegui criar o escopo do catálogo.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const escopo = data as EscopoRow;
  auditarCatalogo({
    acao: ACOES_DO_CATALOGO.escopoCriado,
    actorUserId: guarda.user.id,
    resourceType: RECURSO,
    resourceId: escopo.id,
    requestId,
    metadata: { slug: escopo.slug, display_name: escopo.display_name },
  });

  return ok({ ...escopo, materials_count: 0 }, { status: 201, requestId, headers: teto.headers });
}
