-- 0127 — onde mora o texto de um documento
--
-- Spec 002 (RAG por operadora), fatia F4. Tarefa T140, e o que destrava T083/T084 — e com
-- elas FR-004 inteiro.
--
-- ═══ O BURACO ═══
--
-- O `data-model.md` não modelava destino para texto extraído de PDF ou Markdown.
-- `ingestPolicyFile` (`lib/ai/rag/ingest/policy.ts:94-126`) extrai o texto, conta os
-- caracteres, devolve a contagem e **joga o texto fora**. O indexador
-- (`workers/rag-indexer.ts:313`) lê exclusivamente `ai_faq_items` e, para uma fonte que
-- não é par pergunta/resposta, encerra com `skip("no_content_to_index")`.
--
-- O resultado é o defeito que FR-004 nomeia: o corretor sobe o manual da operadora, a tela
-- diz "salvo", e nenhum trecho buscável existe. Material aceito que nunca vira lastro —
-- descartado em silêncio, que é o modo de falha que o Princípio II proíbe.
--
-- ═══ AS DUAS SAÍDAS, E POR QUE ESTA ═══
--
-- (a) Afrouxar `ai_faq_items.question` para `nullable` e usar a tabela para tudo.
-- (b) Tabela nova, `ai_source_passages`. ← ESTA.
--
-- (a) não perde dado — relaxar `not null` é aditivo — e mesmo assim é a pior. O motivo não
-- é destrutividade, é SIGNIFICADO: `ai_faq_items` quer dizer "par pergunta/resposta", e é
-- isso que todo consumidor dela assume. Guardar passagem de documento ali faz a tabela
-- deixar de significar o que o nome diz, e transfere para cada leitor a obrigação de
-- lembrar que `question` pode ser nulo — a classe de defeito que o CLAUDE.md chama de
-- duplicação sem source of truth declarado. E o caminho de volta seria bloqueado no dia
-- em que a primeira linha nula existisse.
--
-- (b) custa uma tabela e paga: cada coisa com o seu nome, `question` continua `not null`
-- para quem depende disso, e a passagem carrega o que o par nunca teve (posição no
-- documento, página, título da seção) — o que dá âncora legível ao corretor em vez de
-- "trecho 47".
--
-- ⚠️ ESTA MIGRATION NÃO É O FIM DE FR-004. Ela abre o destino; T083 (gravar o texto
-- extraído) e T084 (fazer o indexador ler daqui) são o que fecham. Enquanto elas não
-- entrarem, a tabela existe vazia — e material que não é par continua sem virar trecho.

create table if not exists public.ai_source_passages (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  knowledge_source_id uuid not null references public.ai_knowledge_sources(id) on delete cascade,

  -- O eixo de escopo, ESPELHANDO `ai_knowledge_sources` — as mesmas duas colunas que
  -- `fn_buscar_lastro` filtra. Elas existem aqui, e não só na fonte, porque um documento
  -- pode ser fatiado com escopos diferentes por seção (um manual que cobre duas
  -- operadoras), e porque o indexador copia daqui para o trecho: derivar por junção na
  -- hora da busca colocaria mais um `join` no caminho quente.
  scope_id            uuid references public.knowledge_scopes(id) on delete set null,
  applies_to_all      boolean not null default false,

  -- O texto. É a razão de a tabela existir.
  content             text not null check (length(btrim(content)) > 0),

  -- Ordem no documento. `numeric` e não `int` pela mesma doutrina de
  -- `position_in_stage`: reprocessar um PDF e precisar inserir uma passagem entre duas
  -- existentes não pode exigir renumerar todas.
  position            numeric not null default 0,

  -- A âncora LEGÍVEL. É o que separa "está no seu manual, página 12, Carências" de
  -- "trecho 47" — a citação que o corretor consegue ir conferir.
  section_title       text,
  page_number         integer,

  tags                text[] not null default '{}'::text[],
  locale              text   not null default 'pt-BR',

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- A leitura do indexador: as passagens daquela fonte, em ordem.
create index if not exists ai_source_passages_source_pos_idx
  on public.ai_source_passages (knowledge_source_id, position);

create index if not exists ai_source_passages_org_scope_idx
  on public.ai_source_passages (organization_id, scope_id);

create index if not exists ai_source_passages_tags_gin
  on public.ai_source_passages using gin (tags);

-- Reprocessar o mesmo documento substitui, não empilha. Sem esta chave, subir de novo o
-- mesmo manual dobraria as passagens e o mesmo texto ancoraria duas vezes — inflando a
-- contagem de trechos que a tela mostra como prova de que o material entrou.
create unique index if not exists ai_source_passages_fonte_posicao_key
  on public.ai_source_passages (knowledge_source_id, position);

comment on table public.ai_source_passages is
  'Migration 0127 (spec 002, F4 · T140): onde mora o texto extraído de documento que NÃO é '
  'par pergunta/resposta. Tabela própria em vez de afrouxar ai_faq_items.question: o motivo '
  'é significado, não destrutividade — aquela tabela quer dizer "par pergunta/resposta", e '
  'usá-la para passagem transferiria a cada leitor a obrigação de lembrar que question pode '
  'ser nulo. Destino de T083; origem de T084.';

drop trigger if exists ai_source_passages_updated_at on public.ai_source_passages;
create trigger ai_source_passages_updated_at
  before update on public.ai_source_passages
  for each row execute function public.fn_set_updated_at();

alter table public.ai_source_passages enable row level security;

drop policy if exists tenant_isolation_ai_source_passages_all on public.ai_source_passages;
create policy tenant_isolation_ai_source_passages_all on public.ai_source_passages
  using ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin())
  with check ((organization_id in (select public.fn_user_org_ids())) or public.fn_is_platform_admin());

revoke all on public.ai_source_passages from anon;

notify pgrst, 'reload schema';
