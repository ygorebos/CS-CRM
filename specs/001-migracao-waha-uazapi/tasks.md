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

- [x] T005 Criar `supabase/migrations/20260807210000_0116_gateway_inbound.sql` com: `channel_sessions.ingest_path text not null default 'legacy' check (ingest_path in ('legacy','gateway'))`, `channel_sessions.gateway_connection_id text`, extensão do `channel_sessions_provider_check` para incluir `whatsapp_uazapi`/`whatsapp_cloud`/`instagram`/`messenger`, extensão do `webhook_events_log_provider_check` para incluir `gateway`, e índice parcial em `webhook_events_log (status, received_at) where status = 'received'` — tudo idempotente (`add column if not exists`, `drop constraint if exists` + `add constraint`), sem `BEGIN`/`COMMIT` explícito
- [x] T006 Acrescentar o mesmo conteúdo como apêndice idempotente e auto-curativo no fim de `supabase/baseline.sql`, no bloco rotulado `-- ---- gateway inbound (migration 0116) ----`
- [x] T007 [P] Registrar a linha da 0116 em `supabase/migrations/MANIFEST.md` (tabela "Applied"), dizendo o QUÊ e o PORQUÊ
- [x] T008 Provar o baseline num Postgres descartável `pgvector/pgvector:pg17`: aplicar em modo install (`ON_ERROR_STOP=1`) e em modo update (re-aplicar, sem a flag) — os dois têm de passar
- [x] T009 Regenerar `lib/database.types.ts` a partir do schema novo

### Contrato do envelope

- [x] T010 [TEST] [P] Escrever `tests/unit/gateway-envelope.test.ts` cobrindo: envelope válido aceito; campo desconhecido preservado em `metadata`; `envelope_version` futura aceita; `type` desconhecido vira `system` com `metadata.original_type`; `event_kind` desconhecido ignorado com motivo; corpo malformado recusado
- [x] T011 Implementar `lib/gateway/envelope.ts` — schema Zod do envelope v1 conforme `contracts/gateway-inbound-v1.md` §3, tolerante a campo desconhecido, exportando os tipos consumidos pelo ingest
- [ ] T011a [TEST] `tests/invariants/gateway-sem-payload-cru.test.ts` — nenhum arquivo fora de `lib/waha/**` e `lib/channels/meta/**` importa parser de provedor ou lê campo cru de payload de canal; o caminho novo só conhece o envelope. **FR-005 está escrito como invariante e hoje não tem vigia** — o Princípio XI diz que invariante só em prosa deixa de ser invariante. Vale como regra de lint equivalente, desde que reprove no CI

### Autenticidade

- [x] T012 [TEST] [P] Escrever `tests/unit/gateway-auth.test.ts` cobrindo: assinatura válida aceita; inválida recusada; ausente recusada; timestamp fora de ±300s recusado; segredo curto ou ausente recusa tudo (fail-closed, **sem** válvula de escape)
- [x] T013 Implementar `lib/gateway/auth.ts` — HMAC-SHA512 sobre `"{timestamp}.{corpo_cru}"` com `crypto.timingSafeEqual` e janela de ±300s, reusando a técnica de `lib/waha/webhook-auth.ts` mas **sem** herdar `WAHA_WEBHOOK_REQUIRE_SIGNATURE`

### Porta de entrada

- [x] T014 Implementar `app/api/v1/webhooks/gateway/[token]/route.ts`: resolve `channel_sessions` por `webhook_path_token` (tolerante a canal arquivado, como a rota WAHA), decifra o segredo via `fn_decrypt_oauth`, verifica assinatura, grava em `webhook_events_log` com `provider='gateway'` e `status='received'`, e **responde `202` antes de qualquer ingestão** (ACK-primeiro)
- [x] T015 Aplicar rate limit na rota nova, com `X-RateLimit-*` e `Retry-After` em 429 — a rota é pública e o Princípio VI exige; `docs/current-state.md` §4.3 mostra que webhooks hoje não têm, e esta rota **não** herda o buraco. **O teto é por conexão e nasce acima do alvo de rajada do SC-010** (200 mensagens em 60s): limite apertado demais derruba o tráfego legítimo do corretor numa campanha respondida, e é indistinguível de estar fora do ar. Fixar o número como múltiplo declarado do alvo, nunca como palpite
- [x] T015a [TEST] `tests/unit/gateway-rate-limit.test.ts` — 200 entregas em 60s pela mesma conexão **passam**; tráfego acima do teto recebe `429` com `Retry-After`; o limite de uma conexão não consome a cota de outra. Sem este teste, T015 e SC-010 são requisitos que se contradizem no escuro
- [ ] T014a [TEST] [P] Estender `tests/unit/gateway-envelope.test.ts` (ou arquivo irmão) com os tetos de tamanho: corpo acima de `GATEWAY_MAX_BODY_BYTES` é recusado com erro claro e **sem** carregar tudo em memória; envelope cuja mídia declara tamanho acima de `GATEWAY_MAX_MEDIA_BYTES` entra como mensagem com anexo indisponível, nunca derruba a ingestão — é o edge case "corpo gigante ou mídia enorme" da spec, que só existia como variável de ambiente
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
- [ ] T017e Recusar com motivo próprio quando o segredo ainda for placeholder: a rota nova responde `gateway_secret_nao_provisionado` (não um `401` genérico) e abre aviso na Central — sem isso, uma conexão não curada vira silêncio, que é o que o Princípio II proíbe

### Gateway — poder subir sem banco

- [ ] T018 Implementar o modo relay em `internal/config/config.go` do gateway: quando `GATEWAY_MODE=relay`, `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` deixam de ser `mustGetEnv` e a persistência é pulada
- [ ] T019 [TEST] [P] Teste em Go provando que o processo **sobe** em modo relay sem as variáveis de Supabase e **continua exigindo-as** no modo padrão

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
- [ ] T022 [TEST] [P] [US1] `tests/e2e/gateway-inbound.spec.ts` — pela tela, em ambiente fresco: envelope assinado entra e a mensagem aparece no inbox com contato e corpo corretos

### Implementação

- [x] T023 [US1] Implementar `lib/gateway/ingest.ts` para `event_kind: "new_message"`: resolve identidade, chama `fn_upsert_wa_contact` e `fn_upsert_wa_conversation` (reuso — **não** escrever `insert` próprio em `contacts`/`conversations`), insere em `messages` capturando `code === '23505'` como caminho normal
- [x] T024 [US1] Disparar a cadeia viva a partir do ingest novo — emissão em `event_log` do `ai_agent.dispatch_requested` e auditoria, espelhando `lib/waha/ingest.ts:462`
- [x] T025 [US1] Implementar `workers/gateway-inbound-worker.ts` consumindo `webhook_events_log` com `provider='gateway'` e `status='received'`, marcando `processed`/`error` e incrementando `attempts`
- [x] T026 [US1] Ligar o disparo imediato em segundo plano na rota (`app/api/v1/webhooks/gateway/[token]/route.ts`), **depois** da resposta — é o que sustenta o alvo de ≤5s
- [x] T027 [US1] Respeitar `channel_sessions.ingest_path` no ingest: conexão `legacy` recusa entrega pelo caminho novo com motivo explícito
- [ ] T027a [TEST] [P] [US1] `tests/invariants/gateway-inbound-identidade-canonica.test.ts` — o mesmo contato chegando com as duas grafias de identificador (número canônico e identificador interno do canal) cai numa **única** conversa, sem partir o histórico
- [ ] T027b [US1] Usar em `lib/gateway/ingest.ts` o identificador **resultante** da canonicalização (o que `fn_upsert_wa_contact` devolve, com `lib/channels/phone-variants.ts`), nunca o que veio no envelope — FR-020
- [ ] T028 [US1] Substituir `internal/handlers/webhook_forward.go` no gateway por entrega do **envelope normalizado** assinado (HMAC + timestamp + `X-Gateway-Delivery-Id`), conforme `contracts/gateway-inbound-v1.md` §2–§3
- [ ] T029 [US1] Mapear `MensagemNormalizada` → envelope v1 em pacote novo do gateway, cobrindo os campos da tabela de vocabulário da análise (`analise-gateway-go-recebimentos.md`)

### Prova

- [ ] T030 [US1] Executar o roteiro do `quickstart.md` §1 (20 envios reais, medir p95 ≤5s, reentregar tudo e conferir contagem estável)
- [x] T031 [US1] **Sabotagem**: remover a captura de `23505` no ingest e confirmar que T020 fica **vermelho**; restaurar. Repetir trocando o `coalesce` de nome e confirmar T021 vermelho

**Checkpoint**: US1 entregue e provada. É a fatia 1 do plano — se ela não fechar, o plano é
reavaliado antes de qualquer investimento adicional.

---

## Phase 4: User Story 2 — Nada se perde com o CRM fora do ar (P2)

**Goal**: CRM indisponível por minutos e nenhuma mensagem se perde.

**Independent Test**: derrubar o CRM, mandar N mensagens, subir, e ver as N no inbox sem duplicata.

- [ ] T032 [TEST] [P] [US2] Teste em Go da fila de entrega do gateway: pendência gravada **antes** da primeira tentativa; sobrevive a reinício do processo; respeita espera crescente; termina em `dead` após o teto
- [ ] T033 [TEST] [P] [US2] `tests/invariants/gateway-inbound-dreno.test.ts` — linha `received` parada além do limite é recolhida pelo dreno; linha `processed` não é reprocessada; linha que falha N vezes vira `dead`
- [ ] T034 [US2] Implementar `internal/delivery/` no gateway: fila durável em disco, espera crescente com teto, e estado terminal inspecionável
- [ ] T035 [US2] Aplicar a política de retentativa do contrato (§5): retenta em rede/timeout/`5xx`/`429` respeitando `Retry-After`; **não** retenta `400`/`401`/`404` — vão direto ao descarte com aviso
- [x] T036 [US2] Implementar `app/api/v1/cron/gateway-inbound-drain/route.ts` e agendá-la no `scheduler` do `docker-compose.prod.yml`, no padrão do `event-log-drain`
- [ ] T037 [US2] Tornar o descarte visível: item na Central de avisos quando houver entrega `dead` (Princípio II — falta de funcionamento aparece na tela, não em `log.Warn`)
- [ ] T038 [US2] Executar o roteiro do `quickstart.md` §2, incluindo o reinício do **gateway** no meio do intervalo
- [ ] T038a [US2] Executar o roteiro de rajada do `quickstart.md` §7 (200 mensagens em 60s): 100% no inbox, zero duplicatas, e o ritmo de resposta do agente ainda obedecendo os limites anti-banimento existentes — é o SC-010, que não tinha tarefa. **Rodar com o rate limit de T015 ligado**, e não desligado para o teste passar: rajada provada sem o limite ativo não prova nada sobre produção
- [ ] T039 [US2] **Sabotagem**: trocar a fila em disco por fila em memória e confirmar que T032 fica vermelho; restaurar

**Checkpoint**: a promessa "nada se perde" deixa de ser promessa.

---

## Phase 5: User Story 3 — Forjado não entra, tenant não vaza (P2)

**Goal**: a rota nova recusa o que não é autêntico e nunca cruza organização.

**Independent Test**: emissor HTTP real dispara as sete requisições da tabela do `quickstart.md` §3.

- [ ] T040 [TEST] [P] [US3] `tests/invariants/gateway-inbound-autenticidade.test.ts` — as sete requisições da tabela do quickstart §3, cada uma provando que **nada** foi gravado quando recusada
- [ ] T041 [TEST] [P] [US3] `tests/invariants/gateway-inbound-isolamento.test.ts` — duas organizações recebendo ao mesmo tempo; usuário da org A enxerga **zero** linhas da org B em `messages`, `conversations` e `contacts`, **com caso de controle** provando antes que as linhas da org B existem
- [ ] T042 [US3] Garantir no ingest que o `organization_id` vem sempre da linha de `channel_sessions` resolvida pelo token, e que qualquer `organization_id` presente no corpo é **ignorado** e a tentativa registrada
- [ ] T043 [US3] Fazer `webhook_events_log` registrar recusa com motivo suficiente para reconstruir o caso sem log de aplicação (SC-012)
- [ ] T044 [US3] Rodar `pnpm test:db` inteiro e confirmar que os invariantes novos entram no job `invariants` (obrigatório na branch protection)
- [ ] T045 [US3] **Sabotagem**: trocar `timingSafeEqual` por `===` e confirmar T040 vermelho; mover a origem do `organization_id` do token para o corpo e confirmar T041 vermelho; restaurar as duas

**Checkpoint**: o buraco que a versão fail-open do WAHA abriu não é reaberto pela porta nova.

---

## Phase 6: User Story 5 — Mídia abre no CRM (P3)

**Goal**: foto, áudio e documento recebidos abrem pela tela.

**Independent Test**: enviar os três e abrir os três no CRM; conferir que o endereço expira.

- [ ] T046 [TEST] [P] [US5] `tests/unit/gateway-media-source.test.ts` — host que veio no envelope é **descartado**; a URL é reconstruída sobre `GATEWAY_BASE_URL`; destino não permitido é recusado
- [ ] T047 [TEST] [P] [US5] Estender `tests/e2e/gateway-inbound.spec.ts` com anexo: mensagem com imagem aparece e o anexo abre
- [ ] T048 [US5] Implementar `lib/messaging/media/gateway-source.ts` na mesma construção anti-SSRF de `lib/messaging/media/waha-source.ts` (descarta o host do payload, reconstrói sobre a base confiável)
- [ ] T049 [US5] Ligar o `media-persist-worker` existente ao caminho novo, gravando `media_storage_path` e servindo por URL assinada
- [ ] T050 [US5] Garantir que falha de mídia **não** impede a mensagem de entrar: marca anexo indisponível e registra o motivo
- [ ] T051 [US5] **Sabotagem**: fazer o CRM usar o host que veio no payload e confirmar T046 vermelho; restaurar

---

## Phase 7: User Story 6 — Estado de entrega e eco do celular (P4)

**Goal**: entregue/lido evoluem corretamente, e a resposta digitada no celular aparece uma vez só.

**Independent Test**: enviar pelo CRM e acompanhar o estado; responder pelo celular e conferir a
conversa.

- [ ] T052 [TEST] [P] [US6] `tests/invariants/gateway-inbound-status.test.ts` — `status_update` não regride o estado; confirmação para mensagem desconhecida não cria mensagem fantasma; `read_watermark` é ignorado com motivo registrado
- [x] T053 [US6] Tratar `event_kind: "status_update"` em `lib/gateway/ingest.ts`, atualizando `messages.status`, `delivered_at`, `read_at`, `error_code` e `error_message` sem regressão de estado
- [x] T054 [US6] Tratar o eco de mensagem enviada por fora do CRM: `sent_by_api=false` em `direction: "outbound"` grava `sent_via='external_device'`, sem duplicar
- [ ] T055 [US6] **Sabotagem**: remover a guarda de não-regressão e confirmar T052 vermelho; restaurar

---

## Phase 8: User Story 4 — Canal novo sem código de ingestão novo (P3)

**Goal**: o retorno do investimento — um canal adicional chega ao inbox sem ingest novo.

**Independent Test**: entregar envelope de um canal diferente de WhatsApp e ver a conversa no
inbox identificada pelo canal.

- [ ] T056 [TEST] [P] [US4] `tests/invariants/gateway-inbound-canal-novo.test.ts` — envelope de outro `platform` entra e é identificado; `type` desconhecido é preservado como `system` com `metadata.original_type`, nunca descartado
- [ ] T057 [US4] Exibir o canal de origem no inbox (`components/inbox/**`), sem tela nova — a conversa já existe, ganha identificação de origem
- [ ] T058 [US4] Acrescentar o gateway como serviço em `docker-compose.prod.yml` e fazê-lo subir pelo `hostgator-setup-kit/install.sh` e `update.sh`, **sem** nenhuma pergunta nova ao usuário
- [ ] T058a [US4] Fazer **instalação nova nascer em `ingest_path='gateway'`**: `scripts/bootstrap-owner.ts` e o caminho de criação de conexão do `install.sh` gravam `'gateway'`; o `default 'legacy'` da coluna continua valendo **só** para as linhas que já existiam quando a `0116` foi aplicada. Sem isto o self-hoster novo sobe um serviço que nunca é usado — o gateway no compose e o CRM ingerindo pelo caminho legado
- [ ] T058b [TEST] [US4] `tests/invariants/gateway-instalacao-nova.test.ts` — banco fresco do `baseline.sql` + `bootstrap-owner` produz conexão com `ingest_path='gateway'`; banco que já tinha conexões antes da `0116` mantém as antigas em `'legacy'`. É a diferença entre "clone novo funciona" e "clone novo parece funcionar"
- [ ] T059 [US4] Tornar a ausência do gateway visível como problema de configuração na tela (Central de avisos / banner), nunca como silêncio (FR-027)
- [ ] T060 [US4] Medir SC-008: contar as linhas de código de ingestão específicas do canal novo — o alvo é **zero**
- [ ] T060a [US4] **Sabotagem**: fazer o ingest tratar `platform` desconhecido com descarte em vez de preservação e confirmar que T056 fica **vermelho**; restaurar. Era a única história sem sabotagem, e o Princípio XI a exige de todas

---

## Phase 9: Polimento e travessias

- [ ] T061 [P] Registrar a peça nova em `docs/architecture/` com ≥2 arestas (Living System Checklist, Princípio II)
- [ ] T062 [P] Atualizar `docs/testing/user-journey-map.md` com os casos novos e a marcação `[P0]` do trecho de estreia
- [ ] T063 [P] Documentar a chave de corte por conexão e o procedimento de reversão em `docs/runbooks/gateway-relay.md`
- [ ] T064 Executar o roteiro de **rollback** do `quickstart.md` §9 — migrar uma conexão, voltar para o legado sem perder o que estava em voo, e voltar ao gateway sem duplicar
- [ ] T065 Cronometrar a jornada de estreia em instalação fresca (`quickstart.md` §4): ≤10 min, **sem regressão**, e contagem de passos de tela idêntica à de antes da feature
- [ ] T066 Definir a política de retenção/arquivamento de `webhook_events_log` usando a coluna `archived_at` já existente (incógnita nº 3 da pesquisa — a tabela passa a receber todo o tráfego de entrada)
- [ ] T067 Rodar a bateria completa na ordem do `quickstart.md` §8 (`typecheck`, `lint`, `lint:channels`, `test:unit`, `test:shell`, `test:db`, `build`, `test:e2e`) e reportar **qual suíte rodou e qual não rodou**
- [ ] T068 Conferir o Definition of Done de 14 itens do `CLAUDE.md` mais o item novo do Princípio XI (teste que prova + suíte verde + sabotagem confirmada)

---

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
