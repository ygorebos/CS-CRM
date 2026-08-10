# Contrato — `/api/v1` de mensagens (feature 006)

**Versão**: v1, aditiva. Nada abaixo remove ou renomeia campo existente: cliente que não
conhece os campos novos continua funcionando, e cliente novo contra servidor velho recebe o
que sempre recebeu.

Envelope de sucesso e de erro seguem `lib/api/wrappers.ts` (`ok()` / `fail()`), como toda
rota v1. `X-Request-Id` em toda resposta. Códigos de erro de `lib/api/errors.ts`.

---

## 1. `GET /api/v1/conversations/{id}/messages` — leitura

**Muda**: cada item de `data` ganha o objeto `projection`. Os campos existentes ficam
intactos.

```jsonc
{
  "data": [
    {
      // … todos os campos de hoje: id, type, direction, body, media_*, status, sent_at, metadata …
      "projection": {
        "quote": {
          "message_id": "uuid | null",
          "author_kind": "inbound | outbound",
          "type": "text",
          "preview": "Qual o valor da coparticipação?",
          "is_deleted": false,
          "is_unavailable": false
        },
        "reactions": [
          { "emoji": "👍", "actor_kind": "inbound", "reacted_at": "2026-08-09T14:02:11Z" }
        ],
        "deletion": {
          "deleted_at": "2026-08-09T14:05:00Z",
          "deleted_by_kind": "inbound"
        },
        "unsupported": { "label": "Mensagem de um tipo que ainda não sabemos exibir" }
      }
    }
  ],
  "meta": { "cursor": "…", "has_more": true }
}
```

**Regras**:

- `projection` está **sempre presente**; cada chave interna é `null` quando não se aplica.
  Ausência opcional obrigaria toda leitura da tela a testar duas coisas.
- `quote.is_unavailable = true` quando a mensagem citada não existe no CRM. A citação
  continua aparecendo, dizendo que o original não está aqui.
- `deletion` **não** altera `body`. O conteúdo continua na resposta (FR-005). Quem esconde
  ou marca é a tela, e a marca é obrigatória.
- Linhas de **reação** e de **apagamento** NÃO aparecem em `data`. Elas viram `projection` da
  mensagem-alvo. Isso muda a **contagem** de itens por página — quem pagina usa `meta.cursor`,
  nunca o tamanho do array (já é a regra hoje).
- `reactions` é **estado**: no máximo uma entrada por `actor_kind`, a mais recente. Reação
  removida não aparece.
- Alvo anonimizado por LGPD devolve `preview` anonimizado. Nunca o original.
- A resolução do alvo filtra `organization_id` da sessão. `external_id` é único **por
  organização** — sem o filtro, dois tenants com o mesmo id colidem.

---

## 2. `POST /api/v1/messages` — envio

**Muda**: `type` ganha valores; o corpo ganha campos por tipo; `reply_to_message_id` vale
para qualquer tipo.

### 2.1 Citação (User Story 2)

```jsonc
{ "conversation_id": "uuid", "type": "text", "body": "Sim, cobre sim",
  "reply_to_message_id": "uuid" }
```

- É **UUID de mensagem do CRM**, nunca o identificador do canal vindo do corpo. O servidor
  resolve o identificador externo a partir da linha, conferindo que ela pertence à **mesma
  conversa** e à **mesma organização**. Aceitar o id do canal pelo corpo seria deixar o
  cliente apontar para mensagem de outro tenant.
- Alvo sem identificador externo (mensagem ainda em envio) → `422`
  `reply_target_not_addressable`. A mensagem **não** sai sem a citação (FR-012).
- Alvo em outra conversa ou fora da organização → `404 not_found`. Não `403`: não se confirma
  a existência de linha alheia.

### 2.2 Localização (User Story 3)

```jsonc
{ "conversation_id": "uuid", "type": "location",
  "location": { "lat": -23.5613, "lng": -46.6565, "name": "Clínica X", "address": "Av. Paulista, 1000" } }
```

### 2.3 Contato (User Story 3)

```jsonc
{ "conversation_id": "uuid", "type": "contact",
  "contacts": [ { "name": "Dra. Ana", "phones": ["+5511999998888"] } ] }
```

### 2.4 Figurinha (User Story 3)

```jsonc
{ "conversation_id": "uuid", "type": "sticker", "media_storage_path": "org/conv/arquivo.webp" }
```

- A escolha de mandar como figurinha é **do usuário**, não deduzida do MIME. Hoje um `.webp`
  vira `image` por inferência (`validateOutboundMedia`), e é por isso que figurinha não existe.

### 2.5 Menu, botão de link, pedido de localização (User Story 4)

```jsonc
{ "type": "menu", "body": "Qual plano te interessa?",
  "menu": { "options": ["Individual", "Familiar", "Empresarial"], "footer": "Responda tocando" } }

{ "type": "cta_url", "body": "Simule agora",
  "cta_url": { "button_label": "Abrir simulador", "button_url": "https://…" } }

{ "type": "location_request", "body": "Me manda sua localização pra achar a clínica mais perto" }
```

### 2.6 Regras que valem para todos

- **Zod valida tudo** (Princípio VI). Carga ausente para o tipo → `422 validation_failed`
  nomeando o campo. Nunca se monta um pedido incompleto para o canal descobrir depois.
- **Tipo aceito é tipo enviável** (FR-017). Enum de envio e carga obrigatória andam juntos; o
  invariante reprova o par que se separar.
- **Capacidade antes de tudo** (FR-018): tipo que o canal da conversa não suporta →
  `422 channel_capability_unsupported`, com o motivo. A tela já não deveria ter oferecido; a
  API não confia na tela.
- **Cadeia `before_send` inalterada** (FR-020): bloqueio, anonimização, janela, ritmo
  anti-banimento e permissão continuam decidindo antes do adapter. Nenhum envio novo passa
  por fora — é o que `nenhum-envio-escapa-das-travas.test.ts` já vigia.
- **Audit log** em toda mutação bem-sucedida (FR-021), com o tipo na entrada.
- **`Idempotency-Key`** continua aceito, como em todo POST de criação.
- **Resposta é aceite provisório**: `status: "sending"`/`"queued"` e o estado definitivo vem
  pelo ACK. Não se grava `delivered` na resposta síncrona — regra já vigiada por
  `messages-handler-desfechos.test.ts`.

---

## 3. Contrato com a porta de tráfego (`POST /v1/messages` do gateway)

**Não muda.** O gateway já aceita tudo que esta feature envia — medido em
`internal/handlers/messages.go:33-76` (`quoted_id`, `latitude`, `longitude`, `nome`,
`endereco`, `contatos`, `opcoes`, `texto_rodape`, `rotulo_botao`, `url_botao`) e
`:86-107` (os 17 tipos). O que muda é **o CRM passar a preencher** campos que já existem.

Mapeamento (o adapter é o único que conhece estes nomes):

| CRM | gateway |
|---|---|
| `reply_to_message_id` → identificador externo do alvo | `quoted_id` |
| `location.lat` / `.lng` / `.name` / `.address` | `latitude` / `longitude` / `nome` / `endereco` |
| `contacts[]` | `contatos[]` |
| `menu.options` / `.footer` | `opcoes` / `texto_rodape` |
| `cta_url.button_label` / `.button_url` | `rotulo_botao` / `url_botao` |
| `body` (legenda ou texto) | `texto` |

**Fora deste contrato**: reagir e apagar. A porta de tráfego não expõe a operação para
conversa comum (`tiposParaOperacao` não tem `reaction`; apagar existe só como passagem do
canal não-oficial). Enviar os dois está fora do escopo desta spec (FR-022).

---

## 4. Capacidades de canal (contrato interno)

`ChannelCapabilities` ganha campos booleanos — um por ação que a tela pode oferecer:
citar, figurinha, localização, contato, menu, botão de link, pedido de localização. Mais o
teto de opções do menu, que é número e não booleano.

**Regra que não se negocia**: quem consome pergunta **capacidade**, nunca provider. Nome de
provedor fora de `lib/channels/` é reprovado por `scripts/lint-channels.ts`. Capability sem
consumidor é código morto e o teste de matriz reprova — cada uma nasce com quem a usa.
