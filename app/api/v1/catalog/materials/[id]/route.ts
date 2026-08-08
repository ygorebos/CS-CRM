/**
 * GET   /api/v1/catalog/materials/{id} — o material, com o texto inteiro
 * PATCH /api/v1/catalog/materials/{id} — corrige o material criando `version + 1`
 *
 * Spec 002 (RAG por operadora), T065 — a trava 6. Só `is_platform_admin` (trava 1).
 *
 * ═══ O PATCH NÃO ATUALIZA NADA. ELE INSERE. ═══
 *
 * Material curado nunca é reescrito (FR-037, migration 0117): editar cria uma versão
 * nova e a anterior permanece. O verbo continua sendo PATCH porque é isso que o cliente
 * está fazendo — corrigindo aquele material —, mas a gravação é um INSERT, e o recurso
 * devolvido é a versão nova, com `201`.
 *
 * Duas coisas, juntas, fazem a correção valer no COMPORTAMENTO e não só no registro:
 *
 *  1. A versão nova nasce `origin='local'`, `adopted_at=now()`, `adopted_by=<curador>` —
 *     `inserirVersaoLocal` cuida disso. É a adoção que faz a próxima versão semeada
 *     daquele slug nascer inerte (trigger da migration 0124).
 *  2. `fn_buscar_lastro` (0124) ancora, por slug, APENAS a maior versão não-inerte. Sem
 *     esse recorte, a versão anterior continuaria respondendo ao lado da correção — as
 *     duas ao mesmo tempo, uma delas dizendo justamente o que o curador consertou.
 *
 * Sem a adoção, o release seguinte apaga a correção sem tocar em uma linha: `version+1`
 * chega semeada, mais recente, e vence pelo desempate de FR-035. SC-018 continuaria
 * verde contando linhas, e o requisito falharia respondendo — a classe de defeito que o
 * Princípio XI nomeia.
 *
 * ═══ E OS TRECHOS? ═══
 *
 * A versão nova nasce SEM `catalog_chunks` — quem os produz é a indexação do catálogo, e
 * ela não acontece dentro de uma requisição HTTP (embedding é chamada de rede; a rota
 * responderia em segundos e falharia junto com o provedor). Até a indexação rodar, o
 * material corrigido não ancora resposta. A resposta traz `chunks_count: 0` para que a
 * tela possa dizer isso em vez de fingir que já está valendo.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  CAMPOS_MATERIAL,
  type MaterialRow,
  editarMaterialSchema,
  inserirVersaoLocal,
  maiorVersao,
  resumirMaterial,
} from "../../_materiais";
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
  const { data, error } = await db.from("catalog_materials").select(CAMPOS_MATERIAL).eq("id", id).maybeSingle();

  if (error) {
    logger.error("[catalog/materials/:id] leitura falhou", { error: error.message, request_id: requestId });
    return fail("internal_error", "Não consegui ler o material.", 500, { requestId, headers: teto.headers });
  }
  if (!data) {
    return fail("not_found", "Material do catálogo não encontrado.", 404, { requestId, headers: teto.headers });
  }

  const material = data as MaterialRow;

  // `head: true` + `count: exact`: a pergunta é "está indexado?", e baixar milhares de
  // trechos (com `embedding` junto) para respondê-la seria pagar o payload inteiro por
  // um número. O `embedding` nunca sai daqui — o contrato o proíbe explicitamente.
  const { count, error: erroContagem } = await db
    .from("catalog_chunks")
    .select("id", { count: "exact", head: true })
    .eq("catalog_material_id", id);
  if (erroContagem) {
    logger.warn("[catalog/materials/:id] contagem de trechos falhou", {
      error: erroContagem.message,
      request_id: requestId,
    });
  }

  return ok(
    { ...resumirMaterial(material), body: material.body, chunks_count: count ?? 0 },
    { requestId, headers: teto.headers },
  );
}

// ---------------------------------------------------------------------------
// PATCH — cria versão nova (trava 6)
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const guarda = await exigirAdminDePlataforma(requestId, RECURSO);
  if (!guarda.ok) return guarda.response;

  const teto = await aplicarTeto(guarda.user.id, TETO_ESCRITA, requestId);
  if (teto.excedido) return teto.excedido;

  const parsed = editarMaterialSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
      headers: teto.headers,
    });
  }

  const db = createAdminClient();

  const { data: base, error: erroBase } = await db
    .from("catalog_materials")
    .select(CAMPOS_MATERIAL)
    .eq("id", id)
    .maybeSingle();
  if (erroBase) {
    logger.error("[catalog/materials/:id] leitura do material base falhou", {
      error: erroBase.message,
      request_id: requestId,
    });
    return fail("internal_error", "Não consegui ler o material.", 500, { requestId, headers: teto.headers });
  }
  if (!base) {
    return fail("not_found", "Material do catálogo não encontrado.", 404, { requestId, headers: teto.headers });
  }

  const anterior = base as MaterialRow;

  // A versão nova sai da MAIOR versão do slug, não da versão que o curador abriu. Editar
  // a v2 enquanto existe uma v3 (semeada, talvez inerte) e inserir "v3" bateria no
  // `unique (slug, version)` — ou, pior, criaria uma v3 concorrente se o índice não
  // existisse. O conteúdo vem da linha aberta; o número, do topo da pilha.
  const { versao, erro } = await maiorVersao(db, anterior.slug);
  if (erro !== null || versao === null) {
    logger.error("[catalog/materials/:id] leitura de versão falhou", { error: erro, request_id: requestId });
    return fail("internal_error", "Não consegui calcular a versão nova.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const { data, error } = await inserirVersaoLocal(db, {
    slug: anterior.slug,
    version: versao + 1,
    // O eixo (escopo ou "vale para todos") acompanha o material, não é reescolhido na
    // edição: mudar de operadora não é corrigir um material, é criar outro. Mantê-lo
    // aqui também preserva o XOR do CHECK sem a rota precisar reconstruí-lo.
    catalog_scope_id: anterior.catalog_scope_id,
    applies_to_all: anterior.applies_to_all,
    title: parsed.data.title ?? anterior.title,
    body: parsed.data.body ?? anterior.body,
    valid_until: parsed.data.valid_until === undefined ? anterior.valid_until : (parsed.data.valid_until ?? null),
    actorUserId: guarda.user.id,
  });

  if (error || !data) {
    // `23505` em `(slug, version)`: outro curador criou a mesma versão entre a leitura e
    // a escrita. É conflito de estado, não erro de infraestrutura — e o cliente precisa
    // saber a diferença para recarregar em vez de repetir cegamente.
    if (error?.code === "23505") {
      return fail(
        "state_conflict",
        "Outra edição criou essa versão primeiro. Recarregue o material e refaça a correção.",
        409,
        { requestId, headers: teto.headers },
      );
    }
    logger.error("[catalog/materials/:id] insert da versão nova falhou", {
      error: error?.message,
      request_id: requestId,
    });
    return fail("internal_error", "Não consegui criar a versão nova do material.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const nova = data as MaterialRow;
  auditarCatalogo({
    acao: ACOES_DO_CATALOGO.materialVersionado,
    actorUserId: guarda.user.id,
    resourceType: RECURSO,
    resourceId: nova.id,
    requestId,
    metadata: {
      slug: nova.slug,
      from_material_id: anterior.id,
      from_version: anterior.version,
      to_version: nova.version,
      from_origin: anterior.origin,
      // O que a adoção significa, gravado junto: a partir daqui a semeadura deste slug
      // chega inerte nesta instalação.
      adopted: true,
      campos: Object.keys(parsed.data),
    },
  });

  return ok(
    {
      ...resumirMaterial(nova),
      body: nova.body,
      chunks_count: 0,
      replaces: { id: anterior.id, version: anterior.version },
    },
    { status: 201, requestId, headers: teto.headers },
  );
}
