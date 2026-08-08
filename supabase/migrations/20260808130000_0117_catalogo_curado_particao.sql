-- 0117 — a partição curada do catálogo (`catalog_*`)
--
-- Spec 002 (RAG por operadora), fatia F2. Tarefas T042 e T043.
--
-- ═══ A DIVISÃO QUE ESTA MIGRATION CRIA ═══
--
-- Toda tabela deste repositório é tenant-aware: tem `organization_id not null` e RLS por
-- `fn_user_org_ids()`. Estas três NÃO têm — e isso não é esquecimento, é o Princípio X
-- (catálogo curado + sete travas). O conteúdo aqui é do FABRICANTE, compartilhado por
-- todas as organizações da instalação: procedimento de operadora não pertence a um
-- corretor, e duplicá-lo por tenant significaria corrigir o mesmo erro N vezes.
--
-- A ausência de `organization_id` é, por si só, a **trava 2**: não existe coluna onde
-- guardar dado de cliente ou identificador de organização. O invariante
-- `tests/invariants/catalogo-sem-dado-de-ninguem.test.ts` (T035) varre a partição e cobra
-- isso; o schema já torna a violação difícil de escrever por acidente.
--
-- A **trava 1** é a RLS abaixo: leitura para qualquer sessão autenticada, escrita apenas
-- com `fn_is_platform_admin()`. `admin` de organização é papel DENTRO do tenant e não
-- alcança o catálogo por nenhum caminho — nem pela tela, nem pelo PostgREST.
--
-- ═══ POR QUE `applies_to_all` É COLUNA, E NÃO UM ESCOPO FICTÍCIO "TODOS" ═══
--
-- Um escopo fictício apareceria na lista do corretor e no seletor do contato, e alguém
-- acabaria vinculando um cliente a ele — um vínculo que não quer dizer nada. Coluna
-- booleana não tem esse caminho. O CHECK garante que exatamente um dos dois está
-- preenchido (FR-001).
--
-- ═══ POR QUE `unique (slug, version)` ═══
--
-- É a chave que a semeadura usa. O bloco de seed do `baseline.sql` insere com
-- `on conflict (slug, version) do nothing` — NUNCA `do update` (trava 6, contrato
-- `semeadura-do-catalogo.md`). Sem esse par único, o `on conflict` não teria em que se
-- apoiar e o `update.sh` de um clone ou duplicaria material ou sobrescreveria correção
-- local. É a diferença entre "atualizar acrescenta" e "atualizar apaga".
--
-- Material curado nunca é reescrito: editar cria `version + 1`. A linha anterior
-- permanece, e é isso que torna SC-018 mensurável (zero edições sobrescritas).

-- ── 1 · escopos, como o fabricante os mantém ────────────────────────────────
create table if not exists public.catalog_scopes (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  -- Registro oficial (ANS, no nicho de saúde). Chave estável para uma importação
  -- futura (A-12). SEM FK e sem leitura de banco externo: o dia em que alguém quiser
  -- cruzar com a base da ANS, cruza por este código — não por nome, que muda.
  official_code text,
  -- Desativação GLOBAL, do fabricante. Não confundir com a do tenant, que vive em
  -- `knowledge_scopes.is_active` (migration 0118) e é a trava 4.
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.catalog_scopes is
  'Migration 0117 (spec 002, F2): escopo de conhecimento curado pelo fabricante, '
  'compartilhado por todas as organizações. SEM organization_id de propósito — '
  'Princípio X, travas 1 e 2.';

-- ── 2 · materiais: versionados, nunca reescritos ────────────────────────────
create table if not exists public.catalog_materials (
  id               uuid primary key default gen_random_uuid(),
  catalog_scope_id uuid references public.catalog_scopes(id) on delete restrict,
  applies_to_all   boolean not null default false,
  slug             text not null,
  version          integer not null,
  title            text not null,
  body             text not null,
  -- Validade opcional (FR-025). Nulo = não vence. Material vencido não ancora
  -- resposta — o corte vive em `fn_buscar_lastro` (migration 0123).
  valid_until      date,
  -- A "recência" do desempate de FR-035.
  published_at     timestamptz not null default now(),
  -- `seed` veio da semeadura; `local` foi escrito pelo administrador desta
  -- instalação. Separar os dois é o que permite provar SC-018: a semeadura só pode
  -- tocar em linha `seed`.
  origin           text not null default 'seed',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint catalog_materials_origin_check
    check (origin in ('seed', 'local')),
  -- Exatamente um dos dois (FR-001): ou o material vale para um escopo, ou vale
  -- para todos. Nunca ambos, nunca nenhum.
  constraint catalog_materials_scope_xor_all
    check (
      (applies_to_all and catalog_scope_id is null)
      or (not applies_to_all and catalog_scope_id is not null)
    ),
  constraint catalog_materials_version_positive
    check (version >= 1)
);

-- O par que a semeadura usa no `on conflict do nothing`. Como índice único nomeado
-- (e não constraint inline) para poder ser criado com `if not exists` — o apêndice do
-- baseline re-roda em banco que já o tem.
create unique index if not exists catalog_materials_slug_version_key
  on public.catalog_materials (slug, version);

create index if not exists catalog_materials_scope_idx
  on public.catalog_materials (catalog_scope_id) where catalog_scope_id is not null;

create index if not exists catalog_materials_applies_to_all_idx
  on public.catalog_materials (applies_to_all) where applies_to_all;

comment on table public.catalog_materials is
  'Migration 0117 (spec 002, F2): material curado, versionado e NUNCA reescrito — '
  'editar cria version+1 (trava 6, FR-037). unique (slug, version) é a chave do '
  'on conflict do nothing da semeadura.';

-- ── 3 · trechos: o que a busca de lastro recupera ───────────────────────────
create table if not exists public.catalog_chunks (
  id                  uuid primary key default gen_random_uuid(),
  catalog_material_id uuid not null references public.catalog_materials(id) on delete cascade,
  -- DUPLICAÇÃO DECLARADA. Source of truth é `catalog_materials`; o trecho carrega
  -- cópia porque a busca filtra por escopo ANTES de qualquer join, e porque a spec
  -- exige que a restrição seja verificável no PRÓPRIO trecho, não por associação.
  -- Mantida pelo trigger abaixo — não por cron (anti-pattern nº 5).
  catalog_scope_id    uuid references public.catalog_scopes(id) on delete restrict,
  applies_to_all      boolean not null default false,
  position            integer not null,
  content             text not null,
  content_hash        text not null,
  token_count         integer not null,
  -- Pré-computado na semeadura e embutido como literal no `baseline.sql` (research
  -- D6): instalação fresca não tem chave de IA, e um catálogo que só ficasse
  -- buscável depois de o corretor configurar provider não seria "nascer sabendo".
  embedding           public.vector(1536) not null,
  -- Permite re-embeddar SÓ quando o modelo configurado difere deste.
  embedding_model     text not null,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists catalog_chunks_material_idx
  on public.catalog_chunks (catalog_material_id);

create index if not exists catalog_chunks_scope_idx
  on public.catalog_chunks (catalog_scope_id) where catalog_scope_id is not null;

create index if not exists catalog_chunks_applies_to_all_idx
  on public.catalog_chunks (applies_to_all) where applies_to_all;

create index if not exists catalog_chunks_embedding_ivfflat_idx
  on public.catalog_chunks using ivfflat (embedding public.vector_cosine_ops)
  with (lists = 100);

comment on table public.catalog_chunks is
  'Migration 0117 (spec 002, F2): trecho recuperável do catálogo. catalog_scope_id e '
  'applies_to_all são cópia denormalizada do material (source of truth), mantida por '
  'trigger, para a busca filtrar escopo sem join.';

-- ── 4 · a cópia denormalizada é mantida por trigger, não por cron ───────────
--
-- Anti-pattern nº 5 do CLAUDE.md: campo sincronizado por cron quando devia ser
-- trigger. O escopo do trecho é derivado do material — ele nunca é informado pelo
-- indexador nem pela semeadura, e sobrescrevê-lo aqui elimina a classe inteira de bug
-- "trecho com escopo diferente do material dele", que a busca não teria como detectar
-- (ela filtra pelo trecho, justamente para não fazer join).
create or replace function public.fn_sincronizar_escopo_do_trecho_do_catalogo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  select m.catalog_scope_id, m.applies_to_all
    into new.catalog_scope_id, new.applies_to_all
    from public.catalog_materials m
   where m.id = new.catalog_material_id;
  return new;
end $$;

-- As TRÊS origens de EXECUTE (CLAUDE.md, doutrina de migrations item 9):
--   `public`        — o grant que o Postgres dá a toda função ao criá-la;
--   `anon`          — o ALTER DEFAULT PRIVILEGES do baseline, que alcança toda função
--                     criada DEPOIS dele, isto é, todo apêndice novo;
--   `authenticated` — idem, e é o que a varredura de hardening cobra.
-- Revogar as três é seguro aqui porque o único call site é o TRIGGER, e o Postgres não
-- exige EXECUTE do usuário para invocar função de trigger.
revoke execute on function public.fn_sincronizar_escopo_do_trecho_do_catalogo() from public, anon, authenticated;
grant  execute on function public.fn_sincronizar_escopo_do_trecho_do_catalogo() to service_role;

drop trigger if exists trg_catalog_chunks_escopo on public.catalog_chunks;
create trigger trg_catalog_chunks_escopo
  before insert or update of catalog_material_id on public.catalog_chunks
  for each row execute function public.fn_sincronizar_escopo_do_trecho_do_catalogo();

-- Quando o MATERIAL muda de escopo, os trechos dele acompanham. Sem este lado, a cópia
-- ficaria correta no insert e mentirosa depois da primeira correção de curadoria.
create or replace function public.fn_propagar_escopo_do_material_do_catalogo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.catalog_chunks
     set catalog_scope_id = new.catalog_scope_id,
         applies_to_all   = new.applies_to_all
   where catalog_material_id = new.id
     and (catalog_scope_id is distinct from new.catalog_scope_id
          or applies_to_all is distinct from new.applies_to_all);
  return new;
end $$;

revoke execute on function public.fn_propagar_escopo_do_material_do_catalogo() from public, anon, authenticated;
grant  execute on function public.fn_propagar_escopo_do_material_do_catalogo() to service_role;

drop trigger if exists trg_catalog_materials_propaga_escopo on public.catalog_materials;
create trigger trg_catalog_materials_propaga_escopo
  after update of catalog_scope_id, applies_to_all on public.catalog_materials
  for each row execute function public.fn_propagar_escopo_do_material_do_catalogo();

-- `updated_at` pelo helper que o repositório já usa.
drop trigger if exists catalog_scopes_updated_at on public.catalog_scopes;
create trigger catalog_scopes_updated_at
  before update on public.catalog_scopes
  for each row execute function public.fn_set_updated_at();

drop trigger if exists catalog_materials_updated_at on public.catalog_materials;
create trigger catalog_materials_updated_at
  before update on public.catalog_materials
  for each row execute function public.fn_set_updated_at();

-- ── 5 · TRAVA 1 — quem lê e quem escreve ────────────────────────────────────
--
-- O `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon` do baseline alcança toda
-- tabela criada depois dele, inclusive estas. A RLS abaixo já barra `anon` (nenhuma
-- policy o contempla), mas o revoke explícito é a segunda tranca: privilégio que não
-- existe não depende de policy escrita certa.
revoke all on table public.catalog_scopes    from anon;
revoke all on table public.catalog_materials from anon;
revoke all on table public.catalog_chunks    from anon;

alter table public.catalog_scopes    enable row level security;
alter table public.catalog_materials enable row level security;
alter table public.catalog_chunks    enable row level security;

-- Leitura: qualquer sessão autenticada, de qualquer organização. É o ponto do
-- catálogo — conteúdo do fabricante é o mesmo para todo mundo.
drop policy if exists catalog_scopes_read_authenticated on public.catalog_scopes;
create policy catalog_scopes_read_authenticated on public.catalog_scopes
  for select to authenticated using (true);

drop policy if exists catalog_materials_read_authenticated on public.catalog_materials;
create policy catalog_materials_read_authenticated on public.catalog_materials
  for select to authenticated using (true);

drop policy if exists catalog_chunks_read_authenticated on public.catalog_chunks;
create policy catalog_chunks_read_authenticated on public.catalog_chunks
  for select to authenticated using (true);

-- Escrita: SÓ administrador de plataforma. `admin` de organização é papel dentro do
-- tenant e não alcança o catálogo por caminho nenhum — é a trava 1, e o invariante
-- T034 (`catalogo-escrita-so-plataforma.test.ts`) a exercita por todos os caminhos.
--
-- Uma policy por comando, em vez de um `for all`: um `for all` cujo USING fosse
-- `fn_is_platform_admin()` também governaria o SELECT e fecharia a leitura para o
-- corretor, que é o oposto do que o catálogo existe para fazer.
drop policy if exists catalog_scopes_write_platform_admin_insert on public.catalog_scopes;
create policy catalog_scopes_write_platform_admin_insert on public.catalog_scopes
  for insert to authenticated with check (public.fn_is_platform_admin());

drop policy if exists catalog_scopes_write_platform_admin_update on public.catalog_scopes;
create policy catalog_scopes_write_platform_admin_update on public.catalog_scopes
  for update to authenticated
  using (public.fn_is_platform_admin()) with check (public.fn_is_platform_admin());

drop policy if exists catalog_scopes_write_platform_admin_delete on public.catalog_scopes;
create policy catalog_scopes_write_platform_admin_delete on public.catalog_scopes
  for delete to authenticated using (public.fn_is_platform_admin());

drop policy if exists catalog_materials_write_platform_admin_insert on public.catalog_materials;
create policy catalog_materials_write_platform_admin_insert on public.catalog_materials
  for insert to authenticated with check (public.fn_is_platform_admin());

drop policy if exists catalog_materials_write_platform_admin_update on public.catalog_materials;
create policy catalog_materials_write_platform_admin_update on public.catalog_materials
  for update to authenticated
  using (public.fn_is_platform_admin()) with check (public.fn_is_platform_admin());

drop policy if exists catalog_materials_write_platform_admin_delete on public.catalog_materials;
create policy catalog_materials_write_platform_admin_delete on public.catalog_materials
  for delete to authenticated using (public.fn_is_platform_admin());

drop policy if exists catalog_chunks_write_platform_admin_insert on public.catalog_chunks;
create policy catalog_chunks_write_platform_admin_insert on public.catalog_chunks
  for insert to authenticated with check (public.fn_is_platform_admin());

drop policy if exists catalog_chunks_write_platform_admin_update on public.catalog_chunks;
create policy catalog_chunks_write_platform_admin_update on public.catalog_chunks
  for update to authenticated
  using (public.fn_is_platform_admin()) with check (public.fn_is_platform_admin());

drop policy if exists catalog_chunks_write_platform_admin_delete on public.catalog_chunks;
create policy catalog_chunks_write_platform_admin_delete on public.catalog_chunks
  for delete to authenticated using (public.fn_is_platform_admin());

notify pgrst, 'reload schema';
