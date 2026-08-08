-- 0128 — a âncora do documento chega ao corretor
--
-- Spec 002 (RAG por operadora), fatia F4. Forward-fix de `fn_buscar_lastro` (0123 + 0124 +
-- 0125), fechando a ponta solta que a T083/T084 deixou.
--
-- ═══ O DEFEITO ═══
--
-- A T083 passou a gravar `section_title` (e `page_number`, quando o formato diz) no
-- `metadata` do trecho — é o que faz a citação virar *"seu manual, Carências"* em vez de
-- *"trecho 47"*, e é literalmente o que FR-022 pede: o corretor **chega ao trecho**.
--
-- Só que `fn_buscar_lastro` monta `source_ref` a partir da linha da FONTE (`title`,
-- `scope`, `updated_at`, `source_type`) e nunca olha `ai_chunks.metadata`. Resultado: o
-- dado está gravado, correto, e **invisível** — o painel de citação mostra o título do
-- manual inteiro, e o corretor abre um PDF de oitenta páginas para conferir uma frase.
--
-- Gravado-e-invisível é pior que ausente: parece feito. O teste do ingest fica verde
-- provando a gravação, e o requisito continua descumprido do lado de quem usa.
--
-- ═══ POR QUE SÓ A CAMADA DO TENANT ═══
--
-- `catalog_chunks` não tem a coluna: o catálogo curado é escrito pela plataforma, material
-- a material, e não passa pelo ingest de documento. Inventar as chaves lá seria devolver
-- `null` com cara de campo.
--
-- ═══ `jsonb_strip_nulls`, e por que ele importa aqui ═══
--
-- `page_number` é nulo em todo PDF hoje (o extrator concatena as páginas numa string só, e
-- recuperar a fronteira depois seria adivinhação). Sem o `strip`, toda citação carregaria
-- `"page_number": null` e a tela teria de decidir se aquilo significa "página 1", "sem
-- página" ou "não medido". Chave ausente não tem essa ambiguidade.

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
  preterido              boolean,
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
      -- `strip_nulls` porque chave ausente e chave nula dizem coisas diferentes na tela:
      -- a primeira é "este formato não informa", a segunda vira "informou nada".
      jsonb_strip_nulls(jsonb_build_object(
        'layer',       'tenant',
        'title',       s.name,
        'scope',       ks.display_name,
        'updated_at',  s.updated_at,
        'source_type', s.source_type,
        -- A âncora DENTRO do documento (T083 · FR-022). Sem estas duas, o corretor recebe
        -- o nome do manual inteiro e vai procurar a frase à mão.
        'section_title', c.metadata->>'section_title',
        'page_number',   c.metadata->>'page_number'
      ))                                              as source_ref
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
  vencedor_por_balde as (
    select distinct on (t.balde) t.balde, t.material_id
      from tudo t
     where t.layer = 'tenant'
     order by t.balde, t.similarity desc
  ),
  marcado as (
    select
      t.*,
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
  'Migrations 0123 + 0124 + 0125 + 0128 (spec 002): busca de lastro nas duas camadas. Tenant '
  'e acervo derivados de p_agent_id, nunca do chamador (FR-019). Escopo desconhecido ou '
  'desligado devolve só "vale para todos" (FR-017, trava 4). Material vencido não ancora '
  '(FR-026). Precedência dentro do balde (research D7). No catálogo, por slug ancora só a '
  'MAIOR versão não-inerte (FR-037). p_incluir_preteridos=true acrescenta as linhas que o '
  'desempate rejeitou, marcadas — elas NUNCA ancoram resposta (FR-035). Na camada do tenant, '
  'source_ref carrega a âncora DENTRO do documento (section_title, page_number) quando o '
  'formato a informa — é o que FR-022 pede: chegar ao trecho, não ao manual inteiro.';

-- `create or replace` preserva os grants, mas repetir é barato e protege contra a ordem em
-- que os apêndices do baseline são aplicados num banco novo (doutrina de migrations, item 9).
revoke execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) from public, anon, authenticated;
grant  execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) to service_role;

notify pgrst, 'reload schema';
