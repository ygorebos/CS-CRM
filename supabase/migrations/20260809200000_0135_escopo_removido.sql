-- 0135 — remover a operadora, sem apagar o acervo nem promovê-lo a "vale para todos"
--
-- Spec 002 (RAG por operadora), T099 — a metade de FR-008 que faltava: "remover ou
-- desativar uma operadora DEVE tornar o material dela inerte para respostas novas
-- IMEDIATAMENTE, preservando a rastreabilidade das respostas já dadas".
--
-- ═══ POR QUE NÃO É UM `DELETE` DE VERDADE ═══
--
-- Foi essa a primeira implementação, e ela NÃO RODA. Medido em 2026-08-09, num Postgres
-- descartável: `delete from knowledge_scopes` onde existe material daquele balde ergue
--
--     new row for relation "ai_knowledge_sources" violates check constraint
--     "ai_knowledge_sources_scope_xor_all"
--
-- porque a FK é `on delete set null` e a constraint da 0118 exige
-- `(applies_to_all and scope_id is null) or (not applies_to_all and scope_id is not null)`.
-- Escopo apagado deixaria a fonte com `scope_id` nulo e `applies_to_all = false` — estado
-- que a própria 0118 declarou impossível, e com razão: fonte sem balde não é alcançável
-- por busca nenhuma nem visível em tela nenhuma.
--
-- As saídas que existiam, e por que nenhuma serve:
--
--   · **`applies_to_all = true` ao soltar o ponteiro.** O material da operadora REMOVIDA
--     passaria a responder a todo mundo, sobre tudo. É o oposto exato de FR-008, e não
--     aparece em tela: some da lista e volta na resposta.
--   · **FK para `cascade`.** Apagaria o acervo do corretor junto com o rótulo. Destrutivo,
--     irreversível, e numa instância única não há de onde restaurar.
--   · **Recusar remoção enquanto houver material.** Honesto, mas deixa FR-008 pela metade:
--     o escopo criado por engano, já com material dentro, fica na lista para sempre.
--
-- ═══ O QUE ESTA MIGRATION FAZ ═══
--
-- `deleted_at`. O escopo sai da lista do corretor e para de resolver na busca; o material
-- continua no banco, arquivado, e o ponteiro dele continua válido — a constraint segue
-- satisfeita porque `scope_id` nunca fica nulo. A rastreabilidade das respostas já dadas
-- não depende disto: `message_groundings` não tem FK para escopo e carrega a cópia
-- congelada da origem.
--
-- A inércia tem DUAS causas independentes de propósito. A rota escreve `is_active = false`
-- junto, e a CTE `escopo_ativo` passa a exigir `deleted_at is null` também: reativar por
-- fora (`update ... set is_active = true`) não ressuscita escopo removido. Uma trava só
-- seria uma linha de UPDATE entre o corretor e o material que ele acha que apagou.

alter table public.knowledge_scopes
  add column if not exists deleted_at timestamptz;

comment on column public.knowledge_scopes.deleted_at is
  'Remoção lógica do escopo próprio (spec 002, T099 / FR-008). Preenchido = fora da lista '
  'do corretor e sem resolver na busca. Não é `delete` porque a FK para '
  'ai_knowledge_sources é `on delete set null` e a constraint scope_xor_all recusa fonte '
  'sem balde — apagar de verdade deixaria o acervo inalcançável ou o promoveria a "vale '
  'para todos". Espelho do catálogo NUNCA é removido por aqui: a sincronização o recria.';

-- A leitura quente é "os escopos vivos desta organização". O índice antigo
-- (organization_id, is_active) continua servindo a busca; este serve a lista.
create index if not exists knowledge_scopes_org_vivos_idx
  on public.knowledge_scopes (organization_id, created_at)
  where deleted_at is null;

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
       and ks.deleted_at is null
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
  'Migrations 0123 + 0124 + 0125 + 0133 + 0135 (spec 002): busca de lastro nas duas camadas. Tenant '
  'e acervo derivados de p_agent_id, nunca do chamador (FR-019). Escopo desconhecido ou '
  'desligado devolve só "vale para todos" (FR-017, trava 4). Material vencido não ancora '
  '(FR-026). Precedência dentro do balde (research D7). No catálogo, por slug ancora só a '
  'MAIOR versão não-inerte (FR-037). p_incluir_preteridos=true acrescenta as linhas que o '
  'desempate rejeitou, marcadas — elas NUNCA ancoram resposta (FR-035). Na camada do tenant, '
  'source_ref carrega a âncora DENTRO do documento (section_title, page_number) quando o '
  'formato a informa — é o que FR-022 pede: chegar ao trecho, não ao manual inteiro. Escopo '
  'REMOVIDO (deleted_at preenchido) não resolve, mesmo que alguém reative is_active (0135).';

-- `create or replace` preserva os grants, mas repetir é barato e protege contra a ordem em
-- que os apêndices do baseline são aplicados num banco novo (doutrina de migrations, item 9).
revoke execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) from public, anon, authenticated;
grant  execute on function public.fn_buscar_lastro(uuid, uuid, public.vector, integer, real, boolean) to service_role;

notify pgrst, 'reload schema';
