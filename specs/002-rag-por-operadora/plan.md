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

Retira o maior risco do plano sem depender de nenhuma tabela nova. Se o veto determinístico não
for viável na cadeia atual, é aqui que se descobre — antes de qualquer schema.

Entrega: gate `assistance_grounding` na cadeia (versão 6 → 7); classificação determinística de
"afirmação de assistência"; `knowledge_unavailable` tratado como ausência de lastro em vez de
"responda com o que você já sabe"; citação virando invariante de envio (some o `update` pós-envio);
recusa gerando escalação + item na Central (`agent_inbox_items` kind novo).

Cobre: FR-009 a FR-014, FR-020, FR-024, A-02, A-03 · SC-001, SC-002, SC-011.

### F2 — A instalação nasce sabendo *(≈2 jornadas)*

**Observável**: banco recém-aplicado do `baseline.sql`, corretor não carregou nada, cliente
pergunta algo coberto pelo catálogo e recebe resposta ancorada; cliente de outra operadora
pergunta o mesmo e é recusado.

Entrega: a partição curada (`catalog_*`), a tabela `operadoras` por tenant com ponteiro para o
catálogo, o vínculo contato↔operadora pela conversa, a função de busca nova com escopo por
operadora e sem tenant vindo do chamador, e a semeadura versionada com embeddings pré-computados.
Tela do tenant: lista de operadoras em leitura, com a porta declarada no registry.

Cobre: FR-016, FR-017 (via conversa), FR-019, FR-030, FR-038, FR-041 · SC-005, SC-007, SC-017,
SC-020, SC-021.

### F3 — Nós curamos, e atualizar não destrói *(≈2 jornadas)*

**Observável**: administrador de plataforma cria material pela tela e ele ancora resposta na hora,
sem deploy; reaplicar o schema de atualização num clone com material editado localmente não perde
nem sobrescreve nada, e reaplicar duas vezes dá o mesmo estado que uma.

Entrega: superfície de curadoria em `app/admin/(protected)/catalogo/`, a regra de semeadura que só
acrescenta versão, e as invariantes das travas 1, 2 e 3 do Princípio X.

Cobre: FR-036, FR-037, FR-028 (lado plataforma) · SC-010, SC-018.

### F4 — O corretor manda no que vale para ele *(≈2 jornadas)*

**Observável**: o corretor sobe um PDF de uma operadora e ele vira trecho buscável de verdade, com
contagem na tela; sobrepõe um assunto do catálogo e a resposta passa a ancorar no material dele;
acrescenta uma operadora que não existe em lugar nenhum.

Entrega: fim do índice único de 4 slots por agente, N materiais por operadora, estados de
processamento visíveis, extração de PDF que persiste (hoje ela valida e descarta), precedência de
camada, desativação de operadora do catálogo para o próprio tenant.

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
(compartilhada pela instalação) e `operadoras` + colunas em `contacts` **com** `organization_id` e
RLS. Embeddings em `vector(1536)`, mesmo tipo de `ai_chunks`.

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

Fonte: `.specify/memory/constitution.md` **v2.0.0** — a emenda do Princípio X está commitada em
`3c2a06b4`, na branch `docs/constituicao-principio-x-catalogo-curado`, **ainda não mergeada na
`main`**. Ver a linha na Complexity Tracking: este plano é executável somente depois desse merge.

| # | Gate | Pergunta que o plano responde | Status |
|---|---|---|---|
| I | Isolamento de tenant | `operadoras` e as colunas novas de `contacts` são tenant-aware com `organization_id` + RLS. A partição `catalog_*` **não** é tenant-aware e é a exceção declarada do Princípio X — legível por todos, gravável só por `is_platform_admin`. A função de busca nova **não recebe o tenant do chamador**: deriva de `auth.uid()`/`fn_user_org_ids()` e é revogada de `authenticated`, fechando o buraco que a atual `retrieve_top_k_chunks` tem hoje. | **PASS** |
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
| XII | Contexto antes de ação | A sessão que produziu este plano declarou ter lido a constituição (Version **1.2.0** na leitura de entrada, hoje **2.0.0** por emenda desta mesma sessão), o `CLAUDE.md` e o `README.md` antes de agir. Divergência com o Princípio X foi **reportada, não resolvida em silêncio**, e virou emenda em PR próprio. Aprofundamento lido para o tipo desta task: `supabase/baseline.sql` (schema/RLS), o registry de navegação, e a cadeia de `before-send`. | **PASS** |

**Não lido, e declarado**: `docs/current-state.md` e `docs/index.md` não foram lidos nesta sessão.
A consequência é que as estimativas de jornada por fatia são derivadas do código medido, não do
inventário de "pronto, incompleto e quebrado" — trate-as como ordem de grandeza, não como
compromisso. `docs/harness-audit.md` também não foi lido; nenhum resultado de CI foi tratado como
prova aqui.

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
├── migrations/
│   ├── <ts>_0116_catalogo_curado_particao.sql        # F2
│   ├── <ts>_0117_operadoras_por_tenant_e_vinculo.sql # F2
│   ├── <ts>_0118_busca_com_escopo_de_operadora.sql   # F2
│   ├── <ts>_0119_acervo_multi_material.sql           # F4
│   └── <ts>_0120_validade_e_lacunas.sql              # F5
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

tests/
├── invariants/                           # travas 1/2/3, não-vazamento entre operadoras
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
