/**
 * Superfície de plataforma do catálogo curado — guarda, teto e trilha.
 *
 * Spec 002 (RAG por operadora), fatia F2, tarefas T063/T064/T065.
 * Contrato: `specs/002-rag-por-operadora/contracts/rotas-http.md` §"Superfície de plataforma".
 *
 * ═══ POR QUE UMA GUARDA PRÓPRIA, E NÃO `requireRole` ═══
 *
 * `requireRole` resolve o papel DENTRO de uma organização ativa e nega com
 * `forbidden_tenant` quando não há nenhuma. O catálogo curado não tem
 * `organization_id` (migration 0117, trava 2): não existe org onde resolver papel, e o
 * administrador de plataforma de uma instalação pode legitimamente não ser membro de
 * organização nenhuma. Usar `requireRole(..., { allowPlatformAdmin: true })` aqui
 * trocaria o 403 correto ("você não é admin de plataforma") por um 403 enganoso
 * ("sem organização ativa") — e barraria o curador legítimo.
 *
 * A trava 1 é `is_platform_admin` e nada mais. `admin` de organização não alcança o
 * catálogo por caminho nenhum (FR-036), nem aqui nem na RLS da 0117.
 */
import type { NextResponse } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { loadAuthUser } from "@/lib/auth/server";
import type { AuthUser } from "@/lib/auth/types";

// ---------------------------------------------------------------------------
// Guarda de papel
// ---------------------------------------------------------------------------

export type GuardaDePlataforma =
  | { ok: true; user: AuthUser }
  | { ok: false; response: NextResponse<ApiError> };

/**
 * Gate de toda rota `/api/v1/catalog/*`:
 * `const guarda = await exigirAdminDePlataforma(requestId, "catalog_scopes");`
 * `if (!guarda.ok) return guarda.response;`
 *
 * A negativa é auditada (`authz.denied`, fire-and-forget) pelo mesmo motivo que
 * `requireRole` audita a dele: tentativa de alcançar o catálogo por quem não deveria é
 * exatamente o evento que a trava 1 existe para tornar visível.
 */
export async function exigirAdminDePlataforma(
  requestId: string,
  recurso: string,
): Promise<GuardaDePlataforma> {
  const user = await loadAuthUser();
  if (!user) {
    // `unauthenticated`, não `unauthorized`: este último é reservado ao segredo interno
    // das rotas host↔app (lib/api/errors.ts).
    return { ok: false, response: fail("unauthenticated", "Faça login para continuar.", 401, { requestId }) };
  }

  if (!user.is_platform_admin) {
    void audit({
      action: "authz.denied",
      actorUserId: user.id,
      resourceType: recurso,
      requestId,
      metadata: { required_role: "platform_admin", surface: "catalog" },
    });
    return {
      ok: false,
      response: fail(
        "forbidden",
        "O catálogo curado é da plataforma. Só o administrador do servidor edita este conteúdo.",
        403,
        { requestId },
      ),
    };
  }

  return { ok: true, user };
}

// ---------------------------------------------------------------------------
// Teto de requisições
// ---------------------------------------------------------------------------

export interface TetoDaRota {
  /** Prefixo do balde no Redis. O identificador do usuário é acrescentado aqui. */
  balde: string;
  limite: number;
  janelaSeg: number;
}

export interface ResultadoDoTeto {
  /** Resposta 429 pronta quando o teto estourou; `null` quando pode seguir. */
  excedido: NextResponse<ApiError> | null;
  /** `X-RateLimit-*` para acompanhar TODA resposta, estourando ou não. */
  headers: Record<string, string>;
}

/**
 * Aplica `checkRateLimit` (lib/ai/dispatcher/rate-limit.ts) à rota.
 *
 * Ele NÃO se herda de lugar nenhum: é chamada explícita, rota a rota, e é por isso que
 * T063/T064 o cobram aqui em vez de deixá-lo para o Polish. Sem Upstash configurado ele
 * cai para o contador em memória do processo — degrada em instalação de nó único, mas
 * não deixa a porta escancarada.
 *
 * O balde é por USUÁRIO (id vindo do JWT validado), nunca por organização: o catálogo é
 * da instalação e não tem tenant onde contar.
 */
export async function aplicarTeto(
  userId: string,
  teto: TetoDaRota,
  requestId: string,
): Promise<ResultadoDoTeto> {
  const resultado = await checkRateLimit(`${teto.balde}:${userId}`, teto.limite, teto.janelaSeg);

  // Janela FIXA (INCR + EXPIRE): o reset é o início da próxima janela, não "agora + janela".
  const agoraSeg = Math.floor(Date.now() / 1000);
  const resetSeg = (Math.floor(agoraSeg / teto.janelaSeg) + 1) * teto.janelaSeg;
  const restam = Math.max(0, teto.limite - resultado.count);

  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(teto.limite),
    "X-RateLimit-Remaining": String(restam),
    "X-RateLimit-Reset": String(resetSeg),
  };

  if (resultado.allowed) return { excedido: null, headers };

  const retryAfter = Math.max(1, resetSeg - agoraSeg);
  return {
    excedido: fail("rate_limited", "Muitas requisições ao catálogo. Tente de novo em instantes.", 429, {
      requestId,
      headers: { ...headers, "Retry-After": String(retryAfter) },
    }),
    headers,
  };
}

/** Tetos por superfície. Escrita é mais apertada que leitura porque tem efeito. */
export const TETO_LEITURA: TetoDaRota = { balde: "catalog:read", limite: 120, janelaSeg: 60 };
export const TETO_ESCRITA: TetoDaRota = { balde: "catalog:write", limite: 30, janelaSeg: 60 };
export const TETO_LACUNAS: TetoDaRota = { balde: "catalog:gaps", limite: 60, janelaSeg: 60 };

// ---------------------------------------------------------------------------
// Trilha de auditoria
// ---------------------------------------------------------------------------

/**
 * Ações de auditoria da superfície do catálogo (FR-036: toda mutação auditada com autor
 * e data).
 *
 * Os quatro códigos vivem no union canônico de `lib/audit/actions.ts` — o `satisfies`
 * abaixo é o que garante isso: inventar um código aqui que não exista lá reprova o
 * `typecheck`, em vez de gravar uma trilha que ninguém consegue consultar depois.
 *
 * (Nasceram com `as AuditAction` porque o union estava fora do conjunto de escrita do
 * agente que escreveu estas rotas — arquivo compartilhado é do orquestrador. O cast durou
 * uma integração.)
 */
export const ACOES_DO_CATALOGO = {
  escopoCriado: "catalog.scope_created",
  escopoAtualizado: "catalog.scope_updated",
  materialCriado: "catalog.material_created",
  materialVersionado: "catalog.material_version_created",
} as const satisfies Record<string, AuditAction>;

export type AcaoDoCatalogo = (typeof ACOES_DO_CATALOGO)[keyof typeof ACOES_DO_CATALOGO];

/**
 * Escreve a trilha da mutação. `organization_id` fica NULO de propósito: o catálogo não
 * é de tenant nenhum (trava 2), e carimbar a org do curador na linha faria a auditoria
 * mentir sobre a quem o conteúdo pertence.
 *
 * Fire-and-forget como o resto do repo: falha de audit alerta no Sentry, não bloqueia a
 * mutação (doutrina do CLAUDE.md).
 */
export function auditarCatalogo(entrada: {
  acao: AcaoDoCatalogo;
  actorUserId: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
  metadata?: Record<string, unknown>;
}): void {
  void audit({
    action: entrada.acao,
    actorUserId: entrada.actorUserId,
    organizationId: null,
    resourceType: entrada.resourceType,
    resourceId: entrada.resourceId,
    requestId: entrada.requestId,
    metadata: entrada.metadata ?? {},
    bypassedRls: true,
    actingAsPlatformAdmin: true,
  });
}

// ---------------------------------------------------------------------------
// Utilidades compartilhadas
// ---------------------------------------------------------------------------

export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corpo JSON, ou `null` quando não é JSON válido — sem estourar a rota. */
export async function lerJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}
