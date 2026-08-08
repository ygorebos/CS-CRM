# Data Model — Fase 1

**Spec**: [spec.md](./spec.md) · **Plano**: [plan.md](./plan.md) · **Research**:
[research.md](./research.md)

> **Esta feature não cria tabela nenhuma.** Cria **um papel** e **duas funções** (mais o grant de
> três que já existem), e dá significado
> de escrita a duas colunas que já nasceram na spec 001. Se você veio procurar DDL de tabela, não há
> — e isso é resultado da doutrina DIRC, não descuido: tudo que a feature precisa **já existe**
> (`I`ntegrar), e o que falta é caminho de escrita, não campo.

---

## 1. Papel — `gateway_writer`

| Propriedade | Valor | Por quê |
|---|---|---|
| Login | `nologin` | Não é conta; é papel assumido por troca via PostgREST (research D1) |
| Grants de tabela | **nenhum** | FR-002. Escrever tabela crua tem de falhar em desenvolvimento |
| Grants de função | `EXECUTE` só nas cinco da §2 (2 novas + 3 existentes) | A superfície inteira do fork |
| Membro de | `authenticator`, **se o papel existir** | Armadilha medida — research D1.1 |
| Vigiado por | `tests/invariants/` (T011) | Reprova se ganhar qualquer privilégio em `role_table_grants` |

**Regra que não pode ser afrouxada**: `gateway_writer` **nunca** recebe `service_role`, nunca recebe
`bypassrls`, e nunca recebe grant de tabela — nem de `select`. Um `select` direto em `messages`
parece inofensivo e já é acoplamento ao schema, que é exatamente o que a **trava 1 do Princípio VII**
(v2.3.0) existe para impedir — e ela é condição de existência da quarta superfície, não recomendação.

---

## 2. Funções — a superfície de escrita

### 2.1 Já existem, reaproveitadas sem mudança

Criadas para o caminho do WAHA, com o grant certo (`baseline.sql:4187-4234` e `:4565-4567`,
`:9180-9193`):

| Função | Papel |
|---|---|
| `fn_upsert_wa_contact(uuid, text, text, text, text, text)` | contato |
| `fn_upsert_wa_conversation(uuid, uuid, uuid)` | conversa |
| `fn_mark_conversation_message(uuid, text, text, timestamptz)` | marca última mensagem da conversa |

**Mudança necessária**: acrescentar `grant execute ... to gateway_writer` (hoje só `service_role`).
Nada mais — assinatura e corpo ficam.

### 2.2 Novas (migration 0128) — **duas**

#### `fn_gateway_ingest_message` — a peça central

```
entrada:  p_gateway_connection_id  text      -- FONTE DA VERDADE do tenant
          p_external_id            text      -- `wamid` no vocabulário do provedor
          p_direction              text      -- 'inbound' | 'outbound'
          p_eh_eco                 boolean   -- eco do próprio envio
          p_type, p_body, p_sent_at, ...     -- conteúdo
saída:    message_id  uuid
          duplicada   boolean
```

**Regras de validação, em ordem de execução** — a ordem importa:

1. **Resolve tenant** de `channel_sessions` por `gateway_connection_id`, com `archived_at is null`.
   Não encontrou → erro **definitivo** (§3). `organization_id` **nunca** vem de parâmetro.
2. **`set constraints public.messages_org_external_id_unique immediate`.** Sem esta linha o passo 4
   não funciona — research D2, medido. **Não é otimização; é pré-requisito.**
3. Upsert de contato e conversa pelas funções da §2.1.
4. `insert into messages`, com `exception when unique_violation` devolvendo o id existente e
   `duplicada = true`. Duplicata é **sucesso**, não erro (FR-006).
5. **Só se `direction = 'inbound'` e `not p_eh_eco`**: emite `ai_agent.dispatch_requested` via
   `fn_log_event`, **na mesma transação** (FR-008). Eco não pede turno — pedir faria o agente
   responder a si mesmo (FR-009).
6. `fn_mark_conversation_message`.

**Invariante da função**: ou tudo dos passos 3-6 acontece, ou nada. Não existe estado intermediário
observável — é isso que a decisão compra em troca da fronteira de rede.

#### `fn_gateway_update_message_status` — o ACK

```
entrada:  p_gateway_connection_id  text
          p_external_id            text
          p_status                 text
          p_at                     timestamptz
saída:    efeito  text   -- 'aplicado' | 'ignorado'
          motivo  text   -- 'estado_nao_regride' | 'mensagem_desconhecida' | null
```

**Máquina de estado — portada de `lib/gateway/ingest.ts:279-322`, sem mudar a regra**:

| Estado | Ordem |
|---|---|
| `queued` | 0 |
| `sending` | 1 |
| `sent` / `received` | 2 |
| `delivered` | 3 |
| `read` | 4 |
| `failed` | 5 |

Transição só é aplicada se **avança**. Duas exceções, e as duas têm motivo:

- **`failed` sempre entra**, mesmo depois de `read` — é informação nova (mensagem que falhou numa
  segunda tentativa).
- **Mensagem desconhecida é ignorada com sucesso**, nunca criada. Entrega fora de ordem acontece, e
  criar mensagem fantasma seria pior: apareceria na conversa sem corpo e sem autor.

> Esta guarda **não existe** no caminho do WAHA (`lib/waha/ingest.ts:657-677`). Migrar herda um ACK
> melhor que o atual, de graça.

#### ~~`fn_gateway_provision_connection`~~ — **não existe** (T003 decidiu a rota HTTP)

Ela chegou a ser desenhada e **morreu na decisão de 2026-08-08** (research D6): o provisionamento é
a rota HTTP do gateway, e quem grava `channel_sessions` volta a ser o **CRM**, pelo caminho que ele
já usa — service role com `organization_id` filtrado de fonte confiável.

**Efeito colateral bom**: a superfície de escrita do gateway fica em **duas** funções em vez de
quatro, e `channel_sessions` **nunca** é tocada por ele. Registrado aqui, riscado e não apagado, para
a próxima sessão não recriar a função achando que faltou.

---

## 3. Taxonomia de erro (FR-005)

Duas classes, e o contrato não admite uma terceira:

| Classe | Casos | O gateway faz |
|---|---|---|
| **definitivo** | conexão desconhecida, arquivada, de outro dono; corpo inválido; plataforma não suportada | descarta e registra — **não** retenta |
| **transitório** | banco indisponível, tempo esgotado, conflito de serialização | retenta com recuo |

**Erro sem classe declarada é tratado como transitório.** Errar para o lado de retentar perde menos
que errar para o lado de descartar — e a assimetria é deliberada: mensagem descartada por engano é
invisível, mensagem retentada por engano é barulhenta.

---

## 4. Colunas que mudam de significado (não de forma)

Nasceram na spec 001, migration 0119. Nenhum `ALTER` aqui.

| Coluna | Antes | Depois |
|---|---|---|
| `channel_sessions.gateway_connection_id` | `text`, preenchido só por semente de teste | **fonte da verdade do tenant** para toda escrita do gateway. Continua `text`, ponteiro **sem FK** — nenhuma chave atravessa fronteira de produto |
| `channel_sessions.ingest_path` | chave de corte do recebimento | passa a valer também para **envio** (FR-015) e conexão |
| `messages.external_id` | id do WAHA | id devolvido pelo gateway, e MUST casar com o do ACK (FR-019) |

**Por que `gateway_connection_id` continua sem FK**: é ponteiro para entidade que vive no outro
produto. FK cruzando fronteira é proibida (Princípio VII) e seria mentira — o registro do outro lado
pode sumir sem o Postgres do CRM saber.

---

## 5. Vocabulário — Cotador ↔ CRM

A tradução que o `internal/store/crm.go` implementa (research D5):

| Cotador | CRM |
|---|---|
| `escritorio_id` | `organization_id` |
| `wa_connections` | `channel_sessions` |
| `inbox_contatos` | `contacts` |
| `inbox_conversas` | `conversations` |
| `inbox_mensagens` | `messages` |
| `wa_webhook_logs` | `webhook_events_log` |
| `wamid` | `external_id` |
| `wa_template_envios` | **não existe** — ver §6 |

### Estados de conexão — normalizados pelo gateway, não pelo CRM

`created` · `awaiting_scan` · `connecting` · `connected` · `disconnected` · `failed`

Estado desconhecido cai em `failed` com o valor cru preservado à parte, e a tela mostra algo legível
— **nunca tela vazia** (FR-032). O gateway normaliza porque fala com N provedores e o CRM fala com
um gateway: traduzir aqui é uma tabela, traduzir lá é uma tabela por provedor dentro do CRM.

---

## 6. Lacuna declarada — `wa_template_envios`

O Cotador registra envio de template WhatsApp Cloud (`internal/supabase/types.go:169-179`:
`escritorio_id`, `connection_id`, `wa_contact_id`, `template_name`, `language_code`, `components`,
`wamid`, `status`, `error_msg`). **O CRM não tem equivalente.**

Como o pedido foi migrar *"todos os registros"*, isto é escolha pendente, não esquecimento:

- **(a)** nasce tabela no CRM — mas hoje o CRM não envia template, então seria tabela sem escritor;
- **(b)** o registro fica no gateway, que continua sendo dono dele;
- **(c)** vira linha em `messages` com `type='template'` — DIRC diria `D`uplicar? não; `I`ntegrar,
  sim.

**Recomendação: (b) por ora, (c) quando o CRM enviar template.** Criar tabela agora violaria a
doutrina DIRC — campo que ninguém escreve é campo que apodrece.

---

## 7. O que NÃO entra no modelo

- **Tabela nova** — nenhuma. Ver o aviso no topo.
- **Dado de cobrança** — Princípio XIII, mora no Cotador.
- **Credencial do provedor** — fica no gateway. O CRM guarda o ponteiro, nunca o token.
- **FK atravessando produto** — proibida.
- **`webhook_events_log` no caminho do gateway** — sai da direção de entrada, mas **a tabela
  permanece** e continua em uso pelos demais provedores. A dívida T071 da spec 001 (cron de retenção,
  LGPD) **não** é dispensada por esta feature.
