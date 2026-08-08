# Contrato — provisionamento de conexão no gateway, v1

**Direção**: CRM → gateway. É a direção **oposta** à do
[`gateway-inbound-v1.md`](../../001-migracao-waha-uazapi/contracts/gateway-inbound-v1.md), que
descreve gateway → CRM.

**Status**: proposto. Nada disto existe hoje. Este documento é o que o CRM precisa que o
`gateway_go` exponha para que as frentes 2 e 3 da [spec 004](../spec.md) tenham ambiente.

**Escopo**: nascer, parear, observar e encerrar uma conexão de canal. **Não** cobre envio de
mensagem — esse contrato já existe e está implementado (`POST /v1/messages`); o que falta lá é o
chamador do lado do CRM.

---

## 0. O buraco que este contrato tapa

Hoje o gateway resolve toda conexão contra uma linha de `wa_connections`
(`internal/resolver/connection.go:145-172`) e **nenhuma rota cria essa linha** — 9 leituras, 3
atualizações de `status`, zero `Insert`. A linha nasce à mão, do lado do outro produto.

Duas peças já existem e este contrato as **embrulha em vez de reescrever**:

| Peça | Onde | O que já faz |
|---|---|---|
| Criar instância no provedor | `POST /v1/uazapi/admin/instances` (auth de admin) | fala `/instance/create` no upstream |
| Parear, observar, encerrar | `POST /connect\|status\|disconnect /uazapi` | devolve `qrcode`, `paircode`, `status`; atualiza `status` da conexão |
| Entregar envelope assinado ao CRM | `internal/entrega/` + `forwarding_webhooks` | HMAC-SHA512, fila durável, `envelope_v1` |

**O que falta é o registro**: uma conexão que o gateway possa resolver, e a configuração de para
onde entregar o que chegar nela.

---

## 1. Onde o registro mora — SUPERADO em 2026-08-08

> ⚠️ **Esta seção está desatualizada e é mantida para registro.** Ela assumia um gateway dono do
> próprio armazenamento. A decisão de 2026-08-08 — [`../decisao-escrita-direta.md`](../decisao-escrita-direta.md) —
> aponta o fork do gateway para o banco do CRM: **mensagem, conversa e contato** passam a ser
> gravados lá, por **função `security definer` versionada**, com papel Postgres próprio e sem grant
> de tabela. A **conexão** (`channel_sessions`) ficou de fora — quem a grava é o CRM, ver abaixo.
>
> **O que sobrevive desta seção**: `organization_id` continua sem vir do corpo (resolvido da conexão,
> §3c da decisão), e o gateway continua sem tocar tabela crua. **O que caiu**: a fronteira de rede e,
> com ela, o `webhook_events_log` como segunda rede de proteção.
>
> **As seções 2 a 12 abaixo são O caminho de provisionamento** — decidido pelo dono em 2026-08-08
> (T003 / research D6). A alternativa que chegou a ser desenhada, uma função
> `fn_gateway_provision_connection` no CRM, foi **descartada**.
>
> **Quem grava `channel_sessions` é o CRM**, pelo caminho que ele já usa: chama `POST /v1/connections`
> aqui, recebe o `connection_id`, grava sua própria linha. O gateway **nunca toca essa tabela** — e é
> por isso que a superfície de escrita dele ficou em duas funções (mensagem e ACK), não quatro.
>
> **A compensação tem um dono só, e é o CRM**: se a gravação da linha falhar depois da instância ter
> nascido, ele chama o `DELETE` da §7 para desfazer. É o que fecha FR-012 e FR-033 sem partir o
> tudo-ou-nada entre dois sistemas.

O texto original, para não se perder o motivo de ele ter sido escrito assim:

O contrato é indiferente ao armazenamento. Isso é deliberado: se o registro mora numa base própria
do gateway, num schema separado, ou em qualquer outro lugar, **nada nas seções 3 a 8 muda**.

O que o contrato **exige** é uma coisa só, e ela não é negociável:

> **O gateway não escreve nas tabelas do CRM.** Quem persiste mensagem, conversa e contato no CRM é
> o CRM, com `organization_id` resolvido de fonte confiável. Princípio VII, e anti-pattern nº 15 do
> `CLAUDE.md`.

Ter uma variante do gateway apontada para outro banco é compatível com isso **enquanto esse banco
for do gateway**. Deixa de ser no instante em que o alvo passa a ser as tabelas de aplicação do CRM
(`messages`, `conversations`, `contacts`, `channel_sessions`) — aí o gateway vira um segundo
escritor dessas tabelas, sem RLS, sem a resolução de tenant que a rota de entrada faz, e a spec 001
inteira (ACK-primeiro, idempotência por `external_id`, fila com dono) passa a ter dois donos.

**A divisão que o contrato assume:**

| Quem | Do que é dono |
|---|---|
| **CRM** | o **canal**: `channel_sessions`, `organization_id`, o segredo do webhook, o `gateway_connection_id` como ponteiro sem FK |
| **Gateway** | a **instância**: credencial do provedor, endereço do upstream, estado de pareamento, configuração de entrega |

Nenhuma chave estrangeira atravessa a fronteira. É o mesmo desenho que a spec 001 já usa:
`gateway_connection_id` é `text`, ponteiro sem integridade referencial, de propósito.

---

## 2. Autenticação

`Authorization: Bearer <GATEWAY_INTERNAL_TOKEN>` — mesmo esquema das rotas de envio
(`internal/middleware/token.go:10-33`). Nunca em query string.

**Duas correções que o contrato pede na implementação atual:**

1. **Comparação em tempo constante.** O middleware interno compara com `!=` de string
   (`token.go:25`), enquanto o de admin usa `subtle.ConstantTimeCompare` (`admin.go:44`). Provisionar
   conexão é operação de credencial; merece a mesma trava do admin.
2. **Escopo do token.** Um token único para tudo significa que quem pode enviar mensagem também pode
   apagar instância. Provisionamento e desprovisionamento **devem** exigir o token de admin, não o
   interno.

**Falhas**: `500` token não configurado · `401` sem cabeçalho · `403` token inválido.

---

## 3. `POST /v1/connections` — nascer

Cria a instância no provedor **e** o registro que o resolver vai usar. Um passo, não dois: dois
passos deixam instância órfã quando o segundo falha.

```jsonc
{
  "platform": "whatsapp_uazapi",       // obrigatório
  "label": "Comercial",                // opcional, só diagnóstico

  // Para onde ENTREGAR o que chegar nesta conexão. Sem isto a conexão nasce muda.
  // ⚠️ OBRIGATÓRIO na variante do COTADOR; ver a nota abaixo para a do CRM.
  "delivery": {
    "url": "https://crm.exemplo/api/v1/webhooks/gateway/<webhook_path_token>",
    "format": "envelope_v1",           // único valor aceito em v1
    "secret": "<≥16 bytes>"            // HMAC-SHA512; o gateway recusa menor ANTES da rede
  }
}
```

> **`delivery` na variante do CRM — o que a escrita direta mudou.** O gateway apontado para o banco
> do CRM **não entrega por webhook**: ele grava pela função. Nessa variante o bloco `delivery` é
> **opcional**, e o que o toma o lugar dele é o alvo de escrita, que é **configuração do processo**
> (research D1/D5), não campo de requisição — deixá-lo vir no corpo permitiria a um chamador
> redirecionar a escrita de uma conexão para outro banco.
>
> **A variante do Cotador continua exigindo `delivery`**, e é por isso que o campo não sai do
> contrato: as duas versões falam a mesma v1. O gateway MUST recusar `delivery` ausente quando a
> configuração do processo for "entregar por webhook", e MUST ignorá-lo com aviso quando for
> "escrever por função" — silêncio aqui faria o operador achar que configurou uma entrega que nunca
> vai acontecer.

**201**

```jsonc
{
  "connection_id": "…",                // vai para channel_sessions.gateway_connection_id
  "platform": "whatsapp_uazapi",
  "status": "created",                 // ainda não pareada
  "provider_instance_ref": "…"         // opcional; diagnóstico
}
```

**Regras**

- **`Idempotency-Key` obrigatório.** Repetir a mesma chave devolve a mesma conexão, não uma
  segunda. Sem isso, um timeout do lado do CRM vira duas instâncias no provedor e uma delas
  fica órfã para sempre — e instância órfã custa dinheiro e some do inventário.
- **Tudo-ou-nada, em dois níveis.** (1) Dentro do gateway: instância nascendo e registro falhando,
  ele desfaz a instância antes de responder erro. (2) **Entre CRM e gateway**: se o `201` volta e o
  CRM falha ao gravar sua `channel_sessions`, **o CRM** chama o `DELETE` da §7. A compensação tem um
  dono só — é o que T003 decidiu, e é o que impede a instância órfã que nenhum dos dois lados
  reconhece como sua. FR-012 e FR-033.
- O gateway **NÃO** recebe `organization_id`. O dono da conexão é quem apresentou a credencial. O
  corpo nunca decide tenant — mesma regra que a rota de entrada já aplica.
- O `secret` **nunca** volta em nenhuma resposta, nem em `GET`, nem em log, nem em erro.

**Erros**: `400 corpo_invalido` · `409 idempotencia_divergente` (mesma chave, corpo diferente) ·
`422 plataforma_nao_suportada` · `502 erro_do_provedor`.

---

## 4. `POST /v1/connections/{id}/pair` — parear

Devolve o material de pareamento. Substitui `POST /connect/uazapi`, que hoje resolve a conexão por
`connection_id` no corpo.

```jsonc
{ "phone": "5585…", "force": false }   // ambos opcionais; force = descartar credencial e refazer
```

**200**

```jsonc
{
  "status": "awaiting_scan",
  "qr_code": "data:image/png;base64,…",   // ou null
  "pair_code": "1234-5678",               // ou null
  "expires_at": "2026-08-08T10:15:00Z"    // quando o material perde validade
}
```

**`expires_at` é a razão desta seção não ser só um proxy.** Hoje a tela do CRM refaz a imagem do QR
a cada 15 s por cache-buster, no escuro. Com a validade declarada, ela pede outro **quando expira**
— e o corretor deixa de olhar um QR morto achando que o celular dele é que está ruim.

---

## 5. `GET /v1/connections/{id}` — observar

**200**

```jsonc
{
  "connection_id": "…",
  "platform": "whatsapp_uazapi",
  "status": "connected",
  "phone_number": "+5585…",     // null enquanto não pareado
  "last_seen_at": "…",
  "provider_status": "…"        // valor CRU do provedor, só diagnóstico
}
```

### 5.1 Vocabulário de estado — normalizado, e é o gateway quem normaliza

| Estado | Significa |
|---|---|
| `created` | registro existe, nunca pareado |
| `awaiting_scan` | material de pareamento válido, esperando o celular |
| `connecting` | pareado, subindo |
| `connected` | operando |
| `disconnected` | caiu ou foi encerrado; reversível por `pair` |
| `failed` | credencial revogada ou instância inválida; exige `force` |

**Por que o gateway normaliza e não o CRM**: o CRM fala com **um** gateway; o gateway fala com
**N** provedores. Traduzir aqui é uma tabela; traduzir lá é uma tabela por provedor, dentro do CRM,
que é exatamente o que a doutrina de restrição de canal existe para impedir.

**Estado desconhecido**: o CRM trata como `failed` e mostra estado legível — nunca tela vazia
(FR-032). Estado que o gateway não reconheça sobe como `provider_status` sem virar `status`.

---

## 6. `POST /v1/connections/{id}/disconnect` — encerrar sessão

Derruba a sessão, **mantém** o registro. Reversível por `pair`. **200** `{ "status": "disconnected" }`.

---

## 7. `DELETE /v1/connections/{id}` — desprovisionar

Encerra sessão, apaga a instância no provedor e o registro. **Irreversível.**

**204** sem corpo. **Idempotente**: apagar o que já não existe é `204`, não `404` — senão o CRM
trava com uma linha que ele não consegue limpar.

> Hoje `DELETE /v1/uazapi/instance` apaga a instância e **deixa a linha órfã** — comentado no
> próprio código do gateway (`uazapi_ops.go:243-246`). Este contrato fecha isso: o registro morre
> junto.

---

## 8. `PUT /v1/connections/{id}/delivery` — rodar o segredo

Substitui a configuração de entrega. Existe para o segredo poder ser trocado sem recriar a conexão
— e sem isso, rodar credencial exigiria parear o número de novo, o que significa pedir ao corretor
que escaneie um QR por causa de uma operação nossa.

Corpo igual ao `delivery` da seção 3. **200** `{ "ok": true }`.

---

## 9. Erros

Envelope idêntico ao das rotas de mensagem (`internal/handlers/errors.go:17-32`):

```jsonc
{ "erro": "…", "mensagem": "…", "operacao": "…", "plataforma": "…", "referencia": "…" }
```

Toda saída passa pela sanitização de credencial que já existe (`errors.go:224-319`).

| Status | Quando |
|---|---|
| `400` | corpo inválido, campo obrigatório ausente |
| `401` / `403` | credencial ausente / inválida |
| `404` | conexão inexistente (exceto `DELETE`) |
| `409` | conflito de idempotência |
| `422` | plataforma não suportada, operação impossível no estado atual |
| `502` | erro do provedor |

**O CRM trata `5xx` como reagendável e `4xx` como definitivo** — mesma política do contrato de
entrada, invertida de direção.

---

## 10. Versionamento e compatibilidade para frente

Herdado do `gateway-inbound-v1.md` §87-96, e por exigência do Princípio XIV — os dois lados
versionam separado, então cada um tem de tolerar o outro andar primeiro:

- Campo desconhecido na resposta é **ignorado**, nunca causa falha.
- `status` desconhecido cai em `failed` + `provider_status` preservado.
- Campo novo entra **opcional**; campo obrigatório novo é versão nova de rota.
- `platform` desconhecida é recusada com `422` — aqui **não** se tolera, porque provisionar um
  canal que ninguém sabe operar cria instância que nunca vai funcionar.

---

## 11. O que este contrato deliberadamente NÃO faz

- **Não expõe credencial do provedor ao CRM.** O CRM guarda o ponteiro, não o token.
- **Não recebe `organization_id`.** Dono vem da credencial.
- **Não persiste nada nas tabelas do CRM.** Ver §1.
- **Não controla vazão.** O gateway não tem throttle nenhum hoje, e o lugar certo dele é o CRM, que
  é quem conhece aquecimento, janela e histórico do número. Este contrato mantém assim.
- **Não cobre envio.** Já existe.

---

## 12. O que muda do lado do CRM

| Peça | Mudança |
|---|---|
| `channel_sessions.gateway_connection_id` | passa a ser **escrito** na criação. Hoje só semente de teste o preenche |
| criação de canal | fala com este contrato em vez de `waha.startSession` |
| `lib/channels/session-ref.ts` | união ganha o membro do gateway (hoje são dois: `waha`, `meta_cloud`) |
| tela de QR | consome `qr_code` + `expires_at` em vez de proxiar bytes de imagem do WAHA |
| rotas de onboarding | convergem com as da Central **e passam a exigir `admin`** — hoje não exigem papel nenhum (FR-034, FR-035) |
| exclusão de canal | chama `DELETE` aqui antes de arquivar a linha |
