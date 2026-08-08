-- 0129 — o aviso de gateway fora do ar (spec 004, FR-023 / T037).
--
-- O Princípio XIV declara o gateway como SPOF: instância única, sem réplica. A
-- consequência prática é que a queda dele não é hipótese remota, é o modo de
-- falha esperado — e o que a constituição proíbe é que ela aconteça em
-- silêncio: "queda vira alerta pra nós E aviso na Central pro usuário".
--
-- O alerta para a operação já existe em qualquer lugar onde se escreve log de
-- erro. O que faltava era a metade do usuário: sem um kind próprio, a queda do
-- gateway aparece para o corretor como "hoje ninguém respondeu" — idêntico a um
-- dia devagar, e sem lugar nenhum para olhar.
--
-- Kind SEPARADO de `gateway_inbound_down` de propósito, ainda que a tela do
-- corretor pareça a mesma: lá o recebimento está desligado por CONFIGURAÇÃO
-- (uma variável, conserto nosso e imediato); aqui o processo não responde
-- (conserto é subir o serviço, e enquanto isso o envio TAMBÉM não sai). Fundir
-- os dois faria o aviso dizer a coisa errada em metade dos casos.
--
-- Um bloco por constraint (tests/unit/baseline-constraint-reconstruida.test.ts):
-- o vocabulário novo EDITA a lista existente, não acrescenta um segundo bloco.
-- Ver o racional completo no apêndice do baseline.
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
    'assistance_without_grounding',
    'channel_secret_missing',
    'gateway_delivery_dead',
    'gateway_inbound_down',
    -- (0129, spec 004 FR-023) O gateway não responde. Nem entra nem sai
    -- mensagem, e o corretor não tem como distinguir isso de um dia parado.
    'gateway_unreachable',
    'other'
  ));
