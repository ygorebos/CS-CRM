import { describe, it, expect } from "vitest";

import { deriveAgentStatus } from "./AgentStatusBadge";
import type { AgentRow } from "@/hooks/ai/useAgent";

const base = {
  id: "a", organization_id: "o", name: "Atendente IA", description: null,
  model: "anthropic/claude-sonnet-4-6", system_prompt: "oi", is_active: true,
  is_default: true, kind: "rag_bot", priority: 0, published_version_id: null,
  archived_at: null, config: {}, guardrails: {}, active_kb_version_id: null,
  created_at: "", updated_at: "",
} as unknown as AgentRow;

describe("deriveAgentStatus", () => {
  it("sem versão publicada é RASCUNHO, mesmo ativo", () => {
    // O defeito de origem: o agente criado no onboarding (rag_bot, ativo, sem
    // versão) aparecia como "Publicado" enquanto os dois runtimes o ignoram —
    // ambos resolvem o agente por join com ai_agent_versions.
    expect(deriveAgentStatus({ ...base, is_active: true, published_version_id: null })).toBe("draft");
    expect(deriveAgentStatus({ ...base, kind: "mcp_agent", published_version_id: null } as AgentRow)).toBe("draft");
  });

  it("com versão publicada e ativo é PUBLICADO", () => {
    expect(deriveAgentStatus({ ...base, published_version_id: "v1" } as AgentRow)).toBe("published");
  });

  it("com versão publicada e inativo é PAUSADO (rag_bot legado)", () => {
    expect(deriveAgentStatus({ ...base, published_version_id: "v1", is_active: false } as AgentRow)).toBe("paused");
  });

  it("mcp_agent publicado é PUBLICADO mesmo com is_active false", () => {
    // `is_active` é semântica do rag_bot legado. Para mcp_agent os dois runtimes
    // (lib/ai/dispatcher e lib/agent-engine/agent/agent-config) resolvem o agente
    // só por published_version_id + archived_at — nenhum dos dois lê is_active.
    // Lendo a coluna aqui, o badge dizia "Pausado" para um agente que está no ar,
    // e o menu não oferecia saída: "Despausar" fica disabled para mcp_agent e
    // unpauseAgentAction recusa com publish_required. Republicar também não
    // liberava, porque fn_publish_ai_agent_version não toca is_active.
    expect(
      deriveAgentStatus({
        ...base,
        kind: "mcp_agent",
        published_version_id: "v1",
        is_active: false,
      } as AgentRow),
    ).toBe("published");
  });

  it("arquivado vence tudo", () => {
    expect(deriveAgentStatus({ ...base, archived_at: "2026-01-01", published_version_id: "v1" } as AgentRow)).toBe("archived");
  });
});
