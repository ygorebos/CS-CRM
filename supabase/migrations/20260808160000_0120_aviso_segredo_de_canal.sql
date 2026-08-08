-- 0117 — a conexão que não recebe nada precisa APARECER (spec 001, T017e)
--
-- A entrega do gateway é fail-closed sem válvula: sem chave de verificação, a
-- rota recusa 100% das entregas daquela conexão. O comportamento é o certo — o
-- caminho legado tinha válvula e ela virou o estado permanente de toda
-- instalação, que é como "fail-closed" virou teatro.
--
-- O que faltava é o que o operador VÊ quando isso acontece: nada. As mensagens
-- param, o inbox fica vazio, e não há onde olhar. A cura das linhas antigas roda
-- fora do SQL (`scripts/curar-segredos-de-canal.ts`, chamado pelo install.sh e
-- pelo update.sh) porque a chave de cifra só existe depois do baseline — então
-- um clone que atualize pela metade fica exatamente neste estado, em silêncio.
--
-- Este kind é o que faz o defeito chegar à Central de avisos. O Princípio II
-- proíbe que falta de funcionamento vire silêncio.
--
-- Idempotente: a lista só cresce, nenhuma linha existente viola a constraint
-- nova. A reconstrução é `drop if exists` + `add` num bloco único — reconstruir
-- a mesma constraint em N blocos quebra o `update.sh` de clones que já tenham
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
    -- (migration 0120, spec 001 §T017e) Conexão cuja chave de verificação nunca
    -- foi gerada: toda entrega do gateway é recusada, nenhuma mensagem se perde
    -- (o gateway retenta 5xx) mas nenhuma entra. Sem este aviso o sintoma é "as
    -- mensagens pararam", sem lugar nenhum para olhar.
    'channel_secret_missing',
    'other'
  ));
