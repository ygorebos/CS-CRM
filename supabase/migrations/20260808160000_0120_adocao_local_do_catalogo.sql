-- 0120 — a edição local vence a versão nova semeada
--
-- Spec 002 (RAG por operadora), fatia F3. Tarefas T133 e T134.
--
-- ═══ O DEFEITO QUE ESTA MIGRATION FECHA ═══
--
-- Duas frases verdadeiras, juntas, produziam o oposto do que FR-037 pede:
--
--   1. "a semeadura só ACRESCENTA versão, nunca sobrescreve" (trava 6)
--   2. "o desempate é por recência" (FR-035)
--
-- A versão que chega por release é sempre a mais recente. Logo, ela venceria a correção
-- que o administrador da instalação fez — **no comportamento**, enquanto o banco fica
-- intacto. SC-018 passaria contando linhas ("zero edições sobrescritas": verdade, nenhuma
-- linha foi tocada) e o requisito falharia respondendo. É exatamente a classe de defeito
-- que o Princípio XI nomeia: medir o registro em vez do efeito.
--
-- ═══ ESTADO POR MATERIAL, NUNCA CHAVE GLOBAL (A-21) ═══
--
-- Adotar um `slug` não congela o catálogo inteiro. Um botão "não atualizar meu catálogo"
-- seria mais simples e muito pior: o administrador que corrigiu UMA carência pararia de
-- receber correção de todo o resto, e descobriria isso meses depois.
--
-- ═══ A SEGUNDA METADE, QUE NÃO ESTAVA NA TAREFA E FALTAVA ═══
--
-- Só marcar a versão nova como inerte NÃO faz a edição local vencer: a versão `seed`
-- ANTERIOR continuava no conjunto ao lado da local, e o agente ancorava nas duas — uma
-- delas dizendo justamente o que o administrador corrigiu. Versionar material e deixar
-- toda versão ancorar é fábrica de contradição.
--
-- Por isso a `fn_buscar_lastro` passa a considerar, por `slug`, **apenas a maior versão
-- não-inerte**. É o mínimo que torna "editar cria version+1" (trava 6) coerente com
-- "o agente responde o que vale hoje".

alter table public.catalog_materials
  add column if not exists adopted_at timestamptz;

alter table public.catalog_materials
  add column if not exists adopted_by uuid references auth.users(id) on delete set null;

-- Versão que chegou por semeadura DEPOIS de o slug ter sido adotado. Não ancora e não
-- desempata; fica visível para ser aceita (FR-037).
alter table public.catalog_materials
  add column if not exists inert boolean not null default false;

create index if not exists catalog_materials_adotados_idx
  on public.catalog_materials (slug) where adopted_at is not null;

-- ── a inércia é aplicada no INSERT, não conferida na leitura ────────────────
--
-- Podia ser um `where` na busca ("ignore seed mais nova que a adoção"). Não é, por dois
-- motivos: a busca é o hot path, e a inércia precisa ser VISÍVEL na tela de curadoria
-- para o administrador poder aceitar a versão nova. Estado que só existe dentro de um
-- `where` não tem como aparecer.
create or replace function public.fn_versao_semeada_sobre_adotado_nasce_inerte()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.origin = 'seed' and exists (
    select 1 from public.catalog_materials m
     where m.slug = new.slug
       and m.adopted_at is not null
  ) then
    new.inert := true;
  end if;
  return new;
end $$;

revoke execute on function public.fn_versao_semeada_sobre_adotado_nasce_inerte() from public, anon, authenticated;
grant  execute on function public.fn_versao_semeada_sobre_adotado_nasce_inerte() to service_role;

drop trigger if exists trg_catalog_materials_inercia on public.catalog_materials;
create trigger trg_catalog_materials_inercia
  before insert on public.catalog_materials
  for each row execute function public.fn_versao_semeada_sobre_adotado_nasce_inerte();

comment on column public.catalog_materials.inert is
  'Migration 0120 (spec 002, F3): versão semeada que chegou depois de o slug ser adotado '
  'localmente. Não ancora e não desempata (FR-037); fica visível para ser aceita.';

comment on column public.catalog_materials.adopted_at is
  'Migration 0120: marca o slug como adotado por esta instalação. Gravado na versão local '
  'criada pela edição. Estado por material, nunca chave global (A-21).';

-- ── T134 · forward-fix da busca ─────────────────────────────────────────────
--
-- `create or replace` da 0119. Duas mudanças, ambas no lado do catálogo:
--   · versão inerte não entra no conjunto;
--   · por `slug`, só a MAIOR versão não-inerte ancora.
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
  -- A versão VIGENTE de cada material curado: a maior `version` entre as não-inertes.
  -- Sem este recorte, a versão `seed` anterior continuaria ancorando ao lado da local —
  -- uma delas dizendo justamente o que o administrador corrigiu.
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
  )
  select t.chunk_id, t.layer, t.material_id, t.content, t.similarity, t.source_ref
    from tudo t
   where t.layer = 'tenant'
      or not exists (
        select 1 from tudo x
         where x.layer = 'tenant'
           and x.balde = t.balde
      )
   order by t.similarity desc
   limit greatest(p_k, 0);
$$;

comment on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real) is
  'Migrations 0119 + 0120 (spec 002): busca de lastro nas duas camadas. Tenant e acervo '
  'derivados de p_agent_id, nunca do chamador (FR-019). Escopo desconhecido ou desligado '
  'devolve só "vale para todos" (FR-017, trava 4). Material vencido não ancora (FR-026). '
  'Precedência de camada dentro do balde (research D7). No catálogo, por slug ancora só a '
  'MAIOR versão não-inerte — é o que faz a edição local vencer a semeada (FR-037).';

revoke execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real) from public, anon, authenticated;
grant  execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real) to service_role;

notify pgrst, 'reload schema';
