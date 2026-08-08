-- 0123 — `fn_buscar_lastro`: a busca que fundamenta a resposta
--
-- Spec 002 (RAG por operadora), fatia F2. Tarefas T046, T047, T048 e T049.
--
-- É a superfície mais crítica da feature: SC-005 (não-vazamento entre escopos), SC-007
-- (isolamento entre corretores) e SC-019 (precedência de camada) são ganhos ou perdidos
-- aqui dentro. Nada disso é decidido pelo chamador.
--
-- ═══ DE ONDE VEM O TENANT ═══
--
-- De `p_agent_id`, NUNCA do chamador. A organização e o acervo ativo são CONSULTADOS a
-- partir do agente, não AFIRMADOS por quem chama. É o que FR-019 exige: o isolamento não
-- depende de o chamador informar corretamente o próprio tenant — ele aponta um agente,
-- que o runtime resolve a partir da conversa, e o resto a função descobre.
--
-- E por que não `auth.uid()`, que seria o reflexo natural (brecha 7 da revisão cruzada):
-- o chamador real é o agent-engine, que fala com o banco por Pool `pg` com credencial de
-- serviço (`lib/agent-engine/agent/search-knowledge.ts:65`). Não existe sessão de
-- usuário ali. Uma função que derivasse o tenant de `auth.uid()` devolveria conjunto
-- VAZIO em toda chamada de produção — e passaria em qualquer teste escrito com uma
-- sessão autenticada. Este é o tipo de defeito que o Princípio XI nomeia.
--
-- ═══ O BALDE, E POR QUE A PRECEDÊNCIA NÃO É GLOBAL ═══
--
-- "Camada do tenant vence a do catálogo" aplicado ao conjunto INTEIRO produz um desastre
-- silencioso: um texto do corretor sobre o horário de atendimento dele passaria o limiar
-- e apagaria o procedimento de boleto da operadora, que estava correto e era o que o
-- cliente perguntou. A precedência vale DENTRO DO MESMO BALDE (research D7) — ou o escopo
-- específico, ou "vale para todos", nunca os dois juntos.
--
-- ═══ O QUE ESTA MIGRATION AINDA NÃO FAZ ═══
--
-- A regra da versão inerte (FR-037) NÃO está aqui: a coluna `catalog_materials.inert`
-- nasce na 0124, junto com a adoção local. A T134 aplica a inércia por
-- `create or replace` desta mesma função, forward-fix, e espelha no baseline. Escrever
-- agora uma referência a coluna inexistente faria esta migration não criar.

create or replace function public.fn_buscar_lastro(
  p_agent_id  uuid,
  p_scope_id  uuid,
  p_embedding public.vector,
  p_k         integer default 5,
  p_threshold real    default 0.40
)
returns table (
  chunk_id    uuid,
  layer       text,
  material_id uuid,
  content     text,
  similarity  real,
  source_ref  jsonb
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  with agente as (
    -- Tenant e acervo CONSULTADOS, não recebidos. `active_kb_version_id` nulo (corretor
    -- que ainda não indexou nada) zera a camada do tenant e deixa a do catálogo
    -- funcionando — que é exatamente "a instalação nasce sabendo".
    select a.organization_id, a.active_kb_version_id
      from public.ai_agents a
     where a.id = p_agent_id
  ),
  escopo_ativo as (
    -- O escopo é resolvido DENTRO da organização do agente. Um `p_scope_id` de outro
    -- tenant simplesmente não resolve, e a busca cai no caso "escopo desconhecido" —
    -- sem erro, sem vazamento e sem escolher por semelhança.
    --
    -- `is_active` é a trava 4 (FR-008): escopo desligado não resolve, e por consequência
    -- nenhum trecho daquele balde entra — nem do tenant, nem do catálogo.
    select ks.id as scope_id, ks.catalog_scope_id
      from public.knowledge_scopes ks
      join agente g on g.organization_id = ks.organization_id
     where ks.id = p_scope_id
       and ks.is_active
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
        'layer',        'tenant',
        'title',        s.name,
        'scope',        ks.display_name,
        'updated_at',   s.updated_at,
        'source_type',  s.source_type
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
       -- Ou vale para todos, ou é EXATAMENTE o escopo resolvido. Quando nada resolveu, a
       -- comparação com o subselect vazio dá NULL, que não é verdadeiro — e o resultado é
       -- o que FR-017 manda: só "vale para todos", nunca busca ampla.
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
        'layer',        'catalog',
        'title',        cm.title,
        'scope',        cs.display_name,
        'updated_at',   cm.published_at,
        'material_slug', cm.slug,
        'version',      cm.version
      )                                               as source_ref
      from public.catalog_chunks cc
      join public.catalog_materials cm
        on cm.id = cc.catalog_material_id
      left join public.catalog_scopes cs
        on cs.id = cc.catalog_scope_id
     where (cm.valid_until is null or cm.valid_until >= current_date)
       -- O trecho do catálogo carrega `catalog_scope_id`; o interruptor está do lado do
       -- tenant. Por isso a comparação é com o `catalog_scope_id` do escopo ATIVO — se o
       -- corretor desligou aquela operadora, nada dela entra.
       and (cc.applies_to_all or cc.catalog_scope_id = (select catalog_scope_id from escopo_ativo))
       and (1 - (cc.embedding <=> p_embedding)) >= p_threshold
  ),
  tudo as (
    select * from camada_tenant
    union all
    select * from camada_catalogo
  )
  select t.chunk_id, t.layer, t.material_id, t.content, t.similarity, t.source_ref
    from tudo t
   where t.layer = 'tenant'
      -- Precedência DENTRO DO BALDE: o trecho do catálogo só sai do conjunto se houver
      -- trecho do tenant no MESMO balde. Fora dele, os dois convivem.
      or not exists (
        select 1 from tudo x
         where x.layer = 'tenant'
           and x.balde = t.balde
      )
   order by t.similarity desc
   limit greatest(p_k, 0);
$$;

comment on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real) is
  'Migration 0123 (spec 002, F2): busca de lastro nas duas camadas. Tenant e acervo ativo '
  'derivados de p_agent_id, NUNCA recebidos do chamador (FR-019). Escopo desconhecido ou '
  'desligado devolve só material "vale para todos" — nunca busca ampla (FR-017, trava 4). '
  'Material vencido não ancora (FR-026). Precedência de camada vale dentro do mesmo balde '
  '(research D7).';

-- ── T048 · as três origens de EXECUTE ───────────────────────────────────────
--
-- `revoke from public` NÃO tira o grant direto que o `ALTER DEFAULT PRIVILEGES ... TO
-- anon` do baseline dá a toda função criada depois dele; e `revoke from anon` NÃO tira o
-- grant que o Postgres dá a PUBLIC no momento da criação. São origens distintas, e tratar
-- só uma deixa a função exposta com o gate verde. `authenticated` entra na lista porque
-- nenhum caminho autenticado precisa dela — o chamador é o agent-engine, por Pool `pg`.
revoke execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real) from public, anon, authenticated;
grant  execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real) to service_role;

-- ── T049 · forward-fix na função antiga ─────────────────────────────────────
--
-- `retrieve_top_k_chunks` tem `GRANT ALL ... TO authenticated` no baseline
-- (`baseline.sql:3709`) — alcançável por token de tenant, com `p_organization_id`
-- recebido do CHAMADOR e um comentário que delega a validação a ele. Continua existindo
-- para os caminhos vivos, todos com credencial de serviço, medidos em 2026-08-08:
--   · lib/mcp/server.ts:39           createAdminClient()
--   · workers/ai-response-worker.ts  admin.rpc(...)
--   · lib/agent-engine/.../search-knowledge.ts:65  Pool `pg`
-- Nenhum deles é `authenticated`. A porta some, os chamadores ficam.
--
-- Vai JUNTO desta migration de propósito: a feature que mais depende de isolamento não
-- pode conviver com a porta aberta ao lado.
revoke execute on function public.retrieve_top_k_chunks(uuid, uuid, public.vector, integer, real) from authenticated;

notify pgrst, 'reload schema';
