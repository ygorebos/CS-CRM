# Data Model — RAG por operadora

Entidades da spec traduzidas em schema, com a regra de validação que cada uma carrega e a fatia em
que ela entra. Toda mudança aqui sai como a **tripla** do Princípio III: migration versionada +
apêndice idempotente no `baseline.sql` + linha no MANIFEST.

**A divisão que organiza tudo**: tabelas com `organization_id` seguem o Princípio I sem exceção;
tabelas `catalog_*` **não têm** `organization_id` e existem sob as sete travas do Princípio X
v2.0.0. Nenhuma tabela existente muda de lado.

**O nome estrutural é "escopo de conhecimento", não "operadora"** (research D11, FR-033/FR-041). A
spec batiza a entidade "Operadora (Escopo de Conhecimento)" porque outro nicho — clínica com
convênios, distribuidora com fornecedores — usa o mesmo mecanismo com outro nome. "Operadora" é o
**rótulo** que o nicho de validação exibe, resolvido pelo mesmo vocabulário configurável que já
renomeia lead/deal/won/lost.

---

## Camada curada (sem dono de tenant) — F2/F3

### `catalog_scopes`

O escopo como o fabricante o mantém. Compartilhado por todas as organizações da instalação.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | `gen_random_uuid()` |
| `slug` | `text not null unique` | chave estável da semeadura; é por ela que `on conflict do nothing` reconhece o que já existe |
| `display_name` | `text not null` | o que o corretor lê |
| `official_code` | `text` | registro oficial (ANS, no nicho de saúde). Chave estável para uma importação futura (A-12). **Sem FK**, sem leitura de banco externo |
| `is_active` | `boolean not null default true` | desativação **global**, do fabricante. Não confundir com a do tenant, que vive em `knowledge_scopes` |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

**RLS**: leitura para `authenticated`; escrita só com `fn_is_platform_admin()` (trava 1).

### `catalog_materials`

A unidade que quem cura reconhece e corrige. **Versionada e nunca reescrita** (trava 6).

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `catalog_scope_id` | `uuid references catalog_scopes(id)` | nulo quando `applies_to_all` |
| `applies_to_all` | `boolean not null default false` | **check**: exatamente um dos dois preenchido (FR-001) |
| `slug` | `text not null` | estável entre versões |
| `version` | `integer not null` | **unique `(slug, version)`** — é o par que a semeadura usa para não sobrescrever |
| `title` | `text not null` | |
| `body` | `text not null` | |
| `valid_until` | `date` | opcional (FR-025). Nulo = não vence |
| `published_at` | `timestamptz not null default now()` | é a "recência" do desempate de FR-035 |
| `origin` | `text not null check in ('seed','local')` | `seed` = veio da semeadura; `local` = escrito pelo administrador daquela instalação. Separar os dois é o que permite provar SC-018 |
| `adopted_at` | `timestamptz` | **F3, migration 0120.** Preenchido quando o administrador da instalação edita um material `seed`: aquele `slug` passa a ser **adotado localmente** |
| `adopted_by` | `uuid references auth.users(id)` | quem adotou — a curadoria é auditada (FR-036) |
| `inert` | `boolean not null default false` | versão que chegou por semeadura **depois** de o `slug` ser adotado. Não ancora, não desempata, fica visível para ser aceita (FR-037) |

**A regra que estas três colunas implementam** (decisão de 2026-08-08): a edição local vence a
versão nova semeada. Sem elas, "a semeadura só acrescenta versão" + "o desempate é por recência"
significa que a versão que chega por release, sempre mais recente, apaga a correção local **no
comportamento** enquanto o banco fica intacto — SC-018 passaria contando linhas e o requisito
falharia respondendo. É estado por material, nunca chave global de instalação (A-21): adotar um
`slug` não congela o resto do catálogo.

**RLS**: idêntica à `catalog_scopes`.

**Por que `applies_to_all` é coluna e não um escopo fictício "todos"**: um escopo fictício
apareceria na lista do corretor e no filtro do contato, e alguém acabaria vinculando um cliente a
ele. Coluna booleana não tem esse caminho.

### `catalog_chunks`

O trecho recuperável do catálogo. Espelha `ai_chunks` no formato, sem `organization_id`.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `catalog_material_id` | `uuid not null references catalog_materials(id) on delete cascade` | |
| `catalog_scope_id` | `uuid` | denormalizado do material, para a busca filtrar sem join (o escopo viaja no trecho — exigência da entidade **Trecho** da spec) |
| `applies_to_all` | `boolean not null default false` | idem |
| `position` | `integer not null` | |
| `content` | `text not null` | |
| `content_hash` | `text not null` | |
| `token_count` | `integer not null` | |
| `embedding` | `vector(1536) not null` | pré-computado na semeadura (research D6) |
| `embedding_model` | `text not null` | o que permite re-embeddar só quando o modelo muda |
| `metadata` | `jsonb not null default '{}'` | |

**Duplicação declarada** (`catalog_scope_id` e `applies_to_all` vivem no material **e** no trecho):
source of truth é `catalog_materials`; o trecho carrega cópia porque a busca filtra por escopo antes
de qualquer join, e porque a spec exige que a restrição seja verificável **no próprio trecho**, não
por associação. Mantida por trigger de sincronização, não por cron (anti-pattern nº 5).

---

## Camada do tenant — F2/F4

### `knowledge_scopes` (nova, tenant-aware)

O escopo **como aquele tenant o vê**. Todo escopo visível a um corretor tem linha aqui — inclusive
os que vieram do catálogo.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `organization_id` | `uuid not null references organizations(id) on delete cascade` | Princípio I |
| `catalog_scope_id` | `uuid references catalog_scopes(id)` | preenchido = espelho do catálogo; nulo = criado pelo corretor (FR-002) |
| `display_name` | `text not null` | o corretor pode renomear sem tocar no catálogo |
| `official_code` | `text` | herdado do catálogo quando espelho |
| `is_active` | `boolean not null` | **é a chave da trava 4**: desligar torna o material daquele escopo inerte só para este tenant (FR-008). **Espelho do catálogo nasce `false`**; escopo criado pelo corretor nasce `true` — ele acabou de digitar o nome, ligar de novo seria burocracia (A-20) |
| `created_at` / `updated_at` | `timestamptz` | |

**Índices**: `unique (organization_id, catalog_scope_id) where catalog_scope_id is not null` — um
espelho por escopo de catálogo por tenant, e é o que torna a materialização idempotente.

**RLS**: `tenant_isolation_knowledge_scopes_all` via `fn_user_org_ids()`.

**Materialização dos espelhos**: `fn_sincronizar_escopos_do_catalogo(p_organization_id)`, função SQL
idempotente e sem HTTP (Princípio V), chamada (a) na criação da organização e (b) no fim do apêndice
de semeadura para toda organização existente — é o que faz escopo curado novo alcançar clone antigo
na atualização.

### `contacts` — colunas novas

| Coluna | Tipo | Regra |
|---|---|---|
| `knowledge_scope_id` | `uuid references knowledge_scopes(id)` | FK, nunca texto (anti-pattern nº 1) |
| `knowledge_scope_source` | `text check in ('cadastro','conversa')` | **cadastro vence conversa** (FR-017). É a coluna que torna a precedência verificável em vez de convencionada |
| `knowledge_scope_confirmed_at` | `timestamptz` | quando veio da conversa, é o que sustenta a política de não perguntar de novo (A-05) |

Nulo em qualquer uma delas = escopo desconhecido, que é **estado tratado, não erro**.

### `ai_knowledge_sources` — colunas novas e um índice a menos — **F2, migration 0118**

> Estas colunas estavam na 0120 (F4) e **foram para a 0118**. A `fn_buscar_lastro` da 0119 as lê:
> criá-las duas migrations depois faria a função não criar, ou criar sem filtro nenhum do lado do
> tenant. Achado da revisão cruzada de 2026-08-08.


| Mudança | Regra |
|---|---|
| `+ scope_id uuid references knowledge_scopes(id)` | a qual escopo o material se aplica |
| `+ applies_to_all boolean not null default false` | **check**: exatamente um dos dois (FR-001) |
| `+ valid_until date` | validade opcional (FR-025) |
| `− ai_knowledge_sources_unique_per_agent` | o índice que hoje impede duas fontes ativas do mesmo tipo por agente (`baseline.sql:2286`) — é ele que torna a segunda operadora impossível |

**Backfill obrigatório antes do check** (Princípio III item 8): linhas existentes nascem com
`applies_to_all = true`. É o que mais se aproxima do que elas são hoje — um acervo único, sem eixo —
e não perde conteúdo de nenhum clone.

**O `drop index` vai no apêndice do `baseline.sql`, não só na migration** (brecha 10). O snapshot
recria esse índice em toda instalação nova, e o apêndice roda depois dele. Sem o `drop index if
exists` lá, instalação fresca nasceria com o índice e clone atualizado não — duas realidades a
partir do mesmo arquivo.

### `ai_chunks` — colunas novas

`+ scope_id uuid` e `+ applies_to_all boolean`, denormalizados da fonte pela mesma razão de
`catalog_chunks`. `organization_id` continua `not null`: **nada aqui muda de lado**. Também na
**0118**, pelo mesmo motivo da tabela acima.

### `content_divergences` (nova, tenant-aware) — **F4, migration 0121**

A segunda metade de FR-035, que não tinha nem tabela nem tarefa até a revisão cruzada. O desempate
existia; o registro dele, não — e um requisito que manda "registrar para o corretor" sem lugar onde
registrar é requisito que ninguém cumpre.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `organization_id` | `uuid not null references organizations(id) on delete cascade` | Princípio I |
| `scope_id` | `uuid references knowledge_scopes(id)` | qual operadora |
| `winner_ref` / `loser_ref` | `jsonb not null` | camada, material e trecho de cada lado — cópia histórica, como em `message_groundings`, para sobreviver à reindexação |
| `reason` | `text not null check in ('camada','recencia')` | qual das duas regras decidiu |
| `first_seen_at` / `last_seen_at` | `timestamptz not null` | agrupa repetição em vez de gerar linha por resposta |
| `resolved_at` | `timestamptz` | o corretor corrigiu um dos dois lados |

**Índice**: `unique (organization_id, scope_id, md5(winner_ref::text || loser_ref::text))` — o mesmo
par contraditório aparece uma vez, com contagem, não uma vez por conversa.

**RLS**: `tenant_isolation_content_divergences_all` via `fn_user_org_ids()`.

**Onde aparece**: a mesma lista de lacunas de FR-028 (`components/ai/EvolutionGaps.tsx`) — o corretor
já vai lá para saber o que carregar; contradição é o mesmo tipo de dívida, não merece tela própria.

---

## Rastreabilidade e lacunas

### F1 — a âncora entra no `insert` da mensagem

Sem tabela nova. As citações passam a ser gravadas em `messages.metadata` **no insert**, não num
`update` posterior (research D5). É o que fecha FR-024 com a menor mudança possível, e é por isso
que F1 não tem schema além de uma linha de vocabulário.

### `message_groundings` (nova, tenant-aware) — **F5**

O registro permanente que liga a mensagem enviada aos trechos que a fundamentaram, com a camada de
origem e a cópia histórica do conteúdo. Entra em F5, não em F1: é onde a rastreabilidade precisa
**sobreviver à atualização do material** (FR-023) e mostrar a camada na tela (FR-039), o que
`messages.metadata` sozinho não sustenta.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `organization_id` | `uuid not null` | |
| `message_id` | `uuid not null references messages(id) on delete cascade` | |
| `layer` | `text not null check in ('tenant','catalog')` | é o que FR-039 mostra na tela |
| `chunk_id` | `uuid not null` | sem FK: o trecho pode ser reconstruído por uma versão nova do acervo, e a rastreabilidade tem de sobreviver a isso (FR-023) |
| `source_ref` | `jsonb not null` | cópia do que importava na época — texto do trecho, título do material, escopo, data de atualização |
| `similarity` | `real not null` | |
| `created_at` | `timestamptz not null default now()` | |

**Por que `source_ref` duplica o conteúdo**: FR-023 exige que uma resposta antiga continue apontando
para o que estava valendo quando ela foi dada. Ponteiro puro apontaria para conteúdo já
reconstruído — o indexador reconstrói o acervo inteiro a cada mudança
(`workers/rag-indexer.ts:277-294`). A duplicação é deliberada e tem source of truth declarado: a
cópia é a verdade histórica, o material é a verdade atual.

### Lacunas — derivadas, não tabela nova — **F5**

As lacunas de FR-028/FR-029 saem de `knowledge_searches`, que já grava `hits`, `top_score` e
`threshold` (`lib/agent-engine/agent/search-knowledge.ts:85-90`) e já é agregada em "sem resposta" e
"quase acertou" (`lib/ai/evolution/aggregate.ts:88-90`). O que falta é o **eixo de escopo** e o
**motivo da recusa**: duas colunas em `knowledge_searches` (`scope_id`, `refusal_reason`), não uma
tabela nova. Doutrina DIRC: **Calcular**, não Duplicar.

### `agent_inbox_items` — vocabulário novo — **F1**

Um `kind` novo, `assistance_without_grounding`, acrescentado **na lista existente** do apêndice
(`baseline.sql:8999`), nunca num bloco novo — reconstruir a mesma constraint em N blocos quebra o
`update.sh` de todo clone que já tenha vocabulário posterior, como o comentário daquele bloco
registra.

---

## Transições de estado

**Material do tenant** (`ai_knowledge_sources.status`, vocabulário já existente):
`building → ready` quando o indexador termina · `building → failed` com motivo em português (FR-005)
· `ready → archived` na remoção. Nunca existe estado "salvo sem conteúdo buscável" — é a classe que
SC-014 zera.

**Acervo** (`ai_knowledge_versions`): a versão nova só é **ativada** depois de todos os trechos
entrarem. Falha no meio deixa a anterior valendo por inteiro — comportamento que já existe
(`workers/rag-indexer.ts:277-294`) e que FR-006 promove a requisito.

**Vínculo do contato**: `desconhecido → conversa` (o cliente respondeu) · `qualquer → cadastro` (o
corretor registrou; sempre vence) · `cadastro → cadastro` (o corretor corrigiu). Nunca
`cadastro → conversa`.

**Material curado**: `seed v1 → seed v2` (semeadura acrescenta) · `seed → local` **não existe** — a
edição local cria uma linha `origin='local'` nova, e a `seed` permanece. É assim que SC-018 dá zero
edições sobrescritas.

---

## O que este modelo NÃO faz

- **Não reparte o acervo por escopo.** Continua um `ai_knowledge_versions` ativo por agente
  (A-04, `baseline.sql:2278`). O escopo é eixo **dentro** do acervo.
- **Não guarda dado de cliente no catálogo.** É a trava 2 e o critério SC-020: varredura da
  partição curada devolve zero dado pessoal e zero identificador de organização.
- **Não crava o nicho no schema.** Nenhuma tabela ou coluna se chama "operadora" (D11). O rótulo
  vive no vocabulário configurável.
- **Não cria FK atravessando a fronteira de camada além do espelho.**
  `knowledge_scopes.catalog_scope_id` é o único ponto de contato, e ele existe justamente para que
  nenhum outro precise.
- **Não versiona o acervo do tenant por material.** A rastreabilidade histórica vive em
  `message_groundings.source_ref`, não numa árvore de versões de conteúdo que ninguém pediu.
