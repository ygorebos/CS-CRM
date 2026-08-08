# Análise de complexidade — migrar WAHA → gateway Uazapi (oficial + não-oficial)

**Data:** 2026-08-07
**Escopo do pedido:** *apenas analisar o nível de complexidade*. Não há spec de feature,
plano nem tasks neste diretório — de propósito.
**Base medida:** branch `fix/waha-media-storage`, commit `b990bd28`.

---

## Veredito em uma linha

**Complexidade ALTA no agregado — mas mal distribuída.** O **envio já tem seam pronto**
(baixa complexidade: ~1 arquivo novo + 3 linhas de registro). O **recebimento não tem
seam nenhum** (728 linhas de ingest WAHA-específico, sem envelope inbound normalizado), o
**control plane de sessão também não** (11 imports diretos de `lib/waha/*` fora do seam), e
o **vocabulário do WAHA vazou para dentro do banco e da UI** (`waha_session_name NOT NULL`,
`engine CHECK (NOWEB|WEBJS)`, `status CHECK (STARTING|SCAN_QR_CODE|WORKING|STOPPED|FAILED)`).

O maior risco **não é técnico, é de posicionamento**: o kit self-host entrega o WAHA como
contêiner próprio (`docker-compose.prod.yml` serviço `waha`, volumes `waha-data`/`waha-media`,
18 referências no `hostgator-setup-kit/install.sh`). Um gateway hospedado de terceiro
transforma "self-host em VPS" em "self-host + dependência SaaS paga externa", que contradiz
a tese em `VISION.md`/`CLAUDE.md`. Isso precisa ser decidido **antes** de qualquer código.

---

## O que já está pronto (e reduz muito o custo do envio)

Existe uma doutrina de canal escrita e com catraca de CI: `docs/doctrine/restricao-de-canal.md`,
vigiada por `scripts/lint-channels.ts`. O seam existe e já tem **dois** providers vivos:

| Peça | Arquivo | Estado |
|---|---|---|
| Interface do adapter | `lib/channels/types.ts:113` (`ChannelAdapter`) | pronta |
| Registro de providers | `lib/channels/index.ts:11` (`ADAPTERS`) | pronta, fail-closed |
| Matriz de capabilities | `lib/channels/capabilities.ts:15` | pronta, exaustiva (teste reprova buraco) |
| Resolução de sessionRef | `lib/channels/session-ref.ts` | pronta, tagged union |
| Adapter WAHA | `lib/channels/adapters/waha.ts` | 100 LOC, delega a `lib/waha/*` |
| Adapter Meta Cloud | `lib/channels/adapters/meta-cloud.ts` | vivo |

Consumidores **já** passam pelo seam (não precisam mudar para um provider novo):
`app/api/v1/messages/_handler.ts:332`, `lib/ai/runtime/agent.ts:293`,
`app/api/v1/cron/contact-avatars/route.ts:147`,
`lib/agent-engine/guardrails/before-send.ts:425`,
`lib/agent-engine/agent/inbound-turn.ts:1842`.

**Consequência prática:** somar o Uazapi ao *envio* é aditivo e barato. É o único front barato.

---

## Complexidade por frente (medida, não estimada de cabeça)

### 1. Envio (outbound) — **BAIXA**

O que muda: um `lib/channels/adapters/uazapi.ts` espelhando o WAHA (~120 LOC), um cliente de
transporte (~200–250 LOC, tamanho de `lib/waha/client.ts`), + 1 linha em `ADAPTERS`, + 1
bloco em `CHANNEL_CAPABILITIES`, + o union `ChannelProvider`.

**Porém — decisão doutrinária embutida:** o Uazapi expõe **API oficial e não-oficial**. Pela
doutrina (`restricao-de-canal.md`), são famílias de restrição **invertidas**:

- não-oficial → auto-restrição: throttle, jitter, warm-up, cap; violar = ban silencioso;
- oficial → hetero-restrição: janela 24h, template aprovado, custo por mensagem; violar = 400 na hora.

A matriz de capabilities é indexada por `ChannelProvider`. Logo o Uazapi provavelmente entra
como **dois providers** (`uazapi_oficial` / `uazapi_naooficial`), não um. Tratar como um só e
resolver capability em runtime por config quebra a exaustividade que
`tests/unit/channel-capability-matrix.test.ts` cobra. Isso dobra o trabalho de matriz e de
testes de gate — mas é o desenho certo.

### 2. Recebimento / webhooks (ingest) — **ALTA. É aqui que mora o custo.**

Não existe envelope inbound normalizado. O precedente do repo é **cada provider escreve o
seu ingest inteiro**:

- WAHA: `lib/waha/ingest.ts` (**728 LOC**, 15 funções) + rota `app/api/v1/webhooks/waha/[token]/route.ts` + `lib/waha/webhook-auth.ts` (74)
- Meta: `lib/channels/meta/webhook.ts` (227) + `lib/channels/meta/ingest.ts` (173) + rota `app/api/v1/webhooks/meta/[token]/route.ts`

O ingest WAHA carrega conhecimento que **não é portável** e precisa ser redescoberto por
medição no Uazapi (não por leitura de doc):

| Detalhe | Onde | Por que dói |
|---|---|---|
| `parseChatId` — `@c.us` / `@lid` / `@g.us` | `ingest.ts:83` | privacidade LID, grupos, endereçabilidade |
| `handleOutboundFromUserPhone` — eco de msg digitada no celular | `ingest.ts:524` | multi-device; sem isso duplica mensagem |
| `handleAck` + casamento de `external_id` | `ingest.ts:657` | ver linha seguinte |
| Assimetria de id (envio devolve bare, webhook manda composto) | `lib/waha/message-id.ts` | **causa nº 1 de duplicata e status travado em `sent`** |
| `echoExternalIds` | `adapters/waha.ts:33` | reconhecer o próprio eco |
| Mapeamento de tipo de mensagem | `ingest.ts:196` | vocabulário próprio do provider |
| HMAC SHA512 fail-closed por sessão | `lib/waha/webhook-auth.ts` | esquema de auth do Uazapi é outro → módulo novo + envs novas |

Estimativa realista: o ingest do Uazapi é **um terceiro ingest completo**, não um plugin.

### 3. Mídia recebida — **MÉDIA-ALTA (com risco de segurança)**

`lib/messaging/media/waha-source.ts` garante anti-SSRF **por construção**: descarta o host
anunciado no payload e reconstrói a URL sobre `WAHA_API_BASE_URL`. Essa garantia só existe
porque o WAHA roda na rede interna do Docker. Se o Uazapi entregar mídia em URL assinada no
domínio dele (ou base64 inline), a propriedade "o host nunca vem do payload" **se perde** e
precisa de outro desenho (allowlist de host, ou download server-side com validação). Não é
copiar-colar: é reprojetar a garantia.

Some-se o commit `b990bd28` (mídia recebida ia para `/tmp` e sumia em 180s) — a cadeia de
mídia é justamente onde o repo já se queimou.

### 4. Control plane de sessão (QR, start/stop/logout/delete/status) — **MÉDIA-ALTA**

`ChannelAdapter` **não tem** métodos de ciclo de vida de sessão. As rotas chamam
`getWahaClient()` direto — **11 imports de `lib/waha/*` fora do seam**:

```
app/api/v1/channel-sessions/route.ts:19
app/api/v1/channel-sessions/[id]/route.ts:31
app/api/v1/channel-sessions/[id]/reconnect/route.ts:42
app/api/v1/onboarding/whatsapp/session/route.ts:12
app/onboarding/connect-whatsapp/page.tsx:3
lib/agent-engine/edge/crm/session-reconciler.ts:21
… (+ rotas de webhook e teste)
```

Além do volume, há **regra WAHA-específica embutida**: o reconnect faz `logout` antes de
`start` porque credencial em disco revogada leva a `FAILED` sem passar por `SCAN_QR_CODE`
(`lib/waha/client.ts`, `logoutSession`). O Uazapi tem outro ciclo de vida → outra regra.

Isso implica **estender o seam** (`ChannelAdapter` ganha um control-plane), que é trabalho
de refatoração em código de primeira impressão (onboarding — `[P0]` na doutrina de QA Visual).

### 5. Banco — **MÉDIA (mas com a tripla obrigatória)**

`channel_sessions` tem o vocabulário do WAHA cravado (`supabase/baseline.sql:1313`):

- `waha_session_name text NOT NULL` + UNIQUE — **80 usos no código**, 28 arquivos
- `engine CHECK ('NOWEB','WEBJS')` — nome de engine do WAHA virou constraint
- `status CHECK ('STARTING','SCAN_QR_CODE','WORKING','STOPPED','FAILED')` — máquina de estados do WAHA virou contrato do banco, lido pela UI e pelo watchdog
- `channel_sessions_provider_check` / `provider_ref_check` (baseline.sql:8425–8432, migration 0087)

Trabalho: coluna nova de ref (`uazapi_instance_id`), extensão dos dois CHECKs, e — se o
Uazapi tiver estados que não mapeiam — extensão do `status_check`. Tudo pela doutrina:
**migration versionada + apêndice idempotente no `baseline.sql` + linha no MANIFEST**, com
`pnpm test:db` local antes do PR (o `verify` não cobre schema).

### 6. Agent-engine (daemon separado) — **MÉDIA**

Há um **segundo** seam de canal, incompatível com o primeiro:
`lib/agent-engine/channel-adapter.ts` + `lib/agent-engine/edge/channel/waha-adapter.ts`
(interface própria, `capabilities()`, `costPerMessage()`).

E há um caminho que **fura os dois seams**: `lib/agent-engine/edge/crm/session-reconciler.ts`
chama a REST do WAHA na mão (`/api/sessions?all=true`, `/api/sendText`, linhas 45 e 139) para
reconciliar espelho de status e fazer redrive de mensagens `queued`. Esse caminho precisa ser
reescrito por provider, ou o redrive some para quem estiver no Uazapi — silenciosamente.

Também tocam: `lib/agent-engine/health/circuit.ts` (431), `obs/metrics.ts` (246), `env.ts` (168).

### 7. Infra, kit self-host e superfície pública — **ALTA (estratégico)**

- `docker-compose.prod.yml`: serviço `waha`, volumes `waha-data`/`waha-media`, envs
  `WAHA_API_KEY_SHA512`, `WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS`, `WHATSAPP_HOOK_HMAC`
- `hostgator-setup-kit/install.sh`: 18 referências; `backup.sh`, `healthcheck.sh`, `comecar.sh`
- `app/api/v1/health/route.ts:211`: `checks.waha` é **campo de API pública** — renomear quebra contrato
- 5 envs em `lib/env.ts:68-80` + `.env.example`
- Docs: `docs/prd/03-prd-whatsapp-waha.md`, `docs/specs/03-spec-whatsapp-waha.md`, `docs/runbooks/waha-hostgator.md`, `README*.md` (3 idiomas)

### 8. Testes e catracas de CI — **MÉDIA, mas obrigatória**

**61 arquivos de teste** citam WAHA. Os que barram o merge de um provider novo:

- `tests/unit/channel-capability-matrix.test.ts` — matriz exaustiva; capability faltando reprova
- `tests/invariants/channel-provider-schema.test.ts` — schema do provider
- `scripts/lint-channels.ts` + `scripts/lint-channels.pattern.ts` — **catraca que só encolhe**.
  O padrão hoje reconhece `waha`/`meta_cloud`. Ao entrar o Uazapi, o nome precisa entrar no
  padrão também — senão o repo ganha um provider com violação **invisível** ao gate, que é
  exatamente o defeito da issue #118.
- `tests/unit/lint-channels-fronteira.test.ts`, `tests/unit/waha-*.test.ts` (7 arquivos)

E a doutrina de QA Visual: onboarding/conectar canal é `[P0]` — exige prova pela tela em VPS
fresca (`baseline.sql` + `bootstrap-owner.ts`), não curl.

---

## Tabela-resumo

| Frente | Complexidade | Motivo dominante |
|---|---|---|
| Envio (outbound) | **Baixa** | seam pronto e já consumido |
| Capabilities (oficial × não-oficial) | Média | duas famílias de restrição = provavelmente dois providers |
| Recebimento / ingest | **Alta** | 728 LOC sem seam; semântica de id/ack só descobrível medindo |
| Mídia recebida | Média-alta | garantia anti-SSRF depende da topologia do WAHA |
| Control plane de sessão + UI | Média-alta | 11 imports fora do seam; vocabulário WAHA na UI |
| Banco / migrations | Média | 80 usos de `waha_session_name`; 3 CHECKs; tripla obrigatória |
| Agent-engine / reconciler | Média | segundo seam + caminho que fura os dois |
| Infra / kit self-host / docs | **Alta (estratégico)** | contêiner próprio vs. SaaS externo |
| Testes e catracas | Média | 61 arquivos; matriz exaustiva; lint que só encolhe |

**Ordem de grandeza (1 dev, Uazapi *somado* ao WAHA, sem remover nada):**
~**24–37 dias-dev** (≈5–7,5 semanas), distribuídos assim: contrato/medição do gateway 2–3 ·
schema 1–2 · outbound 2–3 · control plane + UI 4–6 · ingest 5–8 · mídia 2–3 · agent-engine
3–4 · kit/infra/docs 2–3 · QA visual + invariantes 3–5.

**Substituir** o WAHA (em vez de somar) **não é menor** — soma a migração das instalações já
existentes: cada cliente self-hosted precisaria reparear o número, e as sessões WAHA em disco
(`waha-data`) não migram.

---

## O que impede uma estimativa mais apertada

1. **O gateway não existe neste repo.** Busca por `uazapi`, `gateway request`, `gateway_request`
   em `.ts/.tsx/.md/.sql`: **zero ocorrências**. Todo o lado de destino foi tratado como
   incógnita. Com o contrato em mãos (payload de webhook, esquema de auth, shape do id de
   mensagem, formato de mídia, ciclo de vida de instância), a faixa acima aperta bastante —
   principalmente as frentes 2, 3 e 4.
2. **Coexistir ou substituir?** Muda o trabalho de "aditivo" para "aditivo + migração de base
   instalada", e muda a resposta à pergunta de posicionamento self-host.
3. **Uma linha de provider ou duas?** (oficial e não-oficial como providers separados na matriz)
   — decide o tamanho de capabilities, gates e testes.

---

## Recomendação

**Não comece pelo código.** Faça primeiro uma **Fase 0 de medição do gateway** (2–3 dias):
subir uma instância Uazapi de teste, capturar payload real de webhook (inbound, eco `fromMe`,
ack, status de sessão), medir o shape do id nos dois lados (envio × webhook) e o formato de
mídia. Essa medição é o que separa uma estimativa de 5 semanas de uma de 10 — e é exatamente
o conhecimento que o `lib/waha/message-id.ts` documenta ter custado bugs em produção.

Depois disso, um `/speckit-specify` com escopo decidido (coexistir vs. substituir) produz uma
spec que vale o nome.
