# gateway_go × DeskcommCRM — como funciona o gateway e como adaptar os RECEBIMENTOS

**Data:** 2026-08-07
**Complementa:** [`analise-complexidade.md`](./analise-complexidade.md) (que analisou o CRM
falando com a uazapi **direto**, sem gateway).
**Fontes medidas:** `/root/PROJETOS/gateway_go` (HEAD local, branch `main`) e
`/root/PROJETOS/crm_3_0` (`fix/waha-media-storage`, `b990bd28`).

---

## A frase que muda a conclusão anterior

**O gateway já tem exatamente a peça que falta no CRM: um envelope inbound normalizado.**

`internal/normalizer/types.go` define `MensagemNormalizada` — *"o formato interno após
normalização. **Todos os canais convertem para esse formato antes de persistir**"*. Quatro
normalizadores já escritos e testados alimentam esse tipo:

| Canal | Arquivo | LOC |
|---|---|---|
| WhatsApp uazapi (não-oficial) | `internal/normalizer/uazapi.go` | 351 |
| WhatsApp Cloud API (oficial) | `internal/normalizer/whatsapp_cloud.go` | 585 |
| Instagram Direct | `internal/normalizer/instagram.go` | 145 |
| Messenger | `internal/normalizer/messenger.go` | 242 |
| **Total de parsing por provider já pronto** | | **1.323** |

No CRM não existe nada disso. Cada provider escreve seu ingest inteiro do zero:
`lib/waha/ingest.ts` (728 LOC) e `lib/channels/meta/*` (~400 LOC) são implementações
**paralelas**, sem contrato comum. Um terceiro provider = um terceiro ingest.

**Consequência:** ligar o CRM ao gateway não é só "trocar de fornecedor de WhatsApp" — é
**parar de escrever ingest por provider**. Sai mais barato que o caminho direto à uazapi, e
traz Instagram e Messenger junto de graça.

---

## Como o gateway funciona hoje (medido)

```
webhook do canal                     ┌─ responde 200 ANTES de tocar em rede (princípio I)
   │                                 │
   ▼                                 │
handlers/{uazapi,whatsapp_cloud,     │   resolve conexão por token → escritorio_id
          instagram,messenger}.go ───┘   (princípio III: NUNCA do payload)
   │
   ▼  goroutine separada
normalizer.Normalizar*  ──────────►  MensagemNormalizada   ◄── o contrato canônico
   │
   ├──► processor.ProcessarWebhook ──► Supabase do Cotador (PostgREST + RPC)
   │        1. RPC upsert_contato_multicanal_v1   → inbox_contatos
   │        2. RPC upsert_conversa_multicanal     → inbox_conversas
   │        3. upsert inbox_mensagens  (ignore-duplicates on escritorio_id,wamid)
   │        4. insert wa_webhook_logs  (append-only, fire-and-forget)
   │
   └──► encaminharWebhook() ─────────► forwarding_webhooks (POST do body **CRU**)
```

Tamanho por pacote (sem testes): `handlers` 5.330 · `sender` 4.862 · `normalizer` 1.568 ·
`processor` 883 · `supabase` 472 · `resolver` 342. Rotas: 4 webhooks públicos, `/v1/messages`
(camada 1 unificada), 123 rotas `/v1/uazapi/*` (camada 2), 18 rotas `/send/*` (compat).

### Princípios do gateway que o CRM já compartilha (alinhamento gratuito)

| Princípio (constituição do gateway) | Equivalente no CRM |
|---|---|
| III — `escritorio_id` vem da conexão, nunca do payload | `organization_id` resolvido de fonte confiável, nunca do body (CLAUDE.md) |
| II — idempotência por constraint: `unique(escritorio_id, wamid)` | `unique(organization_id, external_id)` + captura de `23505` |
| V — PostgREST é o caminho de escrita | Supabase admin client |
| VI — autenticidade na borda, segredo nunca em URL | HMAC fail-closed + API key só em header |

**São o mesmo desenho, com nomes diferentes.** Isso é o que torna a ponte viável.

### Um princípio que o CRM **não** cumpre e o gateway sim

**ACK primeiro** (princípio I, "NÃO-NEGOCIÁVEL" lá): o handler responde `200` **antes** de
qualquer I/O; o processamento vai para goroutine. Motivo escrito no `CLAUDE.md` deles: *"Meta
retenta em 20s; persistir antes de responder duplica mensagem no inbox."*

A rota do CRM faz o oposto — `app/api/v1/webhooks/waha/[token]/route.ts` consulta
`channel_sessions`, chama `fn_decrypt_oauth`, insere em `webhook_events_log` e **aguarda
`dispatchWahaEvent` inteiro** antes de responder. Com WAHA, que não retenta agressivamente,
passa despercebido. Com Meta/uazapi via gateway, vira duplicata no inbox. **É dívida a
consertar independentemente desta migração.**

---

## O descasamento real: os dois bancos

Você descreveu certo — e é a raiz de toda a decisão de arquitetura.

| | gateway_go → Cotador Simplificado | DeskcommCRM |
|---|---|---|
| Banco | Supabase do Cotador (compartilhado com o portal) | Supabase **próprio**, só do CRM |
| Chave de tenant | `escritorio_id` | `organization_id` (+ RLS em toda tabela) |
| Conexão/canal | `wa_connections` (`platform`, `externo_id`, `access_token`) | `channel_sessions` (`provider`, `waha_session_name`, `webhook_path_token`) |
| Contato | `inbox_contatos` | `contacts` (`wa_identity` phone/lid) |
| Conversa | `inbox_conversas` | `conversations` |
| Mensagem | `inbox_mensagens` (`wamid`, `direcao`, `conteudo`) | `messages` (`external_id`, `direction`, `body`) |
| Log bruto | `wa_webhook_logs` | `webhook_events_log` |
| Escrita | PostgREST + service role, sem RLS no caminho | admin client **com filtro manual de `organization_id`** |
| O que acontece depois do insert | nada — o portal lê a tabela | dispara agent-engine, follow-up, pacing, governança de inbox, audit, `event_log` |

**A última linha é a decisiva.** No Cotador, ingerir = persistir. No CRM, ingerir é o gatilho
de uma cadeia viva (turno do agente de IA, reatividade de follow-up, guardrails de envio,
audit log). Um gateway em Go escrevendo direto nas tabelas do CRM **pularia tudo isso** — ou
teria que reimplementar em Go regra de negócio que hoje é TypeScript testado.

---

## Três arquiteturas possíveis (e a recomendada)

### A. Gateway normaliza e **encaminha o normalizado**; o CRM tem UM ingest ✅ recomendada

```
uazapi / Cloud API / Instagram / Messenger
        │
        ▼
   gateway_go  ── normaliza ──► MensagemNormalizada
        │                              │
        ├─► persiste no Cotador        └─► POST assinado ──► CRM: /api/v1/webhooks/gateway/[token]
        │   (segue como hoje)                                    │
        └─► (opcional) modo relay: só normaliza, não persiste     ▼
                                                    ingest ÚNICO → contacts/conversations/messages
                                                                  → agent-engine, follow-up, audit
```

**Por que ganha:** o CRM escreve **um** ingest contra **um** contrato estável, em vez de três
contra três payloads de provider. Canal novo que o gateway aprender chega ao CRM sem código
novo no CRM. E as 1.323 linhas de parsing já testadas continuam valendo.

**O que falta construir no gateway** (`internal/handlers/webhook_forward.go` hoje tem 61 LOC e
**não serve como está**):

1. **Encaminha o body CRU, não o normalizado.** Se o CRM assinar o forward de hoje, recebe o
   payload da uazapi/Meta e tem que escrever os parsers de novo — perdendo justamente o ganho.
   Precisa de um modo `formato: "normalizado"`.
2. **Não assina nada.** É `POST` fire-and-forget sem header de autenticidade. O CRM tem webhook
   **fail-closed** por doutrina (`lib/waha/webhook-auth.ts` existe porque a versão fail-open
   permitia injetar mensagem falsa em CRM alheio — provado com `curl`). Aceitar forward não
   assinado reabre exatamente esse buraco. Precisa de HMAC.
3. **Não tem retry nem dead-letter.** Timeout de 5s, `go func()`, erro só vira `log.Warn`. CRM
   fora do ar por 30s = mensagens perdidas **para sempre**. O gateway tem `wa_webhook_logs`
   para o que ele persiste, mas o forward não tem ledger nenhum.
4. **Não carrega mapa conexão → organização do CRM.** `wa_connections.escritorio_id` é do
   Cotador; o CRM precisa de `organization_id`. O mapa tem que existir em algum lugar (coluna
   nova em `wa_connections`, ou o token do path do CRM já identificando o tenant — que é como
   o CRM já faz: `webhook_path_token` por `channel_session`).
5. **`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são obrigatórias** (`config.go`, `mustGetEnv`
   → `panic`). Hoje o gateway **não sobe** sem um Supabase para persistir. Para embarcar no kit
   self-host do CRM ele precisa de um **modo relay** (normaliza + encaminha, não persiste).

**O que muda no CRM:**

- rota nova `/api/v1/webhooks/gateway/[token]` com HMAC fail-closed (reusa o desenho existente)
- **um** ingest contra `MensagemNormalizada` — substitui, não soma
- `channel_sessions.provider` ganha os valores do gateway + linhas na matriz de capabilities
- `MediaSource` novo (a garantia anti-SSRF atual depende do WAHA estar na rede interna)
- control plane de sessão (QR/conectar/status) — **não vem de graça**: o gateway resolve
  recebimento e envio, não o ciclo de vida de instância na UI do CRM

### B. Gateway escreve direto no banco do CRM ❌ não recomendada

Quebra RLS e a cadeia viva: pula agent-engine, follow-up, audit, `event_log`. Para não pular,
teria que reimplementar regra de negócio TypeScript em Go — e manter as duas em paridade.
É o anti-pattern nº 3 do CLAUDE.md (evento sem consumer) invertido: consumer sem evento.

### C. CRM fala com a uazapi direto (sem gateway) — o cenário da análise anterior

Custa **24–37 dias-dev**, joga fora 1.323 LOC de normalizadores testados, e não traz Instagram
nem Messenger. Só faz sentido se o gateway não puder ser dependência do CRM.

---

## Mapeamento de vocabulário — o trabalho concreto da adaptação

| `MensagemNormalizada` | Destino no CRM | Observação |
|---|---|---|
| `EscritorioID` | `organization_id` | precisa do mapa conexão→org |
| `ConnectionID` | `channel_sessions.id` | |
| `Platform` (`whatsapp_oficial`/`whatsapp_uazapi`/`instagram`/`messenger`) | `channel_sessions.provider` | hoje só aceita `waha`/`meta_cloud` — CHECK a estender |
| `WaMsgID` | `messages.external_id` | idempotência já casa (`unique(org, external_id)`) |
| `ReplyToMsgID` | `messages.metadata` | CRM não tem coluna de citação |
| `ContatoExternoID` | `contacts.wa_identity` / `phone_number` | `@lid`/`@c.us` já tratados dos dois lados |
| `Direcao` (`recebida`/`enviada`) | `messages.direction` | tradução PT→EN |
| `Tipo` (10 valores + `postback`/`referral`/`optin`) | `messages.type` | CRM não conhece os 3 do Messenger |
| `Status` (`sent`/`delivered`/`read`/`failed`) | `messages.status` | casa |
| `EventKind` (`new_message`/`status_update`/`read_watermark`) | hoje são caminhos separados (`handleInbound`/`handleAck`) | `read_watermark` **não existe** no CRM |
| `IsGroup` + `RemetenteID`/`RemetenteNome` | — | **o CRM SKIPA grupos por doutrina** (`@g.us`); o gateway os trata |
| `JanelaExpiraEm` | capability `freeformOutsideWindow` | alinhado com a doutrina de canal |
| `ErroCodigo`/`ErroDetalhe` | `messages.error_code`/`error_message` | o gateway preserva o código do provedor (ex.: 131047) |
| `WasSentByApi` | distingue eco do envio × digitado no celular | o CRM resolve isso em `handleOutboundFromUserPhone` |
| `MidiaURL`/`MediaID`/`MidiaMime` | pipeline de mídia → Supabase Storage | redesenho do anti-SSRF |
| `MetadataExtra` | `messages.metadata` | mesma intenção |

### Três lições do gateway que o CRM deveria copiar de qualquer jeito

1. **Posse de campo de nome** (feature 006 deles): `inbox_contatos.nome` é do **atendente**;
   `nome_origem_whatsapp` é do **canal**, e nenhum caminho automático escreve o primeiro. O bug
   que isso consertou — mensagem recebida apagando a qualificação feita pelo humano — é
   estruturalmente possível no `upsertContact` do CRM (`lib/waha/ingest.ts:245`).
2. **`ConversaUpsert.WaContactID` pode voltar diferente do enviado** (canonicalização de
   telefone): quem grava a mensagem usa o valor **retornado**, senão o histórico se parte na
   primeira variante do número que chegar. O CRM tem o mesmo risco com `phone` × `lid`.
3. **ACK primeiro** (já detalhado acima).

---

## Complexidade e ordem de grandeza

| Frente | Onde | Estimativa |
|---|---|---|
| Modo de forward normalizado + HMAC + retry/ledger | gateway_go (Go) | 4–7 d |
| Modo relay (subir sem persistir) | gateway_go | 2–3 d |
| Rota + ingest único contra `MensagemNormalizada` | CRM | 5–8 d |
| Provider novo: schema, capabilities, matriz, testes | CRM | 3–4 d |
| Mídia (novo MediaSource + anti-SSRF redesenhado) | CRM | 2–3 d |
| Control plane de sessão + UI (QR, status, reconectar) | CRM | 4–6 d |
| ACK-first na rota de webhook (dívida a pagar junto) | CRM | 1–2 d |
| Kit self-host: gateway como serviço no compose | ambos | 2–3 d |
| QA visual VPS fresca + invariantes + `test:db` | CRM | 3–5 d |
| **Total** | | **≈ 26–41 dias-dev** |

À primeira vista é *mais* que os 24–37 do caminho direto — mas não é comparável, porque
entrega **quatro canais** (uazapi, Cloud API oficial, Instagram, Messenger) em vez de um, e
deixa o CRM com **um** ingest em vez de N. Isolando só o WhatsApp, o caminho pelo gateway é
mais barato **e** mais barato de manter: o próximo canal custa ~0 no CRM.

**Complexidade: MÉDIA-ALTA** — contra ALTA do caminho direto. O que baixou foi o item mais caro
da análise anterior (o ingest), justamente porque o gateway já resolveu.

---

## As duas decisões que travam tudo

1. **O gateway pode virar dependência de runtime do CRM self-host?** Ele é código seu, tem
   Dockerfile e imagem de 24,5 MB — embarcar no `docker-compose.prod.yml` é factível e **não**
   é "SaaS externo pago" (era o que a análise anterior temia). Mas hoje ele **não sobe sem
   Supabase para persistir**, e o CRM não quer que ele persista. O modo relay é pré-requisito.
2. **Um gateway compartilhado ou um por instalação?** Compartilhado = o CRM self-hosted do
   cliente manda webhook para a sua infraestrutura (some a independência, aparece LGPD de
   dado em trânsito por terceiro).

---

## Recomendação

Substitui a Fase 0 da análise anterior (medir a uazapi por fora): **o contrato já está medido
dentro do gateway.** O passo certo agora é um **spike de 2–3 dias** provando a ponta a ponta
mais fina:

> gateway em modo relay → forward normalizado assinado → uma rota nova no CRM → uma mensagem
> real do WhatsApp aparecendo no inbox do CRM, com `external_id` idempotente.

Se essa costura funcionar, o resto é volume conhecido. Se não funcionar, o custo do
aprendizado foi 3 dias e não 3 semanas.
