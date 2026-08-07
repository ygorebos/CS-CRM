/**
 * Fire-and-forget insert into `ai_invocations`.
 *
 * Caller should NOT await. We use `queueMicrotask` so the parent handler can
 * return without waiting for the audit insert; failures bubble to logger only.
 */

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/** Espelha o CHECK de `ai_invocations.invocation_kind` (ver o invariante). */
export type InvocationKind =
  | "bot_respond"
  | "sentiment_classify"
  | "triage_classify"
  | "embedding_generate";

export interface LogInvocationInput {
  organization_id: string;
  /**
   * NULL quando a invocação não pertence a agente nenhum — é o caso do
   * classificador de sentimento numa org que ainda não publicou agente (issue
   * #160). Antes isto era `string` e o chamador mandava `""` para preencher,
   * que o Postgres recusa como uuid. Como o insert é fire-and-forget, o custo
   * era pago e sumia: a tabela ficava vazia e as telas de consumo mostravam
   * zero. Tipo que aceita `null` é o que descreve a realidade.
   */
  agent_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  /**
   * O vocabulário é o do CHECK de `ai_invocations.invocation_kind` — nem um
   * valor a mais.
   *
   * Achado junto com a #160: este tipo listava `sentiment_check`,
   * `embed_chunk`, `embed_query` e `intent_classify`, que o banco NÃO aceita, e
   * omitia `triage_classify` e `embedding_generate`, que aceita. Nenhum dos
   * quatro estava em uso, então não havia sintoma — era armadilha carregada:
   * quem escolhesse um deles pelo autocomplete teria um `23514` num INSERT
   * fire-and-forget, ou seja, silêncio. O par entra em
   * `tests/invariants/vocabulario-banco-x-typescript.test.ts`, que é o único
   * gate que enxerga o banco.
   */
  invocation_kind: InvocationKind;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_cents: number;
  finish_reason?: string | null;
  citations?: Array<Record<string, unknown>>;
  error_payload?: Record<string, unknown> | null;
}

export function logInvocation(row: LogInvocationInput): void {
  queueMicrotask(() => {
    void (async () => {
      try {
        const admin = createAdminClient();
        const { error } = await admin.from("ai_invocations").insert({
          organization_id: row.organization_id,
          // NORMALIZA AQUI, e não no chamador (issue #160). O tipo já diz
          // `string | null`, mas `string` aceita `""` — e foi exatamente `?? ""`
          // que fez esta tabela ficar vazia numa VPS com tráfego real, porque o
          // Postgres recusa string vazia como uuid e o insert é fire-and-forget.
          // Consertar só o chamador que apareceu deixaria a armadilha armada
          // para o próximo: quem escreve na coluna uuid é esta função, então é
          // ela que fecha a porta. `?? null` continua sendo o certo lá; isto é a
          // rede embaixo.
          agent_id: row.agent_id === null || row.agent_id.trim() === "" ? null : row.agent_id,
          conversation_id: row.conversation_id,
          message_id: row.message_id,
          invocation_kind: row.invocation_kind,
          model: row.model,
          prompt_tokens: row.prompt_tokens,
          completion_tokens: row.completion_tokens,
          latency_ms: row.latency_ms,
          cost_cents: row.cost_cents,
          finish_reason: row.finish_reason ?? null,
          citations: row.citations ?? [],
          error_payload: row.error_payload ?? null,
        });
        if (error) {
          logger.warn("[ai-invocations] insert failed", {
            error: error.message,
            organization_id: row.organization_id,
            invocation_kind: row.invocation_kind,
          });
        }
      } catch (err) {
        logger.warn("[ai-invocations] insert threw", {
          error: err instanceof Error ? err.message : String(err),
          organization_id: row.organization_id,
        });
      }
    })();
  });
}
