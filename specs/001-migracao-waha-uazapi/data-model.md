# Phase 1 — Data Model: recebimento unificado pelo gateway

**Data**: 2026-08-07 · **Spec**: [spec.md](./spec.md) · **Pesquisa**: [research.md](./research.md)

Regra que orienta tudo abaixo: **DIRC antes de campo novo** (Duplicar, Integrar, Referenciar,
Calcular). O resultado é que esta feature acrescenta **duas colunas e dois valores de vocabulário**
— o resto já existe.

---

## 1. O que já existe e será reusado (medido)

| Peça | Onde | Por que serve sem mudança |
|---|---|---|
| `channel_sessions.webhook_path_token` | `baseline.sql:1318` | único, url-safe, já resolve conexão → organização. É o mapeamento que a análise dizia faltar. |
| `channel_sessions.webhook_secret_encrypted` | `baseline.sql:1319` | segredo por conexão, cifrado, decifrado por `fn_decrypt_oauth`. Vira o segredo de assinatura do gateway. |
| `webhook_events_log` | `baseline.sql:1887` | **já é uma fila**: `status ∈ (received, processed, error, dead)`, `attempts`, `error_message`, `processed_at`, `archived_at`. Sustenta o ACK-primeiro sem tabela nova. |
| `messages.external_id` + unicidade por organização | `baseline.sql:1661` | idempotência ponta a ponta (D6). |
| `messages.status` | `baseline.sql:1684` | `queued/received/sending/sent/delivered/read/failed` já cobre os estados que o envelope traz. |
| `messages.type` | `baseline.sql:1685` | 10 tipos; os do Messenger (`postback`/`referral`/`optin`) **não** estão — ver §3. |
| `messages.error_code` / `error_message` | `baseline.sql:1666-1667` | o gateway preserva o código do provedor; há onde guardar. |
| `messages.sent_via = 'external_device'` | `baseline.sql:1683` | mensagem digitada no celular já tem valor próprio (US6). |
| `fn_upsert_wa_contact` | `baseline.sql:4192` | **já protege o nome humano**: `do update set display_name = coalesce(contacts.display_name, excluded.display_name)` — o nome vindo do canal só preenche vazio, nunca sobrescreve. FR-019 já é verdade neste caminho; falta o **teste** que o vigia (Princípio XI). |
| `fn_upsert_wa_conversation` | `baseline.sql:4211` | upsert atômico de conversa. |
| `media-persist-worker` | `workers/media-persist-worker.ts` | já leva mídia para o armazenamento e devolve caminho assinado. |

**Consequência de projeto**: o ingest novo **chama as mesmas RPCs**. Não escreve `insert` próprio
em `contacts`/`conversations`. Isso é o que impede a segunda cópia da regra de posse de nome —
o anti-pattern "duplicação sem source of truth".

---

## 2. O que muda no schema (a tripla obrigatória)

Migration `20260807_______0116_gateway_inbound.sql` + apêndice idempotente no `baseline.sql` +
linha no `MANIFEST.md`. Próximo número da sequência medido: **0116**.

### 2.1 `channel_sessions.provider` — estender vocabulário

Hoje (`baseline.sql:8425`): `check (provider = any (array['waha','meta_cloud']))`.

Passa a aceitar também os canais que o gateway normaliza. Um valor por plataforma, espelhando
`MensagemNormalizada.Platform`, para que o canal de origem seja legível no CRM sem tradução:

`whatsapp_uazapi`, `whatsapp_cloud`, `instagram`, `messenger`.

- Idempotente: `drop constraint if exists` + `add constraint` no apêndice.
- Nenhum backfill: linhas existentes continuam `waha`/`meta_cloud`.
- O invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` cobre colunas com `CHECK`
  — esquecer o lado TypeScript reprova no portão. É o comportamento desejado.

### 2.2 `webhook_events_log.provider` — estender vocabulário

Hoje (`baseline.sql:1907`): `waha`, `nuvemshop`, `generic`. Acrescenta `gateway`.

Sem isso, a rota nova não consegue registrar nada — e o registro auditável é FR-017.

### 2.3 `channel_sessions.ingest_path` — coluna nova (chave de corte)

```
ingest_path text not null default 'legacy'
  check (ingest_path in ('legacy','gateway'))
```

**Justificativa DIRC**: não dá para *calcular* (é escolha operacional), não vem de outra tabela,
e não é ponteiro. É estado próprio da conexão. Uma coluna, com padrão que preserva o
comportamento atual de toda instalação existente.

É o que sustenta FR-029 (migrar uma conexão por vez) e FR-030 (desligar o legado só com
evidência).

### 2.4 `channel_sessions.gateway_connection_id` — coluna nova (referência)

```
gateway_connection_id text null
```

Identificador da conexão **do lado do gateway**. Nullable porque conexões legadas não têm.

**Justificativa DIRC**: é *Referenciar* — ponteiro para entidade de outro sistema, sem FK
(proibido cruzar fronteira de produto, Princípio VII). Serve para diagnóstico ("esta conversa veio
de qual conexão do gateway?") e para o gateway saber para qual token entregar.

### 2.5 Índice para o dreno

Índice parcial em `webhook_events_log (status, received_at)` restrito a `status = 'received'`, para
o dreno periódico não varrer a tabela inteira — ela passa a crescer com **todo** o tráfego de
entrada.

---

## 3. O que NÃO muda (e por quê)

| Tentação | Decisão | Razão |
|---|---|---|
| Coluna nova para citação/resposta (`ReplyToMsgID`) | vai em `messages.metadata` | um campo de uso ainda não provado não justifica coluna; promove-se quando virar caminho quente (doutrina de `tags`/`jsonb`). |
| Tipos `postback`/`referral`/`optin` no `CHECK` de `messages.type` | **não entram agora** | são do Messenger, que só chega na US4. Entram na fatia que traz o canal, com a tripla. Até lá, FR-021 manda **preservar e sinalizar**, não descartar: vão como `type='system'` com o tipo original em `metadata`. |
| Tabela nova de entregas no CRM | não | a entrega é estado **do gateway** (D5). No CRM, `webhook_events_log` já registra o que chegou. Duas tabelas de entrega seriam duas verdades. |
| Tabela de mapeamento conexão→organização | não | `webhook_path_token` já é esse mapa (D3). |
| `read_watermark` como entidade | não nesta feature | o CRM não tem o conceito; o envelope pode trazê-lo e o ingest o ignora explicitamente, registrando que ignorou. Adicionar semântica de leitura em massa é feature de produto, não de tubulação. |
| Coluna nova para nome vindo do canal | não | `contacts.source_metadata->>'notify_name'` já guarda, e `display_name` já tem a regra de posse. |

---

## 4. Entidades novas fora do banco do CRM

### 4.1 Envelope normalizado (contrato de entrada)

Não é tabela — é o formato da requisição. Definição completa em
[`contracts/gateway-inbound-v1.md`](./contracts/gateway-inbound-v1.md). Aqui só a forma:

- **identidade**: `envelope_version`, `event_id`, `occurred_at`
- **origem**: `platform`, `gateway_connection_id`
- **classificação**: `event_kind` ∈ `new_message | status_update | read_watermark`
- **mensagem**: `external_id`, `direction`, `type`, `body`, `reply_to_external_id`, `is_group`,
  `sent_by_api`
- **participante**: `contact_external_id`, `contact_display_name`, `group_sender_id`
- **estado**: `status`, `error_code`, `error_detail`, `window_expires_at`
- **mídia**: `media_ref`, `media_mime`, `media_size_bytes`, `media_filename`
- **extensão**: `metadata` (objeto livre, preservado inteiro)

### 4.2 Entrega pendente (estado interno do gateway)

Registro durável, por entrega: envelope serializado, destino, tentativas, próxima tentativa,
estado (`pendente | entregue | descartada`), último erro. Vive em disco no gateway (D5). O CRM
**não** conhece esta entidade — se conhecesse, seria a fronteira cruzada.

---

## 5. Invariantes que passam a existir (Princípio XI)

Cada um vira teste em `tests/invariants/`, ou não é invariante:

1. **Nenhuma linha de uma organização é alcançável por outra** pelo caminho novo — duas
   organizações recebendo tráfego simultâneo, com caso de controle provando que as linhas da
   segunda existem.
2. **Entrega sem assinatura, com assinatura inválida, ou com timestamp fora da janela não grava
   nada** — nem mensagem, nem contato, nem conversa.
3. **A mesma entrega duas vezes produz uma mensagem** e a segunda responde sucesso.
4. **O nome definido por humano nunca é sobrescrito** pelo nome vindo do canal — vigia a regra que
   hoje só existe no `coalesce` de `fn_upsert_wa_contact` e em nenhum teste.
5. **Todo valor de `provider` aceito pelo banco tem correspondente no TypeScript** — já coberto
   pelo invariante de vocabulário, desde que a coluna mantenha o `CHECK`.
6. **Nenhuma função nova em `public` nasce executável por `anon`/`public`** — se a migration criar
   função, a varredura de hardening cobre.
