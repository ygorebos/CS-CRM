# Phase 1 — Modelo de dados

**Feature**: 006-tipos-de-mensagem-whatsapp · **Data**: 2026-08-09

Regra que governa este documento: **nada aqui inventa lugar novo para dado que já tem lugar.**
A pesquisa (R1, R3) mostrou que citação, reação e apagamento já chegam e já são gravados. O
que falta é forma de leitura e carga de envio — não é armazenamento novo.

---

## 1. O que NÃO muda

- **`messages` continua sendo a única tabela de mensagem.** Sem tabela de reação, sem tabela
  de evento de mensagem.
- **`metadata.reply_to_external_id`** continua sendo o vínculo único de citação, reação e
  apagamento (`lib/gateway/ingest.ts:171`). Os três apontam pelo mesmo campo porque são a
  mesma coisa: um evento que aponta para uma mensagem.
- **A reação continua entrando como linha** de `type='reaction'`. Ela deixa de ser exibida
  como bolha; não deixa de existir.
- **`unique (organization_id, external_id)`** continua sendo o que torna a resolução do alvo
  barata e o ingest idempotente.

---

## 2. Mudanças de schema (as duas, e só as duas)

### M1 — Índice de expressão para a projeção *(User Story 1)*

**O quê**: índice sobre `(organization_id, (metadata->>'reply_to_external_id'))` em
`messages`, parcial — só linhas em que o campo não é nulo.

**Por quê**: a projeção pergunta "quem aponta para estes 50 `external_id`?" a cada página de
conversa. Sem índice é varredura de tabela por página, e o defeito só aparece na conversa
grande — nunca no teste pequeno.

**Natureza**: aditiva. Sem `contract`, sem caminho de volta a declarar (dropar índice é
reversível e não perde dado).

**Artefatos obrigatórios**: migration versionada + apêndice idempotente no `baseline.sql`
(`create index if not exists`) + linha no MANIFEST.

### M2 — Vocabulário de tipo: `menu`, `cta_url`, `location_request` *(User Story 4)*

**O quê**: `messages_type_check` passa a aceitar três valores a mais, no molde exato do
apêndice da migration 0091 (`baseline.sql:8544`): `drop constraint if exists` seguido de
`add constraint` com a lista inteira.

**Por quê**: são formas de mensagem distintas, e o tipo é a coluna que carrega o que o
contato de fato viu. Gravar um menu como `text` apagaria a diferença entre "mandei uma
pergunta" e "mandei três botões".

**Natureza**: aditiva — o conjunto antigo é subconjunto do novo, então **backfill é zero por
construção** e a re-aplicação em banco com dado antigo não quebra.

**Artefatos obrigatórios**: os mesmos três. Mais o par novo no invariante de vocabulário
(ver §5).

**Não entram no CHECK**: `revoke`, `interactive`, `edit` e o que vier de novo do canal.
Continuam virando `system` com `metadata.original_type` — é o mecanismo que já existe
(`lib/gateway/envelope.ts:236-243`) e é o que faz canal novo não exigir código novo.

---

## 3. Entidades de leitura (projeção — não são tabelas)

Estas formas existem na resposta da API e na tela. Nenhuma tem linha própria no banco.

### `MessageQuote` — o trecho citado

| Campo | Origem |
|---|---|
| `message_id` | a mensagem alvo, resolvida por `external_id` dentro da mesma organização |
| `author_kind` | `inbound`/`outbound` do alvo — é o que diz "você disse" vs "ele disse" |
| `type` | tipo do alvo, para a citação de mídia dizer o que é em vez de ficar vazia |
| `preview` | recorte do `body` do alvo, limitado |
| `is_deleted` | se o alvo carrega marca de apagado |
| `is_unavailable` | `true` quando o alvo não existe no CRM — a citação existe, o conteúdo não |

**Regra de LGPD**: o `preview` é derivado do alvo **no momento da leitura**. Alvo anonimizado
devolve o texto anonimizado, nunca o original. É a anonimização mandando acima da
preservação, como a spec exige.

### `MessageReaction` — a reação pendurada

| Campo | Origem |
|---|---|
| `emoji` | `body` da linha de reação (e `metadata.reaction_emoji` como confirmação) |
| `actor_kind` | direção da linha de reação: `inbound` = o contato, `outbound` = nós |
| `reacted_at` | `sent_at` da linha de reação |

**Estado, não histórico**: por `(mensagem alvo, actor_kind)` vale **a última** reação. Emoji
vazio significa reação removida e o par some — a spec diz "o estado final é o último, não a
soma".

### `MessageDeletion` — a marca de apagada

| Campo | Origem |
|---|---|
| `deleted_at` | `sent_at` do evento de apagamento |
| `deleted_by_kind` | direção do evento: quem apagou |

**FR-005**: a marca **não** apaga nem esconde o `body` do alvo. O conteúdo continua na
resposta e na tela, sob a marca. O que a marca acrescenta é a informação de que o cliente já
não vê aquilo no aparelho dele.

### `UnsupportedMessage` — o que ainda não sabemos exibir

Mensagem cujo `type` é `system` com `metadata.original_type` presente, ou tipo que esta
versão do front não representa. Vira rótulo legível. **Nunca bolha vazia** (FR-009).

---

## 4. Carga de envio por tipo (`metadata`, com schema central)

Um módulo define a carga de cada tipo; escrita e leitura o consomem. Ninguém lê
`metadata.location.lat` na mão (anti-pattern 6).

| Tipo | Carga | Validação |
|---|---|---|
| `text` | — | `body` 1..4096 |
| `image` `video` `audio` `document` | anexo já existente | allowlist + teto de 50 MB, como hoje |
| `sticker` | anexo | imagem estática; a escolha é do usuário, não inferida do MIME |
| `location` | `lat`, `lng`, `name?`, `address?` | lat −90..90, lng −180..180; ao menos um par válido |
| `contact` | lista de `{name, phones[]}` | ≥1 contato, ≥1 telefone por contato |
| `menu` | `options[]`, `footer?` | ≥1 opção, teto vindo da capability do canal |
| `cta_url` | `button_label`, `button_url` | URL absoluta `https`; rótulo não vazio |
| `location_request` | — | `body` obrigatório (o texto do pedido) |
| `template` | como hoje | inalterado |

**Citação** é campo da mensagem, não tipo: `reply_to_message_id` acompanha **qualquer** um
dos tipos acima.

---

## 5. Invariantes que passam a existir

| Invariante | O que reprova | Gate |
|---|---|---|
| Par `messages_type_check` ↔ constante TypeScript de união | tipo novo no banco sem o TypeScript (ou o contrário) | `test:db` |
| Envio derivado da união | enum de envio com valor que o banco recusa | `test:unit` |
| Nenhum tipo aceito e inenviável | tipo no enum de envio sem carga que o canal exige (FR-017) | `test:unit` |
| Projeção não vaza tenant | evento de outra organização projetado numa conversa | `test:db` |
| Reação fora da linha do tempo | linha `type='reaction'` aparecendo como bolha | `test:unit` |
| Anonimização manda acima da citação | `preview` devolvendo texto de alvo anonimizado | `test:db` |
| Tela oferece só o que o canal suporta | ação oferecida sem capability | `test:unit` |

---

## 6. Tenancy

Nenhuma tabela nova, portanto nenhuma policy nova. O que precisa de vigilância é a
**projeção**: ela busca linhas por `external_id`, que é único **por organização** — a consulta
filtra `organization_id` explicitamente, resolvido da sessão, nunca do corpo (Princípio I).
Sem esse filtro, um `external_id` colidindo entre dois tenants projetaria a reação de um
cliente na conversa de outro. É o caso que o invariante de projeção vigia.
