-- 0116 — recebimento unificado pelo gateway: vocabulário de canal e chave de corte.
--
-- Contexto (spec 001, constituição v1.2.0 "Por onde as mensagens entram"): o
-- `gateway_go` passa a ser o receptor geral do tráfego de entrada. Ele recebe de
-- todos os canais, normaliza para UM envelope e entrega ao CRM por HTTP
-- assinado; quem persiste continua sendo o CRM, porque receber uma mensagem aqui
-- não é um INSERT — dispara agente, follow-up, guardrails, auditoria e event_log.
--
-- Esta migration NÃO cria tabela. O mapa conexão→organização que a análise dizia
-- faltar já existe (`channel_sessions.webhook_path_token`), e a fila para o
-- ACK-primeiro também (`webhook_events_log` já tem `status` com
-- received/processed/error/dead, `attempts`, `error_message`, `processed_at`).
-- O que falta é vocabulário e uma chave de corte.
--
-- ═══ 1 · `channel_sessions.provider` — vocabulário de canal ═══
--
-- Hoje aceita só 'waha' e 'meta_cloud'. Os quatro valores novos espelham
-- `MensagemNormalizada.Platform` do gateway, para que a origem seja legível aqui
-- sem tradução. O CHECK é mantido de propósito: é ele que faz o invariante
-- `tests/invariants/vocabulario-banco-x-typescript.test.ts` cobrar o lado
-- TypeScript. Remover o CHECK "para não precisar migrar" apagaria essa vigilância.
--
-- ═══ 2 · `webhook_events_log.provider` — ganha 'gateway' ═══
--
-- Sem isto a rota nova não consegue registrar NADA, e o registro auditável é
-- requisito (FR-017).
--
-- ═══ 3 · `channel_sessions.ingest_path` — a chave de corte ═══
--
-- Migra-se UMA conexão por vez, e volta-se atrás sem release. Num produto
-- self-host, virar tudo de uma vez significa que a instalação que quebrou não
-- tem caminho de volta. O default 'legacy' preserva o comportamento de toda
-- instalação existente; instalação NOVA nasce em 'gateway' pelo bootstrap, não
-- por default de coluna — senão o clone novo subiria o gateway sem usá-lo.
--
-- Durante a virada os dois caminhos podem entregar a mesma mensagem. É
-- inofensivo: a unicidade (organization_id, external_id) em `messages` derruba a
-- segunda. É por isso que a troca é segura em produção.
--
-- ═══ 4 · `channel_sessions.gateway_connection_id` — ponteiro, sem FK ═══
--
-- Identificador da conexão do lado do gateway. `text` e sem FK de propósito: FK
-- cruzando fronteira de produto é proibida (Princípio VII). Nullable porque
-- conexão legada não tem.
--
-- ═══ 5 · índice do dreno ═══
--
-- `webhook_events_log` deixa de ser só log e passa a ser fila: o dreno varre
-- `status='received'` a cada minuto. Índice parcial para ele não varrer a tabela
-- inteira, que agora cresce com todo o tráfego de entrada.
--
-- Idempotente e portável em psql puro: sem BEGIN/COMMIT (o runner já envolve em
-- transação), sem temp table.

-- ── 1 · vocabulário de canal ────────────────────────────────────────────────

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array[
    'waha'::text,
    'meta_cloud'::text,
    'whatsapp_uazapi'::text,
    'whatsapp_cloud'::text,
    'instagram'::text,
    'messenger'::text
  ]));

-- Cada provider tem de trazer a referência que o SEU canal usa. Sem estender
-- este CHECK junto, ampliar o vocabulário acima não adianta: a sessão de canal
-- do gateway passaria no `provider_check` e morreria no `provider_ref_check`,
-- com erro apontando para a coluna errada. Os canais do gateway se identificam
-- por `gateway_connection_id` — exigi-lo é o que impede linha órfã que não dá
-- para rotear de volta.
alter table public.channel_sessions
  add column if not exists gateway_connection_id text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'       and waha_session_name    is not null) or
    (provider = 'meta_cloud' and meta_phone_number_id is not null) or
    (provider in ('whatsapp_uazapi', 'whatsapp_cloud', 'instagram', 'messenger')
       and gateway_connection_id is not null)
  );

-- ── 2 · provider do log de webhook ──────────────────────────────────────────

alter table public.webhook_events_log
  drop constraint if exists webhook_events_log_provider_check;

alter table public.webhook_events_log
  add constraint webhook_events_log_provider_check
  check (provider = any (array[
    'waha'::text,
    'nuvemshop'::text,
    'generic'::text,
    'gateway'::text
  ]));

-- ── 3 · chave de corte por conexão ──────────────────────────────────────────

alter table public.channel_sessions
  add column if not exists ingest_path text not null default 'legacy';

alter table public.channel_sessions
  drop constraint if exists channel_sessions_ingest_path_check;

alter table public.channel_sessions
  add constraint channel_sessions_ingest_path_check
  check (ingest_path = any (array['legacy'::text, 'gateway'::text]));

comment on column public.channel_sessions.ingest_path is
  'Por qual caminho esta conexão ingere mensagens: ''legacy'' (webhook direto do '
  'provedor) ou ''gateway'' (envelope normalizado do gateway_go). Migra-se uma '
  'conexão por vez e volta-se atrás sem release — num produto self-host, virada '
  'sem caminho de volta é a que não se pode consertar remotamente. Default '
  '''legacy'' preserva instalação existente; instalação nova nasce em ''gateway'' '
  'pelo bootstrap.';

-- ── 4 · ponteiro para a conexão do lado do gateway ──────────────────────────
-- (a coluna já foi criada junto do provider_ref_check, que a referencia)

comment on column public.channel_sessions.gateway_connection_id is
  'Identificador desta conexão no gateway_go. TEXT e sem FK de propósito: FK '
  'cruzando fronteira de produto é proibida (constituição, Princípio VII). Serve '
  'a diagnóstico e ao roteamento da entrega. Nullable — conexão legada não tem.';

-- ── 5 · índice do dreno da fila ─────────────────────────────────────────────

create index if not exists idx_webhook_events_log_pendentes
  on public.webhook_events_log (received_at)
  where status = 'received';

comment on index public.idx_webhook_events_log_pendentes is
  'Índice do dreno de ACK-primeiro: a rota responde 202 e grava status=''received'', '
  'e o worker recolhe o que ficou parado. Parcial porque só o pendente interessa — '
  'a tabela passa a receber TODO o tráfego de entrada e varrê-la inteira a cada '
  'minuto seria custo crescente sem fim.';

notify pgrst, 'reload schema';
