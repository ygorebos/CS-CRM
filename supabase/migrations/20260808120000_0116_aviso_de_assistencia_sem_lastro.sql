-- 0116 — o aviso de "assistência recusada por falta de material" na Central
--
-- Spec 002 (RAG por operadora), fatia F1, FR-012.
--
-- É a ÚNICA mudança de schema da fatia: uma linha de vocabulário. O veto de lastro
-- (`assistance_grounding` na cadeia `before_send`) é código, não tabela — e foi
-- deliberadamente posto primeiro no plano justamente porque não precisa de schema. Se
-- ele não coubesse na cadeia atual, o custo de descobrir seria esta linha, não uma
-- partição inteira.
--
-- Por que o vocabulário precisa existir: quando o agente recusa, a conversa é escalada e
-- um aviso acionável abre para o corretor com a pergunta original, a operadora envolvida
-- (ou "desconhecida") e o motivo. Sem `kind` próprio, essa recusa cairia em 'other' e
-- ficaria indistinguível de qualquer outro aviso — e o corretor não teria como filtrar o
-- que precisa carregar, que é o insumo de FR-028.
--
-- ⚠️ A constraint é reconstruída INTEIRA aqui, com a lista completa. É o padrão do repo
-- (vigiado por tests/unit/baseline-constraint-reconstruida.test.ts): reconstruir a mesma
-- constraint em N blocos parciais quebra o `update.sh` de clones que já tenham uma linha
-- de vocabulário posterior — os blocos antigos rodam antes e falham em cadeia.

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
    -- (migration 0116, spec 002 FR-012) O agente recusou uma afirmação de assistência
    -- por falta de trecho âncora no acervo. Não é erro do sistema: é a resposta correta,
    -- e o aviso existe para que ela vire trabalho do corretor (carregar o material que
    -- falta) em vez de virar silêncio.
    'assistance_without_grounding',
    'other'
  ));

notify pgrst, 'reload schema';
