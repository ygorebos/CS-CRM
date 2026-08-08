-- 0118 — a entrega que morreu precisa APARECER (spec 001, T037)
--
-- O dreno do recebimento (`/api/v1/cron/gateway-inbound-drain`) marca `dead` a
-- entrega que esgotou as tentativas, que chegou sem dono ou cujo envelope não
-- parseia. Até aqui ele emitia `gateway.entrega_descartada` no `event_log` — e
-- ninguém escutava. Evento sem consumidor é anti-pattern declarado no CLAUDE.md,
-- e na prática significa o mesmo silêncio do `log.Warn` que a spec 001 existe
-- para acabar: a mensagem de um cliente real não chegou, e não há tela em que
-- isso apareça.
--
-- Este kind é o consumidor. A diferença para `channel_secret_missing` é o
-- desfecho, e ela importa para quem lê o aviso: lá nenhuma mensagem se perde (o
-- gateway retenta 5xx e elas entram quando a chave existir); aqui a entrega
-- ACABOU — não haverá outra tentativa. Um kind só para os dois casos daria à
-- pessoa a mesma frase para dois problemas de gravidade diferente.
--
-- Idempotente: a lista só cresce, nenhuma linha existente viola a constraint
-- nova. A reconstrução é `drop if exists` + `add` num bloco ÚNICO — reconstruir
-- a mesma constraint em N blocos quebra a re-aplicação de quem já tenha
-- vocabulário posterior (vigiado por
-- tests/unit/baseline-constraint-reconstruida.test.ts).

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
    -- (migration 0116, spec 002 FR-012) Kind da OUTRA frente. Ele entra aqui
    -- porque esta constraint é reconstruída inteira: uma lista que o esquecesse
    -- o apagaria em silêncio no primeiro `update`, e o defeito só apareceria
    -- quando um agente recusasse por falta de lastro e o insert estourasse.
    'assistance_without_grounding',
    'channel_secret_missing',
    -- (migration 0121, spec 001 §T037) Entrega de envelope DESCARTADA: as
    -- tentativas acabaram, ou a linha chegou sem conexão/organização, ou o
    -- envelope não parseia. Ao contrário de `channel_secret_missing`, aqui não
    -- haverá nova tentativa — a mensagem daquele cliente não vai chegar, e a
    -- única forma de alguém saber é esta.
    'gateway_delivery_dead',
    'other'
  ));
