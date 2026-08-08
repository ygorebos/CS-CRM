---
type: mapa-vivo
project: DeskcommCRM
status: vivo
last_updated: 2026-08-08
---

# Migração para o gateway — o fio da meada

**Existe porque a migração atravessa duas specs, dois repositórios e uma inversão de doutrina.**
Quem chegar depois não consegue reconstituir isso lendo `spec.md` isolada: a spec 001 fala de
recebimento, a 004 fala de envio e conexão, e a razão original de ambas foi **invertida** pela
constituição v2.2.0 no meio do caminho. Este arquivo é o único lugar onde as três frentes, o que
bloqueia cada uma e o que já foi decidido cabem numa página.

**Precedência**: este documento **não** é doutrina. Se divergir de `CLAUDE.md` ou da constituição,
eles ganham e este arquivo está velho — corrija aqui.

---

## O desenho em uma frase

Todo tráfego de canal conversacional — receber, enviar e conectar — passa a atravessar o
`gateway_go`, que normaliza para um envelope único. O CRM deixa de falar o dialeto de cada
provedor.

```
                    ┌──────────────────────────────────┐
   celular ───────► │  provedor (uazapi / Meta / …)    │
   do cliente       └───────────────┬──────────────────┘
                                    │  webhook cru
                                    ▼
                    ┌──────────────────────────────────┐
                    │   gateway_go  (serviço ÚNICO,    │
                    │   compartilhado, SEM réplica)    │
                    │   normaliza → envelope_v1        │
                    └───┬───────────────────────▲──────┘
        envelope assinado│                      │ POST /v1/messages
        (F1 recebimento) │                      │ (F2 envio)
                         ▼                      │
                    ┌──────────────────────────────────┐
                    │            CRM (este repo)       │
                    │  /api/v1/webhooks/gateway/[token]│
                    └──────────────────────────────────┘
```

O **ACK do envio volta pela mesma seta de entrada** — `event_kind: "status_update"` no mesmo
envelope. Isso não é coincidência de desenho: é o que faz a frente de envio herdar pronta metade da
sua própria máquina de estados.

---

## As três frentes

| # | Frente | Spec | Onde mora o trabalho | Estado |
|---|---|---|---|---|
| **F1** | **Provisionamento** — existir conexão que o gateway resolva, sem o CRM tocar banco alheio | 004 | `gateway_go` | ⛔ **não existe** — bloqueia F2, F3 e as 5 tarefas abertas da 001 |
| **F2** | **Envio** — CRM manda pelo gateway em vez do WAHA | 004 | CRM | 🟡 superfície do gateway pronta; falta adapter + desarmar 2 desvios |
| **F3** | **Conexão** — corretor pareia número novo pelo gateway, pela tela | 004 | CRM + `gateway_go` | 🟡 gateway tem QR/status/desconectar; falta criar conexão e tirar "WAHA" da tela |
| — | **Recebimento** | 001 | CRM + `gateway_go` | ✅ **76 de 82**, mesclada na `main` |

---

## O bloqueio, medido

Toda rota de envio do gateway começa resolvendo a conexão contra `wa_connections`, tabela do
**Supabase do Cotador Simplificado** (`internal/resolver/connection.go:145-172`). Sem essa linha o
resolver devolve erro genérico, vira **502**, e nenhuma chamada ao provedor acontece
(`internal/resolver/errors.go:76-82`). É o **único passo duro** do caminho de envio — janela de
24h, persistência no inbox e auditoria de template já toleram falha de banco; o resolver não.

**E nenhuma rota do gateway cria essa linha.** Inventário: 9 leituras e 3 atualizações de `status`
em `wa_connections`, **zero `Insert`/`Upsert`**. Hoje a linha nasce à mão, do lado do Cotador.

### O `ModeRelay` não resolve isso — e essa é a descoberta que muda o plano

`ModeRelay` está declarado (`internal/config/config.go:79-83`) e testado, mas **nenhum handler,
processor ou camada de persistência o consulta**:

```
$ grep -rn "IsRelay()" --include="*.go" .
internal/config/config.go:83
internal/config/config_test.go: (11 ocorrências)
```

Seu único efeito real é deixar de exigir `SUPABASE_URL` no boot. O processo sobe sem banco, e
então todo o resolver chama um PostgREST de URL vazia. Ou seja: o relay foi desenhado para cortar a
**escrita** best-effort no inbox e **nunca endereçou a leitura obrigatória** da conexão.

**Consequência**: o que falta não é "ligar o relay". É o gateway passar a **possuir** o registro de
conexão e expô-lo por contrato — que é o que o Princípio VII manda de qualquer forma.

---

## Decisões já tomadas (não reabrir sem motivo novo)

| Decisão | Onde foi tomada | Resumo |
|---|---|---|
| Arquitetura A: gateway como receptor geral, CRM persiste | `specs/001/analise-gateway-go-recebimentos.md` | Rejeitado o caminho direto do CRM a cada provedor (24–37 dias-dev, joga fora 1.323 linhas de normalizador testado) |
| Envelope único versionado, com regra de compatibilidade para frente | `specs/001/contracts/gateway-inbound-v1.md:87-96` | Versão maior é aceita; campo desconhecido preservado em `metadata`; tipo desconhecido vira `system`. **Obrigatório**, não zelo: os dois lados versionam separado |
| ACK-primeiro + fila durável dos dois lados | Princípio XIV | Nenhuma metade sozinha basta |
| Chave de corte **por conexão** (`ingest_path`) | migration 0119 | Migrar e reverter um canal por vez, sem release |
| O gateway **não** entra no deploy do CRM | Princípio XIV | Invalidou a T058 da spec 001 |
| Cobrança não mora aqui | Princípio XIII | Assinatura é do Cotador |
| Ciclo de vida da conexão fica fora da 001 | `specs/001/spec.md` Assumptions | Preservou o teto de 10 min; virou a F3 da 004 |
| Envio fica fora da 001 | `specs/001/spec.md` Assumptions | Virou a F2 da 004 |
| Eco de envio já é desambiguado | T054 da 001 | `sent_by_api=false` + `direction: outbound` grava `sent_via='external_device'`, sem duplicar |
| **Fork do gateway escrevendo no banco do CRM** | dono do produto, 2026-08-08 | Duas versões, uma por produto. A do CRM grava conexão, instância, mensagem, conversa e contato **no banco do CRM**. Desenho e preço em [`specs/004/decisao-escrita-direta.md`](../specs/004-envio-pelo-gateway/decisao-escrita-direta.md) |

### A escrita direta — o que ela custa, em uma tabela

A decisão de 2026-08-08 é a maior mudança de rumo desde a v2.2.0 e reorganiza tudo que está acima.
O detalhe está na [decisão](../specs/004-envio-pelo-gateway/decisao-escrita-direta.md); aqui fica só
o que muda de dono:

| Coisa | Antes | Depois |
|---|---|---|
| Entrada da mensagem | `POST /api/v1/webhooks/gateway/[token]`, HMAC, ACK-primeiro | função `security definer` chamada pelo gateway |
| Idempotência | `unique (organization_id, external_id)` + catch de 23505 em TypeScript | **mesma constraint**, catch em SQL — e exige `set constraints ... immediate`, porque a constraint é `DEFERRABLE` e o `on conflict` **não funciona** contra ela (medido) |
| Fila durável | duas: disco do gateway **e** `webhook_events_log` | **duas ainda** — a do CRM muda de FORMA, não some: fila de entrada vira **reconciliação periódica** (FR-013a). Uma ponta só é descumprimento do XIV, não escolha de custo |
| Acordar o agente | `lib/gateway/ingest.ts:253` emite `ai_agent.dispatch_requested` | dentro da mesma função/transação do insert — mais seguro que hoje |
| Tenant | resolvido do `webhook_path_token` da rota | resolvido de `channel_sessions.gateway_connection_id`. **Nunca do corpo**, nos dois |
| Credencial do gateway | segredo HMAC por conexão | papel Postgres `gateway_writer`, `EXECUTE` só nas funções, zero grant de tabela |

**A doutrina foi emendada** — constituição **v2.3.0**, em 2026-08-08. O Princípio VII passou de três
para **quatro superfícies**: a nova é a **função `security definer` versionada**, e a proibição que
sobrevive ficou mais precisa que a antiga — "acesso direto ao **banco**" virou "acesso direto **a
tabela**", que é o que de fato acopla ao schema. A superfície existe **só sob seis travas** (zero
grant de tabela nem `select` · papel dedicado, nunca `service_role` nem o segredo do JWT · tenant
resolvido dentro do banco · assinatura versionada · invariante em CI · sem HTTP na função), e falhar
em qualquer uma a torna proibida, não degradada. Ela **não** se estende ao Cotador. O XIV também foi
esclarecido: a ponta de durabilidade do CRM muda de **forma** (fila com dreno / reconciliação
periódica), nunca de obrigatoriedade. `CLAUDE.md` e `AGENTS.md` propagados na mesma data.

⚠️ **A permissão é condicional, e isso importa na revisão de PR**: enquanto o invariante que reprova
grant de tabela e a varredura de HTTP na função não estiverem verdes, a conformidade é promessa. Se
a função existir e o invariante não, **reprove o PR** — a emenda permitiu a superfície *sob
condição*, e sem a condição ela é proibida.

### A inversão de doutrina, registrada de propósito

A `research.md` D10 da spec 001 **rejeitou explicitamente** "manter o gateway fora da instalação,
como serviço nosso", com o argumento de que isso mataria a independência do self-host. A
constituição v2.2.0 tornou essa alternativa **obrigatória**: não há instalação de cliente, e o
Princípio XIV define o gateway como instância única compartilhada.

**O desenho técnico sobreviveu inteiro à inversão** — envelope, ACK-primeiro, fila durável, chave
de corte. Só o argumento mudou. Está escrito aqui, e em nota na própria `spec.md` da 001, porque
decisão cuja razão sumiu volta a ser questionada na sessão seguinte.

---

## O que já está pronto e a 004 herda de graça

- **O caminho de volta do ACK.** O gateway devolve confirmação de entrega como `envelope_v1`
  assinado com `delivery.status` (`internal/envelope/envelope.go:205-216`). O CRM já roteia isso:
  `lib/gateway/ingest.ts:92` → `atualizarEstado` (`:289`), **com guarda contra regressão de
  estado** (`:278-288`) — proteção que o ACK do WAHA não tem (`lib/waha/ingest.ts:657-677`).
  Migrar o envio herda um ACK melhor que o atual.
- **O seam de canal.** `getAdapter(provider)` (`lib/channels/index.ts:27`), fail-closed, com
  `whatsapp_uazapi: null` deixado de propósito. O envio novo é um adapter, não uma reescrita.
- **As colunas.** `channel_sessions.gateway_connection_id` e `ingest_path`, migration 0119.
- **O `event_id` determinístico do gateway inclui o status** — `sent`, `delivered` e `read` geram
  identificadores distintos. Idempotência de ACK sai de graça.

---

## O que a 004 vai ter de enfrentar

1. **Dois desvios de envio fogem do seam.** O redrive do watchdog
   (`lib/agent-engine/edge/crm/session-reconciler.ts:139`) monta `{session, chatId, text}` cru e
   faz `fetch` direto no `/api/sendText` do WAHA. Num canal migrado ele envia para o lugar errado,
   em silêncio. O outro é o control plane de conexão, que chama `getWahaClient()` direto em 11
   pontos fora do seam.
2. **O gateway não tem controle de vazão nenhum.** Nem por conexão, nem global, nem por IP —
   varredura no repo inteiro. Todo o anti-banimento vive no CRM, e é onde deve viver: é o CRM que
   conhece aquecimento, janela e histórico do número.
3. **O CRM tem TRÊS controles de vazão independentes**, e o compositor humano, a integração externa
   e o runtime antigo **não passam por nenhum**. Dívida pré-existente. A migração não pode
   agravá-la.
4. **Duas jornadas de conexão divergentes.** Onboarding e Central de Conexões usam rotas
   diferentes, formatos de nome de sessão diferentes — e **as rotas do onboarding não checam papel
   nenhum**, enquanto as da Central exigem `admin`. Migrar as duas separadamente duplicaria o furo.
5. **O vocabulário de estado do canal é literalmente o do WAHA** (`lib/schemas/channels.ts:14-21`,
   com CHECK no banco). O gateway devolve estado de outro provedor.
6. **A assimetria de id do WAHA** (envio devolve id nu, webhook manda composto) é a causa nº 1 de
   duplicata e status travado em `sent`. O caminho novo não pode reproduzi-la.

---

## Dívidas abertas do recebimento (spec 001)

Cinco tarefas abertas, **todas bloqueadas pela F1** — não por falta de trabalho: não existe hoje
um gateway implantado que sirva o CRM sem o banco do Cotador, e o único gateway rodando é o de
produção do Cotador, cujo webhook não pode ser redirecionado sem quebrar o atendimento real deles.

| Tarefa | O que falta | Bloqueio |
|---|---|---|
| T030 | 20 envios reais, p95 ≤5s, reentrega | F1 |
| T038 | CRM fora do ar 5 min + reinício do gateway | F1 |
| T038a | rajada de 200/60s com o teto de taxa ligado | F1 + Upstash |
| T064 | rollback no meio do tráfego | F1 |
| T065 | jornada de estreia cronometrada | F1 + **roteiro §4 precisa ser reescrito antes** |
| ~~T058~~ | — | invalidada pelo Princípio XIV |

Mais três levantadas na revisão pós-merge de 2026-08-08:

| Tarefa | O que é |
|---|---|
| T069 | `scripts/curar-segredos-de-canal.ts` **não tem quem o chame** — três comentários afirmam que o `install.sh` o chama; ele não chama, e o kit foi aposentado |
| T070 | falta a prova **de banco** de que nenhuma conexão nasce com segredo placeholder (a de unidade existe) |
| T071 | cron de retenção de `webhook_events_log` — a política está escrita, a execução nunca foi agendada. `raw_body` guarda conversa de cliente: é LGPD antes de ser disco |

---

## Numeração de migrations — a armadilha que já mordeu

A sequência é **compartilhada entre specs**, e duas frentes paralelas reservaram a mesma faixa. No
merge de 2026-08-08 as migrations da 001 foram renumeradas 0116–0119 → **0119–0122**, e a
numeração *planejada* da 002 foi realocada para **0123–0126**.

Pior que o número: as duas frentes reconstruíam o CHECK de `agent_inbox_items.kind` **inteiro**,
cada lista ignorando os kinds da outra. A ordem de aplicação é a do nome do arquivo, então a última
apagaria os kinds da primeira — **sem erro, sem teste vermelho**, até alguém abrir um aviso e tomar
violação de CHECK em produção.

> **Regra**: antes de criar migration, `ls supabase/migrations/`. E ao reconstruir constraint de
> vocabulário, a lista tem de conter **todos** os valores, inclusive os da outra frente.

---

## Onde ler mais

| Assunto | Arquivo |
|---|---|
| Recebimento — spec, plano, tarefas | [`specs/001-migracao-waha-uazapi/`](../specs/001-migracao-waha-uazapi/spec.md) |
| Envio e conexão — spec | [`specs/004-envio-pelo-gateway/spec.md`](../specs/004-envio-pelo-gateway/spec.md) |
| Contrato do envelope de entrada | [`specs/001-migracao-waha-uazapi/contracts/gateway-inbound-v1.md`](../specs/001-migracao-waha-uazapi/contracts/gateway-inbound-v1.md) |
| Operar e diagnosticar | [`docs/runbooks/gateway-relay.md`](runbooks/gateway-relay.md) |
| Mapa vivo do recebimento | [`docs/architecture/recebimento-pelo-gateway.architecture.json`](architecture/recebimento-pelo-gateway.architecture.json) |
| Doutrina de canal (nenhuma feature nomeia provider) | [`docs/doctrine/restricao-de-canal.md`](doctrine/restricao-de-canal.md) |
| Princípios XIII e XIV | [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) |
