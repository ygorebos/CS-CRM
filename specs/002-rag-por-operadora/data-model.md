# Data Model — RAG por operadora

Entidades da spec traduzidas em schema, com a regra de validação que cada uma carrega e a fatia em
que ela entra. Toda mudança aqui sai como a **tripla** do Princípio III: migration versionada +
apêndice idempotente no `baseline.sql` + linha no MANIFEST.

**A divisão que organiza tudo**: tabelas com `organization_id` seguem o Princípio I sem exceção;
tabelas `catalog_*` **não têm** `organization_id` e existem sob as sete travas do Princípio X
v2.0.0. Nenhuma tabela existente muda de lado.

---

## Camada curada (sem dono de tenant) — F2/F3

### `catalog_operadoras`

A operadora como o fabricante a mantém. Compartilhada por todas as organizações da instalação.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | `gen_random_uuid()` |
| `slug` | `text not null unique` | chave estável da semeadura; é por ela que `on conflict do nothing` reconhece o que já existe |
| `display_name` | `text not null` | o que o corretor lê |
| `ans_code` | `text` | registro oficial. Chave estável para uma importação futura (A-12). **Sem FK**, sem leitura de banco externo |
| `is_active` | `boolean not null default true` | desativação **global**, do fabricante. Não confundir com a do tenant, que vive em `operadoras` |
| `created_at` / `updated_at` | `timestamptz not null default now()` | |

**RLS**: leitura para `authenticated`; escrita só com `fn_is_platform_admin()` (trava 1).

### `catalog_materials`

A unidade que quem cura reconhece e corrige. **Versionada e nunca reescrita** (trava 6).

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `catalog_operadora_id` | `uuid not null references catalog_operadoras(id)` | ou o marcador de "vale para todas" — ver abaixo |
| `applies_to_all` | `boolean not null default false` | quando `true`, `catalog_operadora_id` é nulo. **Check**: exatamente um dos dois preenchido (FR-001) |
| `slug` | `text not null` | estável entre versões |
| `version` | `integer not null` | **unique `(slug, version)`** — é o par que a semeadura usa para não sobrescrever |
| `title` | `text not null` | |
| `body` | `text not null` | |
| `valid_until` | `date` | opcional (FR-025). Nulo = não vence |
| `published_at` | `timestamptz not null default now()` | é a "recência" do desempate de FR-035 |
| `origin` | `text not null check in ('seed','local')` | `seed` = veio da semeadura; `local` = escrito pelo administrador daquela instalação. Separar os dois é o que permite provar SC-018 |

**RLS**: idêntica à `catalog_operadoras`.

**Por que `applies_to_all` é coluna e não uma operadora fictícia "todas"**: uma operadora fictícia
apareceria na lista do corretor e no filtro do contato, e alguém acabaria vinculando um cliente a
ela. Coluna booleana não tem esse caminho.

### `catalog_chunks`

O trecho recuperável do catálogo. Espelha `ai_chunks` no formato, sem `organization_id`.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `catalog_material_id` | `uuid not null references catalog_materials(id) on delete cascade` | |
| `catalog_operadora_id` | `uuid` | denormalizado do material, para a busca filtrar sem join (a operadora viaja no trecho — exigência da entidade **Trecho** da spec) |
| `applies_to_all` | `boolean not null default false` | idem |
| `position` | `integer not null` | |
| `content` | `text not null` | |
| `content_hash` | `text not null` | |
| `token_count` | `integer not null` | |
| `embedding` | `vector(1536) not null` | pré-computado na semeadura (research D6) |
| `embedding_model` | `text not null` | o que permite re-embeddar só quando o modelo muda |
| `metadata` | `jsonb not null default '{}'` | |

**Duplicação declarada** (`catalog_operadora_id` e `applies_to_all` vivem no material **e** no
trecho): source of truth é `catalog_materials`; o trecho carrega cópia porque a busca filtra por
operadora antes de qualquer join, e porque a spec exige que a restrição de escopo seja verificável
**no próprio trecho**, não por associação. Mantida por trigger de sincronização, não por cron
(anti-pattern nº 5).

---

## Camada do tenant — F2/F4

### `operadoras` (nova, tenant-aware)

A operadora **como aquele tenant a vê**. Toda operadora visível a um corretor tem linha aqui —
inclusive as que vieram do catálogo.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `organization_id` | `uuid not null references organizations(id) on delete cascade` | Princípio I |
| `catalog_operadora_id` | `uuid references catalog_operadoras(id)` | preenchido = espelho do catálogo; nulo = criada pelo corretor (FR-002) |
| `display_name` | `text not null` | o corretor pode renomear sem tocar no catálogo |
| `ans_code` | `text` | herdado do catálogo quando espelho |
| `is_active` | `boolean not null default true` | **é a desativação da trava 4**: desligar aqui torna o material daquela operadora inerte só para este tenant (FR-008) |
| `created_at` / `updated_at` | `timestamptz` | |

**Índices**: `unique (organization_id, catalog_operadora_id) where catalog_operadora_id is not null`
— um espelho por catálogo por tenant, e é o que torna a materialização idempotente.

**RLS**: `tenant_isolation_operadoras_all` via `fn_user_org_ids()`.

**Materialização dos espelhos**: função SQL idempotente, sem HTTP (Princípio V), chamada (a) na
criação da organização e (b) no fim do apêndice de semeadura para toda organização existente — é o
que faz operadora curada nova alcançar clone antigo na atualização.

### `contacts` — colunas novas

| Coluna | Tipo | Regra |
|---|---|---|
| `operadora_id` | `uuid references operadoras(id)` | FK, nunca texto (anti-pattern nº 1) |
| `operadora_source` | `text check in ('cadastro','conversa')` | **cadastro vence conversa** (FR-017). É a coluna que torna a precedência verificável em vez de convencionada |
| `operadora_confirmed_at` | `timestamptz` | quando veio da conversa, é o que sustenta a política de não perguntar de novo (A-05) |

Nulo em qualquer uma delas = operadora desconhecida, que é **estado tratado, não erro**.

### `ai_knowledge_sources` — colunas novas e um índice a menos

| Mudança | Regra |
|---|---|
| `+ operadora_id uuid references operadoras(id)` | a qual operadora o material se aplica |
| `+ applies_to_all boolean not null default false` | **check**: exatamente um dos dois (FR-001) |
| `+ valid_until date` | validade opcional (FR-025) |
| `− ai_knowledge_sources_unique_per_agent` | o índice que hoje impede duas fontes ativas do mesmo tipo por agente (`baseline.sql:2286`) — é ele que torna a segunda operadora impossível |

**Backfill obrigatório antes do check** (Princípio III item 8): linhas existentes nascem com
`applies_to_all = true`. É o que mais se aproxima do que elas são hoje — um acervo único, sem eixo —
e não perde conteúdo de nenhum clone.

### `ai_chunks` — coluna nova

`+ operadora_id uuid` e `+ applies_to_all boolean`, denormalizados da fonte pela mesma razão de
`catalog_chunks`. `organization_id` continua `not null`: **nada aqui muda de lado**.

---

## Rastreabilidade e lacunas — F1/F5

### `message_groundings` (nova, tenant-aware)

O registro permanente que liga a mensagem enviada aos trechos que a fundamentaram. É o artefato que
torna o Princípio X verificável, e é escrito **antes do envio** (research D5).

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `organization_id` | `uuid not null` | |
| `message_id` | `uuid not null references messages(id) on delete cascade` | |
| `layer` | `text not null check in ('tenant','catalog')` | é o que FR-039 mostra na tela |
| `chunk_id` | `uuid not null` | sem FK: o trecho pode ser reconstruído por uma versão nova do acervo, e a rastreabilidade tem de sobreviver a isso (FR-023) |
| `source_ref` | `jsonb not null` | cópia do que importava na época — texto do trecho, título do material, operadora, data de atualização |
| `similarity` | `real not null` | |
| `created_at` | `timestamptz not null default now()` | |

**Por que `source_ref` duplica o conteúdo**: FR-023 exige que uma resposta antiga continue apontando
para o que estava valendo quando ela foi dada. Ponteiro puro apontaria para conteúdo já
reconstruído — o indexador reconstrói o acervo inteiro a cada mudança
(`workers/rag-indexer.ts:277-294`). A duplicação é deliberada e tem source of truth declarado: a
cópia é a verdade histórica, o material é a verdade atual.

### `knowledge_gaps` — derivada, não tabela nova

As lacunas de FR-028/FR-029 saem de `knowledge_searches`, que já grava `hits`, `top_score` e
`threshold` (`lib/agent-engine/agent/search-knowledge.ts:85-90`) e já é agregada em "sem resposta" e
"quase acertou" (`lib/ai/evolution/aggregate.ts:88-90`). O que falta é o **eixo de operadora** e o
**motivo da recusa**: duas colunas em `knowledge_searches` (`operadora_id`, `refusal_reason`), não
uma tabela nova. Doutrina DIRC: **Calcular**, não Duplicar.

### `agent_inbox_items` — vocabulário novo

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

- **Não reparte o acervo por operadora.** Continua um `ai_knowledge_versions` ativo por agente
  (A-04, `baseline.sql:2278`). A operadora é eixo **dentro** do acervo.
- **Não guarda dado de cliente no catálogo.** É a trava 2 e o critério SC-020: varredura da
  partição curada devolve zero dado pessoal e zero identificador de organização.
- **Não cria FK atravessando a fronteira de camada a partir do tenant para o catálogo além do
  espelho.** `operadoras.catalog_operadora_id` é o único ponto de contato, e ele existe justamente
  para que nenhum outro precise.
- **Não versiona o acervo do tenant por material.** A rastreabilidade histórica vive em
  `message_groundings.source_ref`, não numa árvore de versões de conteúdo que ninguém pediu.
