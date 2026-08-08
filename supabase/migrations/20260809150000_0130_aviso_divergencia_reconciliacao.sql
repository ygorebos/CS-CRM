-- 0130 — o aviso da divergência de reconciliação (spec 004, FR-013a / T050).
--
-- A reconciliação é a ponta que PUXA do Princípio XIV: o CRM pergunta ao gateway
-- o que existiu numa janela e grava o que faltar. O que a doutrina proíbe é ela
-- fazer isso EM SILÊNCIO — "reconciliar em silêncio é proibido".
--
-- A razão é que silêncio transforma rede de segurança em tapa-buraco permanente:
-- se toda rodada recupera mensagens e ninguém fica sabendo, o defeito que as
-- perde continua lá, agora invisível porque alguém o conserta a cada minuto.
--
-- Severidade `warn` e não `critical`, ao contrário do `gateway_unreachable`: aqui
-- as mensagens JÁ foram recuperadas e estão na conversa certa. O que se pede ao
-- corretor é conferir se alguém ficou sem resposta no intervalo — não uma ação
-- de emergência.
alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'qr_rescan', 'job_dead', 'event_dead', 'budget_exceeded', 'handoff',
    'promotion_review', 'judge_unaligned', 'followup_dead', 'snooze_expired',
    'next_action_ambiguous', 'risk_backlog_seeded', 'reactivation_expired',
    'capabilities_missing', 'message_send_stuck', 'promise_unfulfilled',
    'assistance_without_grounding', 'channel_secret_missing',
    'gateway_delivery_dead', 'gateway_inbound_down', 'gateway_unreachable',
    -- (0130, spec 004 FR-013a) A reconciliação achou e recuperou mensagem que
    -- o caminho normal perdeu. Recuperar calado esconderia o defeito de origem.
    'gateway_reconciliation_gap',
    'other'
  ));
