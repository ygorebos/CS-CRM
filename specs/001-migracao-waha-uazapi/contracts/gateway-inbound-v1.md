# Contrato: entrega de envelope normalizado — gateway → CRM (v1)

**Estado**: proposto · **Data**: 2026-08-07 · **Decisões**: [research.md](../research.md) D1–D7

Este é o **único** contrato de entrada de tráfego de canal no CRM. Enquanto ele estiver de pé,
canal novo suportado pelo gateway não exige código de ingestão novo no CRM.

---

## 1. Endpoint

```
POST /api/v1/webhooks/gateway/{token}
```

- `{token}` = `channel_sessions.webhook_path_token` (já existente, único, url-safe).
- Identifica **conexão e organização**. O corpo nunca decide organização.
- `Content-Type: application/json; charset=utf-8`
- Um evento por requisição.

## 2. Cabeçalhos obrigatórios

| Cabeçalho | Conteúdo |
|---|---|
| `X-Gateway-Timestamp` | epoch em **segundos**, momento da emissão |
| `X-Gateway-Signature` | HMAC-SHA512 em hex de `"{timestamp}.{corpo_cru}"` |
| `X-Gateway-Delivery-Id` | UUID v4 da **tentativa de entrega** (para correlação de log; não é chave de idempotência) |

Segredo: o mesmo `channel_sessions.webhook_secret_encrypted` da conexão, decifrado por
`fn_decrypt_oauth`. Comparação com `crypto.timingSafeEqual`. Janela de validade **±300s**.

> **Fail-closed sem válvula.** A rota do WAHA tem `WAHA_WEBHOOK_REQUIRE_SIGNATURE` desligada por
> padrão porque o WAHA Core não assina. Aqui o emissor é o nosso gateway e assina sempre — esta
> rota **não** herda a válvula. Segredo ausente ou curto demais ⇒ recusa tudo.

## 3. Corpo — envelope v1

```jsonc
{
  "envelope_version": 1,
  "event_id": "9f1c…",                    // UUID v4 do acontecimento (estável entre reentregas)
  "event_kind": "new_message",            // new_message | status_update | read_watermark
  "occurred_at": "2026-08-07T21:14:03Z",  // ISO-8601 UTC

  "platform": "whatsapp_uazapi",          // whatsapp_uazapi | whatsapp_cloud | instagram | messenger
  "gateway_connection_id": "conn_7f…",

  "message": {
    "external_id": "3EB0…",               // chave de idempotência no CRM
    "direction": "inbound",               // inbound | outbound
    "type": "text",                       // text|image|video|audio|document|sticker|location|contact|reaction|system|<novo>
    "body": "Boa tarde, queria um plano",
    "reply_to_external_id": null,
    "is_group": false,
    "sent_by_api": false                  // true = eco de envio nosso; false = digitado no aparelho
  },

  "participant": {
    "external_id": "5511999999999",       // telefone canônico OU identificador interno do canal
    "display_name": "Maria",              // nome vindo do CANAL — nunca sobrescreve nome humano
    "group_sender_id": null
  },

  "delivery": {
    "status": "received",                 // received|sent|delivered|read|failed
    "error_code": null,                   // código do provedor, preservado (ex.: "131047")
    "error_detail": null,
    "window_expires_at": null             // fim da janela livre de resposta, quando o canal tem uma
  },

  "media": null,                          // ou o objeto abaixo
  "metadata": {}                          // objeto livre, preservado inteiro em messages.metadata
}
```

`media`, quando presente:

```jsonc
{
  "ref": "media/abc123",       // caminho RELATIVO — o host é ignorado se vier (ver §6)
  "mime": "image/jpeg",
  "size_bytes": 184320,
  "filename": "documento.jpg"
}
```

### Regras de compatibilidade

- **Campo desconhecido não derruba a ingestão.** O CRM valida o que conhece e preserva o resto em
  `metadata`. É o que permite o gateway evoluir sem release acoplado do CRM.
- **`envelope_version` maior que o suportado** ⇒ o CRM aceita (`202`), registra, e processa o
  subconjunto que entende. Recusar quebraria a instalação do corretor no dia de um deploy do
  gateway.
- **`type` desconhecido** ⇒ mensagem entra como `system` com o valor original em
  `metadata.original_type` (FR-021). Nunca descartada.
- **`event_kind` desconhecido** ⇒ registrado e ignorado, com o motivo gravado. Não é erro.

## 4. Respostas

| Situação | Código | Corpo |
|---|---|---|
| Aceito (novo) | `202` | `{ "data": { "accepted": true, "duplicate": false } }` |
| Aceito (já conhecido) | `202` | `{ "data": { "accepted": true, "duplicate": true } }` |
| Corpo inválido | `400` | `{ "error": { "code": "invalid_request", … } }` |
| Assinatura ausente/inválida/fora da janela | `401` | `{ "error": { "code": "unauthenticated", … } }` |
| Token desconhecido ou conexão arquivada | `404` | `{ "error": { "code": "not_found", … } }` |
| Excesso de requisições | `429` | `Retry-After` + `X-RateLimit-*` |
| Falha interna | `500` | `{ "error": { "code": "internal_error", … } }` |

Toda resposta carrega `X-Request-Id`. Envelope de sucesso/erro pelos helpers `ok()`/`fail()`.

**Reentrega responde `202` com `duplicate: true`, nunca erro** — é o que faz o gateway parar de
retentar algo já processado (D6).

**O `202` significa "aceito e durável", não "processado".** A rota grava em `webhook_events_log` e
responde; a ingestão roda fora do ciclo (D4). É o que cumpre ACK-primeiro.

## 5. Retentativa e descarte (lado do gateway)

- Retenta quando: erro de rede, tempo esgotado, `5xx`, `429`.
- **Não** retenta quando: `400`, `401`, `404` — são defeitos de configuração, e retentar só
  multiplica o ruído. Vão direto para o descarte inspecionável, com aviso.
- Espera crescente entre tentativas, com teto; a pendência é gravada em disco **antes** da
  primeira tentativa e sobrevive a reinício (D5).
- `429` respeita `Retry-After`.

## 6. Mídia

O CRM **descarta qualquer host** que venha em `media.ref` e reconstrói a URL sobre a base
configurada localmente (`GATEWAY_BASE_URL`), autenticando com a credencial própria. É a mesma
construção anti-SSRF de `lib/messaging/media/waha-source.ts` — a garantia vem da **construção**,
não da confiança no payload.

Download recusado ou falho ⇒ a mensagem entra assim mesmo, marcada como anexo indisponível
(FR-025). A conversa nunca some por causa de um arquivo.

## 7. O que este contrato **não** cobre

- **Envio.** Continua pelo caminho atual do CRM nesta feature.
- **Ciclo de vida da conexão** (QR, conectar, status, reconectar). Feature separada; até ela
  existir, os provedores novos não aparecem na tela.
- **Webhooks que não são de canal** (e-commerce, retornos de LGPD em endereços fixos). Seguem
  diretos, como hoje.
