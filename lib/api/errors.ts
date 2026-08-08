/**
 * Códigos de erro canônicos da API DeskcommCRM.
 *
 * Adicionar novo código:
 *  1. Adicionar à enum/constante abaixo
 *  2. Documentar em docs/specs/<spec>.md
 *  3. Sem renomear código existente — versionar em /api/v2/ se precisar quebrar
 */

export const ApiErrorCodes = {
  // 400 — body / params
  invalid_request: "invalid_request",
  validation_failed: "validation_failed", // Zod retornou erros de schema (422 também aceita)
  invalid_cursor: "invalid_cursor",
  formato_nao_suportado: "formato_nao_suportado", // material de conhecimento em formato que o ingest não lê (spec 002, FR-007)
  material_muito_grande: "material_muito_grande", // acima do teto declarado ANTES do envio (FR-007)
  material_sem_texto_extraivel: "material_sem_texto_extraivel", // aceito e sem virar trecho buscável seria aceite em silêncio (FR-004)
  material_sem_escopo: "material_sem_escopo", // não declarou operadora nem "vale para todas" (FR-001)

  // 401 — auth
  unauthorized: "unauthorized", // segredo interno inválido/ausente (rotas host↔app, ex. system/agent)
  unauthenticated: "unauthenticated",
  token_expired: "token_expired",
  token_revoked: "token_revoked",
  invalid_credentials: "invalid_credentials",
  mfa_required: "mfa_required",
  auth_in_query_forbidden: "auth_in_query_forbidden",

  // 403 — authz
  forbidden: "forbidden",
  forbidden_role: "forbidden_role",
  forbidden_tenant: "forbidden_tenant",
  lgpd_anonymization_irreversible: "lgpd_anonymization_irreversible",
  escopo_do_catalogo_nao_editavel: "escopo_do_catalogo_nao_editavel", // o tenant lê, desativa ou sobrepõe — nunca edita o catálogo (spec 002, FR-019/FR-036)

  // 404
  not_found: "not_found",

  // 409 — conflito
  idempotency_conflict: "idempotency_conflict",
  state_conflict: "state_conflict",
  invalid_state: "invalid_state", // resposta a um agent_case que saiu de awaiting_human (spec 15 §7)
  tenant_already_exists: "tenant_already_exists",
  escopo_ja_existe: "escopo_ja_existe", // nome já usado por escopo próprio OU por espelho do catálogo (spec 002, FR-002)
  duplicate_external_id: "duplicate_external_id",
  event_gone: "event_gone", // resend de run cujo event_log original foi apagado (on delete set null)
  next_action_absent: "next_action_absent", // decisão sobre proposta que não existe (mais) [wave 4]
  next_action_changed: "next_action_changed", // o agente reescreveu a proposta entre o render e o clique
  channel_archived: "channel_archived", // ação sobre canal que o usuário excluiu (a linha só sobrevive como âncora das FKs)

  // 422 — semântica
  unprocessable_entity: "unprocessable_entity",
  assistencia_sem_lastro: "assistencia_sem_lastro", // afirmação de assistência sem trecho âncora (spec 002, FR-009)
  channel_without_session: "channel_without_session", // operação de sessão (reiniciar, parear) pedida a canal que não tem sessão no transporte — o oficial
  invalid_state_transition: "invalid_state_transition",
  invalid_owner: "invalid_owner", // novo dono não é membro ativo agent+ da org (bulk assign, G3-04)
  trigger_kind_not_implemented: "trigger_kind_not_implemented", // publish de followup-flow com kind sem motor de enrollment (stage_change/conversation_end)

  // 429
  rate_limited: "rate_limited",

  // 500 / upstream
  internal_error: "internal_error",
  upstream_unavailable: "upstream_unavailable",
  unavailable: "unavailable", // 503: dependência de config ausente (ex.: pool do engine sem SUPABASE_DB_URL)
  waha_error: "waha_error",
  ai_provider_error: "ai_provider_error",
  nuvemshop_error: "nuvemshop_error",
} as const;

export type ApiErrorCode = (typeof ApiErrorCodes)[keyof typeof ApiErrorCodes];
