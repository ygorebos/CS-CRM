# Implementation Plan: Recebimento unificado pelo gateway — envelope normalizado e ingest único

**Branch**: `001-migracao-waha-uazapi` | **Date**: 2026-08-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-migracao-waha-uazapi/spec.md`

**Artefatos**: [research.md](./research.md) · [data-model.md](./data-model.md) ·
[contracts/gateway-inbound-v1.md](./contracts/gateway-inbound-v1.md) ·
[quickstart.md](./quickstart.md)

## Summary

**Resultado observável**: uma mensagem real de WhatsApp entra pelo `gateway_go`, é normalizada num
envelope único, atravessa uma rota assinada do CRM e **aparece no inbox** — com contato, conversa,
idempotência por `external_id` e a cadeia viva (agente, follow-up, auditoria) disparando como no
caminho antigo. Depois disso, canal novo suportado pelo gateway chega ao mesmo inbox sem código de
ingestão novo no CRM.

**Abordagem técnica**: o gateway ganha (a) **modo relay** — normaliza e entrega sem persistir em
banco próprio, hoje impossível porque `config.go` entra em pânico sem `SUPABASE_*` — e (b) um
**encaminhamento durável e assinado** do envelope normalizado, substituindo o
`webhook_forward.go` atual, que manda o corpo cru, não assina, não retenta e não registra nada.

O CRM ganha **uma** rota (`/api/v1/webhooks/gateway/[token]`) e **um** ingest contra o envelope,
reusando o que já existe: `webhook_path_token` como mapa conexão→organização, `fn_upsert_wa_contact`
e `fn_upsert_wa_conversation` como escrita, `webhook_events_log` como fila de ACK-primeiro (a
tabela **já tem** `status ∈ (received, processed, error, dead)` e `attempts`), e a construção
anti-SSRF de `waha-source.ts` para mídia. Schema muda em **duas colunas e dois vocabulários**.

**Custo estimado**: ≈ **7 a 9 jornadas deste time**, em 5 fatias entregáveis (§ Estratégia). A
análise anterior falava em 26–41 *dias-dev* — unidade de equipe humana hipotética, que infla o
número em ordem de grandeza e não é a régua deste time (constituição, "Papéis, Ritmo e Método").

## Technical Context

**Language/Version**: TypeScript 6 estrito (CRM, Next.js 16 App Router / React 19, Node 22) ·
Go (gateway, `/root/PROJETOS/gateway_go` @ `7777ba1`)

**Primary Dependencies**: Supabase (Postgres 17 + RLS + pgvector) · Zod para todo input externo ·
`node:crypto` (HMAC-SHA512 + `timingSafeEqual`) · Supabase Storage · Upstash Redis (rate limit) ·
**nenhuma dependência nova no CRM**; no gateway, uma biblioteca embarcada de fila em disco (D5)

**Storage**: Postgres do CRM (`messages`, `contacts`, `conversations`, `channel_sessions`,
`webhook_events_log`) + Supabase Storage (`whatsapp-media`, privado, URL assinada). No gateway em
modo relay: **arquivo em volume**, sem banco.

**Testing**: Vitest (`test:unit`) · Vitest contra Postgres real (`test:db`, é quem roda
`tests/invariants/**`) · Playwright (`test:e2e`) em ambiente fresco estilo VPS · emissor HTTP real
para o contrato externo

**Target Platform**: VPS Linux self-host (Docker Compose: app + WAHA + gateway + Postgres), com
Vercel como alvo secundário do app

**Project Type**: aplicação web multi-tenant + serviço companheiro em Go

**Performance Goals**: mensagem visível no inbox em **≤5s (p95)**; rajada de 200 mensagens em 60s
sem perda nem duplicata; ACK da rota **antes** de qualquer I/O de ingestão

**Constraints**: **zero** passos novos na jornada de estreia (Princípio VIII); o gateway **não**
escreve no banco do CRM (Princípio VII); fail-closed sem válvula de escape; migration em tripla
(migration + apêndice no `baseline.sql` + MANIFEST); coexistência com o caminho legado e reversão
por conexão

**Scale/Scope**: 1 rota nova · 1 ingest novo · 2 colunas · 2 vocabulários estendidos · 1 worker de
dreno · ~6 invariantes novos · 2 mudanças estruturais no gateway

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Fonte: `.specify/memory/constitution.md` **v1.2.0**.

| # | Gate | Status | Como este plano responde |
|---|---|---|---|
| I | Isolamento de tenant | **PASS** | Organização resolvida por `webhook_path_token` (fonte confiável), **nunca** do corpo — FR-009, provado no §3 do quickstart. Nenhuma tabela nova; as duas colunas entram em `channel_sessions`, que já é tenant-aware com RLS. Handlers usam admin client **com filtro manual**, como o resto do repo. Nenhuma função nova em `public` prevista; se surgir, revoga `execute` de `public` **e** `anon`. |
| II | Nada é ilha | **PASS** | Entrada: gateway. Saída: `contacts`/`conversations`/`messages` + `event_log` (`ai_agent.dispatch_requested`) + auditoria. Tela: inbox, e **ausência do gateway aparece como problema de configuração** (FR-027), não como silêncio. Anti-morte: fila `webhook_events_log` + dreno + descarte inspecionável. `docs/architecture/` ganha a peça com ≥2 arestas. |
| III | Schema viaja com o clone | **PASS** | Migration `0116` + apêndice idempotente no `baseline.sql` + linha no `MANIFEST.md`. Constraints estendidas com `drop … if exists` + `add`; nenhum backfill necessário (colunas nascem com padrão que preserva o comportamento atual). |
| IV | Prova pela tela | **PASS** | US1, US2, US5 e a jornada cronometrada provadas por Playwright em ambiente fresco (baseline + `bootstrap-owner`, envs opcionais ausentes). O efeito externo é provado com **emissor HTTP real assinando**, não mock — quickstart §3. |
| V | Evento na fila | **PASS** | Nenhum trigger faz HTTP. Idempotência por `unique(organization_id, external_id)` com captura de `23505`. ACK-primeiro: a rota grava em `webhook_events_log` e responde; a ingestão roda fora do ciclo. **Dono da fila declarado**: o dreno periódico recolhe `received` parado; `dead` é estado terminal com aviso. |
| VI | Contrato de API | **PASS, com dívida herdada declarada** | Rota sob `/api/v1/`, `ok()`/`fail()`, Zod no envelope, `X-Request-Id`, credencial em header (nunca em query string), auditoria das recusas. **Rate limit é obrigatório aqui** e o repositório hoje não o aplica em webhook (`docs/current-state.md` §4.3, 🔴) — esta feature **não** herda o buraco: a rota nova nasce com limite e cabeçalhos `X-RateLimit-*`/`Retry-After`. Corrigir as demais rotas continua fora deste escopo. **Segredo cifrado, não hasheado — justificativa:** o Princípio VI manda armazenar *bearer token* como hash SHA256, e aqui o segredo por conexão é guardado **cifrado** (reversível via `fn_decrypt_oauth`). Não é desvio: hash serve para credencial que o portador **apresenta** e o servidor só precisa comparar; este segredo é chave de **HMAC**, e verificar assinatura exige recalcular com o material original — hash o tornaria inutilizável. É o mesmo desenho que WAHA e Nuvemshop já usam no repositório. O que a regra de fato exige — segredo nunca em claro no banco, nunca em query string, único por conexão — continua valendo. |
| VII | Interoperável por contrato | **PASS** | O gateway entrega envelope por HTTP assinado e **não** escreve no banco do CRM. Sem FK cruzando fronteira: `gateway_connection_id` é `text`, ponteiro sem integridade referencial. Toda entidade nasce com `organization_id`. |
| VIII | Corretor em 10 minutos | **PASS** | FR-028 proíbe expor o gateway ao corretor; o `install.sh` sobe o serviço junto. SC-006 cronometra em instalação fresca **sem regressão**; SC-007 exige **zero** passos novos. O ciclo de vida da conexão fica fora do escopo justamente para **não** quebrar este teto (ver Assumptions da spec). |
| IX | Vender ou assistir | **PASS** | Serve às duas: é a tubulação de onde ambas bebem. Nenhuma capacidade de agente é adicionada aqui, então a regra de "declarar qual missão serve" se resolve no cabeçalho da spec. |
| X | Operadora é dado curado | **N/A** | Feature de transporte e ingestão. Nada específico de operadora entra em código, e nada de conteúdo é tocado. |
| XI | Teste que prova e vigia | **PASS** | FR-031/032/033 e SC-011. Gate por tipo: `test:db` para schema/RLS/isolamento, Playwright para o que é visível, emissor real para o contrato externo. **Cada teste novo confirmado por sabotagem** — as sabotagens exatas estão escritas no quickstart, uma por prova. |
| XII | Contexto antes de ação | **PASS** | Declaração abaixo. |

### Declaração do Princípio XII

Esta sessão leu, antes de planejar: **a constituição** (`.specify/memory/constitution.md`,
**Version 1.2.0**), o **`CLAUDE.md`** e o **`README.md`**. Aprofundamento exigido pela natureza da
task: `docs/current-state.md` (estimativa e estado real), `docs/harness-audit.md` (onde o CI é
cego), `supabase/baseline.sql` (schema medido, não presumido) e o código de ingestão vigente.

**Divergências encontradas, reportadas e não resolvidas em silêncio:**

1. **A constituição foi emendada por outra sessão durante este planejamento** (v1.1.0 → v1.2.0,
   Princípio XII). O plano foi reavaliado contra a versão final. Registrado porque a árvore de
   trabalho é compartilhada.
2. **`CLAUDE.md:217` está desatualizado**: afirma que a spec `capacidades-do-agente` está fora do
   CI porque "reprova de verdade". Ela foi corrigida em `bf20db49` (issue #162) e **roda** —
   `.github/workflows/e2e.yml` diz "32 de 33 specs". Mesmo erro em `AGENTS.md:74`, `AGENTS.md:136`
   e `docs/current-state.md:128`.
3. **A análise que fundamenta esta spec superestimou um risco**: dizia que o apagamento de nome
   humano por mensagem recebida era "estruturalmente possível" no `upsertContact` do CRM. Medido:
   `fn_upsert_wa_contact` usa `do update set display_name = coalesce(contacts.display_name,
   excluded.display_name)` — **não** sobrescreve. O que falta não é a regra, é o **teste** que a
   vigia (e por isso ela entrou como invariante nº 4 do data-model).
4. **`docs/current-state.md` tem `last_updated: 2026-07-29`** e avisa no próprio corpo que apodrece
   rápido. Os números usados aqui foram reconferidos contra o código, não copiados dele.

## Project Structure

### Documentation (this feature)

```text
specs/001-migracao-waha-uazapi/
├── spec.md                          # requisitos (o quê)
├── plan.md                          # este arquivo
├── research.md                      # Fase 0 — D1..D11, decisões fechadas
├── data-model.md                    # Fase 1 — o que muda no schema e o que é reuso
├── contracts/
│   └── gateway-inbound-v1.md        # Fase 1 — o contrato de entrada
├── quickstart.md                    # Fase 1 — como se prova cada critério
├── checklists/requirements.md       # gate de qualidade da spec
├── analise-complexidade.md          # análise anterior (caminho direto, descartado)
└── analise-gateway-go-recebimentos.md
```

### Source Code (repository root)

```text
DeskcommCRM/
├── app/api/v1/
│   ├── webhooks/gateway/[token]/route.ts     # NOVO — verifica, enfileira, responde 202
│   └── cron/gateway-inbound-drain/route.ts   # NOVO — dreno de webhook_events_log 'received'
├── lib/
│   ├── gateway/
│   │   ├── envelope.ts                       # NOVO — schema Zod do envelope v1 + tipos
│   │   ├── auth.ts                           # NOVO — HMAC + janela, fail-closed sem válvula
│   │   └── ingest.ts                          # NOVO — ingest ÚNICO contra o envelope
│   ├── messaging/media/gateway-source.ts     # NOVO — MediaSource anti-SSRF sobre GATEWAY_BASE_URL
│   ├── channels/{capabilities,session-ref}.ts# ALTERADO — providers novos
│   └── env.ts                                 # ALTERADO — GATEWAY_* (+ .env.example)
├── workers/
│   └── gateway-inbound-worker.ts             # NOVO — consome a fila, chama lib/gateway/ingest
├── supabase/
│   ├── migrations/20260808…_0119_gateway_inbound.sql   # NOVO
│   ├── baseline.sql                          # ALTERADO — apêndice idempotente
│   └── migrations/MANIFEST.md                # ALTERADO — linha da 0119
├── tests/
│   ├── unit/gateway-envelope.test.ts         # NOVO — contrato, versão futura, tipo desconhecido
│   ├── invariants/gateway-inbound-*.test.ts  # NOVO — autenticidade, isolamento, idempotência,
│   │                                          #        posse de nome
│   └── e2e/gateway-inbound.spec.ts           # NOVO — pela tela, ambiente fresco
├── docker-compose.prod.yml                   # ALTERADO — gateway como serviço
├── hostgator-setup-kit/install.sh|update.sh  # ALTERADO — sobe o gateway, sem passo novo p/ usuário
└── docs/architecture/                        # ALTERADO — peça nova com ≥2 arestas

gateway_go/
├── internal/config/config.go                 # ALTERADO — modo relay: SUPABASE_* opcionais
├── internal/handlers/webhook_forward.go      # SUBSTITUÍDO — envelope normalizado, assinado,
│                                             #   durável, com retentativa e descarte
└── internal/delivery/                        # NOVO — fila em disco, backoff, dead-letter
```

**Structure Decision**: dois repositórios, um contrato entre eles. O CRM segue a estrutura de
Next.js App Router já vigente (`app/api/v1/**` para rotas, `lib/**` para lógica, `workers/**` para
consumidores de fila, `tests/{unit,invariants,e2e}` para os três gates). O gateway ganha um pacote
novo isolado (`internal/delivery`) para não misturar durabilidade de entrega com normalização.
Nenhuma camada nova, nenhum projeto novo, nenhuma dependência nova no CRM.

## Andamento (atualizado a cada fase concluída)

| Fase | Estado | Evidência |
|---|---|---|
| 1 · Setup | ✅ **concluída** | `6ea0a4b6` — envs com tetos medidos, serviço no compose de dev, runbook |
| 2 · Foundational | ✅ **concluída** | `6366d5ce` (schema, tripla + vocabulário TS), `d0f9d5b6` (envelope + autenticidade), `41806231` (rota, teto por conexão, segredo por conexão), `0117` + aviso na Central quando a conexão não tem chave de verificação — recusa com código próprio `gateway_secret_not_provisioned` e **503**, não 401, para o gateway retentar e o histórico do período quebrado entrar sozinho. Modo relay no `gateway_go` (`00f9078` naquele repo): `GATEWAY_MODE=relay` dispensa as variáveis de Supabase, o modo padrão continua exigindo-as, e um typo (`relai`) **não** vira relay |
| 3 · US1 — a costura | 🟡 **quase** | ingest único, dreno periódico, agendamento no `scheduler`, invariantes de banco (T020/T021) e a identidade canônica (T027a/T027b — a mesma pessoa com as duas grafias do número vira UM contato, regra extraída para `lib/channels/identidade-canonica.ts` com a busca injetada, para o invariante exercitar a MESMA função que o ingest). Do lado do gateway (`c3d44fd`): o encaminhamento cru virou **envelope normalizado e assinado** — `internal/envelope` (mapeador, `event_id` determinístico) e `internal/entrega` (HMAC sobre timestamp+corpo), ligados nos quatro canais, com **virada por destino** para não quebrar quem já consome o formato antigo. **Falta**: a prova pela tela (T022) e a ponta a ponta com mensagem real (T030) |
| 4 · US2 — durabilidade | 🟡 **quase** | a fila durável existe (`internal/entrega/fila.go` no `gateway_go`): pendência gravada em disco **antes** da primeira tentativa, espera crescente com teto, `Retry-After` como piso, política do contrato §5 (`409` e demais 4xx não listados também vão ao descarte — insistir contra eles é laço infinito), e descarte inspecionável em `mortas/`. Ligada no encaminhamento e no boot, com retomada imediata do que sobrou do processo anterior. Uma decisão mudou no caminho: o segredo de assinatura **mora na pendência** — sem ele a retentativa pós-reinício é inassinável, e o gateway resolve conexão por token do provedor, não por ID. Do lado do CRM, `0118` + `gateway_delivery_dead`: o dreno emitia evento que **ninguém escutava**, e agora o descarte chega à Central. **Falta**: T038 e T038a, que pedem ambiente real (gateway + WAHA + número), mesma classe de T022 e T030 |
| 5 · US3 — autenticidade provada | ✅ **concluída** | as sete requisições do quickstart §3 viraram invariante de banco (`gateway-inbound-autenticidade.test.ts`), somadas ao isolamento entre duas organizações (`gateway-inbound-isolamento.test.ts`). O corpo nunca decide tenant, e a tentativa vira auditoria em vez de silêncio; recusa passou a gravar linha com motivo e `valid_signature` verdadeiro (era `true` fixo — a coluna mentia justamente para quem fosse auditar). Sabotagens do T045 confirmadas vermelhas |
| 6 · US5 — mídia | 🟡 **quase** | `lib/messaging/media/gateway-source.ts` com a mesma construção anti-SSRF do caminho legado (host do payload descartado, URL remontada sobre `GATEWAY_BASE_URL`) e teto próprio de 100 MiB; o worker de mídia passou a escolher a origem, e o **ingest passou a emitir `media.persist_requested`** — sem isso, anexo vindo pelo gateway nunca teria sido baixado. FR-025 provado como ordem: a mensagem entra, e só então o anexo é pedido. Anexo declarado acima do teto nem é baixado. **Falta**: T047 (a prova pela tela) |
| 7 · US6 — estado de entrega | ✅ **concluída** | `gateway-inbound-status.test.ts` contra o Postgres real: não regride, `failed` entra depois de `read` com motivo, confirmação de mensagem desconhecida não cria fantasma, `read_watermark` é ignorado COM motivo, e confirmação de outra organização não alcança a mensagem. Sabotagem da guarda de não-regressão: 1 vermelho |
| 8 · US4 — canal novo | 🟢 **concluída, com uma task invalidada pela constituição** | **SC-008 medido: zero** — nenhuma ocorrência de nome de canal em 1377 linhas de `lib/gateway/`. Instagram entra com identificador que não é telefone, tipo desconhecido vira `system` + `metadata.original_type`, plataforma desconhecida também entra. Selo de canal na lista e no cabeçalho (só quando não é WhatsApp). Conexão nova nasce no caminho da instalação. `0119` + `gateway_inbound_down`: a combinação `ingest_path='gateway'` + interruptor desligado deixou de ser silêncio. **T058 não foi executada**: o Princípio XIV (v2.0.0) proíbe o gateway no compose do CRM, que é literalmente o que ela mandava fazer — o que ela garantia passou para o check `gateway` do health e o aviso do T059 |
| 9 · Polimento | 🟡 **quase** | mapa de arquitetura (19 peças, 24 arestas, 4 não-ligações declaradas), mapa de jornadas, runbook (reversão, o que fica em voo, variáveis da fila, diagnóstico do interruptor), política de retenção de `webhook_events_log` declarada, bateria completa rodada. **Falta**: T064 e T065, que pedem ambiente vivo |

**Placar de tarefas**: 74 de 82 concluídas. As 8 abertas: 1 invalidada pela constituição (T058) e 7 que dependem de ambiente real (T022, T030, T038, T038a, T047, T064, T065) — nenhuma delas é dúvida de projeto.

**Portões no último commit** (bateria completa do `quickstart.md` §8 — T067):

| Suíte | Resultado |
|---|---|
| `typecheck` | ✅ 0 erros |
| `lint` | ✅ 0 erros (187 avisos pré-existentes) |
| `lint:channels` | ✅ ok — 61 arquivos de dívida conhecida, **nenhum novo** |
| `test:unit` | ✅ 298 arquivos / **3038 testes** |
| `test:shell` | ✅ todas as provas |
| `test:db` | ✅ 80 arquivos / **530 testes** (1 skip) |
| `build` | ✅ `next build` completo |
| `go test ./...` (gateway) | ✅ 14 pacotes (em contêiner: a máquina não tem Go) |
| `test:e2e` | ⬜ **NÃO rodada** — exige `next build` + `.env.e2e` + Supabase local, e o Supabase local desta máquina está em uso por outra sessão nesta árvore compartilhada. A spec nova (`gateway-inbound.spec.ts`) está escrita e entra no job `e2e` |

**Fonte do Constitution Check**: este plano foi escrito contra a **v1.2.0**. A constituição está
em **v2.0.0** e redefiniu III e IV e acrescentou XIII e XIV. As decisões do plano seguem válidas —
o gateway já era serviço externo e o envelope já era contrato HTTP —, mas duas mudam de estatuto:
a fila durável da US2 deixa de ser zelo e vira **exigência do Princípio XIV** (sem réplica, a
durabilidade tem de estar do lado de fora), e "ambiente fresco" do Princípio IV passa a significar
**conta nova**, não instalação nova. As justificativas escritas em termos de self-host estão sob
`TODO(SPEC001_RATIONALE_REWRITE)`.

## Estratégia de entrega — 5 fatias, cada uma utilizável sozinha

Ordem por **risco decrescente**: o que pode invalidar o plano inteiro vem primeiro.

| # | Fatia | Entrega observável | Histórias | Custo |
|---|---|---|---|---|
| 1 | **Costura** (spike) | mensagem real de WhatsApp aparece no inbox pelo caminho novo, idempotente | US1 | ~2 jornadas |
| 2 | **Durabilidade** | CRM cai 5 min e nada se perde; ACK-primeiro pago junto | US2 | ~1,5 |
| 3 | **Autenticidade provada** | forjado não entra, tenant não vaza, invariantes no gate de banco | US3 | ~1 |
| 4 | **Riqueza da conversa** | mídia abre; estado de entrega e eco do celular corretos | US5, US6 | ~1,5 |
| 5 | **Colheita** | canal novo sem ingest novo; gateway no kit self-host; docs e mapa vivo | US4 | ~1,5 |

**Fatia 1 é um spike deliberado** (constituição, "quando o risco domina o custo"): se a costura
não fechar, o aprendizado custou duas jornadas e não o projeto. Só depois dela o resto vira volume
conhecido.

**Ponto de não-retorno**: a fatia 5 encosta no `install.sh`. Antes dela, tudo é reversível pela
chave de corte por conexão. O desligamento do caminho legado **não** está em nenhuma fatia — é
passo posterior, condicionado a evidência em produção (FR-030).

## Complexity Tracking

> Preenchido porque a feature introduz peças novas que exigem justificativa no plano, mesmo sem
> violar gate (constituição, "Governance": complexidade é justificada, nunca presumida).

| Complexidade | Por que é necessária | Alternativa mais simples, e por que foi rejeitada |
|---|---|---|
| **Serviço novo no runtime do self-host (gateway)** | Sem ele o CRM continuaria escrevendo um ingest por provedor; são 1.323 linhas de normalização já testadas do outro lado | *CRM falando direto com cada provedor*: 24–37 dias-dev na análise anterior, joga fora os normalizadores e não traz Instagram/Messenger |
| **Modo relay no gateway** | `config.go` faz `mustGetEnv("SUPABASE_URL")` e entra em pânico; hoje o gateway **não sobe** sem um banco para persistir | *Dar um banco descartável a ele*: mais uma peça para o corretor manter, sem ninguém para ler os dados |
| **Fila durável em disco no gateway** | A promessa de "nada se perde" (US2) é falsa se a pendência morre no reinício do contêiner | *Fila em memória*: perde tudo em voo a cada deploy — foi o que se mediu no `webhook_forward.go` atual |
| **Coluna `ingest_path` (chave de corte)** | Produto self-host precisa de caminho de volta sem release quando uma instalação quebra | *Virar tudo de uma vez*: sem reversão por tenant e sem como cumprir FR-030 |
| **Coluna `gateway_connection_id`** | Diagnóstico ("de qual conexão veio?") e roteamento da entrega | *Inferir por nome de sessão*: é o anti-pattern nº 4 do `CLAUDE.md` (FK ausente que vira inferência por nome) |
| **Rota nova em vez de estender a rota WAHA** | Contratos diferentes, autenticidades diferentes (uma com válvula, outra sem) e necessidade de rodar os dois lado a lado durante a virada | *Reusar `/webhooks/waha/[token]`*: impediria a coexistência exigida por FR-029 e misturaria dois regimes de segurança na mesma porta |

## Riscos que este plano assume conscientemente

1. **O gateway vira dependência de runtime do self-host.** Já declarado como dívida na emenda da
   constituição. Mitigação: modo relay (sem banco extra), imagem pequena, e ausência detectada e
   mostrada na tela em vez de silêncio.
2. **`webhook_events_log` passa a receber todo o tráfego de entrada** e cresce rápido. A coluna
   `archived_at` já existe; a política de retenção fica na fatia de polimento e está registrada
   como incógnita nº 3 da pesquisa — não como esquecimento.
3. **A jornada de estreia não tem gate de CI hoje** (`vps-fresh-onboarding` está fora do `e2e.yml`
   por exigir WAHA + Redis + Resend + Nuvemshop). O SC-006 será medido **à mão**, e isso é
   declarado em vez de mascarado.
4. **O `e2e` ainda não é check obrigatório** na branch protection. As provas que importam para
   isolamento e idempotência foram colocadas em `test:db`, que **é** obrigatório — de propósito.
5. **O rate limit degrada em silêncio numa instalação nova.** Sem Upstash configurado — o estado
   normal de um primeiro deploy — o limite passa a ser por processo (`docs/current-state.md` §5.2).
   A rota nova nasce com limite, mas a garantia real depende de uma env que o corretor pode não ter
   preenchido. Fica declarado no runbook em vez de mascarado.
6. **Descoberto na análise de consistência**: a criação de sessão grava
   `webhook_secret_encrypted: Buffer.from([0])` em dois dos três caminhos
   (`app/api/v1/channel-sessions/route.ts:105` e `app/api/v1/onboarding/whatsapp/session/route.ts:102`).
   Como a rota nova é fail-closed sem válvula, ela recusaria **100%** das entregas de conexões
   criadas pelo onboarding. Virou bloqueador explícito da Fase 2 (T017a–T017e) — é dívida de
   segurança preexistente que esta feature obriga a pagar, não custo criado por ela.

7. **A cura desse segredo não cabe no SQL, e por pouco não quebrou a instalação.** Medido na
   segunda rodada de análise: `public.fn_encrypt_oauth` (`baseline.sql:5276`) lança exceção
   quando a chave de cifra é nula, e `hostgator-setup-kit/_common.sh:460` registra que
   `ensure_encryption_key` só semeia essa chave **depois** de o baseline ser aplicado. Curar
   dentro do apêndice abortaria o `install.sh` (que usa `ON_ERROR_STOP=1`) numa VPS nova e
   falharia em silêncio no `update.sh`. A cura passou para um passo do instalador, posterior à
   chave (T017c), com recusa explícita e visível enquanto uma conexão não estiver curada (T017e).
