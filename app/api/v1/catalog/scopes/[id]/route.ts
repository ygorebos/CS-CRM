/**
 * GET   /api/v1/catalog/scopes/{id} — um escopo curado
 * PATCH /api/v1/catalog/scopes/{id} — renomear, trocar registro oficial, ligar/desligar
 *
 * Spec 002 (RAG por operadora), T063. Só `is_platform_admin` (trava 1).
 *
 * ═══ O QUE ESTA ROTA SE RECUSA A FAZER ═══
 *
 * **Não muda `slug`.** Ele é a chave que a semeadura reconhece (`on conflict (slug,
 * version) do nothing`). Renomeá-lo não renomeia nada: faz o próximo `update.sh` do
 * clone deixar de reconhecer o escopo e inserir uma SEGUNDA cópia dele, com os materiais
 * antigos órfãos na primeira. O schema aceitaria; o efeito é um catálogo duplicado em
 * toda instalação, descoberto meses depois. O corpo é `strict`, então mandar `slug` volta
 * 422 dizendo isso — em vez de ser aceito e ignorado em silêncio.
 *
 * **Não apaga.** `catalog_materials.catalog_scope_id` é `on delete restrict` (0117), e
 * apagar um escopo semeado só o traria de volta na próxima atualização. Tirar de
 * circulação é `is_active = false`, que é reversível e sobrevive à semeadura.
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
  UUID_RX,
  aplicarTeto,
  auditarCatalogo,
  exigirAdminDePlataforma,
  lerJson,
} from "../../_plataforma";

export const dynamic = "force-dynamic";

const RECURSO = "catalog_scopes";
const CAMPOS = "id, slug, display_name, official_code, is_active, created_at, updated_at";

const patchSchema = z
  .strictObject({
    display_name: z.string().min(2).max(120).optional(),
    official_code: z.string().min(1).max(40).nullish(),
    is_active: z.boolean().optional(),
  })
  // Corpo vazio viraria um UPDATE sem colunas, que o PostgREST rejeita com uma mensagem
  // que não ajuda ninguém. Melhor recusar aqui, dizendo o que falta.
  .refine((v) => Object.keys(v).length > 0, {
    message: "Informe ao menos um campo: display_name, official_code ou is_active.",
  });

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_LEITURA, requestId);
  if (teto.excedido) return teto.excedido;

  const db = createAdminClient();
  const { data, error } = await db.from("catalog_scopes").select(CAMPOS).eq("id", id).maybeSingle();

  if (error) {
    logger.error("[catalog/scopes/:id] leitura falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", "Não consegui ler o escopo.", 500, { requestId, headers: teto.headers });
  }
  if (!data) {
    return fail("not_found", "Escopo do catálogo não encontrado.", 404, { requestId, headers: teto.headers });
  }

  return ok(data, { requestId, headers: teto.headers });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_ESCRITA, requestId);
  if (teto.excedido) return teto.excedido;

  const parsed = patchSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
      headers: teto.headers,
    });
  }

  // Monta o patch com as chaves que VIERAM. Espalhar `parsed.data` direto gravaria
  // `undefined` nas ausentes, e o PostgREST as manda como null — desligar um escopo
  // apagaria o registro oficial dele de brinde.
  const patch: Record<string, unknown> = {};
  if (parsed.data.display_name !== undefined) patch.display_name = parsed.data.display_name;
  if (parsed.data.official_code !== undefined) patch.official_code = parsed.data.official_code ?? null;
  if (parsed.data.is_active !== undefined) patch.is_active = parsed.data.is_active;

  const db = createAdminClient();
  const { data, error } = await db.from("catalog_scopes").update(patch).eq("id", id).select(CAMPOS).maybeSingle();

  if (error) {
    logger.error("[catalog/scopes/:id] update falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", "Não consegui atualizar o escopo.", 500, { requestId, headers: teto.headers });
  }
  if (!data) {
    return fail("not_found", "Escopo do catálogo não encontrado.", 404, { requestId, headers: teto.headers });
  }

  auditarCatalogo({
    acao: ACOES_DO_CATALOGO.escopoAtualizado,
    actorUserId: guarda.user.id,
    resourceType: RECURSO,
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(patch), ...patch },
  });

  return ok(data, { requestId, headers: teto.headers });
}
