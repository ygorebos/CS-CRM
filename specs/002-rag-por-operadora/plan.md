# Implementation Plan: RAG por operadora de plano de saúde

**Branch**: `002-rag-por-operadora` | **Date**: 2026-08-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-rag-por-operadora/spec.md`

---

## Resultado observável

Um corretor instala o produto numa VPS limpa, faz login e, **antes de carregar qualquer coisa**,
um cliente pergunta no WhatsApp "perdi meu boleto da [operadora], como faço?" — e recebe o
procedimento correto, com o corretor conseguindo abrir na conversa o trecho exato que originou
aquela resposta e de qual material ele veio. Pergunta que o acervo não cobre **não recebe resposta
factual**: o cliente ouve que vai ser confirmado por uma pessoa, a conversa é escalada, e o aviso
com a pergunta original aparece na Central.

O que prova que acabou: as duas perguntas acima, na mesma sessão, num banco recém-criado do
`baseline.sql`.

---

## Summary

A feature acrescenta um **eixo de operadora** e uma **camada curada** ao RAG que já existe, e
transforma a citação — hoje enfeite carimbado depois do envio — em **condição de envio**.

Três mudanças estruturais, em ordem de risco:

1. **O veto de lastro.** Um gate novo na cadeia determinística de `before-send` barra toda
   afirmação de assistência sem trecho âncora. Hoje a única defesa é texto de prompt, e a citação
   é anexada por um `update` posterior cujo erro "só loga".
2. **A partição curada.** Tabelas novas, **sem `organization_id`**, para o catálogo que o
   fabricante mantém e distribui semeado no `baseline.sql`. É exceção declarada ao Princípio I e
   só existe sob as sete travas do Princípio X v2.0.0.
3. **O escopo por operadora na recuperação.** Uma função de busca nova que une as duas camadas
   filtrando pela operadora do contato, com precedência do material do tenant — e que **não aceita
   o tenant como parâmetro do chamador**, ao contrário da atual.

O acervo próprio do corretor deixa de ter 4 slots fixos por agente e passa a suportar N materiais
por operadora, com PDF que de fato vira trecho buscável.

---

## Fatias

Ordem por **risco decrescente**: o que pode invalidar o plano inteiro vem primeiro. Cada fatia é
utilizável sozinha ao fim dela — nenhuma depende da seguinte para entregar valor.

O CHK037 do checklist da spec está aberto exatamente por isto: o primeiro corte não cabe em duas
jornadas. Estas cinco fatias são a resposta.

### F1 — O agente para de inventar *(≈2 jornadas)*

**Observável**: num tenant sem acervo nenhum, 20 perguntas de assistência resultam em 20 recusas +
escalações e 0 afirmações factuais — inclusive com a busca de conhecimento derrubada de propósito.
A conversão continua funcionando integralmente.

Retira o maior risco do plano com a **menor mudança de schema possível**: uma linha no vocabulário
de `agent_inbox_items` (migration 0116), e nada mais. Nenhuma tabela nova. Se o veto determinístico
não for viável na cadeia atual, é aqui que se descobre — antes de qualquer partição.

Entrega: gate `assistance_grounding` na cadeia (versão 6 → 7); classificação determinística de
"afirmação de assistência"; `knowledge_unavailable` tratado como ausência de lastro em vez de
"responda com o que você já sabe"; citação virando invariante de envio, gravada no **insert** da
mensagem (`messages.metadata`, que já existe) em vez do `update` pós-envio; o guardrail
`rag_must_hit`, hoje salvo e nunca avaliado, passando a ter efeito observável; recusa gerando
escalação + item na Central.

Cobre: FR-009 a FR-015, FR-020, FR-024, A-02, A-03 · SC-001, SC-002, SC-011, SC-012 (parte).

### F2 — A instalação nasce sabendo *(≈2 jornadas)*

**Observável**: banco recém-aplicado do `baseline.sql`, corretor não carregou nada. Com o escopo do
catálogo **desligado** — que é como ele nasce (A-20) — a pergunta é recusada e o aviso oferece
ligá-lo; ligado em um clique, a mesma pergunta recebe resposta ancorada, e um cliente de outra
operadora pergunta o mesmo e é recusado.

Entrega: a partição curada (`catalog_*`), a tabela `knowledge_scopes` por tenant com ponteiro para o
catálogo, **o eixo de escopo e validade no acervo que já existe** (`ai_knowledge_sources`,
`ai_chunks`, com backfill e o fim do índice único), o vínculo contato↔escopo pelas duas vias, a
função de busca nova com escopo por operadora e sem tenant vindo do chamador, e a semeadura
versionada com embeddings pré-computados. Tela do tenant: lista de operadoras com o interruptor de
ligar/desligar, a porta declarada no registry e o rótulo vindo do vocabulário configurável, não
cravado. O aviso de FR-042 nasce aqui: recusar sem dizer que a resposta está no produto, a um
clique, é o pior desfecho da feature.

**Registra a linha de base de SC-006 aqui, ANTES da semeadura**, com 1 escopo carregado à mão —
depois de semear o catálogo esse número deixa de existir, e medi-lo no fim da fatia seria inventá-lo.

Cobre: FR-016, FR-017, FR-018, FR-019, FR-030, FR-031, FR-033, FR-038, FR-041, FR-042 · SC-005,
SC-007, SC-017, SC-020, SC-021.

### F3 — Nós curamos, e atualizar não destrói *(≈2 jornadas)*

**Observável**: administrador de plataforma cria material pela tela e ele ancora resposta na hora,
sem deploy; reaplicar o schema de atualização num clone com material editado localmente não perde
nem sobrescreve nada, e reaplicar duas vezes dá o mesmo estado que uma.

Entrega: superfície de curadoria em `app/admin/(protected)/catalogo/`, a regra de semeadura que só
acrescenta versão, o estado **adotado localmente** — material editado no clone trava as versões
semeadas seguintes, que chegam inertes até serem aceitas — e as invariantes das travas 1, 2 e 3 do
Princípio X.

**Por que a adoção local existe** (decisão de 2026-08-08): "só acrescenta versão" mais "desempate
por recência" significa que a versão nova, sempre mais recente, apagaria a correção local **no
comportamento** enquanto o banco continuava intacto. SC-018 passaria contando linhas e o requisito
falharia respondendo. Por isso SC-018 passou a medir a resposta.

Cobre: FR-036, FR-037, FR-028 (lado plataforma) · SC-010, SC-018.

### F4 — O corretor manda no que vale para ele *(≈2 jornadas)*

**Observável**: o corretor sobe um PDF de uma operadora e ele vira trecho buscável de verdade, com
contagem na tela; sobrepõe um assunto do catálogo e a resposta passa a ancorar no material dele;
acrescenta uma operadora que não existe em lugar nenhum.

Entrega: N materiais por operadora, estados de processamento visíveis, extração de PDF que persiste
(hoje ela valida e descarta), precedência de camada **com a divergência registrada e visível ao
corretor** — a segunda metade de FR-035, que não tinha tarefa nenhuma —, e desativação de operadora
do catálogo para o próprio tenant. O fim do índice único de 4 slots por agente saiu daqui e foi
para a F2: a função de busca precisa dele derrubado uma fatia antes.

Cobre: FR-001 a FR-008, FR-035, FR-032 · SC-003, SC-004, SC-014, SC-016, SC-019.

### F5 — O erro fica corrigível *(≈2 jornadas)*

**Observável**: o corretor abre uma conversa antiga, com o modo de depuração desligado, e chega em
3 cliques ao texto do trecho e à camada de onde ele veio; a tela de conhecimento lista o que os
clientes perguntaram e o acervo não cobria, separando "não há nada" de "quase acertou"; material
vencido não ancora.

Entrega: origem visível sem depuração, rastreabilidade sobrevivendo à atualização do material,
lacunas agrupadas por operadora e assunto, validade opcional com aviso antes do vencimento, e a
superfície de teste exercendo a mesma regra de lastro da conversa real.

Cobre: FR-021 a FR-023, FR-025 a FR-029, FR-034, FR-039, FR-040 · SC-006, SC-008, SC-009, SC-012,
SC-013, SC-015.

---

## Technical Context

**Language/Version**: TypeScript 6 estrito, Node 22, Next.js 16 App Router (React 19)

**Primary Dependencies**: Supabase (`@supabase/ssr`, admin client), `pg` (Pool direto no
agent-engine), `pgvector`, Vercel AI SDK v7 via AI Gateway, Zod, Playwright, Vitest

**Storage**: Postgres (Supabase). Duas partições novas: `catalog_*` **sem** `organization_id`
(compartilhada pela instalação) e `knowledge_scopes` + colunas em `contacts` **com**
`organization_id` e RLS. Embeddings em `vector(1536)`, mesmo tipo de `ai_chunks`. O nome estrutural
é **escopo de conhecimento**, não "operadora" — "operadora" é o rótulo configurável que o nicho de
validação usa (FR-033, FR-041; research D11).

**Testing**: `pnpm test:db` é o gate certo — a feature toca schema, RLS e isolamento. Playwright
pela tela para F2, F4 e F5 (Princípio IV). `test:unit` para a cadeia de gates de F1, com sabotagem
confirmada (Princípio XI).

**Target Platform**: self-host em VPS (Docker Compose) e Vercel. O caminho que importa é o do
`install.sh`/`update.sh` aplicando **só** o `baseline.sql`.

**Project Type**: web-service monorepo — Next.js Route Handlers + workers de `event_log` no mesmo
repositório.

**Performance Goals**: SC-006 — com 20 operadoras carregadas, o p95 do tempo até a resposta não
cresce mais que 25% em relação à mesma bateria com 1 operadora. A linha de base é medida na
primeira execução, não herdada de suposição.

**Constraints**: o teto de 10 minutos do Princípio VIII é preservado por desenho — nenhuma tela
desta feature pode entrar no caminho de publicar o agente (FR-031). O acréscimo do catálogo ao
`baseline.sql` tem custo de tamanho declarado em research.md (D6).

**Scale/Scope**: primeiro catálogo com poucas operadoras, produtos do Ceará (A-16). Estrutura sem
limite de quantidade (FR-041). 5 fatias, ~10 jornadas no total.

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Fonte: `.specify/memory/constitution.md` **v2.1.0** — duas emendas commitadas na branch
`docs/constituicao-principio-x-catalogo-curado` e **nenhuma mergeada na `main`**: `3c2a06b4`
(v2.0.0, Princípio X ganha duas camadas e sete travas) e `259a3e0f` (v2.1.0, cadência de commit por
fase). Ver a linha na Complexity Tracking: este plano é executável somente depois do merge da
primeira. A segunda não bloqueia nada — muda como se commita, e já está sendo seguida: **um commit
por fase**, com migration saindo em commit próprio junto do apêndice e do MANIFEST.

| # | Gate | Pergunta que o plano responde | Status |
|---|---|---|---|
| I | Isolamento de tenant | `knowledge_scopes` e as colunas novas de `contacts` são tenant-aware com `organization_id` + RLS. A partição `catalog_*` **não** é tenant-aware e é a exceção declarada do Princípio X — legível por todos, gravável só por `is_platform_admin`. A função de busca nova **não recebe o tenant do chamador**: deriva de `p_agent_id` (research D2) e é revogada de `public`, `anon` e `authenticated`, fechando o buraco que a atual `retrieve_top_k_chunks` tem hoje. | **PASS** |
| II | Nada é ilha | Entrada: material curado + material do corretor + pergunta do cliente. Saída: resposta ancorada, escalação, item na Central, lacuna na tela. Atividade legível: recusa vira aviso, não `return` mudo. Portas: `lib/navigation/registry.ts` para a tela do tenant; nav do `app/admin/(protected)` para a curadoria. Anti-morte: as lacunas de FR-028 realimentam as duas camadas. Mapa vivo em `docs/architecture/` com ≥2 arestas. | **PASS** |
| III | Schema viaja com o clone | Cada fatia com schema sai com a tripla: migration `<timestamp>_0116+_<slug>.sql`, apêndice idempotente no `baseline.sql`, linha no MANIFEST. A semeadura do catálogo é idempotente **e não-destrutiva** — `on conflict do nothing`, nunca `do update` (trava 6; ver research.md D6). Constraint nova corrige dados antes de existir. | **PASS** |
| IV | Prova pela tela | F2, F4 e F5 provadas por Playwright em banco fresco do `baseline.sql` + `bootstrap-owner.ts`, com envs opcionais ausentes. F1 tem prova de conversa real, não `curl`. Receiver real não se aplica: não há efeito externo novo. | **PASS** |
| V | Evento na fila | Nenhum trigger novo faz HTTP. A indexação do acervo do tenant continua por `event_log` + `rag-indexer`. A reindexação do catálogo, quando o modelo de embedding mudar, é worker com dono declarado e aparece na Central quando trava. | **PASS** |
| VI | Contrato de API | Rotas novas sob `/api/v1/` com `ok()`/`fail()`, Zod em todo input, audit log nas mutações de material (FR-032, FR-036), rate limit nas públicas. Nenhuma credencial nova. | **PASS** |
| VII | Interoperável por contrato | Nada cruza fronteira de produto. O identificador oficial de registro da operadora é guardado como chave estável para uma importação futura (A-12), **sem** FK, sem leitura do banco do Cotador. | **PASS** |
| VIII | Corretor em 10 minutos | A feature **melhora** o teto em vez de consumi-lo: a instalação nasce com catálogo semeado e responde antes de qualquer configuração (FR-030). Nenhuma tela dela é pré-requisito de publicar o agente (FR-031). SC-011 cronometra isso em instalação fresca. | **PASS** |
| IX | Vender ou assistir | A feature declara **assistir** no cabeçalho da spec. O veto de F1 recusa e escala quando não há respaldo, e FR-020 garante que a exigência não alcança o discurso de conversão. | **PASS** |
| X | Operadora é dado curado | Nada de operadora em `if`, prompt ou tabela de código. Operadora nova na própria instalação = carregar conteúdo. Rastreabilidade até o trecho **e** até a camada (FR-039). As sete travas: (1) escrita só `is_platform_admin` — F3; (2) sem dado pessoal nem de organização — FR-038, SC-020; (3) nenhuma tabela tenant-aware afrouxada — partição própria, research.md D1; (4) tenant desativa e sobrepõe — FR-008, FR-035; (5) origem diz a camada — FR-039; (6) semeadura só acrescenta versão — FR-037, SC-018; (7) nada de telemetria voltando — A-18. | **PASS sob v2.0.0** — ver Complexity Tracking |
| XI | Teste que prova e vigia | F1: teste da cadeia confirmado por sabotagem (desarmar o gate tem de deixar vermelho). F2/F3: `pnpm test:db` com invariantes das travas 1, 2 e 3 e do não-vazamento entre operadoras. F4/F5: Playwright. A opção "Exigir citação da base" ganha **teste de efeito**, não de gravação — é o defeito que originou o Princípio XI. | **PASS** |
| XII | Contexto antes de ação | A sessão que produziu este plano declarou ter lido a constituição (Version **1.2.0** na leitura de entrada, hoje **2.0.0** por emenda desta mesma sessão), o `CLAUDE.md` e o `README.md` antes de agir. Divergência com o Princípio X foi **reportada, não resolvida em silêncio**, e virou emenda em PR próprio. Aprofundamento lido para o tipo desta task: `supabase/baseline.sql` (schema/RLS), o registry de navegação, a cadeia de `before-send`, e — na revisão de brechas — `docs/current-state.md` e `docs/harness-audit.md`, que produziram a seção "Riscos herdados" e uma segunda divergência documental reportada (contagem de migrations desatualizada). | **PASS** |

---

## Riscos herdados do estado atual do repositório

Lidos em `docs/current-state.md` e `docs/harness-audit.md`. Não são criados por esta feature —
são o terreno em que ela cai, e cada um muda como uma fatia é executada ou provada.

1. **A prova mais importante desta feature não é vigiada por gate nenhum.** O `e2e` **não é check
   obrigatório** na branch protection, e `vps-fresh-onboarding.spec.ts` — a jornada de instalação
   fresca, `[P0]` da doutrina de QA Visual — está entre as 4 specs que **não rodam no CI**
   (`current-state.md` §4.1, issue #63). A prova de F2 ("a instalação nasce sabendo") é exatamente
   dessa família. Consequência prática: ela é manual, e a evidência tem de ser registrada em
   `.superpowers/evidence/`, porque nenhum job vai reprovar a regressão dela.
2. **`inbound-turn.ts` tem 1789 linhas e é o hot path do produto** (`current-state.md` §5.5,
   2,4× o segundo maior arquivo de lógica). F1 e F5 mexem nele. Toda mudança ali entra com teste
   confirmado por sabotagem, e o que puder nascer em arquivo próprio (`assistance-grounding.ts`,
   a classificação) nasce fora dele.
3. **89 dos 169 handlers usam `createAdminClient`, sem enforcement automático** da regra "filtre
   `organization_id` manualmente, nunca do body" (`current-state.md` §5.1). As rotas novas de F2/F3
   entram nessa conta. Mitigação desta feature: `fn_buscar_lastro` **não aceita** o tenant do
   chamador (research D2), o que tira o caminho mais perigoso das mãos do handler.
4. **Rate limit existe em 2 pontos do sistema inteiro** (`current-state.md` §4.3, 🔴), e o fallback
   sem Upstash é por processo. As rotas novas não podem assumir infra de rate limit pronta: onde o
   Princípio VI o exige, ele é implementado junto, não herdado.
5. **`pnpm gov:verify` não cobre `test:db` nem `test:e2e`** (`harness-audit.md` item de nível H5).
   Nenhuma fatia com schema pode ser declarada pronta por `gov:verify` verde — o quickstart lista a
   sequência completa de propósito.

**Divergência documental encontrada e reportada** (Princípio XII, não resolvida em silêncio):
`docs/current-state.md` afirma "81 migrations, até `0092`" e que o apêndice do `baseline.sql` cobre
até a `0092`. O repositório tem migrations até **0115** — o documento tem `last_updated: 2026-07-29`
e envelheceu. Não altera nenhuma decisão deste plano (a numeração 0116+ foi tirada de `ls
supabase/migrations/`, não do documento), mas fica registrado como issue de alinhamento em vez de
correção silenciosa.

---

## Project Structure

### Documentation (this feature)

```text
specs/002-rag-por-operadora/
├── plan.md              # este arquivo
├── research.md          # decisões técnicas com alternativa rejeitada
├── data-model.md        # entidades, colunas, RLS, transições de estado
├── quickstart.md        # como provar cada fatia, em ambiente fresco
├── contracts/           # contratos de rota, de busca e de semeadura
└── tasks.md             # gerado por /speckit-tasks, não por este comando
```

### Source Code (repository root)

```text
supabase/
├── migrations/                                        # última aplicada hoje: 0115
│   ├── <ts>_0116_aviso_de_assistencia_sem_lastro.sql # F1 — só vocabulário de inbox
│   ├── <ts>_0117_catalogo_curado_particao.sql        # F2
│   ├── <ts>_0118_escopos_por_tenant_e_vinculo.sql    # F2 — inclui o eixo no acervo existente
│   ├── <ts>_0119_busca_de_lastro.sql                 # F2
│   ├── <ts>_0120_adocao_local_do_catalogo.sql        # F3
│   ├── <ts>_0121_divergencia_de_conteudo.sql         # F4
│   └── <ts>_0122_rastreabilidade_validade_lacunas.sql # F5
├── baseline.sql                                      # apêndice idempotente por fatia
└── migrations/MANIFEST.md                            # uma linha por migration

lib/
├── agent-engine/
│   ├── guardrails/
│   │   ├── before-send.ts                # F1: gate novo, cadeia 6 → 7
│   │   └── assistance-grounding.ts       # F1: o gate e a classificação
│   └── agent/
│       ├── search-knowledge.ts           # F1+F2: sem "responda com o que já sabe"; escopo
│       └── inbound-turn.ts               # F1: citação deixa de ser update pós-envio
├── ai/
│   ├── knowledge/busca.ts                # F2: passa pela função nova
│   ├── rag/ingest/policy.ts              # F4: extração de PDF que persiste
│   └── catalogo/                         # F2/F3: leitura e curadoria do catálogo
├── navigation/registry.ts                # F2: porta da tela de operadoras
└── database.types.ts                     # regenerado a cada fatia com schema

workers/
├── rag-indexer.ts                        # F4: N materiais por operadora
└── catalog-reindexer.ts                  # F2: re-embeda só em troca de modelo

app/
├── app/ai/conhecimento/operadoras/       # F2 (leitura) → F4 (escrita)
├── admin/(protected)/catalogo/           # F3: curadoria de plataforma
└── api/v1/…                              # rotas das duas superfícies

docs/architecture/                        # F2: a peça nova entra no mapa vivo com ≥2 arestas
docs/testing/user-journey-map.md          # F2: a jornada "instalação já responde" entra como [P0]

tests/
├── invariants/                           # travas 1/2/3, não-vazamento entre escopos
├── unit/                                 # cadeia de gates + sabotagem
└── e2e/                                  # jornadas de F2, F4, F5
```

**Structure Decision**: nenhuma estrutura nova. A feature se encaixa no monorepo Next.js existente
— `lib/agent-engine` para o veto, `workers/` para indexação, `app/app/…` e `app/admin/(protected)/…`
para as duas superfícies, `supabase/` para a tripla de schema. A única peça sem precedente no repo
é a partição `catalog_*`, e ela existe por exigência da trava 3 (research.md D1).

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **Gate X depende de emenda constitucional ainda não mergeada** (v2.0.0 em `3c2a06b4`, branch `docs/constituicao-principio-x-catalogo-curado`) | A v1.2.0 vigente na `main` declara que conteúdo de operadora é dado de tenant, sem exceção. O catálogo compartilhado a contradiz de frente. A Governança exige emenda em PR próprio e anterior à feature. | Não há alternativa que preserve a decisão do dono do produto: manter o conteúdo como dado de tenant significaria não distribuir catálogo nenhum, que é exatamente a opção descartada na sessão de clarificação. **Este plano não é executável antes do merge da emenda.** |
| **Partição `catalog_*` sem `organization_id`** — a única tabela do sistema que não pertence a uma organização | O catálogo é compartilhado por todas as organizações da instalação por decisão registrada em Clarifications. | Rejeitado: `organization_id` nullable em `ai_chunks`. Relaxaria a RLS de uma tabela tenant-aware existente para acomodar linhas sem dono, que é literalmente o que a trava 3 do Princípio X proíbe. Uma partição própria mantém a policy de `ai_chunks` intocada e torna o vazamento testável em um lugar só. |
| **Função de busca nova em vez de estender `retrieve_top_k_chunks`** | A atual recebe `p_organization_id` do chamador e é executável por `authenticated` — o Princípio XI cita isso como defeito que atravessou todos os gates verdes. Estendê-la propagaria o defeito para a camada nova. | Rejeitado: acrescentar parâmetros à existente. Manteria a assinatura que confia no chamador, e a feature que mais precisa de isolamento provado nasceria sobre a função que menos o garante. A nova deriva o tenant de `auth.uid()` e é revogada de `authenticated` — verificado que **nenhum chamador `authenticated` existe** hoje (MCP e worker usam admin client). |
| **Embeddings pré-computados dentro do `baseline.sql`** (~1,2 MB para ~100 trechos) | Sem eles, a instalação fresca só responde depois que um worker rodar e gastar chave de IA — SC-017 e FR-030 falhariam no minuto zero, que é a primeira impressão. | Rejeitado: indexar no primeiro boot. Torna a primeira impressão dependente de worker + chave de IA válida, e faz cada clone gerar embeddings ligeiramente diferentes, o que impede reproduzir um bug de recuperação a partir do relato de um self-hoster. |

---

## Revisão de brechas — 2026-08-08

Auditoria do próprio plano, depois de escrito. **12 brechas**, todas fechadas nesta revisão. Ficam
registradas porque cada uma é uma classe de erro que volta.

### Cobertura incompleta

1. **Quatro requisitos sem fatia.** FR-015, FR-018, FR-031 e FR-033 não apareciam em nenhuma linha
   "Cobre:" — a conferência foi mecânica, comparando o conjunto das cinco fatias com os 41 FR da
   spec. FR-015 foi para F1 (é o `rag_must_hit` que existe na tela e nenhum runtime avalia);
   FR-018, FR-031 e FR-033 para F2.
2. **`docs/architecture/` e `user-journey-map.md` não eram tarefa de ninguém**, apesar de serem os
   itens 13 e 12 do Definition of Done. Entraram na estrutura de F2.
3. **SC-006 sem linha de base atribuída.** A medição com 1 escopo virou entrega explícita de F2 — é
   a única execução em que ela pode ser feita honestamente.

### Contradições internas

4. **F1 dizia "sem depender de nenhuma tabela nova" e precisava de um `kind` novo em
   `agent_inbox_items`.** Corrigido para o que é: a menor mudança de schema possível, uma linha de
   vocabulário, migration 0116.
5. **`message_groundings` estava em F1 no data-model, e F1 se dizia sem schema.** A tabela foi para
   F5, onde a rastreabilidade histórica é requisito. F1 grava a âncora no `insert` da mensagem, em
   `messages.metadata`, que já existe.
6. **A numeração das migrations não incluía F1.** Renumerado 0116–0121, a partir da última que
   existe hoje (0115, conferida em `ls supabase/migrations/`, não no doc desatualizado).

### Defeitos de desenho

7. **`fn_buscar_lastro` derivava o tenant de `auth.uid()` — que é NULL no chamador real.** O
   agent-engine fala com o banco por Pool `pg` com credencial de serviço; não há sessão de usuário.
   Como estava, a função devolveria vazio sempre. Corrigido: o tenant e o acervo ativo são
   derivados de **`p_agent_id`**, resolvido server-side a partir da conversa. Continua atendendo
   FR-019 — o chamador aponta um agente, não afirma um tenant. É a pior da lista: teria passado
   como decisão elegante e falhado na primeira execução.
8. **A precedência de camada não dizia sobre qual conjunto se aplica.** Material "vale para todas" e
   material de um escopo específico servem a propósitos diferentes; suprimir um pelo outro apagaria
   a política do corretor com o procedimento da operadora, ou o contrário. A supressão passou a
   valer **dentro do mesmo balde**.
9. **Faltava a rota do caminho "cadastro" de FR-017.** A spec dá precedência ao cadastro sobre a
   conversa, e não havia como gravá-lo. Entrou em `contracts/rotas-http.md`.
10. **O apêndice do `baseline.sql` não derrubava o índice único que o snapshot recria.** Num banco
    novo o snapshot cria `ai_knowledge_sources_unique_per_agent` e o apêndice roda depois; sem o
    `drop index if exists` lá, instalação fresca nasceria com o índice que impede a segunda
    operadora, e clone atualizado não. Duas realidades diferentes a partir do mesmo arquivo.

### Nome que cravava o nicho

11. **`operadoras` como nome de tabela contraria FR-033 e FR-041.** A spec batiza a entidade
    "Operadora (**Escopo de Conhecimento**)" justamente porque outro nicho usa o mesmo mecanismo com
    outro nome. A estrutura passou a ser `knowledge_scopes` / `catalog_scopes`; "operadora" é rótulo
    de vocabulário. Barato agora, caro depois do código escrito (research D11).

### Terreno ignorado

12. **O plano não olhava o estado real do repositório.** `docs/current-state.md` e
    `docs/harness-audit.md` foram lidos e viraram a seção "Riscos herdados". O que mais muda a
    execução: a prova de F2 é da mesma família da `vps-fresh-onboarding`, que **não roda no CI** e
    cujo check nem é obrigatório. Nenhum gate protege a regressão dela.

**O que esta revisão não fez**: nenhum código foi escrito, nenhum gate foi rodado, e as estimativas
por fatia continuam sendo ordem de grandeza. As brechas 7, 8 e 10 só serão *provadas* fechadas
quando F2 existir e o `pnpm test:db` as exercitar.

---

## Revisão cruzada — 2026-08-08 (segunda passagem, com `tasks.md` pronto)

A revisão acima olhou o plano sozinho. Esta olhou os três artefatos **juntos** e conferiu cada
afirmação contra o repositório: **19 achados**, dos quais três derrubariam a execução.

**Os três que quebrariam de verdade**

1. **A `fn_buscar_lastro` lia colunas de duas migrations à frente.** Ela nasce na 0119 (F2) e filtra
   o acervo do tenant por `scope_id` e por `valid_until` — colunas que a 0120 (F4) criava. A função
   não criaria, ou criaria sem filtro nenhum do lado do tenant, e a F2 seria declarada pronta com
   metade do isolamento que ela existe para provar. **As colunas foram para a 0118.**
2. **A instalação fresca não recusaria nada.** O gate nasce desarmado, no padrão do
   `internalVocabularyGate` — e nada armava o agente padrão. `app/actions/onboarding/createDefaultAgent.ts`
   não grava guardrail algum hoje, e `rag_must_hit` só existe no schema Zod. FR-030, SC-001, SC-011 e
   SC-017 seriam falsos com a suíte inteira verde. É a mesma classe de defeito que originou o
   Princípio XI: configuração que existe e não tem efeito.
3. **FR-035 tinha só metade das tarefas.** "E **DEVE** registrar a divergência para o corretor" não
   aparecia em lugar nenhum — nem migration, nem runtime, nem tela. SC-016 era inatingível.

**Os seis de execução**

O teste de porta de navegação, escrito na Foundational, deixaria `pnpm test:unit` vermelho durante
toda a F1 · o rate limit adiado ao Polish faria F2 e F4 serem entregues reprovando o item 6 do
próprio Definition of Done · dois workers nasciam sem gatilho, e neste repositório cron é rota HTTP
batida pelo `crond` do serviço `scheduler` · a linha de base de SC-006 era medida depois da
semeadura, quando "1 escopo" já não existe · a âncora nasceria com dois formatos, `messages.metadata`
na F1 e `message_groundings` na F5, sem ninguém reconciliando · e o caminho da tela cravava o nicho
na URL, o mesmo erro que a brecha 11 tirou do schema.

**O que as três respostas do dono do produto mudaram**

- **Catálogo de exemplo** (A-19), com cada material dizendo no próprio corpo que é exemplo. Remove o
  risco de implementar a semeadura contra conteúdo que ainda não existe.
- **Adoção local** (FR-037): a edição no clone vence a versão que chega por release, que fica inerte
  até ser aceita.
- **Escopo do catálogo nasce desligado** (A-20) — contra a recomendação do desenvolvedor, que era
  nascer ligado pela primeira impressão. A escolha é do dono do produto e é defensável: o agente não
  fala de operadora que aquele corretor não vende. O custo — a instalação fresca só assiste depois de
  um passo — foi absorvido em FR-030, SC-011 e SC-017, e **FR-042 nasceu** para que a recusa diga que
  a resposta já está no produto. Sem FR-042, essa decisão entregaria uma instalação que parece burra
  por configuração que ninguém mostrou.
