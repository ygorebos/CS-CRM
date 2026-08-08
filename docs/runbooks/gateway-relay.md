# Runbook — gateway multicanal em modo relay

**Para quem**: quem opera uma instalação do DeskcommCRM e precisa entender, ligar ou diagnosticar
o recebimento de mensagens pelo gateway.

**Spec**: [`specs/001-migracao-waha-uazapi/`](../../specs/001-migracao-waha-uazapi/spec.md) ·
**Contrato**: [`contracts/gateway-inbound-v1.md`](../../specs/001-migracao-waha-uazapi/contracts/gateway-inbound-v1.md)

---

## O que o gateway faz, em uma frase

Ele recebe as mensagens de todos os canais (WhatsApp oficial e não-oficial, Instagram Direct,
Messenger), traduz cada uma para **um formato único**, e entrega ao CRM. O CRM grava no banco dele.

**O que ele NÃO faz**: escrever no banco do CRM. Receber uma mensagem aqui não é um `INSERT` —
dispara o agente de IA, o follow-up, os guardrails de envio, a auditoria e a fila de eventos. Quem
faz isso é o CRM, pelo caminho dele. O gateway entrega o envelope e sai.

## O que é "modo relay"

O gateway nasceu dentro de outro produto, onde ele **persistia** o que recebia num banco próprio.
Aqui isso não serve: ninguém leria aquele banco, e ele seria mais uma peça para o operador manter.

Modo relay é o gateway **normalizando e entregando, sem persistir**. É o que permite embarcá-lo na
instalação do CRM sem arrastar um banco extra junto.

> Sem esse modo o processo **não sobe**: `internal/config/config.go` exige `SUPABASE_URL` e
> `SUPABASE_SERVICE_ROLE_KEY` como obrigatórias e entra em pânico sem elas.

## Variáveis do lado do CRM

| Variável | Padrão | O que faz |
|---|---|---|
| `GATEWAY_INBOUND_ENABLED` | `false` | Liga a rota de recebimento nova. Desligado por padrão: instalação existente continua no caminho WAHA legado. |
| `GATEWAY_BASE_URL` | vazio | Base do gateway na rede interna. **Obrigatória quando a rota está ligada — o app não sobe sem ela.** |
| `GATEWAY_MAX_BODY_BYTES` | `10485760` (10 MiB) | Teto do corpo da entrega. |
| `GATEWAY_MAX_MEDIA_BYTES` | `104857600` (100 MiB) | Teto do anexo baixado. |

### Por que `GATEWAY_BASE_URL` derruba o boot em vez de virar aviso

Ela é a **âncora anti-SSRF** do download de mídia. O envelope traz uma *referência* de arquivo, não
os bytes; o CRM **descarta qualquer host que venha nessa referência** e reconstrói a URL sobre esta
base. Sem a base, ou o CRM não busca anexo nenhum, ou alguém "resolve" usando o host que veio no
envelope — que é exatamente o buraco que a construção evita. Não subir é o comportamento seguro.

### De onde vêm os números dos tetos

Não são palpite. `10 MiB` é o limite que o **próprio gateway** impõe ao ler os provedores
(`internal/handlers/uazapi.go:45` e `instagram.go:29` usam `10<<20`), então é o maior corpo que ele
pode precisar representar — e como o envelope carrega referência de mídia e nunca bytes, sobra folga.
`100 MiB` é o maior anexo que um canal suportado entrega (documento do WhatsApp Cloud API; o
Messenger para em 25 MB e imagem em 5 MB).

Anexo acima do teto **não derruba a mensagem**: ela entra marcada como anexo indisponível. Perder o
arquivo é ruim; perder a conversa é pior.

## Ligar em desenvolvimento

A imagem ainda não é publicada. Construa uma vez, a partir do checkout do gateway:

```bash
docker build -t deskcomm/gateway:dev /caminho/para/gateway_go
```

Suba com o profile (o `docker compose up -d` de sempre continua subindo só WAHA + worker):

```bash
docker compose --profile gateway up -d
docker compose logs -f gateway
```

Confira que ele respondeu:

```bash
curl -fsS http://127.0.0.1:8090/health
```

No `.env.local` do app:

```
GATEWAY_INBOUND_ENABLED=true
GATEWAY_BASE_URL=http://127.0.0.1:8090
```

> A porta está presa a `127.0.0.1` de propósito. Publicar um receptor de webhook em `0.0.0.0` sem
> proxy na frente é expor a porta de entrada do sistema.

## Virar uma conexão para o caminho novo

A troca é **por conexão**, não global — é o que permite migrar um número, provar, e só então mexer
no resto. E permite voltar atrás sem release.

```sql
-- ver o estado atual
select id, phone_number, provider, ingest_path from channel_sessions;

-- migrar uma conexão
update channel_sessions set ingest_path = 'gateway' where id = '<uuid>';

-- voltar atrás
update channel_sessions set ingest_path = 'legacy' where id = '<uuid>';
```

Durante a virada os dois caminhos podem entregar a mesma mensagem. Isso é **inofensivo**: a
unicidade `(organization_id, external_id)` em `messages` faz a segunda cair fora. É por isso que a
troca é segura em produção.

## Diagnóstico

**Mensagem não chega no inbox.** Na ordem:

1. O gateway está de pé? `curl http://127.0.0.1:8090/health`
2. A conexão está no caminho novo? `select ingest_path from channel_sessions where id = '...'`
3. A entrega chegou? Ela deixa rastro antes de qualquer processamento:

   ```sql
   select received_at, status, event_type, error_message
     from webhook_events_log
    where provider = 'gateway'
    order by received_at desc
    limit 20;
   ```

   - `status = 'received'` parado há minutos → o dreno não está rodando.
   - `status = 'error'` → leia `error_message`.
   - `status = 'dead'` → esgotou as tentativas; há aviso aberto na Central.
   - **nenhuma linha** → não chegou ao CRM. O problema é do lado do gateway ou da rede.

4. Se não chegou nada, olhe a fila do gateway: entrega pendente é gravada **antes** da primeira
   tentativa e sobrevive a reinício.

**Toda entrega tomando 401.** O segredo daquela conexão provavelmente não foi provisionado. A rota é
*fail-closed* de propósito — ela não aceita entrega que não consegue verificar. O aviso aparece na
Central com motivo próprio (`gateway_secret_nao_provisionado`), não como um 401 genérico, justamente
para não virar silêncio.

**Entregas tomando 429.** O teto de requisições por conexão está baixo demais para o tráfego real.
Ele nasce **acima** do alvo de rajada suportado (200 mensagens em 60 segundos); se está batendo
abaixo disso, algo foi reconfigurado. O gateway respeita `Retry-After` e reentrega — não se perde
mensagem por isso, mas o atraso é visível.

## O que ainda não é do gateway

O **ciclo de vida da conexão** (ler QR, conectar, ver status, reconectar) continua pelo caminho
atual do CRM. Esta feature trata de **recebimento**. Enquanto o painel dos canais novos não existir,
eles não aparecem na tela de conexões.

O **envio** também segue pelo caminho atual.
