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
| `adopted_at` | `timestamptz` | **F3, migration 0124.** Preenchido quando o administrador da instalação edita um material `seed`: aquele `slug` passa a ser **adotado localmente** |
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

> Estas colunas estavam na 0124 (F4) e **foram para a 0118**. A `fn_buscar_lastro` da 0123 as lê:
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

### `knowledge_divergences` (nova, tenant-aware) — **F4, migration 0125** ✅ construída

A segunda metade de FR-035, que não tinha nem tabela nem tarefa até a revisão cruzada. O desempate
existia; o registro dele, não — e um requisito que manda "registrar para o corretor" sem lugar onde
registrar é requisito que ninguém cumpre.

> **Construída em 2026-08-08, e com TRÊS diferenças em relação ao desenho abaixo.** Estão explicadas
> logo depois da tabela, porque cada uma nasceu de uma coisa que só apareceu ao implementar. O nome
> também mudou — `content_divergences` virou `knowledge_divergences`, para ficar na mesma família de
> `knowledge_scopes` e `knowledge_searches`.

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | `uuid pk` | |
| `organization_id` | `uuid not null references organizations(id) on delete cascade` | Princípio I |
| `winner_source_id` | `uuid not null references ai_knowledge_sources(id) on delete cascade` | o material do corretor que venceu |
| `loser_material_id` | `uuid not null references catalog_materials(id) on delete cascade` | o material curado que foi silenciado |
| `scope_id` | `uuid references knowledge_scopes(id) on delete set null` | o balde; nulo = "vale para todos" |
| `subject` | `text not null default ''` | categoria do léxico fechado de assistência, **sem** texto de conversa |
| `occurrences` | `integer not null default 1` | agrupa repetição em vez de gerar linha por resposta |
| `first_seen_at` / `last_seen_at` | `timestamptz not null` | |
| `resolved_at` | `timestamptz` | o corretor declarou tratada; a linha **não** é apagada |

**Índice**: `unique (organization_id, winner_source_id, loser_material_id, subject)` — o mesmo par
contraditório sobre o mesmo assunto aparece uma vez, com contagem, não uma vez por conversa.

**RLS**: `tenant_isolation_knowledge_divergences_all` via `fn_user_org_ids()`.

**Onde aparece**: a mesma lista de lacunas de FR-028 (`components/ai/EvolutionGaps.tsx`) — o corretor
já vai lá para saber o que carregar; contradição é o mesmo tipo de dívida, não merece tela própria.

#### As três diferenças, e o que as causou

**1. FK dos dois lados, não `winner_ref`/`loser_ref` em `jsonb`.** O desenho copiava a cópia
histórica de `message_groundings`, e o paralelo é falso. `message_groundings` prova o PASSADO — o que
valia quando a resposta saiu —, e por isso congela. A divergência é uma TAREFA DO PRESENTE: o
corretor vai abrir os dois materiais e comparar. Congelar o título faria a lista mostrar o nome
antigo depois de ele renomear o material, e mandá-lo procurar um arquivo que não se chama mais
assim. Com FK, título e escopo vêm por junção e acompanham sozinhos (DIRC: Referenciar). O `cascade`
é coerente: material apagado não tem divergência a resolver.

**2. Sem `reason`.** O desenho previa `check in ('camada','recencia')`. Só a primeira produz
divergência entre camadas — a de recência decide qual VERSÃO do mesmo material curado vale (0124,
FR-037), e ali não há dois textos discordando, há um material substituindo a si mesmo. Gravar
`reason` seria gravar a constante `'camada'` em toda linha (DIRC: Calcular). A coluna entra quando
existir um segundo sentido de desempate, com dado real para preenchê-la.

**3. `subject` no lugar do `md5` do par.** A chave do desenho não distinguia assuntos: os mesmos dois
materiais podem discordar sobre carência **e** sobre rede credenciada, e são dois problemas
separados — colapsá-los faria o segundo sumir quando o corretor resolvesse o primeiro. O assunto sai
do léxico fechado de `lib/agent-engine/guardrails/lexico-assistencia.ts`, a mesma régua que
classifica a afirmação no gate de lastro, e **nunca** do texto da pergunta: o contrato de PII da
migration 0086 vale aqui igual.

#### A busca precisou mudar de assinatura

Não estava previsto e é a parte mais invasiva da migration. `fn_buscar_lastro` **descartava** o
perdedor dentro do `where`, então do lado de fora não existia informação de que houve desempate.
Registrar sem tocar nela exigiria uma segunda busca vetorial por turno — cara no caminho quente e
capaz de discordar da que ancorou a resposta. Ela passou a aceitar `p_incluir_preteridos` (default
`false`, conjunto idêntico ao de antes para todo chamador existente) e a devolver `preterido` e
`preterido_por_material`. As linhas preteridas **não consomem o `limit`** das vencedoras: caso
contrário, ligar o registro reduziria em silêncio o lastro da resposta.

### ✅ DECIDIDO — onde mora o texto de um documento (era T140; migration 0127)

**Decisão de 2026-08-08: a tabela nova `ai_source_passages`.** Foi a recomendação registrada abaixo,
e a implementação confirmou o motivo — trocando, porém, qual dos dois argumentos pesa.

O argumento que a análise original deu como principal (*a outra saída é destrutiva*) **não se
sustenta**: afrouxar `ai_faq_items.question` para nullable não perde dado; relaxar `not null` é
aditivo. O que decide é o outro argumento, o de **significado**: `ai_faq_items` quer dizer "par
pergunta/resposta", e é isso que todo consumidor dela assume. Guardar passagem de documento ali faz a
tabela deixar de significar o que o nome diz e transfere a cada leitor a obrigação de lembrar que
`question` pode ser nulo. O caminho de volta ficaria bloqueado no dia da primeira linha nula.

A tabela nova ainda paga o que o par nunca teve: `position` (`numeric`, mesma doutrina de
`position_in_stage` — reprocessar e inserir entre duas não pode exigir renumerar todas),
`section_title` e `page_number`, que fazem a citação virar *"seu manual, página 12, Carências"* em
vez de *"trecho 47"*. E `scope_id`/`applies_to_all` espelham a fonte porque o indexador copia daqui
para o trecho: derivar por junção poria mais um `join` no caminho quente da busca.

**Índice**: `unique (knowledge_source_id, position)` — reprocessar substitui, não empilha. Sem ele,
subir o mesmo manual duas vezes dobra as passagens e infla a contagem de trechos que a tela mostra
como prova de que o material entrou.

⚠️ **A migration não fecha FR-004 sozinha.** Ela abre o destino; **T083** (gravar o texto extraído) e
**T084** (fazer o indexador ler daqui) é que fecham. Enquanto elas não entrarem, a tabela existe
vazia e material que não é par continua sem virar trecho.

<details>
<summary>A análise original que levou à decisão (mantida para registro)</summary>

**Achado em 2026-08-08, ao começar a F4.** Este modelo não diz onde o texto extraído de um PDF ou
Markdown é persistido, e as duas tarefas que dependem disso pressupõem que alguém já decidiu:

- **T083** manda "persistir o texto extraído" — sem destino. Hoje `ingestPolicyFile`
  (`lib/ai/rag/ingest/policy.ts:94-126`) extrai, fragmenta, loga a contagem e **devolve**, sem
  gravar nada.
- **T084** manda o indexador "ler material que não é par pergunta/resposta" — sem lugar de onde ler.
  Hoje `workers/rag-indexer.ts:312-325` consulta **só** `ai_faq_items` e encerra com
  `skip("no_content_to_index")`.

É o defeito nº 5 da seção "Por que esta feature existe" — *o material que o corretor mais tem é
aceito e descartado em silêncio* — e ele **não tem modelagem**. Sem esta decisão, FR-004 ("todo
material aceito DEVE virar conteúdo buscável **ou** falhar de forma visível") não é implementável.

As duas saídas, e por que não é escolha de gosto:

| Saída | O que custa |
|---|---|
| **Tabela nova** `ai_source_passages` (tenant-aware, com `scope_id` e `applies_to_all` como as demais) | Aditiva: não toca constraint existente, não migra dado gravado |
| Afrouxar `ai_faq_items.question` para nullable e marcar o tipo | **Destrutiva**: `question` é `not null` hoje e a tabela tem dado. Exige expand/contract num banco único, sem versão de escape |

**Recomendação do desenvolvedor: a tabela nova.** O Princípio III pede caminho de volta declarado
para mudança destrutiva, e não há razão para gastar esse caminho quando a alternativa aditiva
entrega o mesmo. `ai_faq_items` também carrega semântica de FAQ (`question`/`answer`) que um trecho
de PDF não tem — reusá-la faria a coluna `question` existir vazia em metade das linhas, que é o
anti-pattern nº 1 da doutrina em outra forma.

**Não decidido aqui de propósito.** É modelagem nova, não detalhe de implementação, e a spec exige
que o desenho preceda a migration. Enquanto não houver decisão, T083 e T084 ficam bloqueadas — e a
F4 inteira depende delas para cumprir FR-004. Ver T140.

</details>

---

## Rastreabilidade e lacunas

### F1 — a âncora entra no `insert` da mensagem

Sem tabela nova. As citações passam a ser gravadas em `messages.metadata` **no insert**, não num
`update` posterior (research D5). É o que fecha FR-024 com a menor mudança possível, e é por isso
que F1 não tem schema além de uma linha de vocabulário.

### `message_groundings` (nova, tenant-aware) — **F5, migration 0126** ✅ construída

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
| `chunk_id` | `uuid` (**nullable** ao construir) | sem FK, pelo motivo ao lado; e nullable porque citação antiga pode não tê-lo, e recusá-la faria a resposta perder a âncora inteira em vez de perder um id |
| `source_ref` | `jsonb not null` | cópia do que importava na época — texto do trecho, título do material, escopo, data de atualização |
| `material_id` | `uuid` (**acrescentada**) | sem FK, mesmo motivo. É o que responde "que material ancorou respostas este mês" com índice, que era a razão de a tabela existir |
| `similarity` | `real` (**nullable** ao construir) | ausente vira `null`, nunca `0`: zero afirma "similaridade nenhuma", que é diferente de "não medida" e envenena média de painel |
| `created_at` | `timestamptz not null default now()` | |

**Por que `source_ref` duplica o conteúdo**: FR-023 exige que uma resposta antiga continue apontando
para o que estava valendo quando ela foi dada. Ponteiro puro apontaria para conteúdo já
reconstruído — o indexador reconstrói o acervo inteiro a cada mudança
(`workers/rag-indexer.ts:277-294`). A duplicação é deliberada e tem source of truth declarado: a
cópia é a verdade histórica, o material é a verdade atual.

**Duas coisas que só apareceram ao construir:**

**1. Índice único `(message_id, chunk_id)`.** Não estava no desenho. Reprocessar um turno depois de
um crash duplicaria a âncora, e com ela a contagem de "quantas vezes este material respondeu" — que
é número que vira decisão de curadoria.

**2. Sobre FR-024 ("ou a resposta é rastreável, ou não é enviada"), tomado ao pé da letra, esta
tabela não o cumpre — e não é ela quem deve.** A linha referencia `messages.id`, que só existe
depois que o envio criou a mensagem: gravar antes é impossível. O que cumpre o requisito é o que a
F1 já fez — a âncora nasce ATÔMICA com a mensagem, dentro do mesmo `insert`, porque viaja em
`metadata`. Mensagem sem âncora não chega a existir. Esta tabela é a projeção consultável daquilo,
e por isso a falha dela não pode derrubar o turno nem virar não-envio: a resposta já saiu, e o
cliente já leu. Mas também não some calada.

### Lacunas — derivadas, não tabela nova — **F5**

As lacunas de FR-028/FR-029 saem de `knowledge_searches`, que já grava `hits`, `top_score` e
`threshold` (`lib/agent-engine/agent/search-knowledge.ts:85-90`) e já é agregada em "sem resposta" e
"quase acertou" (`lib/ai/evolution/aggregate.ts:88-90`). O que falta é o **eixo de escopo** e o
**motivo da recusa**: duas colunas em `knowledge_searches` (`scope_id`, `refusal_reason`), não uma
tabela nova. Doutrina DIRC: **Calcular**, não Duplicar.

✅ **As duas colunas entraram na migration 0126.** `refusal_reason` ficou **sem CHECK**, pela exceção
de vocabulário aberto do CLAUDE.md: a constraint quebraria a re-aplicação do `baseline.sql` em modo
update no dia em que uma razão nova aparecesse numa linha já gravada — que é justamente o que o job
`invariants` roda. O vocabulário vive no TypeScript, em constante compartilhada. E `scope_id` tem
`on delete set null`, não cascade: o corretor que apaga um escopo não deve apagar a prova de que
faltava material nele — a lacuna perde o nome, não a existência.

⚠️ **A "pergunta real de exemplo" de FR-028 NÃO pode sair daqui.** A migration 0086 declara que
`knowledge_searches` não grava o texto da pergunta, de propósito: telemetria de retenção longa não
carrega conteúdo de conversa. O exemplo vem do aviso da Central (`agent_inbox_items`, kind
`assistance_without_grounding`), que é do próprio tenant, tem dono, tem tratativa e morre com o
contato na anonimização.

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
