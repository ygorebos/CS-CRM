---
description: "Tasks — 006 Tipos de mensagem do WhatsApp: envio completo e leitura fiel"
---

# Tasks: Tipos de mensagem do WhatsApp — envio completo e leitura fiel

**Input**: `/specs/006-tipos-de-mensagem-whatsapp/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Testes**: **obrigatórios, não opcionais.** O Princípio XI da constituição (v2.5.0) é NÃO
NEGOCIÁVEL: nada é construído sem teste que falharia se a feature não existisse, e **teste que
passa com a implementação sabotada não é teste**. Toda fase termina com a sabotagem
confirmada.

**Organização**: por jornada, para que cada uma seja implementável, provável e entregável
sozinha.

## Format: `[ID] [P?] [Story] Descrição`

- **[P]**: pode rodar em paralelo (arquivo diferente, sem dependência pendente)
- **[Story]**: US1..US4, conforme a spec
- Caminho de arquivo exato em toda descrição

## Convenções de caminho

Repositório único Next.js: `lib/`, `app/api/v1/`, `components/`, `supabase/`, `tests/`,
`docs/`. Nada de `src/` — não existe neste repo.

---

## Phase 1: Setup (ambiente de prova)

**Purpose**: sem isto, toda prova de tela é falso-verde. A receita é não-óbvia e cada item
errado custa uma rodada inteira (ver [quickstart.md](quickstart.md) §2).

- [ ] T001 Subir ambiente fresco: Supabase local **pg17** (`supabase/config.toml` com `major_version = 17`), `supabase/baseline.sql` aplicado, `scripts/bootstrap-owner.ts` executado, app servido com `next build` + `next start` — nunca `next dev`
- [ ] T002 [P] Deixar o gateway de desenvolvimento alcançável e conferir a conta de teste de canal, registrando qual conexão será usada em cada prova com aparelho real
- [ ] T003 [P] Semear uma conversa com **≥500 mensagens** num tenant de teste, em `tests/e2e/fixtures/`, para medir a projeção onde o índice importa — conversa de 10 mensagens não mede índice nenhum

**Checkpoint**: dá para dirigir o navegador numa conta nova, no estado vazio, e dá para medir.

---

## Phase 2: Foundational (bloqueia todas as jornadas)

**Purpose**: fonte única de vocabulário e de capacidade. Três das quatro jornadas escrevem nos
mesmos arquivos — fazer isto primeiro evita conflito e divergência silenciosa.

**⚠️ CRÍTICO**: nenhuma jornada começa antes desta fase fechar.

- [X] T004 Criar a constante única de tipos de mensagem em `lib/messaging/message-types.ts`: a **união** (entrada + saída) que espelha `messages_type_check`, mais os subconjuntos derivados `TIPOS_DE_ENTRADA` e `TIPOS_DE_ENVIO`
- [X] T005 [P] Fazer `TIPOS_CONHECIDOS` de `lib/gateway/envelope.ts` **derivar** de `lib/messaging/message-types.ts`, preservando o comportamento de tipo desconhecido virar `system` com `metadata.original_type`
- [X] T006 [P] Fazer `messageTypeSchema` de `lib/schemas/messaging.ts` **derivar** do subconjunto de saída de `lib/messaging/message-types.ts`, sem transcrever valores
- [X] T007 Acrescentar o par `messages_type_check` ↔ união de `lib/messaging/message-types.ts` em `tests/invariants/vocabulario-banco-x-typescript.test.ts`, apontando arquivo e símbolo — **nunca** transcrevendo os valores, senão o próprio teste vira a terceira lista
- [X] T008 [P] Acrescentar as capacidades novas em `lib/channels/types.ts` (`ChannelCapabilities`) e preencher a matriz em `lib/channels/capabilities.ts` para os seis providers: citar, figurinha, localização, contato, menu (com teto de opções), botão de link, pedido de localização
- [X] T009 [P] Criar `lib/messaging/payloads.ts` — schema Zod central da carga por tipo, consumido por quem escreve **e** por quem lê, para que nenhum componente leia `metadata.location.lat` na mão (anti-pattern 6)
- [X] T010 Escrever em `tests/unit/canal-capacidades-matriz.test.ts` o teste que reprova capability sem consumidor e matriz incompleta, e confirmar por sabotagem que remover uma linha da matriz o derruba

**Checkpoint**: vocabulário tem uma fonte, capacidade tem uma fonte, carga tem um schema.

---

## Phase 3: User Story 1 — Ler a conversa inteira, sem buraco (P1) 🎯 MVP

**Goal**: o corretor entende pela tela tudo que o cliente fez — citação, reação, apagamento,
localização, cartão de contato — e **nenhuma bolha fica em branco**.

**Independent Test**: numa conta nova, com aparelho real do outro lado, o contato executa as
seis ações; cada uma tem representação própria e legível. Zero bolhas vazias.

### Testes (escrever primeiro, ver vermelho)

- [X] T011 [P] [US1] Invariante em `tests/invariants/projecao-de-eventos-isolamento.test.ts`: duas organizações com o **mesmo** `external_id` — a projeção de uma não aparece na conversa da outra (Princípio I)
- [X] T012 [P] [US1] Unitário em `tests/unit/projecao-de-eventos.test.ts`: linha `type='reaction'` e evento de apagamento **não** aparecem em `data`; aparecem como `projection` do alvo
- [X] T013 [P] [US1] Unitário em `tests/unit/bolha-sem-buraco.test.tsx`: tipo que o front não representa vira rótulo legível; **nenhum** caminho produz bolha vazia (FR-009)
- [X] T014 [P] [US1] Unitário em `tests/unit/projecao-de-eventos.test.ts`: reação é **estado** — vale a última por `actor_kind`, e emoji vazio remove o par
- [X] T015 [P] [US1] Invariante em `tests/invariants/projecao-lgpd-anonimizacao.test.ts`: alvo anonimizado devolve `preview` anonimizado, nunca o original
- [X] T016 [P] [US1] Spec de tela em `tests/e2e/mensagens-leitura-fiel.spec.ts`: conversa com um exemplar de cada forma, **zero** bolhas em branco (SC-001) — com **âncora de lugar** (`toHaveURL` da conversa ou elemento que só existe nela) **antes** de qualquer asserção negativa

### Implementação

- [X] T017 [US1] Migration **M1** — índice parcial de expressão sobre `messages (organization_id, (metadata->>'reply_to_external_id'))` onde o campo não é nulo: arquivo em `supabase/migrations/<timestamp>_<NNNN>_indice_projecao_de_eventos.sql`, apêndice idempotente (`create index if not exists`) no fim de `supabase/baseline.sql`, e linha em `supabase/migrations/MANIFEST.md` — **os três artefatos, sempre**
- [X] T018 [US1] Criar `lib/messaging/projection/types.ts` com `MessageQuote`, `MessageReaction`, `MessageDeletion` e `UnsupportedMessage`, conforme [data-model.md](data-model.md) §3
- [X] T019 [US1] Criar `lib/messaging/projection/project-events.ts`: a partir dos `external_id` da página, **uma** consulta resolve os três eventos; filtra `organization_id` da sessão explicitamente; registra em log o contador de eventos não projetados (órfãos) em vez de sumir com eles
- [X] T020 [US1] Em `app/api/v1/messages/_handler.ts` (`listMessagesHandler`): excluir da linha do tempo as linhas de reação e de apagamento, e anexar `projection` a cada item — `projection` **sempre presente**, com chaves internas nulas quando não se aplica
- [X] T021 [US1] Acrescentar o campo `projection` a `Message` em `lib/types/messaging.ts`
- [X] T022 [P] [US1] Criar `components/inbox/message/QuotedPreview.tsx` — trecho citado, autoria, tipo do anexo quando a mídia não baixou, e o estado `is_unavailable`
- [X] T023 [P] [US1] Criar `components/inbox/message/ReactionRow.tsx` — emoji preso à bolha do alvo, nunca item da linha do tempo
- [X] T024 [P] [US1] Criar `components/inbox/message/LocationCard.tsx` — nome, endereço e abrir no mapa
- [X] T025 [P] [US1] Criar `components/inbox/message/ContactCard.tsx` — nome e telefone copiável
- [X] T026 [P] [US1] Criar `components/inbox/message/UnsupportedNotice.tsx` — o rótulo que substitui a bolha vazia
- [X] T027 [US1] Integrar os cinco em `components/inbox/MessageBubble.tsx`, mais a **marca de apagada** que mantém o conteúdo visível (FR-005) e deixa claro que o contato já não o vê no aparelho
- [X] T028 [US1] Em `components/inbox/media/MediaRenderer.tsx`: `location` e `contact` param de cair no `DocumentCard` e passam a ter renderer próprio
- [X] T029 [US1] Em `lib/gateway/ingest.ts` (`carimbarConversa`): a prévia da conversa para reação e apagamento deixa de ser o emoji cru ou vazio e passa a ser legível na listagem
- [X] T030 [US1] **Sabotagem**: desligar a projeção, devolver a reação à linha do tempo e remover o filtro de organização, confirmando o vermelho de T011–T015 um a um
- [ ] T031 [US1] Medir a projeção na conversa de ≥500 mensagens (T003) e registrar o número — sem isto, o índice é fé
- [X] T032 [US1] Registrar em `docs/testing/user-journey-map.md` o buraco nomeado do apagamento no canal não-oficial (research R2), e fazer o caso de apagamento em `tests/e2e/mensagens-leitura-fiel.spec.ts` **afirmar a pré-condição de canal** em vez de assumi-la

**Checkpoint**: US1 funciona e é provável sozinha. É o MVP — sozinha já para a perda de
informação do cliente.

---

## Phase 4: User Story 2 — Responder citando (P1)

**Goal**: o corretor aponta a mensagem exata a que responde, e a citação chega ao aparelho do
cliente.

**Independent Test**: numa conta nova, escolher uma mensagem recebida, responder citando, e
conferir no aparelho real que a citação aponta para a mensagem certa.

### Testes (escrever primeiro, ver vermelho)

- [X] T033 [P] [US2] Unitário em `tests/unit/envio-com-citacao.test.ts`: `reply_to_message_id` é UUID do CRM e o servidor resolve o identificador externo; alvo em outra conversa ou fora da organização → `404`, nunca confirmando existência de linha alheia
- [X] T034 [P] [US2] Unitário no mesmo arquivo: alvo sem identificador externo → `422 reply_target_not_addressable`, e a mensagem **não sai sem a citação** (FR-012)
- [X] T035 [P] [US2] Unitário em `lib/channels/adapters/gateway.test.ts`: o corpo enviado carrega `quoted_id` — sabotagem: descartar o campo derruba o teste
- [X] T036 [P] [US2] Spec de tela em `tests/e2e/responder-citando.spec.ts`: gesto na mensagem → envio em **no máximo 2 ações** (SC-003), contadas pela spec e não a olho

### Implementação

- [X] T037 [US2] Acrescentar `reply_to_message_id` a `sendMessageSchema` em `lib/schemas/messaging.ts` — válido para **qualquer** tipo, nunca só texto
- [X] T038 [US2] Em `app/api/v1/messages/_handler.ts`: resolver o alvo pela linha (mesma conversa, mesma organização), extrair o `external_id` e recusar com motivo quando não houver
- [X] T039 [US2] Acrescentar `replyToExternalId` ao `OutboundEnvelope` em `lib/channels/types.ts`
- [X] T040 [US2] Preencher `quoted_id` em `lib/channels/adapters/gateway.ts`; em `waha.ts` e `meta-cloud.ts`, o comportamento é decidido pela capability de T008 — nunca por `if` de provider
- [X] T041 [US2] Em `components/inbox/Composer.tsx`: estado de citação em preparo, com o trecho, a autoria e o cancelar
- [X] T042 [US2] Em `components/inbox/MessageBubble.tsx` e `components/inbox/ChatThread.tsx`: o gesto "responder" a partir da própria mensagem, oferecido só onde a capability permite
- [ ] T043 [US2] Prova com **aparelho real**: a citação chega apontando para a mensagem certa — dublê responde no formato que eu escrevi e não prova isto
- [X] T044 [US2] **Sabotagem**: remover a resolução do alvo e o `quoted_id`, confirmando o vermelho de T033–T035

**Checkpoint**: US1 e US2 funcionam independentemente.

---

## Phase 5: User Story 3 — Mandar o que o canal já sabe entregar (P2)

**Goal**: localização, cartão de contato e figurinha enviáveis pela tela — e o fim do "tipo
aceito e inenviável".

**Independent Test**: numa conta nova, enviar os três; no aparelho real o mapa abre no lugar
certo, o contato salva na agenda, a figurinha chega como figurinha.

### Testes (escrever primeiro, ver vermelho)

- [X] T045 [P] [US3] Unitário em `tests/unit/envio-carga-por-tipo.test.ts`: `location` sem `lat`/`lng` e `contact` sem contatos → `422` **nomeando o campo**, antes de qualquer rede
- [X] T046 [P] [US3] Invariante em `tests/unit/tipo-aceito-e-enviavel.test.ts` (FR-017): todo valor do subconjunto de envio tem carga declarada em `lib/messaging/payloads.ts` — tipo anunciado sem carga reprova, que é exatamente o defeito de hoje
- [X] T047 [P] [US3] Unitário em `tests/unit/figurinha-e-escolha.test.ts`: figurinha é escolha explícita do usuário, **não** inferida do MIME
- [X] T048 [P] [US3] Spec de tela em `tests/e2e/envio-localizacao-contato-figurinha.spec.ts`, em conta nova e estado vazio

### Implementação

- [X] T049 [US3] Definir em `lib/messaging/payloads.ts` a carga de `location`, `contact` e `sticker`, com os limites de [data-model.md](data-model.md) §4
- [X] T050 [US3] Em `lib/schemas/messaging.ts`: aceitar `location` e `contacts` e trocar o `refine` de hoje ("body ou mídia") por validação **por tipo**
- [X] T051 [US3] Em `lib/channels/types.ts` e `lib/channels/adapters/gateway.ts`: levar a carga ao gateway como `latitude`, `longitude`, `nome`, `endereco` e `contatos`, conforme [contracts/api-mensagens-v1.md](contracts/api-mensagens-v1.md) §3
- [X] T052 [US3] Em `lib/messaging/media/upload-validation.ts`: permitir figurinha como intenção declarada, sem que todo `image/webp` vire `image` por inferência
- [X] T053 [P] [US3] Criar `components/inbox/composer/LocationPicker.tsx`
- [X] T054 [P] [US3] Criar `components/inbox/composer/ContactPicker.tsx`
- [X] T055 [US3] Em `components/inbox/composer/AttachMenu.tsx`: entradas de Localização, Contato e Figurinha, **filtradas pela capability** (FR-018)
- [ ] T056 [US3] Prova com **aparelho real**: mapa abre no lugar certo, contato salva na agenda, figurinha chega sem moldura de imagem; contar **zero** recusas por campo ausente (SC-004)
- [X] T057 [US3] **Sabotagem**: devolver o `refine` genérico e a inferência de MIME, confirmando o vermelho de T045–T047

**Checkpoint**: US1, US2 e US3 funcionam independentemente.

---

## Phase 6: User Story 4 — Botões e pedidos guiados (P3)

**Goal**: menu de opções, botão de link e pedido de localização — com o clique do cliente
voltando legível para a conversa.

**Independent Test**: numa conta nova, enviar menu e botão de link; o clique do cliente
aparece dizendo qual opção foi escolhida.

**Depende de US1**: sem a leitura fiel, o clique do cliente entra como evento mudo e esta
jornada **piora** a conversa em vez de melhorar.

### Testes (escrever primeiro, ver vermelho)

- [X] T058 [P] [US4] Invariante em `tests/invariants/vocabulario-banco-x-typescript.test.ts`: o par de T007 continua fechado com `menu`, `cta_url` e `location_request` no CHECK
- [X] T059 [P] [US4] Unitário em `tests/unit/menu-limites-do-canal.test.ts`: teto de opções e tamanho de rótulo vêm da capability e são impostos **antes** do envio, com motivo legível (FR-019)
- [X] T060 [P] [US4] Spec de tela em `tests/e2e/menu-e-botoes.spec.ts`: menu enviado e clique do cliente legível na conversa

### Implementação

- [X] T061 [US4] Migration **M2** — `messages_type_check` passa a aceitar `menu`, `cta_url` e `location_request`, no molde do apêndice da 0091 (`drop constraint if exists` + `add constraint` com a lista inteira): arquivo em `supabase/migrations/`, apêndice idempotente em `supabase/baseline.sql`, linha em `supabase/migrations/MANIFEST.md`. Backfill: **nenhum por construção** — o conjunto antigo é subconjunto do novo
- [X] T062 [US4] Acrescentar os três valores a `lib/messaging/message-types.ts` e a carga correspondente a `lib/messaging/payloads.ts`
- [X] T063 [US4] Em `lib/schemas/messaging.ts`, `app/api/v1/messages/_handler.ts` e `lib/channels/adapters/gateway.ts`: levar `opcoes`, `texto_rodape`, `rotulo_botao` e `url_botao` ao gateway
- [X] T064 [US4] Criar `components/inbox/composer/MenuBuilder.tsx` e ligá-lo ao `AttachMenu`, filtrado por capability
- [X] T065 [US4] Garantir que o clique do cliente (que chega como `system` com `metadata.original_type`) apareça em texto legível pela projeção da US1 (FR-008)
- [ ] T066 [US4] Prova com **aparelho real** e **sabotagem** de T058–T060

**Checkpoint**: as quatro jornadas funcionam independentemente.

---

## Phase 7: Polish & Cross-Cutting

- [X] T067 [P] Acrescentar a peça "projeção de eventos sobre mensagens" a `docs/architecture/` com **≥2 arestas** (ingest → projeção → inbox), como o Princípio II exige
- [X] T068 [P] Atualizar `docs/testing/user-journey-map.md` com a cobertura das quatro jornadas e os buracos que sobraram, sem maquiar
- [X] T069 [P] Atualizar `docs/current-state.md` com o que passou a estar pronto e o que segue quebrado
- [ ] T070 Rodar [quickstart.md](quickstart.md) de ponta a ponta e **declarar qual suíte rodou e qual não rodou** — verde parcial não é reportado como verde
- [X] T071 `pnpm typecheck` e `pnpm lint` zerados; nenhum `console.log`; `pnpm test:db` verde (é ele, não o `test:unit`, que exercita o isolamento)
- [ ] T072 Apagar todo recurso pago que os testes provisionaram, verificando o **registro vazio** — não a intenção de apagar

---

## Dependencies & Execution Order

### Entre fases

- **Phase 1 (Setup)**: sem dependência — começa já
- **Phase 2 (Foundational)**: depende da Phase 1. **BLOQUEIA todas as jornadas** — é a fonte
  única de tipo, capacidade e carga
- **Phase 3 (US1)**: depende da Phase 2. Não depende de nenhuma outra jornada
- **Phase 4 (US2)**: depende da Phase 2. Independente da US1
- **Phase 5 (US3)**: depende da Phase 2. Independente da US1 e da US2
- **Phase 6 (US4)**: depende da Phase 2 **e da US1** — sem leitura fiel, o clique do cliente
  volta mudo e a jornada piora a conversa
- **Phase 7 (Polish)**: depois das jornadas que forem entregues

### Dentro de cada jornada

- Teste escrito e **vermelho** antes da implementação
- Migration antes do código que a usa (T017 antes de T019; T061 antes de T062)
- Módulo de dados antes do handler; handler antes da tela
- Sabotagem confirmada antes de chamar a fase de pronta

### Paralelismo

- T002 e T003 em paralelo na Phase 1
- T005, T006, T008 e T009 em paralelo depois de T004
- T011–T016 em paralelo (arquivos de teste distintos)
- T022–T026 em paralelo (cinco componentes novos, sem interseção)
- T033–T036, T045–T048 e T058–T060 em paralelo dentro das suas fases
- T053 e T054 em paralelo
- T067, T068 e T069 em paralelo
- Com mais de uma pessoa: US1, US2 e US3 em paralelo depois da Phase 2; US4 espera a US1

---

## Parallel Example: User Story 1

```bash
# Testes da US1, todos juntos (arquivos distintos):
Task: "Invariante de isolamento da projeção em tests/invariants/projecao-de-eventos-isolamento.test.ts"
Task: "Reação fora da linha do tempo em tests/unit/projecao-de-eventos.test.ts"
Task: "Nenhuma bolha vazia em tests/unit/bolha-sem-buraco.test.tsx"
Task: "Anonimização acima da citação em tests/invariants/projecao-lgpd-anonimizacao.test.ts"

# Os cinco componentes de bolha, todos juntos:
Task: "components/inbox/message/QuotedPreview.tsx"
Task: "components/inbox/message/ReactionRow.tsx"
Task: "components/inbox/message/LocationCard.tsx"
Task: "components/inbox/message/ContactCard.tsx"
Task: "components/inbox/message/UnsupportedNotice.tsx"
```

---

## Implementation Strategy

### MVP primeiro (só a User Story 1)

1. Phase 1 — Setup
2. Phase 2 — Foundational (bloqueia tudo)
3. Phase 3 — US1
4. **PARAR E VALIDAR**: percorrer a conversa pela tela, conta nova, aparelho real
5. Entregar

A US1 sozinha já é entrega de verdade: é a única fatia em que o defeito atual **perde
informação do cliente**. Enviar de menos é limitação; ler errado é atender errado.

### Entrega incremental

1. Setup + Foundational → fundação pronta
2. + US1 → linha do tempo fiel (**MVP**)
3. + US2 → responder citando
4. + US3 → localização, contato, figurinha, e o fim do "aceito e inenviável"
5. + US4 → menu, botão de link, pedido de localização

Cada uma acrescenta sem quebrar as anteriores.

---

## Notes

- `[P]` = arquivo diferente, sem dependência pendente
- **Commit por FASE fechada**, não por task: o commit carrega as tasks marcadas, o
  planejamento atualizado e os gates verdes. Commite antes se a árvore for compartilhada ou a
  fase for longa — perder trabalho é pior que histórico bonito. **Esta árvore é
  compartilhada** com outras sessões: commite cedo.
- **Planejamento acompanha a execução** (constituição v2.4.0+): a cada **5 tasks** avançadas —
  ou ao fechar uma fase, o que vier primeiro — atualizar este arquivo com o estado real,
  `plan.md` se o desenho mudou, e `docs/current-state.md` se o que está pronto mudou
- **`pnpm test:db` antes de abrir PR**: esta feature mexe em schema e em projeção que filtra
  tenant. `test:unit` verde aqui é falso-verde — ele não roda `tests/invariants/**`
- **Migrations por `supabase db push`, nunca por MCP** — e há dois MCPs de Supabase alcançáveis
  daqui, apontando para bancos diferentes (`supabase-crm` é este projeto; `supabase` é a
  produção do Cotador)
- **Fora de escopo, e não se conserta sem querer**: enviar reação e apagar para todos (FR-022).
  Se uma task parecer pedir isso, ela está errada — a operação mora na porta de tráfego

---

## Estado da execução — 2026-08-09

**63 de 72 concluídas.** As 9 abertas não são esquecimento: sete dependem de ambiente ou
aparelho que esta sessão não tinha, e duas são fechamento que só faz sentido depois delas.

| Task | Por que segue aberta |
|---|---|
| T001, T002, T003 | Ambiente fresco completo (Supabase pg17 do zero + `bootstrap-owner` + app em produção + gateway pareado) e a conversa de ≥500 mensagens. As specs de tela foram **escritas e listadas** pelo Playwright; falta **executá-las** nesse ambiente. |
| T031 | Medir a projeção na conversa grande. Sem o seed de ≥500 mensagens, o número seria de uma conversa de dez — que não mede índice nenhum. **O índice é fé até esta medição.** |
| T043, T056, T066 | Prova com **aparelho real**: citação chegando apontando certo, mapa abrindo no lugar, contato salvando na agenda, figurinha sem moldura, menu clicável. Formato de terceiro só se sabe medindo o terceiro — dublê não serve. |
| T070, T072 | Fechamento do quickstart e limpeza de recurso pago, que só existem depois das execuções acima. |

**O que ESTÁ provado**, e por qual gate:

- `pnpm typecheck` e `pnpm lint`: **zerados de erro**.
- `pnpm test:unit`: verde, com os arquivos novos (`projecao-de-eventos`, `bolha-sem-buraco`,
  `tipo-aceito-e-enviavel`, `menu-limites-do-canal`, `canal-capacidades-matriz`, e o
  `adapters/gateway.test.ts` estendido).
- `pnpm test:db`: **84 arquivos, 568 testes, verde** — com o `baseline.sql` aplicado em install
  E update, incluindo as migrations 0132 e 0133, o par novo do vocabulário, o isolamento da
  projeção e o invariante de LGPD.
- **Nota de ambiente, para quem repetir:** `scripts/test-db.sh` usa **porta fixa** (54329). Com
  duas sessões rodando `test:db` nesta máquina, uma derruba o container da outra e o resultado é
  uma enxurrada de `No such container` — 138 falhas que não têm nada a ver com o código. Rode com
  `TEST_DB_PORT=54399 pnpm test:db` quando a árvore estiver disputada, e **nunca** remova
  container que não é seu.
- **Sabotagem confirmada em 3 rodadas, 12 vermelhos**: projeção desligada (5), adapter sem
  `quoted_id`/`contatos` (3), bolha sem rótulo/reação/corpo apagado (4).

**Verde parcial não é verde**: a suíte de tela (`pnpm test:e2e`) **não rodou** nesta sessão.
