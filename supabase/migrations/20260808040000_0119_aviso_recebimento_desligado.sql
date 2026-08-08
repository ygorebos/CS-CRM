-- 0119 — conexão migrada para o gateway com o recebimento DESLIGADO (spec 001, T037/T059)
--
-- O modo de falha que este kind torna visível é o mais silencioso da feature
-- inteira, e é de CONFIGURAÇÃO, não de queda:
--
--   `channel_sessions.ingest_path = 'gateway'` diz "as mensagens desta conexão
--   entram pela rota nova". `GATEWAY_INBOUND_ENABLED = false` faz essa rota
--   responder **404**. As duas coisas juntas são coerentes com o desenho (a
--   chave de corte é por conexão, o interruptor é global) e catastróficas juntas:
--   o gateway entrega, leva 404, e — pela política do contrato §5 — **descarta
--   sem retentar**, porque 404 é defeito de configuração. Nenhuma mensagem
--   entra, nenhuma volta, e do lado de cá a tela fica igualzinha a uma
--   segunda-feira devagar.
--
-- FR-027 exige que a ausência do gateway apareça como problema de configuração
-- na tela. Este kind é o veículo. Ele é distinto de `channel_secret_missing`
-- (lá a chave falta, e as mensagens entram sozinhas quando ela existir) e de
-- `gateway_delivery_dead` (lá a entrega individual acabou): aqui o recebimento
-- inteiro está desligado, e o conserto é ligar uma variável.
--
-- Idempotente: a lista só cresce, nenhuma linha existente viola a constraint
-- nova, e a reconstrução é `drop if exists` + `add` num bloco ÚNICO (#159).

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'promise_unfulfilled',
    'channel_secret_missing',
    'gateway_delivery_dead',
    -- (migration 0119, spec 001 §T059) Conexão apontada para o gateway com o
    -- recebimento desligado: a rota responde 404, o gateway descarta sem
    -- retentar (404 é defeito de configuração pelo contrato §5) e nenhuma
    -- mensagem entra. É o silêncio mais caro da feature, e é curável com uma
    -- variável de ambiente.
    'gateway_inbound_down',
    'other'
  ));
