-- 0118 — escopos como o TENANT os vê, o vínculo do contato, e o eixo de escopo no
--        acervo que já existe
--
-- Spec 002 (RAG por operadora), fatia F2. Tarefas T044, T132 e a parte de T045 que cabe
-- aqui.
--
-- ═══ POR QUE O EIXO DO ACERVO EXISTENTE ESTÁ NESTA MIGRATION, E NÃO NA DA F4 ═══
--
-- Ele estava planejado para a migration da fatia F4, duas à frente. A revisão
-- cruzada de 2026-08-08 achou o defeito: `fn_buscar_lastro` (migration 0123, a PRÓXIMA)
-- lê `ai_knowledge_sources.scope_id`, `ai_chunks.scope_id` e `applies_to_all`. Criar a
-- função antes das colunas faria uma de duas coisas, ambas ruins — ou a função não cria
-- (a cadeia para no meio), ou ela cria filtrando só o lado do catálogo e o acervo do
-- corretor entra inteiro, sem eixo nenhum. O segundo caso é o pior: passa verde.
--
-- ═══ AS DUAS CAMADAS, E POR QUE O ESPELHO EXISTE ═══
--
-- `catalog_scopes` (migration 0117) é o escopo do FABRICANTE. `knowledge_scopes` é o
-- escopo COMO AQUELE TENANT O VÊ — e todo escopo visível a um corretor tem linha aqui,
-- inclusive os que vieram do catálogo. Isso custa uma tabela e paga duas coisas que não
-- teriam onde morar: o corretor renomear um escopo sem tocar no catálogo, e a **trava 4**
-- (desligar um escopo torna o material dele inerte só para este tenant, FR-008).
--
-- `knowledge_scopes.catalog_scope_id` é o ÚNICO ponto de contato entre as camadas. Ele
-- existe justamente para que nenhum outro precise existir.
--
-- ═══ A-20: ESPELHO DO CATÁLOGO NASCE DESLIGADO ═══
--
-- Decisão do usuário em 2026-08-08: "todos inativos, ele liga o que vende". Um corretor
-- que vende duas operadoras não quer o agente respondendo sobre quinze. Aqui isso é
-- trigger, não convenção — ver o bloco 2.

-- ── 1 · knowledge_scopes: o escopo como o tenant o vê ───────────────────────
create table if not exists public.knowledge_scopes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- Preenchido = espelho do catálogo. Nulo = criado pelo corretor (FR-002).
  catalog_scope_id uuid references public.catalog_scopes(id) on delete cascade,
  display_name     text not null,
  official_code    text,
  -- A TRAVA 4. Desligar torna o material daquele escopo inerte só para este tenant
  -- (FR-008). Default `true` serve o escopo que o corretor acabou de digitar; o
  -- espelho do catálogo é forçado a `false` pelo trigger do bloco 2 (A-20).
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Um espelho por escopo de catálogo por tenant. É este índice que torna
-- `fn_sincronizar_escopos_do_catalogo` idempotente — sem ele, cada `update.sh` de
-- clone criaria uma cópia nova de cada escopo curado.
create unique index if not exists knowledge_scopes_org_catalog_scope_key
  on public.knowledge_scopes (organization_id, catalog_scope_id)
  where catalog_scope_id is not null;

create index if not exists knowledge_scopes_org_active_idx
  on public.knowledge_scopes (organization_id, is_active);

comment on table public.knowledge_scopes is
  'Migration 0118 (spec 002, F2): escopo de conhecimento como AQUELE tenant o vê. '
  'catalog_scope_id preenchido = espelho do catálogo curado (nasce desligado, A-20); '
  'nulo = criado pelo corretor. is_active é a trava 4 (FR-008).';

drop trigger if exists knowledge_scopes_updated_at on public.knowledge_scopes;
create trigger knowledge_scopes_updated_at
  before update on public.knowledge_scopes
  for each row execute function public.fn_set_updated_at();

alter table public.knowledge_scopes enable row level security;

drop policy if exists tenant_isolation_knowledge_scopes_all on public.knowledge_scopes;
create policy tenant_isolation_knowledge_scopes_all on public.knowledge_scopes
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

-- ── 2 · A-20 como trava, não como convenção ─────────────────────────────────
--
-- "Espelho do catálogo nasce desligado" podia ser só o `false` que a função de
-- sincronização escreve. Não é: o `insert` da função é um caminho, e a rota de
-- curadoria, o onboarding e qualquer script futuro são outros. Convenção que precisa
-- ser lembrada em N lugares é convenção que um deles esquece — e o sintoma seria o
-- oposto do que o usuário pediu (agente falando de operadora que o corretor não vende),
-- num caminho que nenhum teste de linha detecta.
--
-- Só no INSERT: ligar o escopo é UPDATE, e é exatamente o passo que SC-011 cronometra.
create or replace function public.fn_espelho_de_catalogo_nasce_desligado()
returns trigger
language plpgsql
as $$
begin
  if new.catalog_scope_id is not null then
    new.is_active := false;
  end if;
  return new;
end $$;

revoke execute on function public.fn_espelho_de_catalogo_nasce_desligado() from public, anon, authenticated;
grant  execute on function public.fn_espelho_de_catalogo_nasce_desligado() to service_role;

drop trigger if exists trg_knowledge_scopes_espelho_desligado on public.knowledge_scopes;
create trigger trg_knowledge_scopes_espelho_desligado
  before insert on public.knowledge_scopes
  for each row execute function public.fn_espelho_de_catalogo_nasce_desligado();

-- ── 3 · o vínculo do contato ────────────────────────────────────────────────
--
-- FK, nunca texto (anti-pattern nº 1). Nulo em qualquer uma das três = escopo
-- desconhecido, que é ESTADO TRATADO, não erro: o agente pergunta uma única vez, em
-- linguagem natural (FR-017, A-05).
alter table public.contacts
  add column if not exists knowledge_scope_id uuid references public.knowledge_scopes(id) on delete set null;

-- `cadastro` vence `conversa` (FR-017). É esta coluna que torna a precedência
-- VERIFICÁVEL em vez de convencionada — sem ela, "o cadastro tem prioridade" seria uma
-- frase no doc e um `if` que alguém inverte.
alter table public.contacts
  add column if not exists knowledge_scope_source text;

alter table public.contacts
  add column if not exists knowledge_scope_confirmed_at timestamptz;

alter table public.contacts
  drop constraint if exists contacts_knowledge_scope_source_check;

alter table public.contacts
  add constraint contacts_knowledge_scope_source_check
    check (knowledge_scope_source is null or knowledge_scope_source in ('cadastro', 'conversa'));

create index if not exists contacts_knowledge_scope_idx
  on public.contacts (organization_id, knowledge_scope_id)
  where knowledge_scope_id is not null;

-- ── 4 · T132 · o eixo de escopo no acervo QUE JÁ EXISTE ─────────────────────
--
-- Sem isto, `fn_buscar_lastro` (0123) filtra o catálogo por escopo e deixa o acervo do
-- corretor passar inteiro — o vazamento entre operadoras aconteceria justamente na
-- camada que tem precedência.
alter table public.ai_knowledge_sources
  add column if not exists scope_id uuid references public.knowledge_scopes(id) on delete set null;

alter table public.ai_knowledge_sources
  add column if not exists applies_to_all boolean not null default false;

-- Validade opcional (FR-025). Nulo = não vence.
alter table public.ai_knowledge_sources
  add column if not exists valid_until date;

-- BACKFILL ANTES DO CHECK (doutrina de migrations, item 8). As linhas que já existem
-- em qualquer clone nasceram sem eixo nenhum: são um acervo único, que vale para
-- qualquer cliente. `applies_to_all = true` é o que mais se aproxima do que elas SÃO
-- hoje, e não perde conteúdo de instalação nenhuma.
--
-- A condição é auto-curativa de propósito: `scope_id is null and not applies_to_all` é
-- exatamente o estado que o CHECK abaixo proíbe. Re-aplicar em clone já correto não
-- toca em linha alguma; re-aplicar em clone que ficou meio-migrado conserta.
update public.ai_knowledge_sources
   set applies_to_all = true
 where scope_id is null
   and applies_to_all = false;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_scope_xor_all;

alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_scope_xor_all
    check (
      (applies_to_all and scope_id is null)
      or (not applies_to_all and scope_id is not null)
    );

create index if not exists ai_knowledge_sources_scope_idx
  on public.ai_knowledge_sources (organization_id, scope_id)
  where scope_id is not null;

-- ── 5 · T132 · o índice que tornava a segunda operadora impossível ──────────
--
-- `ai_knowledge_sources_unique_per_agent` é UNIQUE (agent_id, source_type) WHERE
-- is_active. Com ele, um agente tem no máximo UMA fonte ativa de cada tipo — o corretor
-- que carrega o manual da segunda operadora recebe violação de unicidade, e a feature
-- inteira é impossível por índice.
--
-- ⚠️ O `drop index` precisa existir TAMBÉM no apêndice do `baseline.sql` (brecha 10). O
-- snapshot recria esse índice em toda instalação NOVA, e o apêndice roda depois dele.
-- Sem o drop lá, instalação fresca nasceria com o índice e clone atualizado não — duas
-- realidades saindo do mesmo arquivo, que é o pior defeito que este projeto pode ter.
drop index if exists public.ai_knowledge_sources_unique_per_agent;

-- ── 6 · T132 · o eixo no trecho, pela mesma razão do catálogo ───────────────
--
-- A busca filtra por escopo ANTES de qualquer join. Cópia denormalizada da fonte, com
-- source of truth declarado (`ai_knowledge_sources`) e mantida por trigger — não por
-- cron (anti-pattern nº 5). `organization_id` continua `not null`: nada aqui muda de
-- lado, o Princípio I vale inteiro nesta camada.
alter table public.ai_chunks
  add column if not exists scope_id uuid references public.knowledge_scopes(id) on delete set null;

alter table public.ai_chunks
  add column if not exists applies_to_all boolean not null default false;

update public.ai_chunks c
   set applies_to_all = s.applies_to_all,
       scope_id       = s.scope_id
  from public.ai_knowledge_sources s
 where s.id = c.knowledge_source_id
   and (c.scope_id is distinct from s.scope_id
        or c.applies_to_all is distinct from s.applies_to_all);

create index if not exists ai_chunks_org_scope_idx
  on public.ai_chunks (organization_id, scope_id)
  where scope_id is not null;

create or replace function public.fn_sincronizar_escopo_do_trecho()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  select s.scope_id, s.applies_to_all
    into new.scope_id, new.applies_to_all
    from public.ai_knowledge_sources s
   where s.id = new.knowledge_source_id;
  return new;
end $$;

revoke execute on function public.fn_sincronizar_escopo_do_trecho() from public, anon, authenticated;
grant  execute on function public.fn_sincronizar_escopo_do_trecho() to service_role;

drop trigger if exists trg_ai_chunks_escopo on public.ai_chunks;
create trigger trg_ai_chunks_escopo
  before insert or update of knowledge_source_id on public.ai_chunks
  for each row execute function public.fn_sincronizar_escopo_do_trecho();

create or replace function public.fn_propagar_escopo_da_fonte()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.ai_chunks
     set scope_id       = new.scope_id,
         applies_to_all = new.applies_to_all
   where knowledge_source_id = new.id
     and (scope_id is distinct from new.scope_id
          or applies_to_all is distinct from new.applies_to_all);
  return new;
end $$;

revoke execute on function public.fn_propagar_escopo_da_fonte() from public, anon, authenticated;
grant  execute on function public.fn_propagar_escopo_da_fonte() to service_role;

drop trigger if exists trg_ai_knowledge_sources_propaga_escopo on public.ai_knowledge_sources;
create trigger trg_ai_knowledge_sources_propaga_escopo
  after update of scope_id, applies_to_all on public.ai_knowledge_sources
  for each row execute function public.fn_propagar_escopo_da_fonte();

-- ── 7 · a materialização dos espelhos ───────────────────────────────────────
--
-- Idempotente e SEM HTTP (Princípio V — trigger/função de banco nunca espera rede).
-- Chamada em dois lugares, e são os dois que importam:
--   (a) na criação da organização — tenant novo em instalação ANTIGA nasce enxergando
--       o catálogo;
--   (b) no fim do bloco de semeadura do `baseline.sql`, para toda organização
--       existente — é o que faz escopo curado NOVO alcançar clone antigo no `update.sh`.
-- Sem (b), a semeadura escreveria no catálogo e nenhum corretor veria diferença: um
-- evento sem consumidor (anti-pattern nº 3), com o agravante de parecer que funcionou.
--
-- Devolve quantos espelhos foram criados, para o chamador poder registrar.
create or replace function public.fn_sincronizar_escopos_do_catalogo(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_criados integer;
begin
  insert into public.knowledge_scopes (organization_id, catalog_scope_id, display_name, official_code)
  select p_organization_id, cs.id, cs.display_name, cs.official_code
    from public.catalog_scopes cs
   where cs.is_active
     and not exists (
       select 1 from public.knowledge_scopes ks
        where ks.organization_id = p_organization_id
          and ks.catalog_scope_id = cs.id
     );

  get diagnostics v_criados = row_count;
  return v_criados;
end $$;

-- `is_active` NÃO é passado no insert acima de propósito: o trigger do bloco 2 o força
-- a `false`. Passá-lo aqui daria a impressão de que este é o lugar que decide, e o
-- próximo chamador copiaria o insert sem o trigger em mente.

revoke execute on function public.fn_sincronizar_escopos_do_catalogo(uuid) from public, anon, authenticated;
grant  execute on function public.fn_sincronizar_escopos_do_catalogo(uuid) to service_role;

comment on function public.fn_sincronizar_escopos_do_catalogo(uuid) is
  'Migration 0118 (spec 002, F2): materializa em knowledge_scopes um espelho DESLIGADO '
  '(A-20) de cada catalog_scope ativo que a organização ainda não tem. Idempotente, sem '
  'HTTP. Chamada na criação da org e no fim da semeadura do baseline, para toda org '
  'existente — é o que faz escopo curado novo alcançar clone antigo.';

notify pgrst, 'reload schema';
