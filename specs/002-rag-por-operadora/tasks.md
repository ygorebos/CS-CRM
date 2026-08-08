---
description: "Lista de tarefas — RAG por operadora de plano de saúde"
---

# Tasks: RAG por operadora de plano de saúde

**Input**: documentos de desenho em `/specs/002-rag-por-operadora/`

**Prerequisites**: [plan.md](plan.md) · [spec.md](spec.md) · [research.md](research.md) ·
[data-model.md](data-model.md) · [contracts/](contracts/) · [quickstart.md](quickstart.md)

**Testes são obrigatórios**, não opcionais. O Princípio XI da constituição
(*"Toda Entrega Nasce com Teste que Prova e que Vigia"*) exige teste que falharia sem a feature,
confirmado por **sabotagem**, e o gate certo por tipo de mudança. Tarefa sem critério de prova não
entra na lista (Papéis, Ritmo e Método).

**Organização**: uma fase por user story, **ordenadas na sequência das fatias do plano** (risco
decrescente), não na ordem numérica das histórias. Cada fase declara a fatia a que pertence — a
fatia é a unidade de entrega, e foi a resposta ao CHK037 do checklist da spec.

| Fatia | Fases | Resultado observável |
|---|---|---|
| **F1** | US2 | o agente para de inventar |
| **F2 + F3** | US7 | a instalação nasce sabendo, e nós curamos sem destruir |
| **F4** | US1, US4 | o corretor manda no que vale para ele |
| **F5** | US3, US5, US6 | o erro fica corrigível |

## Format: `[ID] [P?] [Story] Descrição`

- **[P]**: paralelizável (arquivo diferente, sem dependência de tarefa incompleta)
- **[Story]**: US1…US7, conforme `spec.md`
- Caminho de arquivo exato em toda descrição

## Convenções de caminho (deste repositório)

Monorepo Next.js. `lib/` e `workers/` para lógica, `app/app/…` para tela do tenant,
`app/admin/(protected)/…` para plataforma, `supabase/` para a tripla de schema,
`tests/{unit,invariants,e2e}/` para as três suítes.

---

## Phase 1: Setup

**Purpose**: destravar o processo e tornar a prova reproduzível. Nada aqui escreve código de
produto.

- [ ] T001 Abrir o PR da emenda constitucional a partir da branch `docs/constituicao-principio-x-catalogo-curado` (commit `3c2a06b4`) e mergeá-la na `main` — **bloqueia toda a fatia F2 em diante**; sem ela o Constitution Check do plano reprova no gate X
- [ ] T002 Atualizar `feat/002-rag-por-operadora` com a `main` após o merge da emenda (`git fetch origin && git merge origin/main`), conforme a higiene de branches
- [ ] T003 [P] Montar o ambiente fresco descrito em `quickstart.md` — Supabase local pg17, `baseline.sql` aplicado, `scripts/bootstrap-owner.ts`, WAHA + Redis via `docker compose`, `pnpm build && pnpm start`, e **`RESEND_API_KEY` ausente**
- [ ] T004 [P] Registrar a linha de jornada `[P0]` "a instalação já responde assistência" em `docs/testing/user-journey-map.md`, com o aviso de que ela **não é vigiada por gate** (o check `e2e` não é obrigatório e a spec irmã `vps-fresh-onboarding` está fora do CI — issue #63)
- [ ] T005 [P] Abrir issue de alinhamento para a divergência já reportada: `docs/current-state.md` afirma "81 migrations até 0092" e o repositório tem até **0115**

---

## Phase 2: Foundational (pré-requisito bloqueante)

**Purpose**: o mínimo que toda história precisa. Deliberadamente curto — uma fase foundational
inchada desfaria o fatiamento que o plano existe para garantir.

**⚠️ Nenhuma história começa antes desta fase fechar.**

- [ ] T006 Acrescentar os códigos de erro canônicos da feature em `lib/api/errors.ts` — `assistencia_sem_lastro`, `escopo_ja_existe`, `escopo_do_catalogo_nao_editavel`, `material_sem_texto_extraivel`, `formato_nao_suportado`, `material_muito_grande` (nunca string literal na rota)
- [ ] T007 [P] Criar o módulo de vocabulário do escopo de conhecimento em `lib/vocabulary/knowledge-scope.ts`, resolvendo o rótulo exibido ("Operadora" no nicho de validação) a partir da configuração — **schema e API são neutros de nicho, tela e rótulo carregam o vocabulário** (research D11, FR-033)
- [ ] T008 [P] Criar o léxico determinístico de "afirmação de assistência" como constante compartilhada em `lib/agent-engine/guardrails/lexico-assistencia.ts` — nunca literal espalhado (research D4)
- [ ] T009 [P] Registrar a peça nova no mapa vivo `docs/architecture/`, com ≥2 arestas de entrada e saída (Princípio II, item 13 do DoD)
- [ ] T010 Escrever o teste de completude de navegação esperado para as telas novas em `tests/unit/navegacao-completude.test.ts` (ou a allowlist com justificativa escrita) — tela sem porta reprova o build

**Checkpoint**: base pronta. A fatia F1 pode começar.

---

## Phase 3: User Story 2 — O cliente é atendido com informação verdadeira (Priority: P1) 🎯 MVP · **Fatia F1**

**Goal**: o agente para de inventar. Sem respaldo no acervo, recusa e escala — inclusive quando a
busca cai, inclusive quando o tenant não tem acervo nenhum.

**Independent Test**: num tenant **sem acervo**, 20 perguntas de assistência resultam em 20 recusas
com escalação e **zero** afirmações factuais; a mesma bateria com a busca derrubada de propósito dá
o mesmo resultado; e uma pergunta de conversão continua sendo respondida normalmente.

**Por que é o MVP e não a US1**: retira o maior risco do plano com a menor mudança de schema
possível — uma linha de vocabulário. Se o veto determinístico não couber na cadeia atual, é aqui
que se descobre, antes de qualquer partição.

### Tests for User Story 2 ⚠️

> Escrever primeiro e **confirmar que falham** antes de implementar.

- [ ] T011 [P] [US2] Teste da cadeia de gates para `assistance_grounding` em `lib/agent-engine/guardrails/before-send.test.ts` — veto quando é afirmação de assistência e `groundings` está vazio, `pass` quando há âncora, `pass` quando não é assistência
- [ ] T012 [P] [US2] Teste da classificação determinística em `lib/agent-engine/guardrails/assistance-grounding.test.ts` — inclusive o viés de A-03: na dúvida, classifica como assistência
- [ ] T013 [P] [US2] Teste de que busca indisponível é tratada como ausência de lastro em `lib/agent-engine/agent/search-knowledge.test.ts` (FR-013)
- [ ] T014 [P] [US2] Teste de **efeito** do guardrail `rag_must_hit` em `tests/unit/rag-must-hit-efeito.test.ts` — prova de que ligar a opção muda o comportamento, não de que o valor foi gravado (FR-015, SC-012)
- [ ] T015 [P] [US2] Spec E2E da jornada de recusa e escalação em `tests/e2e/assistencia-sem-lastro.spec.ts`, dirigindo o frontend e conferindo o item na Central

### Implementation for User Story 2

- [ ] T016 [US2] Criar migration `supabase/migrations/<ts>_0116_aviso_de_assistencia_sem_lastro.sql` acrescentando o `kind` `assistance_without_grounding`
- [ ] T017 [US2] Acrescentar o mesmo `kind` **na lista existente** do apêndice de `supabase/baseline.sql` (bloco da constraint `agent_inbox_items_kind_check`, hoje na linha ~8999) — nunca em bloco novo, sob pena de quebrar o `update.sh` de clones com vocabulário posterior
- [ ] T018 [US2] Registrar a migration 0116 em `supabase/migrations/MANIFEST.md` com o QUÊ e o PORQUÊ
- [ ] T019 [P] [US2] Implementar a classificação de "afirmação de assistência" em `lib/agent-engine/guardrails/assistance-grounding.ts`, consumindo o léxico de T008 — **nasce em arquivo próprio**, fora de `inbound-turn.ts`, que já tem 1789 linhas e é o hot path
- [ ] T020 [US2] Implementar o gate `assistanceGroundingGate` em `lib/agent-engine/guardrails/assistance-grounding.ts` conforme `contracts/busca-de-lastro.md`
- [ ] T021 [US2] Inserir o gate em `BEFORE_SEND_GATES` na posição (2.5), entre `lgpd` e `pacing`, em `lib/agent-engine/guardrails/before-send.ts`, e subir `BEFORE_SEND_CHAIN_VERSION` de 6 para 7 com o comentário de racional no padrão das versões anteriores
- [ ] T022 [US2] Fazer o gate nascer **desarmado por default** (`assistanceGroundingEnforced`) em `lib/agent-engine/guardrails/before-send.ts`, no mesmo padrão do `internalVocabularyGate` da v6
- [ ] T023 [US2] Armar o gate no caminho do agente em `lib/agent-engine/agent/inbound-turn.ts`, passando `groundings` e `isAssistanceClaim` ao contexto
- [ ] T024 [US2] Ligar `rag_must_hit` e `min_citations` de `lib/ai/guardrails-schema.ts` ao gate, para que a opção salva na tela passe a ter efeito em runtime (FR-015)
- [ ] T025 [US2] Remover a instrução *"responda com o que você já sabe e não invente fatos"* de `lib/agent-engine/agent/search-knowledge.ts:108` e devolver `knowledge_unavailable` como ausência de lastro
- [ ] T026 [US2] Mover a gravação das citações do `update` pós-envio para o **insert** da mensagem em `lib/agent-engine/agent/inbound-turn.ts` (hoje `:1484-1501`), eliminando o `catch` que "só loga" (FR-024, research D5)
- [ ] T027 [US2] Implementar a frase de recusa ao cliente sem vocabulário interno do produto, em `lib/agent-engine/agent/inbound-turn.ts`, com a expectativa realista de atendimento quando o sistema a souber (FR-011)
- [ ] T028 [US2] Disparar a escalação para humano no veto em `lib/agent-engine/agent/inbound-turn.ts`, reusando o mecanismo de handoff existente (A-09) — sem inventar fila nem canal
- [ ] T029 [US2] Abrir o item na Central via `insertInboxItem` de `lib/agent-engine/db/repository.ts`, com pergunta original, escopo (ou "desconhecido") e motivo, usando o `kind` de T016 (FR-012)
- [ ] T030 [US2] Registrar a entrada do gate no trace de auditoria em `lib/agent-engine/guardrails/before-send.ts` **inclusive quando desarmado** (`verdict: 'skipped'`), para que o ajuste do léxico seja feito sobre medição
- [ ] T031 [US2] Garantir em `lib/agent-engine/guardrails/assistance-grounding.ts` que a exigência **não alcança** o discurso de conversão: `isAssistanceClaim = false` passa direto (FR-020, SC-011)
- [ ] T032 [US2] **Sabotar e confirmar**: desarmar o gate em `lib/agent-engine/guardrails/before-send.ts` e verificar que os testes de T011–T014 ficam **vermelhos**; reverter. Teste que passa com a implementação sabotada não é teste (Princípio XI)
- [ ] T033 [US2] Rodar `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build` e `pnpm test:db`, e registrar evidência da jornada em `.superpowers/evidence/`

**Checkpoint**: o agente para de inventar. Entregável e demonstrável sozinho, sem catálogo nenhum.

---

## Phase 4: User Story 7 — O administrador de plataforma cura o catálogo (Priority: P1) · **Fatias F2 + F3**

**Goal**: a partição curada existe, viaja com o produto, é buscável com escopo, é curável pela
tela — e atualizar não destrói o que o dono da instalação corrigiu.

**Independent Test**: banco recém-aplicado do `baseline.sql`, corretor não carregou nada; um
cliente pergunta algo coberto pelo catálogo e recebe resposta ancorada, e um cliente de outro
escopo faz a mesma pergunta e é recusado. Reaplicar o schema num clone com edição local não perde
nem sobrescreve nada.

**⚠️ Bloqueada por T001**: a partição compartilhada só é constitucional sob a v2.0.0.

### Tests for User Story 7 ⚠️

- [ ] T034 [P] [US7] Invariante da **trava 1** em `tests/invariants/catalogo-escrita-so-plataforma.test.ts` — escrita no catálogo a partir de qualquer papel de tenant, inclusive `admin`, é barrada por todos os caminhos (SC-021)
- [ ] T035 [P] [US7] Invariante da **trava 2** em `tests/invariants/catalogo-sem-dado-de-ninguem.test.ts` — varredura da partição devolve zero dado pessoal e zero identificador de organização (SC-020)
- [ ] T036 [P] [US7] Invariante da **trava 3** em `tests/invariants/isolamento-com-catalogo.test.ts` — consulta que cruza as duas camadas devolve zero linhas de outra organização, com caso de controle provando que as linhas da org B existem (SC-007)
- [ ] T037 [P] [US7] Invariante de não-vazamento entre escopos em `tests/invariants/busca-escopo-nao-vaza.test.ts` — trecho de outro escopo nunca ancora, e `p_scope_id IS NULL` devolve só "vale para todos" (SC-005, FR-016, FR-017)
- [ ] T038 [P] [US7] Invariante de **não-destrutividade** da semeadura em `tests/invariants/semeadura-nao-sobrescreve.test.ts` — install, editar `seed`, criar `local`, update, update de novo: zero perdas, zero sobrescritas, zero duplicatas, e o estado após duas reaplicações idêntico ao de uma (SC-018)
- [ ] T039 [P] [US7] Invariante em `tests/invariants/indice-unico-de-fontes-removido.test.ts` de que `ai_knowledge_sources_unique_per_agent` **não existe** nem no banco instalado do zero nem no atualizado (brecha 10)
- [ ] T040 [P] [US7] Spec E2E da curadoria em `tests/e2e/catalogo-curadoria.spec.ts` — administrador de plataforma cria material e ele ancora resposta sem deploy; `admin` de organização é barrado na tela e na rota
- [ ] T041 [P] [US7] Spec E2E da instalação fresca em `tests/e2e/instalacao-nasce-sabendo.spec.ts` — sem material do corretor, pergunta coberta pelo catálogo é respondida ancorada (SC-017)

### Implementation — schema da partição curada (F2)

- [ ] T042 [US7] Criar migration `supabase/migrations/<ts>_0117_catalogo_curado_particao.sql` com `catalog_scopes`, `catalog_materials` e `catalog_chunks` conforme `data-model.md` — **sem `organization_id`**, com os checks de `applies_to_all` e o unique `(slug, version)`
- [ ] T043 [US7] Ligar RLS nas três tabelas em `supabase/migrations/<ts>_0117_catalogo_curado_particao.sql`: leitura para `authenticated`, escrita condicionada a `fn_is_platform_admin()` (trava 1)
- [ ] T044 [US7] Criar migration `supabase/migrations/<ts>_0118_escopos_por_tenant_e_vinculo.sql` com `knowledge_scopes` (tenant-aware, RLS `tenant_isolation_knowledge_scopes_all`), as colunas de vínculo em `contacts` e a função idempotente `fn_sincronizar_escopos_do_catalogo(p_organization_id)`
- [ ] T045 [US7] Revogar `execute` das **duas** origens (`public` e `anon`) de toda função nova criada em `public`, nas migrations 0118/0119 e no apêndice de `supabase/baseline.sql` — sem isso o PostgREST a expõe pela anon key
- [ ] T046 [US7] Criar migration `supabase/migrations/<ts>_0119_busca_de_lastro.sql` com `fn_buscar_lastro` conforme `contracts/busca-de-lastro.md` — tenant e acervo ativo derivados de `p_agent_id`, **nunca** recebidos do chamador
- [ ] T047 [US7] Implementar em `supabase/migrations/<ts>_0119_busca_de_lastro.sql` o filtro por escopo, o corte de escopo desativado, o corte de material vencido e a precedência de camada **dentro do mesmo balde** (research D7, brecha 8)
- [ ] T048 [US7] Revogar `fn_buscar_lastro` de `public`, `anon` e `authenticated` em `supabase/migrations/<ts>_0119_busca_de_lastro.sql`, concedendo só a `service_role`
- [ ] T049 [US7] **Forward-fix**: revogar `authenticated` de `retrieve_top_k_chunks` no apêndice de `supabase/baseline.sql` — verificado que nenhum chamador autenticado existe (worker e MCP usam admin client; o agent-engine usa Pool `pg`)
- [ ] T050 [US7] Espelhar as três migrations no apêndice idempotente de `supabase/baseline.sql`, em blocos rotulados `-- ---- <coisa> (migration NNNN) ----`
- [ ] T051 [US7] Registrar 0117, 0118 e 0119 em `supabase/migrations/MANIFEST.md`
- [ ] T052 [US7] Regenerar `lib/database.types.ts`

### Implementation — semeadura (F2)

- [ ] T053 [US7] Escrever o bloco de semeadura no apêndice de `supabase/baseline.sql` com `insert … on conflict (slug, version) do nothing` — **nunca `do update`**, conforme `contracts/semeadura-do-catalogo.md`
- [ ] T054 [US7] Embutir em `supabase/baseline.sql` os embeddings pré-computados como literal `vector(1536)`, com `embedding_model` registrado ao lado (research D6) e o custo de tamanho declarado no comentário do bloco
- [ ] T055 [US7] Fechar o bloco de `supabase/baseline.sql` chamando `fn_sincronizar_escopos_do_catalogo` para **toda organização existente** — é o que faz escopo curado novo alcançar clone antigo no `update.sh`
- [ ] T056 [US7] Chamar a mesma função na criação de organização (`scripts/bootstrap-owner.ts` e o fluxo de onboarding), para que tenant novo em instalação antiga também nasça enxergando o catálogo
- [ ] T057 [P] [US7] Criar `workers/catalog-reindexer.ts`, que re-embeda **apenas** quando o modelo configurado difere do `embedding_model` registrado, com dono declarado na Central quando travar
- [ ] T058 [P] [US7] Escrever `scripts/exportar-catalogo-para-baseline.ts`, que exporta as linhas `origin='seed'` da instalação de curadoria para o bloco do apêndice de `supabase/baseline.sql`, com os embeddings já calculados

### Implementation — busca e runtime (F2)

- [ ] T059 [US7] Trocar a chamada de `retrieve_top_k_chunks` por `fn_buscar_lastro` em `lib/agent-engine/agent/search-knowledge.ts`, passando `p_agent_id` e o escopo do contato
- [ ] T060 [US7] Resolver o escopo do contato no turno em `lib/agent-engine/agent/inbound-turn.ts` e perguntar **uma única vez** em linguagem natural quando desconhecido, gravando com `knowledge_scope_source = 'conversa'` (FR-017, A-05)
- [ ] T061 [US7] Garantir em `lib/agent-engine/agent/inbound-turn.ts` que o sistema **não infere** escopo por ser o único cadastrado, pelo mais usado ou por semelhança de texto (FR-017)
- [ ] T062 [US7] Implementar em `lib/agent-engine/agent/inbound-turn.ts` a resposta por escopo, separadamente, quando a pergunta cruza dois — cada parte com sua âncora, a parte sem lastro recusada isoladamente (FR-018)

### Implementation — superfícies (F2 + F3)

- [ ] T063 [P] [US7] Criar as rotas de plataforma `app/api/v1/catalog/scopes/…` e `app/api/v1/catalog/materials/…` conforme `contracts/rotas-http.md`, com Zod, `ok()`/`fail()`, audit log e guarda de `is_platform_admin`
- [ ] T064 [P] [US7] Criar a rota `app/api/v1/catalog/gaps/route.ts`, restrita à própria instalação — nenhuma lacuna atravessa a fronteira de volta ao fabricante (trava 7, A-18)
- [ ] T065 [US7] Fazer a edição de material curado criar **versão nova** (`version + 1`) em `app/api/v1/catalog/materials/[id]/route.ts`, em vez de reescrever a existente (trava 6, FR-037)
- [ ] T066 [P] [US7] Criar a tela de curadoria em `app/admin/(protected)/catalogo/page.tsx` e `_client.tsx`, com a porta declarada na navegação do `app/admin/(protected)`
- [ ] T067 [P] [US7] Criar a rota de leitura do tenant `app/api/v1/knowledge-scopes/route.ts`, devolvendo espelhos do catálogo e escopos próprios juntos, com `origin` visível
- [ ] T068 [P] [US7] Criar a tela do tenant em `app/app/ai/conhecimento/operadoras/page.tsx` e `_client.tsx`, em modo leitura, com o rótulo vindo do vocabulário de T007
- [ ] T069 [US7] Declarar a tela nova em `lib/navigation/registry.ts` com grupo, `minRole` e descrição buscável — tela sem porta reprova o build
- [ ] T070 [US7] Garantir que **nenhuma** tela desta feature entra no caminho de publicar o agente, conferido em `lib/navigation/registry.ts` e em `tests/e2e/vps-fresh-onboarding.spec.ts` (FR-031, SC-011)

### Verificação da fatia

- [ ] T071 [US7] **Registrar a linha de base de SC-006** com 1 escopo carregado: rodar a bateria de perguntas e anotar o p95 do tempo até a resposta, em `.superpowers/evidence/` — é a única execução em que ela pode ser medida honestamente
- [ ] T072 [US7] Provar install + update + update-de-novo num Postgres descartável (`pgvector/pgvector:pg17`), conforme `contracts/semeadura-do-catalogo.md`
- [ ] T073 [US7] **Sabotar e confirmar**: quebrar o filtro de escopo em `supabase/migrations/<ts>_0119_busca_de_lastro.sql` e verificar que `tests/invariants/busca-escopo-nao-vaza.test.ts` fica vermelho; reverter
- [ ] T074 [US7] Rodar a sequência completa de gates e registrar evidência visual da jornada de instalação fresca em `.superpowers/evidence/` — **a regressão dela não é protegida por nenhum job**

**Checkpoint**: a instalação nasce sabendo, e o que curamos chega ao clone sem apagar nada dele.

---

## Phase 5: User Story 1 — O corretor complementa o catálogo (Priority: P1) · **Fatia F4**

**Goal**: o corretor acrescenta escopo próprio, sobe material que de fato vira trecho buscável, e o
que ele escreve vence o catálogo.

**Independent Test**: instalação fresca com catálogo semeado; acrescentar um escopo novo e
sobrescrever um assunto de um escopo do catálogo prova as duas camadas e a precedência entre elas.

### Tests for User Story 1 ⚠️

- [ ] T075 [P] [US1] Invariante de precedência de camada em `tests/invariants/precedencia-de-camada.test.ts` — material do tenant vence o do catálogo **no mesmo balde**, e não vence fora dele (SC-019, FR-035)
- [ ] T076 [P] [US1] Teste do ingest de PDF em `lib/ai/rag/ingest/policy.test.ts` — o texto extraído **persiste** e vira item indexável, em vez de ser usado só para validar
- [ ] T077 [P] [US1] Teste do indexador aceitando material que não é par pergunta/resposta em `workers/rag-indexer.test.ts`
- [ ] T078 [P] [US1] Spec E2E do lote de materiais inválidos em `tests/e2e/material-nada-em-silencio.spec.ts` — 100% terminam em estado explícito, zero em "salvo sem conteúdo buscável" (SC-014)

### Implementation for User Story 1

- [ ] T079 [US1] Criar migration `supabase/migrations/<ts>_0120_acervo_multi_material.sql` acrescentando `scope_id`, `applies_to_all` e `valid_until` a `ai_knowledge_sources`, e `scope_id` + `applies_to_all` a `ai_chunks`
- [ ] T080 [US1] **Backfill antes do check** em `supabase/migrations/<ts>_0120_acervo_multi_material.sql`: marcar as linhas legadas de `ai_knowledge_sources` como `applies_to_all = true` — é o mais próximo do que elas são hoje e não perde conteúdo de nenhum clone
- [ ] T081 [US1] Derrubar o índice `ai_knowledge_sources_unique_per_agent` na migration **e no apêndice de `supabase/baseline.sql`** — o snapshot o recria em toda instalação nova e o apêndice roda depois (brecha 10)
- [ ] T082 [US1] Registrar a 0120 em `supabase/migrations/MANIFEST.md` e regenerar `lib/database.types.ts`
- [ ] T083 [US1] Persistir o texto extraído de PDF/Markdown em `lib/ai/rag/ingest/policy.ts` (hoje `:94-126` extrai só para validar e devolve a contagem)
- [ ] T084 [US1] Fazer `workers/rag-indexer.ts` ler material que não é par pergunta/resposta (hoje `:313` lê exclusivamente pares e encerra com `skip("no_content_to_index")`)
- [ ] T085 [US1] Propagar `scope_id` e `applies_to_all` da fonte para o trecho em `workers/rag-indexer.ts`, e levar `tags`/`locale` de `ai_faq_items` ao trecho, que hoje morrem na ingestão
- [ ] T086 [P] [US1] Criar a rota `POST /api/v1/knowledge-scopes` em `app/api/v1/knowledge-scopes/route.ts`, com `Idempotency-Key` e o `409 escopo_ja_existe` que também cobre colisão com espelho do catálogo
- [ ] T087 [P] [US1] Criar `PATCH /api/v1/knowledge-scopes/{id}` em `app/api/v1/knowledge-scopes/[id]/route.ts`, com renomear, ligar/desligar e o `403 escopo_do_catalogo_nao_editavel`
- [ ] T088 [P] [US1] Criar `app/api/v1/knowledge-scopes/[id]/materials/route.ts` (`POST` e `GET`), declarando formato e tamanho máximo **antes** de aceitar e recusando com motivo acionável em português (FR-007)
- [ ] T089 [P] [US1] Estender `app/api/v1/contacts/[id]/route.ts` para aceitar `knowledge_scope_id` e gravar `knowledge_scope_source = 'cadastro'`, que **vence** o que veio da conversa (FR-017)
- [ ] T090 [US1] Substituir os 4 slots fixos por lista de N materiais por escopo em `app/app/ai/knowledge/sources/_client.tsx` (hoje `:22` e `:56-68`), com estado inequívoco por material e contagem de trechos (FR-005)
- [ ] T091 [US1] Exibir em `app/app/ai/conhecimento/operadoras/_client.tsx` quais escopos vieram do catálogo e quais são próprios, com os dois caminhos disponíveis ao corretor: desativar para si ou sobrepor com material próprio
- [ ] T092 [US1] Exigir papel de gestor ou superior e emitir `api_audit_log` em todas as mutações de `app/api/v1/knowledge-scopes/` (FR-032)
- [ ] T093 [US1] **Sabotar e confirmar** a precedência: inverter o desempate em `supabase/migrations/<ts>_0119_busca_de_lastro.sql` e verificar que `tests/invariants/precedencia-de-camada.test.ts` fica vermelho; reverter
- [ ] T094 [US1] Cronometrar SC-003 (primeiro material próprio, do login ao primeiro trecho buscável, ≤5 min) e registrar evidência em `.superpowers/evidence/`

**Checkpoint**: o corretor manda no que vale para ele.

---

## Phase 6: User Story 4 — A segunda operadora sem parar nada (Priority: P2) · **Fatia F4**

**Goal**: acrescentar escopo não abre janela sem base, e uma pergunta sobre B nunca é respondida com
material de A.

**Independent Test**: com um escopo já carregado, adicionar o segundo e fazer perguntas cruzadas
durante todo o processo.

### Tests for User Story 4 ⚠️

- [ ] T095 [P] [US4] Teste de que a versão nova do acervo só é ativada depois de todos os trechos entrarem, em `workers/rag-indexer.test.ts` — falha no meio deixa a anterior valendo por inteiro (FR-006)
- [ ] T096 [P] [US4] Spec E2E de convivência em `tests/e2e/segundo-escopo-sem-janela.spec.ts` — perguntas sobre o primeiro escopo continuam respondidas durante toda a carga do segundo (SC-004)

### Implementation for User Story 4

- [ ] T097 [US4] Garantir em `workers/rag-indexer.ts` que carregar material **não** desativa, apaga ou substitui material não relacionado (FR-003)
- [ ] T098 [US4] Garantir em `workers/rag-indexer.ts` que falha no processamento preserva o acervo anterior por inteiro, sem base parcial (FR-006)
- [ ] T099 [US4] Implementar remoção e desativação de escopo em `app/api/v1/knowledge-scopes/[id]/route.ts`, tornando o material inerte para respostas novas **imediatamente** e preservando a rastreabilidade das já dadas (FR-008)
- [ ] T100 [US4] Fazer `app/app/ai/conhecimento/operadoras/_client.tsx` listar N escopos sem limite fixo, com o estado de cada um (FR-003, US4 cenário 3)
- [ ] T101 [US4] Cronometrar SC-004 (segundo material em ≤2 min, zero janela sem base) e registrar evidência em `.superpowers/evidence/`

**Checkpoint**: escopos convivem, e nenhum vaza para o outro.

---

## Phase 7: User Story 3 — O corretor confere de onde veio a resposta (Priority: P1) · **Fatia F5**

**Goal**: a origem aparece sem modo de depuração, diz a camada, e sobrevive à atualização do
material.

**Independent Test**: uma resposta de assistência já enviada basta — a rastreabilidade se verifica
sozinha na tela, com o debug desligado.

### Tests for User Story 3 ⚠️

- [ ] T102 [P] [US3] Invariante de rastreabilidade histórica em `tests/invariants/rastreabilidade-sobrevive-reindex.test.ts` — resposta antiga continua apontando para o conteúdo que valia na época, depois de o acervo ser reconstruído (FR-023)
- [ ] T103 [P] [US3] Spec E2E em `tests/e2e/origem-sem-debug.spec.ts` — chegar ao texto do trecho em no máximo 3 interações de tela, com o modo de depuração **desligado** (SC-008)

### Implementation for User Story 3

- [ ] T104 [US3] Criar migration `supabase/migrations/<ts>_0121_rastreabilidade_validade_lacunas.sql` com `message_groundings` (tenant-aware, `layer`, `source_ref` com a cópia histórica), espelhá-la no apêndice de `supabase/baseline.sql` e registrar no MANIFEST
- [ ] T105 [US3] Gravar `message_groundings` no mesmo caminho que envia a mensagem, em `lib/agent-engine/agent/inbound-turn.ts` — ou a resposta é rastreável, ou não é enviada (FR-024)
- [ ] T106 [US3] Tirar a citação de trás do toggle de depuração em `components/inbox/MessageBubble.tsx` (hoje `:40-43`) e `hooks/ai/useDebugToggle.ts`
- [ ] T107 [US3] Exibir em `components/inbox/MessageBubble.tsx` o texto do trecho, o material, o escopo, a data de atualização **e a camada** de origem (FR-022, FR-039)
- [ ] T108 [US3] Tratar em `components/inbox/MessageBubble.tsx` a ausência de origem em resposta que **não** é de assistência como normal, sem sinalizar problema (US3 cenário 4)

**Checkpoint**: o erro vira corrigível, e o corretor sabe a quem cobrar a correção.

---

## Phase 8: User Story 5 — O sistema mostra o que falta carregar (Priority: P2) · **Fatia F5**

**Goal**: o mecanismo anti-morte do acervo. As recusas viram lista acionável.

**Independent Test**: provocar duas recusas por falta de material e verificar que aparecem
agrupadas, com "não há nada" separado de "quase acertou".

### Tests for User Story 5 ⚠️

- [ ] T109 [P] [US5] Teste da agregação por escopo e por assunto em `lib/ai/evolution/aggregate.test.ts`, distinguindo "nada encontrado" de "encontrado insuficiente" (FR-029)
- [ ] T110 [P] [US5] Spec E2E em `tests/e2e/lacunas-acionaveis.spec.ts` — carregar o material que cobre uma lacuna a faz sumir da lista (SC-013)

### Implementation for User Story 5

- [ ] T111 [US5] Acrescentar `scope_id` e `refusal_reason` a `knowledge_searches` em `supabase/migrations/<ts>_0121_rastreabilidade_validade_lacunas.sql` e no apêndice de `supabase/baseline.sql` — **derivar, não duplicar** (DIRC: Calcular)
- [ ] T112 [US5] Gravar as duas colunas na recusa, em `lib/agent-engine/agent/search-knowledge.ts`
- [ ] T113 [US5] Agrupar por escopo e assunto em `lib/ai/evolution/aggregate.ts`, mantendo a separação entre sem-resposta e quase-acertou (hoje `:88-90, 153, 223-224`)
- [ ] T114 [US5] Exibir as lacunas com contagem e ao menos uma pergunta real de exemplo em `components/ai/EvolutionGaps.tsx`
- [ ] T115 [US5] Servir a mesma leitura ao administrador de plataforma em `app/admin/(protected)/catalogo/_client.tsx`, pela rota de T064, restrita à própria instalação

**Checkpoint**: o acervo tem quem o alimente depois da primeira semana.

---

## Phase 9: User Story 6 — Material vencido não vira resposta (Priority: P3) · **Fatia F5**

**Goal**: informação desatualizada sobre rede e cobertura não ancora, e o corretor é avisado antes.

**Independent Test**: carregar material já vencido e verificar que ele nunca ancora resposta.

### Tests for User Story 6 ⚠️

- [ ] T116 [P] [US6] Invariante de que material vencido devolve zero linhas em `tests/invariants/material-vencido-nao-ancora.test.ts` (SC-009, FR-026)
- [ ] T117 [P] [US6] Teste de que material **sem** validade declarada ancora normalmente em `tests/invariants/material-vencido-nao-ancora.test.ts` — datar é opcional e não pode travar o corretor apressado (FR-025)

### Implementation for User Story 6

- [ ] T118 [US6] Expor `valid_until` como campo opcional na tela de material, em `app/app/ai/knowledge/sources/_client.tsx`
- [ ] T119 [US6] Confirmar em `tests/invariants/material-vencido-nao-ancora.test.ts` que `fn_buscar_lastro` corta material vencido (implementado em T047), inclusive quando o vencido era o **único** que responderia
- [ ] T120 [US6] Criar `workers/validade-de-material.cron.ts`, que avisa o corretor antes do vencimento com nome do material e escopo, reusando a Central (FR-027)
- [ ] T121 [US6] Rodar `pnpm test:db` e registrar evidência em `.superpowers/evidence/`

**Checkpoint**: todas as histórias funcionam independentemente.

---

## Phase 10: Polish & Cross-Cutting

- [ ] T122 [P] Fazer a superfície de teste do agente exercer a mesma regra de lastro da conversa real em `lib/ai/agents/avaliar-resposta-de-teste.ts` — ou declarar na própria tela o que ela **não** avaliou (FR-034, SC-015)
- [ ] T123 [P] Garantir em `lib/agent-engine/guardrails/assistance-grounding.ts` que conhecimento gerado automaticamente a partir de conversas **não** ancora afirmação de assistência (FR-040), com teste em `tests/invariants/aprendizado-nao-ancora-assistencia.test.ts`
- [ ] T124 Medir SC-006 com 20 escopos carregados, comparar com a linha de base de T071 e registrar em `.superpowers/evidence/` — critério é a diferença (≤25% no p95), não um número absoluto
- [ ] T125 [P] Aplicar `checkRateLimit` de `lib/ai/dispatcher/rate-limit.ts` nas rotas novas de `app/api/v1/`, **implementando junto** — ele existe hoje em 2 pontos do sistema inteiro e não pode ser herdado como pronto
- [ ] T126 [P] Atualizar `docs/architecture/` e `docs/testing/user-journey-map.md` com o que foi entregue e os achados
- [ ] T127 [P] Atualizar a spec e o `CLAUDE.md` se algum contrato mudou na execução (item 10 do DoD)
- [ ] T128 Rodar `quickstart.md` de ponta a ponta, no ambiente fresco, e registrar evidência visual de cada fatia em `.superpowers/evidence/`
- [ ] T129 Responder o Living System Checklist (`docs/doctrine/sistema-vivo.md`) e os 14 itens do Definition of Done

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências. **T001 bloqueia a Phase 4 em diante** — a partição
  compartilhada só é constitucional sob a v2.0.0.
- **Foundational (Phase 2)**: depende do Setup. Bloqueia todas as histórias.
- **US2 / F1 (Phase 3)**: depende só da Foundational. **Não depende de T001** — não toca a partição.
- **US7 / F2+F3 (Phase 4)**: depende da Phase 3 (o gate precisa existir para o escopo ter efeito) e
  de T001.
- **US1 e US4 / F4 (Phases 5 e 6)**: dependem da Phase 4 (precisam de `knowledge_scopes`).
- **US3, US5, US6 / F5 (Phases 7, 8 e 9)**: dependem da Phase 4. Independentes entre si.
- **Polish (Phase 10)**: depende das fatias que se quer entregar.

### Ordem por risco, não por prioridade numérica

A US2 vem antes da US1 embora as duas sejam P1. O plano ordena por **risco decrescente**: o veto
determinístico é o que pode invalidar tudo, e ele não precisa de nenhuma tabela nova. Descobrir
tarde que ele não cabe na cadeia atual custaria o schema inteiro.

### Dentro de cada história

Testes escritos e **vermelhos** antes da implementação · schema antes de runtime · runtime antes de
tela · sabotagem confirmada antes do checkpoint.

### Parallel Opportunities

- T003, T004 e T005 no Setup
- T007, T008 e T009 na Foundational
- Todos os testes de uma história marcados [P] — arquivos diferentes
- Na Phase 4: T034–T041 (invariantes e specs) juntos; depois T063, T064, T066, T067, T068 (rotas e
  telas em arquivos distintos)
- Na Phase 5: T086–T089 (quatro rotas, quatro arquivos)
- **Não paralelizável**: T016–T018, T042–T052, T079–T082 — todas mexem em `supabase/baseline.sql`
  e no MANIFEST, e conflito nesses dois arquivos é retrabalho garantido

---

## Parallel Example: User Story 7

```bash
# Invariantes e specs, todos em arquivos distintos:
Task: "Invariante da trava 1 em tests/invariants/catalogo-escrita-so-plataforma.test.ts"
Task: "Invariante da trava 2 em tests/invariants/catalogo-sem-dado-de-ninguem.test.ts"
Task: "Invariante da trava 3 em tests/invariants/isolamento-com-catalogo.test.ts"
Task: "Invariante de não-vazamento em tests/invariants/busca-escopo-nao-vaza.test.ts"
Task: "Invariante de não-destrutividade em tests/invariants/semeadura-nao-sobrescreve.test.ts"

# Depois do schema, as superfícies:
Task: "Rotas de plataforma em app/api/v1/catalog/scopes/…"
Task: "Tela de curadoria em app/admin/(protected)/catalogo/page.tsx"
Task: "Tela do tenant em app/app/ai/conhecimento/operadoras/page.tsx"
```

---

## Implementation Strategy

### MVP: US2 sozinha (Fatia F1)

1. Phase 1 (Setup) — exceto T001, que só bloqueia da Phase 4 em diante
2. Phase 2 (Foundational)
3. Phase 3 (US2)
4. **PARE E VALIDE**: 20 perguntas sem lastro → 20 recusas; conversão intacta; sabotagem vermelha
5. Entregável. O agente para de inventar, e nenhuma tabela nova foi criada

### Entrega incremental

Cada fatia é utilizável sozinha e não quebra a anterior:

1. **F1** → o agente para de inventar
2. **F2+F3** → a instalação nasce sabendo, e atualizar não destrói
3. **F4** → o corretor manda no que vale para ele
4. **F5** → o erro fica corrigível

### O que não pode ser esquecido entre fatias

- **`gov:verify` verde não é pronto.** Ele não cobre `test:db` nem `test:e2e`. Toda fatia com schema
  roda `pnpm test:db` localmente antes do PR.
- **A prova de F2 não tem gate.** O check `e2e` não é obrigatório e a jornada irmã de instalação
  fresca está fora do CI. A evidência é manual, e sem ela a regressão passa.
- **Verde parcial não é verde.** Declare qual suíte rodou e qual não rodou.
