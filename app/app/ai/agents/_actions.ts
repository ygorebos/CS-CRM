"use server";
/**
 * Server Actions para a tela de lista de agents.
 *
 * Estas actions são wrappers thin sobre a mesma lógica das rotas REST em
 * `app/api/v1/ai/agents/[id]/...`. Usam `loadAuthUser` + `createAdminClient`
 * directamente para evitar fetch interno (e para reusar `audit()`).
 *
 * Mutations privilegiadas exigem role admin. Errors voltam em forma simples
 * `{ ok: false, error, message }` para a UI tratar com toast.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Role } from "@/lib/auth/types";
import { duplicateAgentWithVersion } from "@/lib/ai/agents/duplicate";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string; message?: string };

type AdminGuard =
  | { kind: "ok"; authUser: { id: string }; activeOrg: { orgId: string; role: Role } }
  | { kind: "fail"; result: { ok: false; error: string } };

async function ensureAdmin(): Promise<AdminGuard> {
  const authUser = await loadAuthUser();
  if (!authUser) return { kind: "fail", result: { ok: false, error: "unauthenticated" } };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { kind: "fail", result: { ok: false, error: "forbidden_tenant" } };
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { kind: "fail", result: { ok: false, error: "forbidden_role" } };
  }
  return { kind: "ok", authUser, activeOrg };
}

export async function pauseAgentAction(id: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureAdmin();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, published_version_id, archived_at, is_active, kind")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "not_found" };
  if (existing.archived_at) return { ok: false, error: "state_conflict", message: "Agent arquivado." };

  const requestId = randomUUID();
  const previousVersionId = (existing as { published_version_id: string | null }).published_version_id;

  if (previousVersionId) {
    await admin
      .from("ai_agent_versions")
      .update({ status: "superseded", superseded_at: new Date().toISOString() })
      .eq("id", previousVersionId)
      .eq("organization_id", activeOrg.orgId)
      .eq("status", "published");
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    published_version_id: null,
  };
  // Legacy rag_bot: também flip is_active para refletir no badge.
  if (existing.kind !== "mcp_agent") updates.is_active = false;

  const { error } = await admin
    .from("ai_agents")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.paused",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    requestId,
    metadata: { previous_version_id: previousVersionId },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function unpauseAgentAction(id: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureAdmin();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, kind, archived_at, is_active")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "not_found" };
  if (existing.archived_at) return { ok: false, error: "state_conflict" };

  // mcp_agent não pode ser despausado por aqui — precisa ir em /publish escolhendo versão.
  if (existing.kind === "mcp_agent") {
    return { ok: false, error: "publish_required", message: "Publique uma versão para reativar." };
  }

  const { error } = await admin
    .from("ai_agents")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    metadata: { unpaused: true },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function archiveAgentAction(id: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureAdmin();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ai_agents")
    .select("id, kind, is_default, archived_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.is_default) return { ok: false, error: "cannot_archive_default" };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (existing.kind === "mcp_agent") {
    updates.archived_at = new Date().toISOString();
    updates.published_version_id = null;
  } else {
    updates.is_active = false;
  }

  const { error } = await admin
    .from("ai_agents")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.archived",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    metadata: { kind: existing.kind },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function renameAgentAction(id: string, name: string): Promise<ActionResult> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const trimmed = (name ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    return { ok: false, error: "validation_failed", message: "Nome entre 1 e 120 caracteres." };
  }
  const guard = await ensureAdmin();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();
  const { error } = await admin
    .from("ai_agents")
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);
  if (error) return { ok: false, error: "internal_error", message: error.message };

  void audit({
    action: "ai_agent.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: id,
    metadata: { renamed_to: trimmed },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true };
}

export async function duplicateAgentAction(id: string): Promise<ActionResult<{ new_id: string }>> {
  if (!UUID_RX.test(id)) return { ok: false, error: "invalid_request" };
  const guard = await ensureAdmin();
  if (guard.kind === "fail") return guard.result;
  const { authUser, activeOrg } = guard;

  const admin = createAdminClient();

  // Mesma implementação da rota /api/v1/ai/agents/:id/duplicate. Antes daqui a
  // action fazia cópia rasa (só a linha de ai_agents), e para mcp_agent isso
  // devolvia um agente em branco: prompt, ferramentas, credencial, canal,
  // palavras de handoff, budgets e follow-up vivem em ai_agent_versions.
  // `requireVersion: false` porque o botão da lista também duplica rag_bot
  // legado, que não tem versão nenhuma.
  const result = await duplicateAgentWithVersion(admin, {
    orgId: activeOrg.orgId,
    agentId: id,
    actorUserId: authUser.id,
    requireVersion: false,
  });

  if (!result.ok) {
    if (result.error === "not_found") return { ok: false, error: "not_found" };
    return { ok: false, error: "internal_error", message: result.message };
  }

  const cloned = result.agent as { id: string };

  void audit({
    action: "ai_agent.duplicated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: cloned.id,
    metadata: {
      source_agent_id: id,
      // Mesma ação (`ai_agent.duplicated`) emitida de dois lugares: os dois metadata
      // têm de ter a MESMA forma, senão quem lê o audit não sabe se o campo faltou
      // porque não houve versão ou porque veio pelo outro caminho.
      source_version_id: result.sourceVersionId,
      source_version_copied: result.version !== null,
    },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true, data: { new_id: cloned.id } };
}
