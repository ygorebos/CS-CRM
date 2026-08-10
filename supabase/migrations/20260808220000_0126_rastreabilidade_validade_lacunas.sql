-- 0126 — a âncora vira registro permanente, e a recusa passa a dizer de onde veio
--
-- Spec 002 (RAG por operadora), fatia F5. Tarefas T104 e T111.
--
-- ═══ PARTE 1 · `message_groundings` (T104, FR-021 e FR-023) ═══
--
-- Hoje a âncora vive dentro de `messages.metadata.citations`, gravada pela T026. Isso já
-- cumpre FR-022 e FR-039 — a tela mostra a origem, e a cópia histórica viaja junto com a
-- mensagem, então sobrevive à reindexação. O que `metadata` **não** dá:
--
--   · consultar âncora sem varrer mensagem ("que material ancorou respostas este mês?");
--   · restringir por camada ou material num `where` que use índice;
--   · garantir por SCHEMA que o campo existe — `jsonb` não tem `not null` por chave, e
--     uma resposta gravada sem citação hoje é indistinguível de uma que nunca teve.
--
-- FR-021 pede que a âncora seja **registro permanente, não campo de conveniência**. É a
-- diferença entre "a tela consegue mostrar" e "o sistema consegue provar".
--
-- ⚠️ `source_ref` é CÓPIA HISTÓRICA de propósito, e não junção. Este é o ponto inteiro de
-- FR-023: reindexar recria `ai_chunks` com ids novos, e uma FK para o trecho apontaria
-- para o vazio (ou, pior, para conteúdo diferente com o mesmo id). O que a resposta
-- precisa provar é o que valia NA ÉPOCA. Por isso título, escopo e data são gravados aqui,
-- congelados — é a única exceção deliberada à doutrina DIRC: Referenciar nesta spec, e ela
-- existe porque o referente é mutável por construção.
--
-- ═══ PARTE 2 · o que faltava em `knowledge_searches` (T111, FR-029) ═══
--
-- A telemetria de busca (0086) responde "quantas quase acertaram" mas não responde as duas
-- perguntas que viram ação: **em qual operadora** a base está furada, e **por que** o
-- agente recusou. Sem `scope_id`, a lacuna aparece somada entre todas as operadoras e o
-- corretor não sabe qual material escrever; sem `refusal_reason`, "não respondeu" mistura
-- causas com consertos opostos — base sem o assunto (escrever material), escopo desligado
-- (um clique), busca fora do ar (ninguém escreve nada, é infraestrutura).
--
-- DERIVAR, NÃO DUPLICAR: as duas colunas são o que o caminho da busca JÁ tem na mão no
-- momento em que grava a linha. Nenhuma consulta nova, nenhum campo sincronizado por cron.

-- ── 1 · a âncora como registro ──────────────────────────────────────────────
create table if not exists public.message_groundings (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  -- `cascade`: apagada a mensagem, a âncora dela não tem o que provar. E a anonimização
  -- da LGPD passa por aqui — âncora órfã de mensagem redigida seria dado sobrevivente de
  -- uma conversa que o titular pediu para apagar.
  message_id      uuid not null references public.messages(id) on delete cascade,

  layer           text not null check (layer in ('tenant', 'catalog')),

  -- SEM FK, e isto é a feature, não um esquecimento. O trecho e o material são recriados
  -- a cada reindexação; uma FK aqui ou impediria reindexar (violação de referência) ou
  -- apagaria o histórico em cascata. O id fica como PISTA para quem investiga hoje, e
  -- `source_ref` é o que responde quando ele não existe mais.
  chunk_id        uuid,
  material_id     uuid,

  -- A cópia congelada: título, escopo, data do material e camada, como estavam quando a
  -- resposta saiu. É o que FR-023 exige que sobreviva à reconstrução do acervo.
  source_ref      jsonb not null default '{}'::jsonb,
  similarity      real,

  created_at      timestamptz not null default now()
);

-- A leitura natural: "que âncoras esta resposta teve?" — é o que a tela pergunta.
create index if not exists message_groundings_message_idx
  on public.message_groundings (message_id);

-- E a que `metadata` não conseguia responder: "que material ancorou respostas na janela?".
create index if not exists message_groundings_org_material_idx
  on public.message_groundings (organization_id, material_id, created_at desc);

-- Reprocessar o mesmo turno não duplica âncora. Sem isto, um retry de worker dobraria a
-- contagem de "quantas vezes este material respondeu" — número que vira decisão de
-- curadoria.
create unique index if not exists message_groundings_mensagem_trecho_key
  on public.message_groundings (message_id, chunk_id)
  where chunk_id is not null;

comment on table public.message_groundings is
  'Migration 0126 (spec 002, F5): a âncora como REGISTRO permanente (FR-021), não campo de '
  'conveniência dentro de messages.metadata. source_ref é cópia histórica congelada, e '
  'chunk_id/material_id NÃO têm FK de propósito: o acervo é recriado a cada reindexação e '
  'a resposta precisa continuar provando o que valia na época (FR-023).';

alter table public.message_groundings enable row level security;

drop policy if exists tenant_isolation_message_groundings_all on public.message_groundings;
create policy tenant_isolation_message_groundings_all on public.message_groundings
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

revoke all on public.message_groundings from anon;

-- ── 2 · a recusa passa a dizer onde e por quê ───────────────────────────────
alter table public.knowledge_searches
  add column if not exists scope_id uuid references public.knowledge_scopes(id) on delete set null;

-- `set null` e não `cascade`: o corretor que apaga um escopo não deve apagar a prova de
-- que faltava material nele. A lacuna perde o nome, não a existência.

alter table public.knowledge_searches
  add column if not exists refusal_reason text;

-- Vocabulário ABERTO, sem CHECK — a exceção deliberada do CLAUDE.md. Um CHECK aqui
-- quebraria a re-aplicação do baseline em modo update assim que uma razão nova aparecesse
-- em linha já gravada, e é exatamente isso que o job `invariants` roda. O vocabulário vive
-- no TypeScript, com constante compartilhada, e esta coluna fica FORA do invariante
-- `vocabulario-banco-x-typescript.test.ts`, que cobre só colunas que JÁ têm CHECK.
comment on column public.knowledge_searches.refusal_reason is
  'Migration 0126 (spec 002, FR-029): por que a busca não ancorou. Vocabulário aberto, sem '
  'CHECK de propósito (ver CLAUDE.md, colunas de vocabulário aberto). Separa causas com '
  'consertos opostos: base sem o assunto, escopo desligado, busca indisponível.';

comment on column public.knowledge_searches.scope_id is
  'Migration 0126 (spec 002, FR-029): em qual operadora a lacuna aconteceu. Sem isto a '
  'lacuna aparece somada entre todas e o corretor não sabe qual material escrever.';

-- A leitura de lacunas: recusas por escopo na janela.
create index if not exists knowledge_searches_org_scope_idx
  on public.knowledge_searches (organization_id, scope_id, created_at desc);

notify pgrst, 'reload schema';
