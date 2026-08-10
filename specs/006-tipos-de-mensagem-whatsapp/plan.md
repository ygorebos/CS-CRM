# Implementation Plan: Tipos de mensagem do WhatsApp — envio completo e leitura fiel

**Branch**: `006-tipos-de-mensagem-whatsapp` | **Date**: 2026-08-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-tipos-de-mensagem-whatsapp/spec.md`

**Leitura de contexto (Princípio XII)**: esta sessão leu, antes de planejar, a constituição
`.specify/memory/constitution.md` **Version 2.5.0**, o `CLAUDE.md` e o `README.md`; e, pelo que
a task toca, `docs/current-state.md`, `docs/testing/user-journey-map.md` e o código dos dois
repositórios (CRM e `gateway_go`).

**Divergência reportada, não resolvida em silêncio** (Princípio XII): o `README.md` ainda
descreve o produto como self-host open source "sem mensalidade, seus dados com você", com
instalador de VPS. A constituição v2.5.0 (Missão + Princípio XV) diz **SaaS de instância
única operada por nós**. Precedência: constituição. O plano segue a constituição; o `README`
desatualizado vira issue de alinhamento — esta feature não o edita.

---

## Summary

Duas coisas, na ordem em que doem: **a conversa hoje esconde do corretor o que o cliente
disse**, e **o CRM manda 5 das 17 formas que o canal aceita** — duas delas anunciadas pela
API e impossíveis de enviar.

A pesquisa mudou o formato da solução. Citação, reação e apagamento chegam pelo **mesmo
campo** (`metadata.reply_to_external_id`) e **já são gravados** — o defeito é de leitura, não
de ingestão. Então a abordagem é **projeção na leitura**: uma consulta por página resolve os
três, sem tabela nova, sem escrita nova, sem tocar o caminho quente que recebe mensagem. Do
lado do envio, o gateway já aceita tudo (`quoted_id`, `latitude`, `contatos`, `opcoes`,
`rotulo_botao`); falta o CRM **preencher** campos que já existem do outro lado.

Duas migrations aditivas, ambas expand puro: um índice de expressão (a projeção sem ele é
varredura por página) e três valores a mais no CHECK de tipo, no molde da migration 0091.

Fora de escopo por decisão do dono (FR-022): **enviar** reação e apagar. **Ler** as duas
está dentro — a informação já chega.

## Technical Context

**Language/Version**: TypeScript 6 estrito, Node 22, React 19

**Primary Dependencies**: Next.js 16 App Router (Turbopack), Zod, Tailwind + shadcn/ui
(`new-york`), TanStack Query nos hooks de inbox, `@supabase/ssr`

**Storage**: Supabase Postgres — tabela `messages` (nenhuma tabela nova); carga de tipo em
`messages.metadata` jsonb com schema Zod central; Supabase Storage (`whatsapp-media`) para
anexo, inalterado

**Testing**: Vitest (`test:unit`), Vitest sobre Postgres efêmero pg17 (`test:db`, invariantes),
Playwright (`test:e2e`) pela tela — mais prova com aparelho de WhatsApp real para formato de
terceiro

**Target Platform**: contêiner Linux único, atrás de proxy reverso; canal alcançado por
`GATEWAY_BASE_URL` (configuração, nunca `localhost`)

**Project Type**: aplicação web em repositório único (Next.js Route Handlers + React no mesmo
repo)

**Performance Goals**: a projeção acrescenta **no máximo 1 consulta por página** de conversa
(50 mensagens), com índice; medida em conversa de ≥500 mensagens, não na de 10

**Constraints**: `gateway_go` **não muda** nesta entrega; código novo lê **envelope**, nunca
payload cru de provedor; nome de provedor não sai de `lib/channels/` (lint reprova); nenhum
envio novo escapa da cadeia `before_send`

**Scale/Scope**: 4 jornadas, 23 requisitos funcionais, 2 migrations aditivas, 0 telas novas
(tudo dentro do inbox, que já tem porta em `lib/navigation/registry.ts`)

## Constitution Check

*GATE: passou antes da Phase 0 e foi re-avaliado depois da Phase 1 — veredito idêntico.*

Fonte: `.specify/memory/constitution.md` **v2.5.0** (o template citava v2.3.0; a diferença é
reportada aqui e o plano segue a versão vigente).

| # | Gate | Como o plano responde | Status |
|---|---|---|---|
| I | Isolamento de tenant | Nenhuma tabela nova → nenhuma policy nova. O ponto de risco é a **projeção**: ela resolve alvo por `external_id`, que é único **por organização** — a consulta filtra `organization_id` da sessão, nunca do corpo, e um invariante em `test:db` reprova o cruzamento. `getUser()` mantido. Nenhuma função nova em `public`. | **PASS** |
| II | Nada é ilha | Entrada: envelope do gateway (já existe). Saída: `POST /v1/messages` do gateway. Log: `api_audit_log` em cada envio novo. Tela: inbox, que já está no `registry.ts` — **zero telas novas, zero portas novas**. Anti-morte: tipo desconhecido vira rótulo legível (FR-009) em vez de sumir, e capability desliga a ação em vez de deixá-la falhar. Mapa vivo: peça "projeção de eventos sobre mensagens" entra em `docs/architecture/` com arestas para ingest e para o inbox. | **PASS** |
| III | Schema muda por migration | Duas: **M1** índice de expressão, **M2** três valores no `messages_type_check`. Cada uma com os três artefatos (migration + apêndice idempotente no `baseline.sql` + linha no MANIFEST). M2 é aditiva — conjunto antigo ⊂ novo, **backfill zero por construção**. Nada destrutivo, então não há contract a declarar. | **PASS** |
| IV | Prova pela tela | Cada jornada provada por Playwright em conta nova, estado vazio (baseline pg17 + `bootstrap-owner`), com evidência visual. Formato de terceiro (citação, vCard, menu) provado com **aparelho real** — dublê responde no formato que eu escrevi. `curl` só como diagnóstico. | **PASS** |
| V | Evento na fila | Nenhum trigger novo, nenhum HTTP em trigger. A idempotência de entrada não muda: `unique (organization_id, external_id)` + captura de `23505` continua sendo o que dedup a mensagem. `Idempotency-Key` segue aceito no POST de envio. | **PASS** |
| VI | Contrato de API | Tudo sob `/api/v1/`, `ok()`/`fail()`, Zod em cada carga nova nomeando o campo que falta, audit log em toda mutação, rate limit inalterado, credencial em header. Mudança **aditiva**: campo novo, nenhum removido ou renomeado. | **PASS** |
| VII | Interoperável por contrato | O gateway é consumido pela superfície HTTP dele (`POST /v1/messages`), que **já aceita** tudo que esta feature manda. Nenhuma tabela do outro sistema é tocada; a quarta superfície não entra aqui. | **PASS** |
| VIII | Corretor em 10 minutos | Nenhuma configuração nova, nenhum arquivo a editar, nenhum passo a mais no caminho login → primeira conversa. As ações novas nascem ligadas onde o canal suporta. O teto de 10 min não é afetado; a cronometragem existente não muda. | **PASS** |
| IX | Vender ou assistir | **Vender**: conversa fiel e resposta citada encurtam o ciclo. A capacidade do agente de IA **não muda** (FR-023) — o que ele pode enviar continua sendo decisão explícita, fora desta spec. | **PASS** |
| X | Operadora é dado curado | Não toca catálogo, prompt, RAG nem nada específico de operadora. | **N/A** |
| XI | Teste que prova e vigia | Sete invariantes nomeados em `data-model.md` §5, com o gate certo por tipo: `test:db` para schema/projeção/tenancy, `test:unit` para vocabulário e capability, Playwright para tela, aparelho real para contrato externo. **Sabotagem obrigatória** em cada teste novo antes de aceitá-lo. Verde parcial não é reportado como verde. | **PASS** |
| XII | Contexto antes de ação | Declarado no topo, com `Version 2.5.0`. Aprofundamento lido conforme a task (UI → `user-journey-map.md`; schema → `docs/index.md`/`current-state.md`). Divergência do `README` **reportada**, não resolvida sozinha. | **PASS** |
| XIII | Cobrança mora no Cotador | Nenhuma coluna, rota ou tela de assinatura, preço, pagamento ou cartão. `pix_button` e `request_payment` — que o canal oferece — ficaram **fora de escopo por este princípio**, escrito na spec. `cta_url` é botão de link (simulador/cotação), não checkout. | **PASS** |
| XIV | Gateway único e sem réplica | O gateway **não muda** nesta entrega. Endereço continua sendo configuração (`GATEWAY_BASE_URL`); nada de `localhost` nem nome de serviço de compose. Código novo lê **envelope** — a projeção consome `metadata` gravado pelo ingest, jamais payload cru de provedor. Teto de taxa por conexão: inalterado. As duas pontas de durabilidade (fila em disco lá, dreno/reconciliação aqui) **já estão de pé** e não são tocadas. | **PASS** |
| XV | Produção é self-hosted; Cloud é dev | Nenhuma operação de banco de produção neste plano. As migrations são aplicadas por `supabase db push` — **nunca por MCP** —, e o ensaio é o Postgres descartável do `test:db`. Endereço `*.supabase.co` é desenvolvimento. | **PASS** |

**Nenhum FAIL.** A Complexity Tracking fica vazia — o plano não introduz nada que precise de
justificativa de exceção.

### Risco que não é violação de gate, e que fica escrito

O apagamento de mensagem **não chega pelo canal não-oficial** — a normalização daquele canal
não tem o caso (`research.md` R2). O código de leitura funciona por evento e serve qualquer
canal que o entregue, mas a prova em produção só existe no canal oficial. A correção mora na
porta de tráfego, que está fora de escopo por decisão do dono (FR-022). Isso entra no
`user-journey-map.md` como buraco nomeado, e a spec de tela **afirma a pré-condição de canal**
em vez de assumi-la. Fingir cobertura aqui seria o falso-verde mais caro desta feature.

## Project Structure

### Documentation (this feature)

```text
specs/006-tipos-de-mensagem-whatsapp/
├── spec.md              # o quê e por quê (com os cortes do dono)
├── plan.md              # este arquivo
├── research.md          # Phase 0 — 9 medições + riscos
├── data-model.md        # Phase 1 — o que muda no schema (pouco) e o que é projeção
├── quickstart.md        # Phase 1 — como provar sem falso-verde
├── contracts/
│   └── api-mensagens-v1.md
└── tasks.md             # Phase 2 — criado por /speckit-tasks, NÃO por este comando
```

### Source Code (repository root)

```text
lib/
├── messaging/
│   ├── projection/            # NOVO — a peça central: eventos sobre mensagens
│   │   ├── project-events.ts  #   resolve citação, reação e apagamento de uma página
│   │   └── types.ts           #   MessageQuote | MessageReaction | MessageDeletion
│   ├── payloads.ts            # NOVO — schema Zod central da carga por tipo (anti jsonb lock-in)
│   └── media/                 # existente, inalterado
├── schemas/
│   └── messaging.ts           # + reply_to_message_id, location, contacts, menu, cta_url
├── channels/
│   ├── capabilities.ts        # + capacidades: citar, figurinha, localização, contato, menu…
│   ├── types.ts               # + campos no OutboundEnvelope
│   └── adapters/
│       ├── gateway.ts         # + quoted_id, latitude/longitude, contatos, opcoes, rotulo_botao
│       ├── waha.ts            # capability desliga o que o canal direto não faz
│       └── meta-cloud.ts      # idem
└── types/messaging.ts         # + o objeto `projection` no Message

app/api/v1/
├── messages/_handler.ts       # envio: valida carga por tipo; leitura: chama a projeção
└── conversations/[id]/messages/route.ts   # inalterado (delega ao handler)

components/inbox/
├── MessageBubble.tsx          # + citação, + reações penduradas, + marca de apagada, + rótulo
├── message/                   # NOVO — renderers por tipo
│   ├── QuotedPreview.tsx
│   ├── ReactionRow.tsx
│   ├── LocationCard.tsx
│   ├── ContactCard.tsx
│   └── UnsupportedNotice.tsx
├── Composer.tsx               # + citação em preparo, + ação por tipo
└── composer/
    ├── AttachMenu.tsx         # + Localização, Contato, Figurinha
    ├── LocationPicker.tsx     # NOVO
    ├── ContactPicker.tsx      # NOVO
    └── MenuBuilder.tsx        # NOVO (User Story 4)

supabase/
├── migrations/                # M1 (índice) e M2 (vocabulário)
├── baseline.sql               # apêndice idempotente das duas
└── migrations/MANIFEST.md     # uma linha por migration

tests/
├── unit/                      # vocabulário, capability, projeção sem tenant, bolha
├── invariants/                # par CHECK↔TypeScript, projeção não cruza organização
└── e2e/                       # jornadas pela tela, conta nova, estado vazio

docs/
├── architecture/              # peça nova com ≥2 arestas
└── testing/user-journey-map.md# cobertura e o buraco declarado do apagamento
```

**Structure Decision**: repositório único Next.js — Route Handlers e React no mesmo projeto,
como todo o resto do CRM. A peça nova de verdade é `lib/messaging/projection/`: ela concentra
a leitura dos três eventos num lugar só, para que nenhum componente de tela leia
`metadata.reply_to_external_id` na mão. `lib/messaging/payloads.ts` é a contrapartida do lado
do envio, e existe pelo mesmo motivo: um schema central, não path de jsonb espalhado.

## Fases de implementação

Cada fase é uma fatia entregável e provável sozinha. A ordem é a da spec — leitura antes de
envio, porque leitura é onde se perde informação do cliente.

| Fase | Jornada | Migration | O que a fase entrega |
|---|---|---|---|
| **F1** | US1 (P1) | **M1** — índice de expressão | projeção dos três eventos; bolha com citação, reação pendurada, marca de apagada, localização, contato, rótulo de desconhecido; zero bolha vazia |
| **F2** | US2 (P1) | — | citar no envio: gesto na mensagem, preparo no campo de escrita, `quoted_id` no adapter, falha legível em vez de sair sem citação |
| **F3** | US3 (P2) | — | localização, contato e figurinha enviáveis; **e o fim do "aceito e inenviável"** (FR-017) |
| **F4** | US4 (P3) | **M2** — vocabulário | menu, botão de link, pedido de localização; clique do cliente legível na conversa (depende de F1) |

**Planejamento acompanha a execução** (constituição v2.4.0+): a cada 5 tasks avançadas — ou ao
fechar uma fase, o que vier primeiro — atualizar `tasks.md` com o estado real, `plan.md` se o
desenho mudou, e `docs/current-state.md` se o que está pronto/quebrado mudou.

## Complexity Tracking

> Vazio de propósito: a Constitution Check não tem nenhum FAIL. Nenhuma exceção a justificar.
