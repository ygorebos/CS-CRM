-- 0125 — a divergência que o desempate produz, e que ninguém via
--
-- Spec 002 (RAG por operadora), fatia F4. Tarefas T079 e T080.
--
-- ═══ O DEFEITO QUE ISTO FECHA ═══
--
-- FR-035 tem DUAS metades: "o material do tenant vence o do catálogo no mesmo balde"
-- **e** "a divergência DEVE ser registrada para o corretor". A primeira nasceu na 0123 e
-- funciona. A segunda não existia em lugar nenhum — nem tabela, nem tarefa, nem tela.
--
-- Isso não é lacuna cosmética. Quando o material do corretor vence o do catálogo, os dois
-- textos dizem coisas diferentes sobre o mesmo assunto, e um deles está errado. O
-- desempate escolhe um e **silencia o outro** — que é a decisão certa para a resposta e a
-- errada para o corretor: ele nunca fica sabendo que o próprio material contradiz a
-- operadora. Descobre pelo cliente, meses depois, quando o texto errado era o dele.
--
-- ═══ POR QUE A FUNÇÃO PRECISOU MUDAR ═══
--
-- `fn_buscar_lastro` DESCARTA o perdedor dentro do `where` (0123, regra de precedência).
-- O chamador recebe só o vencedor — não existe, do lado de fora, informação de que houve
-- desempate. Registrar isso sem tocar na função exigiria uma SEGUNDA busca vetorial por
-- turno, só para descobrir o que a primeira já sabia e jogou fora: caro no caminho quente
-- e, pior, uma consulta que pode discordar da que ancorou a resposta.
--
-- Então a função passa a **poder** devolver o preterido, marcado, sob um parâmetro que
-- nasce `false`:
--
--   · `p_incluir_preteridos = false` (default) — conjunto IDÊNTICO ao de hoje. Todo
--     chamador existente continua igual, sem saber que o parâmetro existe.
--   · `p_incluir_preteridos = true` — as linhas preteridas vêm JUNTO, com
--     `preterido = true` e o material que as venceu.
--
-- As preteridas **não consomem o `limit`** das vencedoras. Se consumissem, ligar o
-- registro de divergência reduziria em silêncio o lastro da resposta — a feature de
-- observabilidade degradaria a feature observada, que é o pior tipo de instrumentação.
--
-- ⚠️ CONTRATO PARA QUEM CHAMAR COM `true`: linha com `preterido = true` **NUNCA** pode
-- virar âncora de resposta. Ela é o texto que o desempate rejeitou. Quem liga o parâmetro
-- é responsável por separar os dois conjuntos ANTES de qualquer uso — em
-- `lib/agent-engine/agent/search-knowledge.ts` a separação acontece na mesma linha em que
-- as linhas chegam, de propósito.
--
-- ═══ POR QUE `drop function` E NÃO SÓ `create or replace` ═══
--
-- O tipo de retorno muda (duas colunas novas), e o Postgres recusa `create or replace`
-- que altere `returns table`. O `drop` também elimina a assinatura de 5 argumentos: mantê-
-- la ao lado da de 6 deixaria duas funções alcançáveis por chamada de 5 argumentos, e
-- qual delas responde é detalhe de resolução de overload — exatamente o tipo de ambiguidade
-- que não se descobre em teste, só em produção. Os `grant`/`revoke` são reaplicados abaixo
-- porque o `drop` os leva junto.
--
-- ═══ A REGRA DE PRECEDÊNCIA NÃO MUDOU ═══
--
-- Ela só foi movida de um `where` que apagava para uma coluna que marca. `preterido` é
-- literalmente a negação do predicado antigo, e a lista devolvida com o default continua
-- a mesma. A 0124 (versão vigente por slug, inércia — FR-037) está preservada aqui
-- dentro: esta migration parte do corpo da 0124, não do da 0123.

-- ── 1 · onde a divergência mora ─────────────────────────────────────────────
--
-- Tenant-aware com RLS, como toda tabela que carrega dado de cliente. O par de materiais
-- é FK dos dois lados (anti-pattern nº 1: nunca guardar nome de material como texto) —
-- título e escopo são LIDOS por junção na hora de mostrar, nunca copiados para cá, que é
-- a doutrina DIRC: Referenciar. Se o corretor renomear o material, a lista de divergências
-- acompanha sozinha.
create table if not exists public.knowledge_divergences (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,

  -- Quem venceu: material do PRÓPRIO corretor. Hoje o desempate só tem um sentido
  -- possível (tenant sobre catálogo), e por isso não há coluna de camada: ela seria uma
  -- constante gravada em toda linha (DIRC: Calcular). Se um dia houver outro sentido, a
  -- coluna entra então, com dado real para preencher.
  winner_source_id  uuid not null references public.ai_knowledge_sources(id) on delete cascade,
  -- Quem foi silenciado: material curado do catálogo.
  loser_material_id uuid not null references public.catalog_materials(id) on delete cascade,

  -- O balde onde o desempate aconteceu, informativo. Nulo = o balde "vale para todos".
  scope_id          uuid references public.knowledge_scopes(id) on delete set null,

  -- Assunto pelo léxico FECHADO de assistência (`lib/agent-engine/guardrails/
  -- lexico-assistencia.ts`), nunca o texto da pergunta. Mesmo contrato de PII da 0086
  -- (`knowledge_searches`): telemetria de retenção longa não carrega conteúdo de conversa.
  -- `''` = não classificado, e é valor legítimo — divergência sem assunto reconhecido
  -- continua sendo divergência.
  subject           text not null default '',

  -- Uma linha por par-e-assunto, não uma por busca. Sem isto, um assunto perguntado cem
  -- vezes por dia viraria cem linhas idênticas e a lista do corretor ficaria ilegível
  -- justamente no caso que mais importa — o que mais se repete.
  occurrences       integer not null default 1,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  -- Preenchido quando o corretor declara a divergência tratada. Não apagamos a linha:
  -- divergência resolvida que volta a aparecer é informação, e `delete` a perderia.
  resolved_at       timestamptz
);

-- É este índice que torna o registro idempotente por turno. Todas as colunas da chave são
-- `not null` de propósito: `null` não conflita em índice único, e uma delas nula
-- devolveria o comportamento que o índice existe para impedir (uma linha nova por busca).
create unique index if not exists knowledge_divergences_par_key
  on public.knowledge_divergences (organization_id, winner_source_id, loser_material_id, subject);

-- A leitura da tela: divergências abertas daquela organização, mais recentes primeiro.
create index if not exists knowledge_divergences_org_aberta_idx
  on public.knowledge_divergences (organization_id, last_seen_at desc)
  where resolved_at is null;

comment on table public.knowledge_divergences is
  'Migration 0125 (spec 002, F4): a SEGUNDA metade de FR-035. Quando o material do tenant '
  'vence o do catálogo no mesmo balde, os dois textos discordam sobre o mesmo assunto e um '
  'está errado — o desempate silencia o perdedor, e sem este registro o corretor nunca '
  'saberia. Uma linha por (par de materiais, assunto), com contagem; assunto pelo léxico '
  'fechado, sem texto de conversa (mesmo contrato de PII da 0086).';

alter table public.knowledge_divergences enable row level security;

drop policy if exists tenant_isolation_knowledge_divergences_all on public.knowledge_divergences;
create policy tenant_isolation_knowledge_divergences_all on public.knowledge_divergences
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

-- Mesma defesa em profundidade da 0086: a policy já devolve zero linha sem sessão, mas o
-- grant que o default privilege do baseline concede a `anon` não tem razão de existir —
-- esta tabela nunca é lida sem sessão. Idempotente: revogar o que não está lá é no-op.
revoke all on public.knowledge_divergences from anon;

-- ── 2 · a busca passa a poder devolver o preterido ──────────────────────────
drop function if exists public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real);

create or replace function public.fn_buscar_lastro(
  p_agent_id            uuid,
  p_scope_id            uuid,
  p_embedding           public.vector,
  p_k                   integer default 5,
  p_threshold           real    default 0.40,
  p_incluir_preteridos  boolean default false
)
returns table (
  chunk_id               uuid,
  layer                  text,
  material_id            uuid,
  content                text,
  similarity             real,
  source_ref             jsonb,
  -- `true` = o desempate rejeitou este trecho. NUNCA ancora resposta (ver contrato no
  -- cabeçalho). Só existe na saída quando `p_incluir_preteridos` é ligado.
  preterido              boolean,
  -- O material do tenant que o venceu, para o registro de divergência apontar os DOIS
  -- lados. Nulo em linha não preterida.
  preterido_por_material uuid
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  with agente as (
    select a.organization_id, a.active_kb_version_id
      from public.ai_agents a
     where a.id = p_agent_id
  ),
  escopo_ativo as (
    select ks.id as scope_id, ks.catalog_scope_id
      from public.knowledge_scopes ks
      join agente g on g.organization_id = ks.organization_id
     where ks.id = p_scope_id
       and ks.is_active
  ),
  -- Da 0124: a versão VIGENTE de cada material curado é a maior `version` não-inerte. É o
  -- que faz a edição local vencer a semeada (FR-037).
  material_vigente as (
    select distinct on (cm.slug) cm.id, cm.slug, cm.title, cm.version,
           cm.published_at, cm.valid_until
      from public.catalog_materials cm
     where not cm.inert
     order by cm.slug, cm.version desc
  ),
  camada_tenant as (
    select
      c.id                                            as chunk_id,
      'tenant'::text                                  as layer,
      s.id                                            as material_id,
      c.content                                       as content,
      (1 - (c.embedding <=> p_embedding))::real       as similarity,
      case when c.applies_to_all then 'todos' else 'escopo' end as balde,
      jsonb_build_object(
        'layer',       'tenant',
        'title',       s.name,
        'scope',       ks.display_name,
        'updated_at',  s.updated_at,
        'source_type', s.source_type
      )                                               as source_ref
      from public.ai_chunks c
      join agente g
        on c.organization_id = g.organization_id
       and c.kb_version_id   = g.active_kb_version_id
      join public.ai_knowledge_sources s
        on s.id = c.knowledge_source_id
      left join public.knowledge_scopes ks
        on ks.id = c.scope_id
     where (s.valid_until is null or s.valid_until >= current_date)
       and (c.applies_to_all or c.scope_id = (select scope_id from escopo_ativo))
       and (1 - (c.embedding <=> p_embedding)) >= p_threshold
  ),
  camada_catalogo as (
    select
      cc.id                                           as chunk_id,
      'catalog'::text                                 as layer,
      cm.id                                           as material_id,
      cc.content                                      as content,
      (1 - (cc.embedding <=> p_embedding))::real      as similarity,
      case when cc.applies_to_all then 'todos' else 'escopo' end as balde,
      jsonb_build_object(
        'layer',         'catalog',
        'title',         cm.title,
        'scope',         cs.display_name,
        'updated_at',    cm.published_at,
        'material_slug', cm.slug,
        'version',       cm.version
      )                                               as source_ref
      from public.catalog_chunks cc
      join material_vigente cm
        on cm.id = cc.catalog_material_id
      left join public.catalog_scopes cs
        on cs.id = cc.catalog_scope_id
     where (cm.valid_until is null or cm.valid_until >= current_date)
       and (cc.applies_to_all or cc.catalog_scope_id = (select catalog_scope_id from escopo_ativo))
       and (1 - (cc.embedding <=> p_embedding)) >= p_threshold
  ),
  tudo as (
    select * from camada_tenant
    union all
    select * from camada_catalogo
  ),
  -- Quem venceu cada balde: o trecho do tenant de maior similaridade ali dentro. É esse o
  -- material que o corretor precisa comparar com o do catálogo — apontar qualquer outro
  -- mandaria ele conferir o texto errado.
  vencedor_por_balde as (
    select distinct on (t.balde) t.balde, t.material_id
      from tudo t
     where t.layer = 'tenant'
     order by t.balde, t.similarity desc
  ),
  marcado as (
    select
      t.*,
      -- A NEGAÇÃO EXATA do predicado de precedência da 0123. Era
      -- `where layer='tenant' or not exists (tenant no mesmo balde)`; virou coluna.
      (t.layer = 'catalog'
        and exists (select 1 from tudo x where x.layer = 'tenant' and x.balde = t.balde)
      ) as preterido
      from tudo t
  ),
  vencedoras as (
    select m.chunk_id, m.layer, m.material_id, m.content, m.similarity, m.source_ref,
           false::boolean as preterido,
           null::uuid     as preterido_por_material,
           0              as ordem
      from marcado m
     where not m.preterido
     order by m.similarity desc
     limit greatest(p_k, 0)
  ),
  rejeitadas as (
    -- Fora do `limit` das vencedoras de propósito: instrumentação que rouba lastro da
    -- resposta é instrumentação que degrada o que veio observar.
    select m.chunk_id, m.layer, m.material_id, m.content, m.similarity, m.source_ref,
           true::boolean  as preterido,
           v.material_id  as preterido_por_material,
           1              as ordem
      from marcado m
      join vencedor_por_balde v on v.balde = m.balde
     where p_incluir_preteridos
       and m.preterido
  )
  select u.chunk_id, u.layer, u.material_id, u.content, u.similarity, u.source_ref,
         u.preterido, u.preterido_por_material
    from (select * from vencedoras union all select * from rejeitadas) u
   order by u.ordem, u.similarity desc;
$$;

comment on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) is
  'Migrations 0123 + 0124 + 0125 (spec 002): busca de lastro nas duas camadas. Tenant e '
  'acervo derivados de p_agent_id, nunca do chamador (FR-019). Escopo desconhecido ou '
  'desligado devolve só "vale para todos" (FR-017, trava 4). Material vencido não ancora '
  '(FR-026). Precedência dentro do balde (research D7). No catálogo, por slug ancora só a '
  'MAIOR versão não-inerte (FR-037). p_incluir_preteridos=true acrescenta as linhas que o '
  'desempate rejeitou, marcadas — elas NUNCA ancoram resposta, existem para registrar a '
  'divergência de FR-035, e não consomem o limit das vencedoras.';

-- As três origens de EXECUTE, de novo: o `drop` acima levou os grants junto, e recriar sem
-- revogar deixaria a função exposta ao PostgREST pela anon key (a doutrina de migrations
-- do CLAUDE.md, item 9).
revoke execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) from public, anon, authenticated;
grant  execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) to service_role;

notify pgrst, 'reload schema';
