/**
 * GET  /api/v1/channel-sessions — lista os canais WhatsApp da org (do DB).
 *   Acessível a qualquer membro (usado pelo seletor do inbox e pela sidebar).
 * POST /api/v1/channel-sessions — conecta um NOVO número (cria a sessão com
 *   nome único e inicia no WAHA). Admin only.
 *
 * organization_id resolvido da sessão (cookie) — nunca do body.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_GATEWAY_WHATSAPP } from "@/lib/channels/capabilities";
import { criarConexaoDeCanal, provisionarEGravarConexao } from "@/lib/channels/criar-conexao";
import { ErroDoGateway, provisionamentoConfigurado } from "@/lib/gateway/provisionamento";
import { createChannelSchema } from "@/lib/schemas/channels";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

export const CHANNEL_COLUMNS =
  "id, waha_session_name, display_name, phone_number, status, status_reason, last_health_check_at, last_status_change_at, daily_message_limit, is_warmup_complete, created_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const base = () =>
    supabase
      .from("channel_sessions")
      .select(CHANNEL_COLUMNS)
      .eq("organization_id", activeOrg.orgId);
  // Canais arquivados sobrevivem só como âncora das FKs RESTRICT
  // (conversations/messages). Para o usuário eles foram excluídos.
  //
  // Tolerante à coluna ausente porque esta é a PRIMEIRA tela de quem já tem
  // número ligado: num clone que subiu o código sem a migration 0106, o filtro
  // devolveria 42703 → 500 → "Nenhum número conectado ainda", convidando o
  // operador a parear de novo um número que já está no ar. Sem a coluna, nada
  // está arquivado, e a lista sem o filtro é a lista certa (ver lib/channels/archived).
  const { data, error, schemaOutdated } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], {
    requestId,
    ...(schemaOutdated ? { meta: { schema_outdated: true } } : {}),
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  // O provisionamento pelo gateway tem precedência quando está configurado: é
  // ele que a instalação passa a usar. Sem ele, o caminho antigo continua
  // valendo — a virada é por CONFIGURAÇÃO, não por release.
  const peloGateway = provisionamentoConfigurado();

  const waha = peloGateway ? null : getWahaClient();
  if (!peloGateway && !waha) {
    return fail(
      "waha_not_configured",
      "O WhatsApp (WAHA) não está configurado neste ambiente: faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY. Configure-as e tente de novo.",
      503,
      { requestId },
    );
  }

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = createChannelSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  // Nome de sessão único por canal — o hardcode `org_<8>` era 1 número por org.
  // Aqui o usuário está ACRESCENTANDO um número aos que já tem; no onboarding a
  // intenção é outra e o nome é fixo (ver `lib/channels/criar-conexao.ts`).
  const sessionName = `org_${activeOrg.orgId.slice(0, 8)}_${randomUUID().replace(/-/g, "").slice(0, 6)}`;

  // ── TUDO-OU-NADA (T043 / FR-033, FR-012) ─────────────────────────────────
  //
  // A instância nasce PRIMEIRO no lado externo, e a linha do CRM depois. A ordem
  // não é arbitrária: se a linha viesse antes, um provisionamento que falhasse
  // deixaria canal fantasma na tela do usuário — e ele tentaria parear um número
  // que não existe em lugar nenhum. Nesta ordem, a falha do PRIMEIRO passo não
  // deixa rastro, e a do segundo é compensada logo abaixo.
  // A orquestração do tudo-ou-nada mora em `lib/channels/criar-conexao.ts`: é a
  // parte que precisa de prova, e compensação dentro de Route Handler só se
  // exercita montando request, sessão e cliente — três dublês para testar um if.
  const pedido = {
    organizationId: activeOrg.orgId,
    sessionName,
    displayName: parsed.data.display_name ?? null,
    actorUserId: user.id,
    requestId,
    origem: "central" as const,
    colunas: CHANNEL_COLUMNS,
  };

  let criacao;
  try {
    criacao = peloGateway
      ? await provisionarEGravarConexao(supabase, {
          ...pedido,
          platform: CHANNEL_PROVIDER_GATEWAY_WHATSAPP,
        })
      : await criarConexaoDeCanal(supabase, pedido);
  } catch (err) {
    const e = err instanceof ErroDoGateway ? err : null;
    return fail(
      "gateway_error",
      e?.message ?? "não consegui provisionar a conexão no gateway",
      e && e.status >= 500 ? 502 : 422,
      { requestId, details: { codigo: e?.codigo ?? "desconhecido" } },
    );
  }

  if (!criacao.ok) {
    if (criacao.motivo === "sem_cifra") {
      return fail(
        "invalid_request",
        "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — a conexão não foi criada",
        422,
        { requestId },
      );
    }
    return fail("internal_error", criacao.detalhe, 500, { requestId });
  }
  const created = criacao.conexao as { id: string };

  if (waha) {
    try {
      await waha.startSession(sessionName);
    } catch (err) {
      // Rollback: sem o transporte no ar, não deixamos um canal fantasma preso
      // em STARTING.
      await supabase
        .from("channel_sessions")
        .delete()
        .eq("organization_id", activeOrg.orgId)
        .eq("id", created.id);
      return fail("waha_error", wahaFriendlyError(err), 502, { requestId });
    }
  }

  return ok(created, { requestId, status: 201 });
}
