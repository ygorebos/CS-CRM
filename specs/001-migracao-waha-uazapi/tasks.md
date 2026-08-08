# Tasks: Recebimento unificado pelo gateway — envelope normalizado e ingest único

**Input**: Design documents from `specs/001-migracao-waha-uazapi/`

**Prerequisites**: [plan.md](./plan.md) · [spec.md](./spec.md) · [research.md](./research.md) ·
[data-model.md](./data-model.md) · [contracts/gateway-inbound-v1.md](./contracts/gateway-inbound-v1.md) ·
[quickstart.md](./quickstart.md)

**Tests**: **OBRIGATÓRIOS.** A spec os exige (FR-031, FR-032, FR-033) e o Princípio XI da
constituição v1.2.0 os torna condição de "pronto". Toda tarefa `[TEST]` é escrita **antes** da
implementação que ela vigia e tem de ficar **vermelha** primeiro; toda fase termina com a tarefa
de **sabotagem**, que prova que o teste realmente vigia.

**Organization**: por história, na ordem de risco decrescente do plano (fatias 1→5). Cada fase é
um incremento utilizável sozinho.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizável (arquivos distintos, sem dependência pendente)
- **[Story]**: US1..US6, conforme `spec.md`
- **[TEST]**: tarefa de teste — escrita antes da implementação correspondente
- Caminho de arquivo exato em toda tarefa

## Path Conventions

- **CRM**: raiz `/root/PROJETOS/crm_3_0` — `app/api/v1/**`, `lib/**`, `workers/**`,
  `tests/{unit,invariants,e2e}/**`, `supabase/**`
- **Gateway**: raiz `/root/PROJETOS/gateway_go` — `internal/**`

---

## Phase 1: Setup (infraestrutura compartilhada)

**Purpose**: deixar os dois lados capazes de se falar em desenvolvimento, sem tocar em
comportamento de produção.

- [x] T001 Declarar `GATEWAY_BASE_URL`, `GATEWAY_INBOUND_ENABLED`, `GATEWAY_MAX_BODY_BYTES` e `GATEWAY_MAX_MEDIA_BYTES` em `lib/env.ts`, com Zod que lança no startup quando a rota estiver ligada e a base faltar. **Os dois tetos nascem com número, não com `TODO`**: medir o maior corpo e a maior mídia que os canais suportados pelo gateway realmente entregam (`internal/normalizer/*.go` e os limites publicados de cada provedor) e adotar esse valor com folga — inventar um número aqui é o que transforma o edge case "corpo gigante" em incidente de produção
- [x] T002 [P] Espelhar as mesmas variáveis em `.env.example`, com comentário do que cada uma faz (item 9 do DoD; `docs/current-state.md` §4.5 registra que este arquivo desgarra de `lib/env.ts`)
- [x] T003 [P] Acrescentar o serviço `gateway` em `docker-compose.yml` (desenvolvimento) em modo relay, com portas presas a `127.0.0.1` e volume nomeado para a fila em disco
- [x] T004 [P] Documentar o modo relay e as variáveis novas em `docs/runbooks/` (arquivo novo `gateway-relay.md`), incluindo como conferir que ele subiu

**Checkpoint**: `docker compose up -d` sobe gateway e app lado a lado; nada de produção mudou.

---

## Phase 2: Foundational (pré-requisito bloqueante)

**Purpose**: schema, contrato, autenticidade e a porta de entrada. **Nenhuma história começa antes
desta fase fechar.**

**⚠️ CRÍTICO**: a fase toca schema — `pnpm test:db` é obrigatório aqui, e `pnpm test:unit` verde
**não** é prova (`tests/invariants/**` está fora dele de propósito).

### Schema — a tripla obrigatória (Princípio III)

- [x] T005 Criar `supabase/migrations/20260808150000_0119_gateway_inbound.sql` com: `channel_sessions.ingest_path text not null default 'legacy' check (ingest_path in ('legacy','gateway'))`, `channel_sessions.gateway_connection_id text`, extensão do `channel_sessions_provider_check` para incluir `whatsapp_uazapi`/`whatsapp_cloud`/`instagram`/`messenger`, extensão do `webhook_events_log_provider_check` para incluir `gateway`, e índice parcial em `webhook_events_log (status, received_at) where status = 'received'` — tudo idempotente (`add column if not exists`, `drop constraint if exists` + `add constraint`), sem `BEGIN`/`COMMIT` explícito
- [x] T006 Acrescentar o mesmo conteúdo como apêndice idempotente e auto-curativo no fim de `supabase/baseline.sql`, no bloco rotulado `-- ---- recebimento unificado pelo gateway (migration 0119) ----`
- [x] T007 [P] Registrar a linha da 0119 em `supabase/migrations/MANIFEST.md` (tabela "Applied"), dizendo o QUÊ e o PORQUÊ
- [x] T008 Provar o baseline num Postgres descartável `pgvector/pgvector:pg17`: aplicar em modo install (`ON_ERROR_STOP=1`) e em modo update (re-aplicar, sem a flag) — os dois têm de passar
- [x] T009 Regenerar `lib/database.types.ts` a partir do schema novo

### Contrato do envelope

- [x] T010 [TEST] [P] Escrever `tests/unit/gateway-envelope.test.ts` cobrindo: envelope válido aceito; campo desconhecido preservado em `metadata`; `envelope_version` futura aceita; `type` desconhecido vira `system` com `metadata.original_type`; `event_kind` desconhecido ignorado com motivo; corpo malformado recusado
- [x] T011 Implementar `lib/gateway/envelope.ts` — schema Zod do envelope v1 conforme `contracts/gateway-inbound-v1.md` §3, tolerante a campo desconhecido, exportando os tipos consumidos pelo ingest
- [x] T011a [TEST] `tests/invariants/gateway-sem-payload-cru.test.ts` — nenhum arquivo fora de `lib/waha/**` e `lib/channels/meta/**` importa parser de provedor ou lê campo cru de payload de canal; o caminho novo só conhece o envelope. **FR-005 está escrito como invariante e hoje não tem vigia** — o Princípio XI diz que invariante só em prosa deixa de ser invariante. Vale como regra de lint equivalente, desde que reprove no CI

  > 3 testes de varredura estática, em `tests/invariants/` porque é a suíte do job obrigatório — regra que não reprova merge é documentação com aparência de portão. Cobre import de módulo de provedor **e** leitura de campo cru (`_data`, `fromMe`, `entry[0]`…, ignorando comentários, que citar o campo para explicar de onde a coisa veio é metade da doutrina deste repo). O terceiro é **caso de controle**: se `lib/waha/` sumisse num refactor, os dois primeiros ficariam verdes por não haver o que violar, e o verde seria lido como "a arquitetura está limpa".

### Autenticidade

- [x] T012 [TEST] [P] Escrever `tests/unit/gateway-auth.test.ts` cobrindo: assinatura válida aceita; inválida recusada; ausente recusada; timestamp fora de ±300s recusado; segredo curto ou ausente recusa tudo (fail-closed, **sem** válvula de escape)
- [x] T013 Implementar `lib/gateway/auth.ts` — HMAC-SHA512 sobre `"{timestamp}.{corpo_cru}"` com `crypto.timingSafeEqual` e janela de ±300s, reusando a técnica de `lib/waha/webhook-auth.ts` mas **sem** herdar `WAHA_WEBHOOK_REQUIRE_SIGNATURE`

### Porta de entrada

- [x] T014 Implementar `app/api/v1/webhooks/gateway/[token]/route.ts`: resolve `channel_sessions` por `webhook_path_token` (tolerante a canal arquivado, como a rota WAHA), decifra o segredo via `fn_decrypt_oauth`, verifica assinatura, grava em `webhook_events_log` com `provider='gateway'` e `status='received'`, e **responde `202` antes de qualquer ingestão** (ACK-primeiro)
- [x] T015 Aplicar rate limit na rota nova, com `X-RateLimit-*` e `Retry-After` em 429 — a rota é pública e o Princípio VI exige; `docs/current-state.md` §4.3 mostra que webhooks hoje não têm, e esta rota **não** herda o buraco. **O teto é por conexão e nasce acima do alvo de rajada do SC-010** (200 mensagens em 60s): limite apertado demais derruba o tráfego legítimo do corretor numa campanha respondida, e é indistinguível de estar fora do ar. Fixar o número como múltiplo declarado do alvo, nunca como palpite
- [x] T015a [TEST] `tests/unit/gateway-rate-limit.test.ts` — 200 entregas em 60s pela mesma conexão **passam**; tráfego acima do teto recebe `429` com `Retry-After`; o limite de uma conexão não consome a cota de outra. Sem este teste, T015 e SC-010 são requisitos que se contradizem no escuro
- [x] T014a [TEST] [P] Estender `tests/unit/gateway-envelope.test.ts` (ou arquivo irmão) com os tetos de tamanho: corpo acima de `GATEWAY_MAX_BODY_BYTES` é recusado com erro claro e **sem** carregar tudo em memória; envelope cuja mídia declara tamanho acima de `GATEWAY_MAX_MEDIA_BYTES` entra como mensagem com anexo indisponível, nunca derruba a ingestão — é o edge case "corpo gigante ou mídia enorme" da spec, que só existia como variável de ambiente

  > Os dois tetos ganharam teste, e a **assimetria entre eles é a decisão**: corpo acima do teto é recusa (413, antes de tocar o banco — teto que só protege depois da consulta não protege o recurso escasso); anexo acima do teto é **mensagem que entra sem o anexo**. A resposta a "o que dói mais": corpo absurdo é entrega malformada, anexo absurdo é uma pessoa mandando um vídeo. Implementado também o caso do tamanho **declarado** no envelope: acima do teto, o download nem é pedido — baixar para descobrir o que já está escrito ali gasta rede e memória justamente no caso do arquivo enorme. Cada teto tem caso de controle, senão um bug que recusasse tudo passaria.
- [x] T016 [P] Auditar as recusas (`webhook.gateway_rejected`) com motivo, seguindo o padrão de `app/api/v1/webhooks/waha/[token]/route.ts`

### Vocabulário de canal no TypeScript

- [x] T017 [P] Acrescentar os providers novos em `lib/channels/session-ref.ts`, `lib/channels/capabilities.ts` e `lib/channels/selectable.ts`, mantendo o invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` verde

### Segredo por conexão — bloqueador descoberto na análise

> **Sem esta sub-fase a US1 não sobe.** Medido: `app/api/v1/channel-sessions/route.ts:105` e
> `app/api/v1/onboarding/whatsapp/session/route.ts:102` gravam
> `webhook_secret_encrypted: Buffer.from([0])` — um byte de enfeite. Como a rota nova é
> fail-closed **sem** válvula e o mínimo é 16 bytes, ela recusaria **100%** das entregas de
> qualquer conexão criada pelo onboarding — que é justamente o caminho do corretor. Só
> `app/api/v1/channels/official/route.ts:200` grava segredo de verdade.

- [x] T017a [TEST] `tests/invariants/channel-session-segredo.test.ts` — toda `channel_session` nasce com segredo decifrável de comprimento ≥16; nenhuma nasce com placeholder
- [x] T017b Gerar segredo forte na criação da sessão e cifrá-lo em `app/api/v1/channel-sessions/route.ts` e `app/api/v1/onboarding/whatsapp/session/route.ts`, no padrão que `app/api/v1/channels/official/route.ts:200` já usa
- [x] T017c Curar as linhas existentes **fora do SQL**: passo idempotente em `scripts/curar-segredos-de-canal.ts`, chamado pelo `install.sh` e pelo `update.sh` **depois** de `ensure_encryption_key`, que gera segredo forte para toda `channel_session` com `webhook_secret_encrypted` placeholder e o cifra por `encryptWebhookSecret` (`lib/webhooks/secrets.ts`) — o mesmo caminho que `app/api/v1/channels/official/route.ts:132` já usa

  > ⛔ **Não fazer isso na migration nem no apêndice do `baseline.sql`.** Medido:
  > `public.fn_encrypt_oauth` (`baseline.sql:5276`) faz
  > `raise exception 'NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente'` quando a chave é nula ou
  > tem menos de 32 caracteres, e a chave só existe no banco depois que
  > `ensure_encryption_key` a semeia em `private.app_secrets` — que
  > `hostgator-setup-kit/_common.sh:460` documenta rodar **"APÓS aplicar o baseline"**.
  > Consequência de cifrar dentro do baseline: no `install.sh` ele roda com
  > `ON_ERROR_STOP=1` (`install.sh:1215`) e **a instalação de uma VPS nova aborta**; no
  > `update.sh`, que roda **sem** a flag, falha em silêncio, o placeholder permanece e a
  > rota fail-closed recusa 100% das entregas daquela conexão sem ninguém saber.
  > A doutrina de corrigir dados antes da constraint continua valendo — o que muda é
  > **onde**, porque este dado depende de uma chave que o SQL ainda não tem.

- [x] T017d **Sabotagem**: devolver o `Buffer.from([0])` em um dos dois caminhos e confirmar que T017a fica vermelho; restaurar
- [x] T017e Recusar com motivo próprio quando o segredo ainda for placeholder: a rota nova responde `gateway_secret_nao_provisionado` (não um `401` genérico) e abre aviso na Central — sem isso, uma conexão não curada vira silêncio, que é o que o Princípio II proíbe

  > **Como saiu, e as duas escolhas que fugiram da letra da tarefa.** O código é
  > `gateway_secret_not_provisioned` — mesma coisa, em inglês, porque `lib/api/errors.ts` é um
  > vocabulário público inteiramente em inglês e um código em português ali seria uma verruga
  > permanente na API. E o status é **503**, não 401: pelo contrato (§5), o gateway DESCARTA 401 e
  > RETENTA 5xx; classificar como falha de autenticação faria o histórico do período quebrado nunca
  > entrar, quando ele entra sozinho assim que a chave existir. O aviso é **um por conexão** enquanto
  > houver um `open` — a conexão quebrada recusa toda entrega, e sem deduplicar um número movimentado
  > enterraria a Central em minutos. O kind `channel_secret_missing` saiu como migration 0120 +
  > apêndice do baseline + linha no MANIFEST, e entrou em `InboxKind` (o par TS×banco é cobrado por
  > `tests/invariants/vocabulario-banco-x-typescript.test.ts`).

### Gateway — poder subir sem banco

- [x] T018 Implementar o modo relay em `internal/config/config.go` do gateway: quando `GATEWAY_MODE=relay`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` deixam de ser `mustGetEnv` e a persistência é pulada
- [x] T019 [TEST] [P] Teste em Go provando que o processo **sobe** em modo relay sem as variáveis de Supabase e **continua exigindo-as** no modo padrão

**Checkpoint**: schema aplicado e provado nos dois modos, contrato e autenticidade testados, rota
respondendo `202` e enfileirando, gateway subindo sem banco. Nenhuma mensagem ingerida ainda.

---

## Phase 3: User Story 1 — A primeira mensagem real atravessa a costura (P1) 🎯 MVP

**Goal**: mensagem real de WhatsApp aparece no inbox pelo caminho novo, uma vez só, com a cadeia
viva disparando.

**Independent Test**: mandar mensagem de um celular e ver no inbox, pela tela; reentregar o evento
e a contagem não muda.

### Testes primeiro (têm de ficar vermelhos)

- [x] T020 [TEST] [P] [US1] `tests/invariants/gateway-inbound-idempotencia.test.ts` — mesma entrega duas vezes produz **uma** mensagem, e a segunda responde `202` com `duplicate: true`
- [x] T021 [TEST] [P] [US1] `tests/invariants/gateway-inbound-posse-nome.test.ts` — nome definido por humano em `contacts.name`/`display_name` **não** é sobrescrito pelo nome vindo do canal (vigia o `coalesce` de `fn_upsert_wa_contact`, hoje sem teste nenhum)
- [x] T022 [TEST] [P] [US1] `tests/e2e/gateway-inbound.spec.ts` — pela tela, em ambiente fresco: envelope assinado entra e a mensagem aparece no inbox com contato e corpo corretos

  > **Executada em 2026-08-08, e a execução achou dois defeitos NA PRÓPRIA SPEC.** Stack fresco
  > isolado (Supabase CLI `deskcomm-e2e001`, baseline.sql, `next build` + `next start`), 4 casos
  > verdes em 39s. Evidência: `.superpowers/evidence/spec001-t022-inbox-gateway.png`.
  >
  > O que a sabotagem revelou (Princípio XI, e por isso ela não é formalidade):
  > **(1)** com o ingest sabotado para gravar `external_id` diferente a cada entrega, o banco
  > ficou com DUAS mensagens de corpo idêntico e o caso de "não duplica" passou **verde**. Duas
  > causas somadas: `toHaveCount(1)` é satisfeito no instante em que existe UMA bolha — e a
  > duplicata chegava depois, porque a rota dá ACK antes de ingerir; e `getByText(corpo)` casava
  > a **prévia da conversa na listagem**, que repete o corpo da última mensagem, então a contagem
  > nunca olhou para a thread. Conserto: espera pelo estado terminal em `webhook_events_log`
  > (o próprio ACK durável da rota) antes de contar, e contagem por `data-testid` da BOLHA.
  > **(2)** o caso da entrega forjada afirmava ausência sem esperar nada — passaria igual com a
  > verificação de assinatura desligada. Agora exige o estado terminal `error` antes de olhar.
  >
  > Re-sabotado depois do conserto: idempotência quebrada → "Received: 2"; assinatura aceita
  > sempre → `Expected 401, Received 202`. Cada caso fica vermelho pelo defeito que vigia.

### Implementação

- [x] T023 [US1] Implementar `lib/gateway/ingest.ts` para `event_kind: "new_message"`: resolve identidade, chama `fn_upsert_wa_contact` e `fn_upsert_wa_conversation` (reuso — **não** escrever `insert` próprio em `contacts`/`conversations`), insere em `messages` capturando `code === '23505'` como caminho normal
- [x] T024 [US1] Disparar a cadeia viva a partir do ingest novo — emissão em `event_log` do `ai_agent.dispatch_requested` e auditoria, espelhando `lib/waha/ingest.ts:462`
- [x] T025 [US1] Implementar `workers/gateway-inbound-worker.ts` consumindo `webhook_events_log` com `provider='gateway'` e `status='received'`, marcando `processed`/`error` e incrementando `attempts`
- [x] T026 [US1] Ligar o disparo imediato em segundo plano na rota (`app/api/v1/webhooks/gateway/[token]/route.ts`), **depois** da resposta — é o que sustenta o alvo de ≤5s
- [x] T027 [US1] Respeitar `channel_sessions.ingest_path` no ingest: conexão `legacy` recusa entrega pelo caminho novo com motivo explícito
- [x] T027a [TEST] [P] [US1] `tests/invariants/gateway-inbound-identidade-canonica.test.ts` — o mesmo contato chegando com as duas grafias de identificador (número canônico e identificador interno do canal) cai numa **única** conversa, sem partir o histórico
- [x] T027b [US1] Usar em `lib/gateway/ingest.ts` o identificador **resultante** da canonicalização (o que `fn_upsert_wa_contact` devolve, com `lib/channels/phone-variants.ts`), nunca o que veio no envelope — FR-020

  > **Onde a regra ficou, e por quê.** Ela já existia — dentro de `lib/channels/meta/ingest.ts`,
  > aplicada só ali. Deixá-la lá faria o ingest do gateway nascer sem ela e o defeito voltar por um
  > caminho novo, então saiu para `lib/channels/identidade-canonica.ts`, com o acesso a dados
  > **injetado**: o ingest busca por supabase-js e o invariante por SQL puro contra o Postgres do
  > `baseline.sql`, exercitando a MESMA função. Regra reescrita no teste provaria uma cópia — e cópia
  > não vigia nada. (`lib/channels/meta/ingest.ts` ainda tem a sua própria; unificar é dívida
  > registrada, fora do escopo desta fatia.)
- [x] T028 [US1] Substituir `internal/handlers/webhook_forward.go` no gateway por entrega do **envelope normalizado** assinado (HMAC + timestamp + `X-Gateway-Delivery-Id`), conforme `contracts/gateway-inbound-v1.md` §2–§3

  > **Substituição COM caminho de volta, e a razão.** O encaminhamento cru não foi apagado: destino
  > sem `formato` continua recebendo o payload do provedor, e só quem tiver `formato:
  > "envelope_v1"` (+ `segredo`) recebe o envelope assinado. Trocar tudo no mesmo deploy derrubaria
  > todos os integradores que já consomem o formato antigo — e num produto que roda em máquina de
  > terceiros isso não se conserta remotamente. É a mesma doutrina da chave `ingest_path` por
  > conexão deste lado. Ligado nos quatro canais (uazapi, cloud, instagram, messenger), em
  > mensagem e em estado. Sem retentativa e sem fila em disco — é a Fase 4.
- [x] T029 [US1] Mapear `MensagemNormalizada` → envelope v1 em pacote novo do gateway, cobrindo os campos da tabela de vocabulário da análise (`analise-gateway-go-recebimentos.md`)

### Prova

- [ ] T030 [US1] Executar o roteiro do `quickstart.md` §1 (20 envios reais, medir p95 ≤5s, reentregar tudo e conferir contagem estável)
- [x] T031 [US1] **Sabotagem**: remover a captura de `23505` no ingest e confirmar que T020 fica **vermelho**; restaurar. Repetir trocando o `coalesce` de nome e confirmar T021 vermelho

**Checkpoint**: US1 entregue e provada. É a fatia 1 do plano — se ela não fechar, o plano é
reavaliado antes de qualquer investimento adicional.

---

## Phase 4: User Story 2 — Nada se perde com o CRM fora do ar (P2)

**Goal**: CRM indisponível por minutos e nenhuma mensagem se perde.

**Independent Test**: derrubar o CRM, mandar N mensagens, subir, e ver as N no inbox sem duplicata.

- [x] T032 [TEST] [P] [US2] Teste em Go da fila de entrega do gateway: pendência gravada **antes** da primeira tentativa; sobrevive a reinício do processo; respeita espera crescente; termina em `dead` após o teto

  > `internal/entrega/fila_test.go`, 9 testes. A prova de ORDEM é feita de dentro da tentativa: o entregador lê o diretório e falha se ele estiver vazio — um teste que só checasse "acabou entregue" passaria com fila em memória. O teste de reinício lê **o disco direto**, sem passar pela fila: `Pendentes()` sozinho não distingue disco de mapa em variável de pacote, que sobrevive a um `AbrirFila` novo mas não ao processo morrer.

- [x] T033 [TEST] [P] [US2] `tests/invariants/gateway-inbound-dreno.test.ts` — linha `received` parada além do limite é recolhida pelo dreno; linha `processed` não é reprocessada; linha que falha N vezes vira `dead`

  > 8 testes contra o Postgres efêmero, com `emit_event` e os CHECKs reais no caminho. Além dos três exigidos: a linha recém-chegada **não** é recolhida (a carência é o que evita ingerir junto com o disparo em segundo plano), a linha sem dono morre com motivo, o aviso não duplica enquanto houver um aberto, e linha de `provider = 'waha'` fica intocada. O dublê de `ingerirEnvelope` registra quem passou por ele — sem isso, "não foi reprocessada" seria verdade por construção.

- [x] T034 [US2] Implementar `internal/delivery/` no gateway: fila durável em disco, espera crescente com teto, e estado terminal inspecionável

  > **Desvio declarado de caminho**: saiu como `internal/entrega/fila.go`, não `internal/delivery/`. O pacote `internal/entrega` já É esta preocupação (assina e manda), o repositório inteiro nomeia pacote em português, e um irmão em inglês partiria a entrega em dois lugares. Descarte inspecionável = arquivo em `<dir>/mortas/`, legível sem o programa.
  >
  > **Decisão que mudou no meio, e por quê**: o desenho inicial não gravava o segredo de assinatura em disco. Não fecha — depois de um reinício, assinar exige o segredo, e o gateway resolve conexão por **token do provedor**, não por ID; guardar esse token seria guardar um segredo maior. Manter só em memória tornaria inassinável exatamente a pendência que a fila existe para salvar. Então o segredo mora na pendência, arquivo `0600`, apagado no aceite, com o campo isolado para quem quiser cifrá-lo.
  >
  > Ligada no `webhook_forward.go` (enfileira em vez de disparar goroutine) e no boot (`ligarFilaDeEntrega`), com retomada imediata do que sobrou do processo anterior. `ENTREGA_FILA_DIR` vazio mantém o comportamento antigo: exigir a variável trocaria "entrega sem durabilidade" por "gateway não sobe".

- [x] T035 [US2] Aplicar a política de retentativa do contrato (§5): retenta em rede/timeout/`5xx`/`429` respeitando `Retry-After`; **não** retenta `400`/`401`/`404` — vão direto ao descarte com aviso

  > `entrega.Classificar`. `Retry-After` entrou em `Resultado` e vale como **piso** da espera própria. Duas leituras acrescentadas ao contrato, ambas testadas: `409` (conexão não migrada) vai ao descarte — insistir não cura, e nesse estado o caminho legado ainda entrega; qualquer outro 4xx idem, porque retentar contra um 4xx não listado é laço infinito. Só a forma em **segundos** de `Retry-After` é lida: a forma HTTP-date depende de relógios alinhados, e errar para mais é mensagem parada por horas.

- [x] T036 [US2] Implementar `app/api/v1/cron/gateway-inbound-drain/route.ts` e agendá-la no `scheduler` do `docker-compose.prod.yml`, no padrão do `event-log-drain`
- [x] T037 [US2] Tornar o descarte visível: item na Central de avisos quando houver entrega `dead` (Princípio II — falta de funcionamento aparece na tela, não em `log.Warn`)

  > Migration **0118** (+ apêndice no `baseline.sql` + MANIFEST): `agent_inbox_items.kind` ganha `gateway_delivery_dead`. Kind próprio, e não reuso de `channel_secret_missing`, porque o desfecho é oposto e é ele que decide a ação de quem lê: lá nada se perde e as mensagens entram quando a chave existir; aqui **acabou**, não haverá outra tentativa. O dreno já emitia `gateway.entrega_descartada` no `event_log` e **ninguém escutava** — evento sem consumidor, anti-pattern nº 3, e na prática o mesmo silêncio do `log.Warn` que esta spec existe para acabar. Do lado do gateway, o gancho equivalente é `AoMorrer`, hoje em log de erro.

- [ ] T038 [US2] Executar o roteiro do `quickstart.md` §2, incluindo o reinício do **gateway** no meio do intervalo

  > **Aberta — depende de ambiente, não de código.** Exige gateway + CRM + WAHA de pé com número real. Mesma classe de T022 e T030.

- [ ] T038a [US2] Executar o roteiro de rajada do `quickstart.md` §7 (200 mensagens em 60s): 100% no inbox, zero duplicatas, e o ritmo de resposta do agente ainda obedecendo os limites anti-banimento existentes — é o SC-010, que não tinha tarefa. **Rodar com o rate limit de T015 ligado**, e não desligado para o teste passar: rajada provada sem o limite ativo não prova nada sobre produção

  > **Aberta — depende de ambiente.** Idem T038.

- [x] T039 [US2] **Sabotagem**: trocar a fila em disco por fila em memória e confirmar que T032 fica vermelho; restaurar

  > Feita duas vezes. A primeira derrubou 2 dos 9 e revelou um buraco: o teste de reinício passava, porque o mapa em variável de pacote sobrevive a um `AbrirFila` novo. Corrigido o teste (leitura direta do disco), a mesma sabotagem derruba **3**. Sabotagem correspondente do T033: remover o aviso na Central e remover a carência do dreno derruba exatamente os 2 testes que as vigiam.

**Checkpoint**: a promessa "nada se perde" deixa de ser promessa.

---

## Phase 5: User Story 3 — Forjado não entra, tenant não vaza (P2)

**Goal**: a rota nova recusa o que não é autêntico e nunca cruza organização.

**Independent Test**: emissor HTTP real dispara as sete requisições da tabela do `quickstart.md` §3.

- [x] T040 [TEST] [P] [US3] `tests/invariants/gateway-inbound-autenticidade.test.ts` — as sete requisições da tabela do quickstart §3, cada uma provando que **nada** foi gravado quando recusada

  > **Dois desvios declarados.** (1) O emissor não é HTTP: o harness de invariantes sobe Postgres
  > cru, sem PostgREST nem servidor Next, então a rota é chamada direto com o client de serviço
  > **traduzido para SQL** (mesmo padrão de `webhooks-trigger-events.test.ts`) — o que pousa no
  > banco é linha de verdade, com constraints e triggers reais. O emissor HTTP de fato fica na
  > ponta a ponta (T030). (2) O caso 6 responde **503**, não o 401 da tabela: é a decisão do
  > T017e — o defeito é deste lado e é curável, e o contrato manda o gateway retentar 5xx, então
  > as entregas do período quebrado entram sozinhas quando a chave existir.
  >
  > **O dublê da ingestão grava linha real** (sentinela). Um no-op faria "zero linhas em
  > `messages`" ser verdade por construção mesmo que a rota chamasse a ingestão numa entrega
  > forjada — o pior falso verde possível aqui. Com o sentinela, "nada foi gravado" passa a
  > incluir "a ingestão nem foi chamada", e o caso 7 cobra o sentinela PRESENTE, senão os seis
  > casos de recusa passariam com a rota recusando tudo.
- [x] T041 [TEST] [P] [US3] `tests/invariants/gateway-inbound-isolamento.test.ts` — duas organizações recebendo ao mesmo tempo; usuário da org A enxerga **zero** linhas da org B em `messages`, `conversations` e `contacts`, **com caso de controle** provando antes que as linhas da org B existem

  > **A leitura é feita com claims de JWT, nunca pelo service role** — o service role bypassa RLS,
  > então medir por ele diria o que o servidor consegue ver, não o que o usuário vê. E cada caso de
  > "vê zero" tem o par "vê as próprias": zero sozinho passaria também com a RLS negando tudo, que
  > é bug de produto com cara de teste verde. Sabotagem confirmada: abrir `messages_select` para
  > `using (true)` no baseline deixa 3 dos 5 casos vermelhos.
- [x] T042 [US3] Garantir no ingest que o `organization_id` vem sempre da linha de `channel_sessions` resolvida pelo token, e que qualquer `organization_id` presente no corpo é **ignorado** e a tentativa registrada

  > A chave do corpo é **ignorada para autorização e registrada como auditoria**
  > (`reason: "tenant_no_corpo_ignorado"`), não recusada: recusar daria ao atacante um oráculo
  > — ele descobriria por tentativa quais chaves o CRM lê. O parser devolve `tenantForcado`, a
  > rota registra, e o valor sobrevive só como `metadata.extra_*`, que é dado inerte.
- [x] T043 [US3] Fazer `webhook_events_log` registrar recusa com motivo suficiente para reconstruir o caso sem log de aplicação (SC-012)

  > `registrarRecebimento` passou a exigir `assinaturaValida: boolean` — antes era `true` fixo, e
  > a coluna mentia justamente para quem fosse auditar um incidente. Os ramos 401 e 409 passaram
  > a gravar linha `error` com motivo e corpo cru. O invariante separa **recusa de autenticidade**
  > de **falha depois do ACK**: a segunda também termina em `error`, e ali `valid_signature = true`
  > é a verdade — ler as duas juntas transformaria a coluna em "deu erro".
- [x] T044 [US3] Rodar `pnpm test:db` inteiro e confirmar que os invariantes novos entram no job `invariants` (obrigatório na branch protection)

  > `pnpm test:db` verde: **75 arquivos / 503 testes** (1 skip). Os dois arquivos novos entram por
  > `include: tests/invariants/**` do `vitest.db.config.ts`, que é o mesmo caminho do job
  > `invariants`. `vitest.db.config.ts` ganhou `GATEWAY_INBOUND_ENABLED`/`GATEWAY_BASE_URL`: sem
  > elas a rota responde 404 e o arquivo mediria o interruptor, não a autenticidade.
- [x] T045 [US3] **Sabotagem**: trocar `timingSafeEqual` por `===` e confirmar T040 vermelho; mover a origem do `organization_id` do token para o corpo e confirmar T041 vermelho; restaurar as duas

  > **A sabotagem literal não vale, e isto importa.** Trocar `timingSafeEqual` por `===` mantém a
  > comparação CORRETA — só perde a resistência a timing, que teste funcional não mede. Um verde
  > ali seria lido como "o teste vigia a assinatura", que é falso. A sabotagem executada foi a que
  > afrouxa de fato a verificação (aceitar assinatura divergente, a válvula do caminho legado):
  > **4 de 14 casos vermelhos**. A segunda, `organization_id` vindo do corpo: **1 vermelho**.
  > As duas restauradas e a suíte reconferida verde.

**Checkpoint**: o buraco que a versão fail-open do WAHA abriu não é reaberto pela porta nova.

---

## Phase 6: User Story 5 — Mídia abre no CRM (P3)

**Goal**: foto, áudio e documento recebidos abrem pela tela.

**Independent Test**: enviar os três e abrir os três no CRM; conferir que o endereço expira.

- [x] T046 [TEST] [P] [US5] `tests/unit/gateway-media-source.test.ts` — host que veio no envelope é **descartado**; a URL é reconstruída sobre `GATEWAY_BASE_URL`; destino não permitido é recusado

  > 11 testes. Além do pedido: `ref` vazia é recusada **antes da rede** (senão `new URL("", base)` viraria a própria base — o CRM guardaria a página inicial do gateway como se fosse o anexo do cliente), e anexo que **mente no `content-length`** é recusado pelo tamanho real. O caso do endereço de metadados de nuvem (`169.254.169.254`) está lá para deixar explícito que a defesa **não é lista de bloqueio**: nenhum host do payload é usado.

- [x] T047 [TEST] [P] [US5] Estender `tests/e2e/gateway-inbound.spec.ts` com anexo: mensagem com imagem aparece e o anexo abre

  > **Executado em 2026-08-08 junto com T022.** O caso provado é o que interessa ao FR-025: anexo
  > cuja referência **não baixa** (base do gateway inalcançável de propósito) e a mensagem
  > aparece na thread assim mesmo. O contrário — anexo quebrado derrubar a conversa — é a
  > inversão de gravidade que a spec existe para impedir.

- [x] T048 [US5] Implementar `lib/messaging/media/gateway-source.ts` na mesma construção anti-SSRF de `lib/messaging/media/waha-source.ts` (descarta o host do payload, reconstrói sobre a base confiável)

  > Duas funções separadas, e não uma genérica com parâmetro de base: uma "genérica" acabaria aceitando base vinda do chamador, que é o buraco que as duas existem para fechar. Teto próprio (`GATEWAY_MAX_MEDIA_BYTES`, 100 MiB) porque o do WAHA foi dimensionado para um canal só. Env nova `GATEWAY_INTERNAL_TOKEN` (a direção é CRM → gateway, oposta à da entrega) em `lib/env.ts` + `.env.example` + runbook.

- [x] T049 [US5] Ligar o `media-persist-worker` existente ao caminho novo, gravando `media_storage_path` e servindo por URL assinada

  > O worker escolhe a origem por `origemDaMidia()`: `media_url` (legado) ou `metadata.media_ref` (gateway). E o **ingest passou a emitir `media.persist_requested`** — antes não emitia, então anexo vindo pelo gateway nunca teria sido baixado. `media_url` continua `null` de propósito: gravar ali o endereço do payload plantaria na coluna a URL não confiável que a construção anti-SSRF existe para não usar, e o worker legado a consumiria sem reconstruir host nenhum.

- [x] T050 [US5] Garantir que falha de mídia **não** impede a mensagem de entrar: marca anexo indisponível e registra o motivo

  > `tests/unit/gateway-midia-nao-bloqueia-mensagem.test.ts`, 4 testes. A garantia é de **ordem**: a mensagem é inserida, e só então o anexo é pedido, em evento separado. Falha ao emitir o pedido **não** derruba a ingestão — a linha já está no banco, e devolver erro faria o dreno retentar sem nada de novo a fazer.

- [x] T051 [US5] **Sabotagem**: fazer o CRM usar o host que veio no payload e confirmar T046 vermelho; restaurar

  > Feita: 2 de 11 vermelhos (o do host arbitrário e o do endereço de metadados de nuvem). Restaurado e reconferido verde.

## Phase 7: User Story 6 — Estado de entrega e eco do celular (P4)

**Goal**: entregue/lido evoluem corretamente, e a resposta digitada no celular aparece uma vez só.

**Independent Test**: enviar pelo CRM e acompanhar o estado; responder pelo celular e conferir a
conversa.

- [x] T052 [TEST] [P] [US6] `tests/invariants/gateway-inbound-status.test.ts` — `status_update` não regride o estado; confirmação para mensagem desconhecida não cria mensagem fantasma; `read_watermark` é ignorado com motivo registrado

  > 6 testes contra o Postgres real. Além dos três pedidos: os carimbos `delivered_at`/`read_at` são conferidos (sem eles "lido" existe como palavra e não como momento — e é o momento que responde "há quanto tempo o cliente viu e não respondeu"); `failed` entra **depois** de `read` com `error_code`/`error_message`; e confirmação de OUTRA organização com o mesmo `external_id` não alcança a mensagem — sem o filtro de org no update, acertar o identificador do provedor daria acesso ao histórico de outro cliente.

- [x] T053 [US6] Tratar `event_kind: "status_update"` em `lib/gateway/ingest.ts`, atualizando `messages.status`, `delivered_at`, `read_at`, `error_code` e `error_message` sem regressão de estado
- [x] T054 [US6] Tratar o eco de mensagem enviada por fora do CRM: `sent_by_api=false` em `direction: "outbound"` grava `sent_via='external_device'`, sem duplicar
- [x] T055 [US6] **Sabotagem**: remover a guarda de não-regressão e confirmar T052 vermelho; restaurar

  > Feita: 1 vermelho, exatamente o caso que a guarda protege (`delivered` atrasado desfazendo `read`). Restaurado.

**Checkpoint**: o selo na tela para de andar para trás.

---

## Phase 8: User Story 4 — Canal novo sem código de ingestão novo (P3)

**Goal**: o retorno do investimento — um canal adicional chega ao inbox sem ingest novo.

**Independent Test**: entregar envelope de um canal diferente de WhatsApp e ver a conversa no
inbox identificada pelo canal.

- [x] T056 [TEST] [P] [US4] `tests/invariants/gateway-inbound-canal-novo.test.ts` — envelope de outro `platform` entra e é identificado; `type` desconhecido é preservado como `system` com `metadata.original_type`, nunca descartado

  > 5 testes com **Instagram** e identificador que não é telefone (IGSID). Achado registrado no próprio teste: `conversations.channel` tem CHECK `= 'whatsapp'` e continuaria dizendo "whatsapp" para uma conversa de Instagram — por isso a tela lê `channel_sessions.provider`, não aquela coluna. Alargar o CHECK seria mudança de schema com dado a corrigir, fora desta fatia. Também cobre plataforma **desconhecida** entrando: recusar exigiria release do CRM a cada canal que o gateway aprendesse.

- [x] T057 [US4] Exibir o canal de origem no inbox (`components/inbox/**`), sem tela nova — a conversa já existe, ganha identificação de origem

  > `lib/channels/rotulo-de-canal.ts` + selo na lista e no cabeçalho, alimentado por `channel_sessions.provider` (acrescentado ao `SELECT_COLS` da listagem). Duas decisões: o rótulo é o nome que o usuário reconhece ("WhatsApp", não "whatsapp_uazapi" — ele não escolheu uazapi), e **canal implícito não ganha selo** — marcar 100% das conversas com "WhatsApp" seria ruído em toda linha, e ruído constante deixa de ser lido justamente no dia em que aparecesse a conversa diferente. Canal que este build não conhece não vira selo com nome cru. 5 testes.

- [ ] ~~T058 [US4] Acrescentar o gateway como serviço em `docker-compose.prod.yml` e fazê-lo subir pelo `hostgator-setup-kit/install.sh` e `update.sh`~~ — **INVALIDADA pela constituição v2.0.0**

  > **Não executada porque a constituição proíbe, e o conflito é frontal.** O Princípio XIV (v2.0.0)
  > diz: *"O gateway MUST NOT entrar no compose de produção do CRM, e o deploy de um MUST NOT exigir
  > o deploy do outro."* Esta task manda exatamente o contrário. Ela foi escrita sob a v1.2.0, quando
  > o produto era self-host e "subir junto" era a única forma de o clone ter o serviço.
  >
  > O que muda na prática: o endereço do gateway é **configuração** (`GATEWAY_BASE_URL`), os dois
  > versionam e sobem separado, e o kit self-host deixou de ser produto (`TODO(SELFHOST_KIT_RETIREMENT)`).
  > O que a task queria garantir — *"o serviço existe e o CRM o alcança"* — passou a ser garantido por
  > outro caminho: o check `gateway` em `/api/v1/health` e o aviso `gateway_inbound_down` na Central
  > (T059). Nenhuma cobertura foi perdida; o meio é que mudou.

- [x] T058a [US4] Fazer **conexão nova nascer em `ingest_path='gateway'`** — reescopada da v2.0.0

  > `lib/gateway/caminho-de-ingestao.ts`, ligada nos **dois** caminhos de criação (`/api/v1/channel-sessions` e `/api/v1/channels/official`). A regra segue o interruptor: ligado nasce `'gateway'`, desligado nasce `'legacy'`. **Não** é fixo em `'gateway'` de propósito — com o recebimento desligado, a conexão apontaria para uma rota que responde 404 e o gateway descartaria sem retentar (contrato §5): ela nasceria muda. O default `'legacy'` da coluna continua valendo só para as linhas anteriores à `0116`.

- [x] T058b [TEST] [US4] `tests/invariants/gateway-conexao-nova.test.ts` — a conexão nova nasce no caminho da instalação; a que já existia em `'legacy'` não é convertida

  > 5 testes. Cobre também que o CHECK recusa um terceiro caminho: sem ele, um typo (`gatewey`) faria a conexão cair no legado em silêncio — o defeito com a pior relação entre custo de digitar e custo de descobrir. Reescopado: "instalação nova" virou "conexão nova", porque em SaaS de instância única não há instalação nova (constituição v2.0.0, Princípio IV).

- [x] T059 [US4] Tornar a ausência do gateway visível como problema de configuração na tela (Central de avisos / banner), nunca como silêncio (FR-027)

  > Migration **0119** + `gateway_inbound_down` + `lib/gateway/aviso-de-recebimento-desligado.ts`, detectado pelo dreno (que já roda a cada minuto e já é o dono da fila — cron novo para uma checagem de duas colunas seria peça a mais para esquecer). O modo de falha é o mais silencioso da feature: `ingest_path='gateway'` + `GATEWAY_INBOUND_ENABLED=false` fazem a rota responder **404**, e o gateway **descarta sem retentar** porque 404 é defeito de configuração. Nada entra, nada volta, e a tela fica igual a uma segunda-feira devagar. O aviso cala quando não é o caso (ligado, ou sem conexão migrada): alarme falso é o que ensina a ignorar a Central. Do lado de ops, `/api/v1/health` ganhou o check `gateway`. 4 testes.

- [x] T060 [US4] Medir SC-008: contar as linhas de código de ingestão específicas do canal novo — o alvo é **zero**

  > **Medido: zero.** `grep -rc "instagram|messenger|uazapi|meta_cloud|waha" lib/gateway/*.ts` = **0 ocorrências em 1377 linhas**, nos 8 arquivos. A única leitura de `envelope.platform` no ingest (`ingest.ts:154`) **copia** o valor para `metadata` — não ramifica. Não há `switch (platform)`, `case "instagram"` nem `platform ===` em lugar nenhum do caminho de entrada. O canal novo do T056 (Instagram, com identificador que não é telefone e tipo desconhecido) entrou sem uma linha nova de ingestão.

- [x] T060a [US4] **Sabotagem**: fazer o ingest tratar `platform` desconhecido com descarte em vez de preservação e confirmar que T056 fica **vermelho**; restaurar

  > Feita no ponto onde a preservação de fato acontece (tipo desconhecido em `parseEnvelope`): 1 vermelho, o caso que vigia. Restaurado.

**Checkpoint**: o retorno do investimento é observável — canal novo custa zero linha de ingestão.

---

## Phase 9: Polimento e travessias

- [x] T061 [P] Registrar a peça nova em `docs/architecture/` com ≥2 arestas (Living System Checklist, Princípio II)

  > `recebimento-pelo-gateway.architecture.json` — 19 peças, 24 arestas, 6 faixas, registrado no `README.md` do diretório. Traz **quatro não-ligações declaradas** (o gateway não escreve no banco do CRM; `conversations.channel` não identifica o canal; `media_url` não recebe endereço do envelope; o gateway não entra no compose do CRM), porque ausência de aresta é indistinguível de aresta esquecida.

- [x] T062 [P] Atualizar `docs/testing/user-journey-map.md` com os casos novos e a marcação `[P0]` do trecho de estreia

  > J2 ganhou 4 casos (J2.8–J2.11) e o documento ganhou uma seção com a tabela do que **já é vigiado** (com o resultado de cada sabotagem) e a do que **ainda depende de ambiente**. Está no mapa, e não só nas tasks, porque espalhado em seis linhas distantes o buraco não aparece: a soma delas — *a jornada de recebimento nunca foi percorrida inteira por uma pessoa* — só é legível junta.

- [x] T063 [P] Documentar a chave de corte por conexão e o procedimento de reversão em `docs/runbooks/gateway-relay.md`

  > Acrescentado: como a conexão nova nasce, o que acontece **com o que está em voo** ao voltar para o legado (o dreno continua recolhendo, porque filtra por `provider`, não por `ingest_path`; o que o gateway ainda tentar entregar toma 409 e vai para `mortas/`), as variáveis da fila do lado do gateway, e um passo de diagnóstico novo — "nenhuma linha em `webhook_events_log` e a conexão está em `'gateway'`" ⇒ confira o interruptor antes de suspeitar da rede.

- [ ] T064 Executar o roteiro de **rollback** do `quickstart.md` §9 — migrar uma conexão, voltar para o legado sem perder o que estava em voo, e voltar ao gateway sem duplicar

  > **Aberta — depende de ambiente vivo.** O comportamento está documentado no runbook (T063) e a idempotência que o sustenta é cobrada por invariante; falta a execução com os dois lados de pé.

- [ ] T065 Cronometrar a jornada de estreia em instalação fresca (`quickstart.md` §4): ≤10 min, **sem regressão**, e contagem de passos de tela idêntica à de antes da feature

  > **Aberta — depende de ambiente fresco e relógio.** O que a feature acrescenta ao caminho de estreia é **zero passo de tela**: a conexão nova nasce já no caminho certo (T058a), sem pergunta nova. Falta cronometrar.

- [x] T066 Definir a política de retenção/arquivamento de `webhook_events_log` usando a coluna `archived_at` já existente (incógnita nº 3 da pesquisa — a tabela passa a receber todo o tráfego de entrada)

  > **Política declarada** no runbook: 0–7 dias linha completa; 7–90 dias `raw_body` esvaziado com os metadados mantidos; >90 dias `archived_at` carimbado e elegível para remoção. A faixa do meio é o ponto: **esvaziar o corpo não é apagar a linha** — apagar destruiria a prova de que a entrega existiu, que é o que se procura num incidente, e é o que sustenta o SC-012. Linha `dead` é exceção enquanto o aviso estiver aberto na Central: ela é o anexo do aviso. A execução (cron) é trabalho separado e está declarada como tal — enquanto não existe, a política escrita é o que impede a tabela de crescer sem ninguém ter decidido nada.

- [x] T067 Rodar a bateria completa na ordem do `quickstart.md` §8 (`typecheck`, `lint`, `lint:channels`, `test:unit`, `test:shell`, `test:db`, `build`, `test:e2e`) e reportar **qual suíte rodou e qual não rodou**
- [x] T068 Conferir o Definition of Done de 14 itens do `CLAUDE.md` mais o item novo do Princípio XI (teste que prova + suíte verde + sabotagem confirmada)

  > **Conferido item a item.** O que passou, e o que é N/A com motivo:
  >
  > | # | Item | Estado |
  > |---|---|---|
  > | 1 | `typecheck` zerado | ✅ |
  > | 2 | `lint` zerado | ✅ 0 erros (187 avisos pré-existentes) |
  > | 3 | testes relevantes existem e passam | ✅ 3038 unit + 530 invariantes + 14 pacotes Go |
  > | 4 | RLS testada se toca tabela tenant-aware | ✅ `gateway-inbound-isolamento.test.ts`; o T052 acrescentou o caso de confirmação de estado cruzando organização |
  > | 5 | audit log em mutação relevante | ✅ recusas auditadas (`webhook.gateway_rejected`) e recusa gravando linha com motivo (SC-012). Os avisos novos não são mutação de API |
  > | 6 | rate limit em rota pública | ✅ a rota já nasceu com teto **por conexão** |
  > | 7 | Zod em todo input externo | ✅ `parseEnvelope` |
  > | 8 | sem `console.log` | ✅ `lint` cobre; o seed de e2e usa `console.info`/`error`, permitidos |
  > | 9 | env nova em `.env.example` + `lib/env.ts` | ✅ `GATEWAY_INTERNAL_TOKEN` nos dois + runbook; as três da fila no `.env.example` do `gateway_go` |
  > | 10 | doc atualizada se mudou contrato | ✅ runbook, mapa de arquitetura, mapa de jornadas, MANIFEST |
  > | 11 | schema saiu como migration + baseline + MANIFEST, com caminho de volta | ✅ `0118` e `0119`, ambas aditivas (vocabulário só cresce) — o caminho de volta é trivial e está declarado: nenhuma linha existente viola as constraints novas |
  > | 12 | provado pela tela em conta nova | ⬜ **NÃO** — é o buraco declarado (T022/T047). A spec existe e roda no job `e2e`; falta a execução |
  > | 13 | Living System Checklist | ✅ mapa em `docs/architecture/` com 19 peças, 24 arestas e 4 não-ligações declaradas |
  > | 14 | tela nova tem porta | N/A — nenhuma tela nova. O selo de canal entra em tela que já existe |
  > | XI | teste que prova + suíte verde + sabotagem confirmada | ✅ quatro sabotagens nesta rodada (host do payload: 2 vermelhos; não-regressão: 1; descarte de tipo desconhecido: 1; e a de fila em memória da fase 4: 3) |
  >
  > **O item 12 é o único vermelho, e ele não se resolve com mais código.** Está declarado no mapa de jornadas e é o mesmo bloqueio de T030/T038/T038a/T064/T065.

## Dependencies

```
Phase 1 (Setup)
   └─► Phase 2 (Foundational)  ◄── BLOQUEIA TUDO
          └─► Phase 3 (US1, P1) 🎯 MVP
                 ├─► Phase 4 (US2, P2)
                 ├─► Phase 5 (US3, P2)   ← independente da Phase 4
                 ├─► Phase 6 (US5, P3)
                 │      └─► Phase 7 (US6, P4)
                 └─► Phase 8 (US4, P3)   ← depende só da Phase 3
                        └─► Phase 9 (Polimento)
```

- **US2 e US3 são independentes entre si** e podem correr em paralelo depois da US1.
- **US6 depende da US5** apenas por proximidade de arquivo (`lib/gateway/ingest.ts`), não por
  lógica.
- **T058 (kit self-host) é o ponto de não-retorno**: antes dele tudo é reversível pela chave de
  corte.

## Parallel Execution Examples

**Fase 2** — os três blocos independentes correm juntos:

```
T007 (MANIFEST)  ‖  T010 (teste de envelope)  ‖  T012 (teste de auth)  ‖  T017 (vocabulário TS)
```

**Fase 3** — os três testes são escritos em paralelo, antes de qualquer implementação:

```
T020 (idempotência)  ‖  T021 (posse de nome)  ‖  T022 (e2e pela tela)
```

**Fases 4 e 5** — duas histórias inteiras em paralelo depois do MVP:

```
T032..T039 (durabilidade)  ‖  T040..T045 (autenticidade e isolamento)
```

## Independent Test Criteria (resumo)

| Fase | História | Prova sozinha por |
|---|---|---|
| 3 | US1 | mensagem real no inbox pela tela; reentrega não duplica |
| 4 | US2 | CRM fora do ar 5 min; nada perdido; gateway reiniciado no meio |
| 5 | US3 | 7 requisições de um emissor real; 2 organizações; caso de controle |
| 6 | US5 | 3 anexos abrindo na tela; endereço expira; host forjado recusado |
| 7 | US6 | estado evolui sem regredir; eco do celular aparece uma vez |
| 8 | US4 | canal diferente no inbox com **zero** linhas de ingest específicas |

## Implementation Strategy

> **Correções da 1ª rodada de `/speckit-analyze`** (achados de planejamento, não de código):
> T017a–T017d (segredo por conexão — **bloqueador crítico**: sem isso a rota nova recusaria 100%
> das entregas do onboarding), T027a–T027b (FR-020, identidade canônica, que não tinha tarefa) e
> T038a (SC-010, rajada, que tinha roteiro de prova mas nenhuma tarefa).
>
> **Correções da 2ª rodada**, esta com verificação das afirmações contra o código real:
> T017c reescrita — cifrar dentro do `baseline.sql` **abortaria a instalação de uma VPS nova**,
> porque a chave de cifra só é semeada depois de o baseline rodar; T017e (recusa com motivo
> próprio em vez de silêncio quando o segredo não foi curado); T060a (a US4 era a única história
> sem tarefa de sabotagem, que o Princípio XI exige de todas).
>
> **Correções da 3ª rodada** (`/speckit-analyze`, achados E1–E3, C1, F1 e D1):
> T015 + T015a + T038a — o rate limit e o alvo de rajada do SC-010 se contradiziam no escuro:
> o teto agora nasce **acima** do alvo, é por conexão, e a rajada é provada com ele **ligado**;
> T011a — FR-005 ("código novo não lê payload cru") estava escrito como invariante e não tinha
> vigia nenhuma, contra o Princípio XI; T058a + T058b — instalação nova herdava
> `ingest_path='legacy'` e subiria o gateway sem nunca usá-lo; T001 + T014a — os tetos de
> tamanho de corpo e mídia existiam só como variável de ambiente sem valor e sem teste, deixando
> o edge case "corpo gigante" sem prova. Fora de `tasks.md`: FR-017 foi dividido em FR-017/FR-017a
> na `spec.md` (era insatisfazível — exigia registrar entrega sem conexão resolvida num log
> isolado por organização), e o gate VI do `plan.md` ganhou a justificativa de o segredo ser
> cifrado em vez de hasheado. Total: **82 tarefas**.

**MVP = Fase 1 + Fase 2 + Fase 3.** Entrega o resultado observável inteiro do plano: mensagem real
atravessando a costura nova. É a **fatia 1**, e é um spike deliberado — se ela não fechar, o
aprendizado custou duas jornadas e o plano é reavaliado antes de qualquer investimento adicional.

Depois do MVP, a ordem por risco decrescente: durabilidade (o que separa demo de operação),
autenticidade (dano irreversível), riqueza da conversa, e por fim a colheita do investimento
(canal novo + kit self-host).

**Custo total**: ≈ **7 a 9 jornadas deste time**, distribuídas nas 5 fatias do `plan.md`.

**O desligamento do caminho legado não está em nenhuma fase** — é passo posterior, condicionado a
evidência em produção (FR-030).
