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
| `GATEWAY_INTERNAL_TOKEN` | vazio | Credencial com que o CRM se autentica **ao baixar anexo** do gateway (direção CRM → gateway, oposta à da entrega). Vazia: o download vai sem `Authorization`, o que só funciona em gateway sem token. Não derruba o boot — mídia indisponível não pode virar sistema fora do ar. |

### Variáveis do lado do gateway (repo `gateway_go`)

| Variável | Padrão | O que faz |
|---|---|---|
| `ENTREGA_FILA_DIR` | vazio | Diretório da **fila durável**: a pendência é gravada aí **antes** da primeira tentativa. Vazio = entrega sem durabilidade (uma tentativa e log), que é o comportamento anterior. Em contêiner, aponte para um **volume** — caminho dentro da imagem some no próximo deploy, que é justamente o caso a cobrir. |
| `ENTREGA_FILA_INTERVALO_MS` | `15000` | Intervalo entre passadas da fila. |
| `ENTREGA_FILA_TETO_TENTATIVAS` | `8` | Depois disto a pendência vira descarte inspecionável em `<ENTREGA_FILA_DIR>/mortas/`, com log de erro. Espera crescente de 5s até o teto de 5min — cobre a ordem de grandeza de um deploy ruim, não a de um incidente de dias. |

Não há padrão de diretório de propósito: escolher um sozinho criaria estado em disco que o operador
não sabe que existe e que ninguém esvazia.

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
arquivo é ruim; perder a conversa é pior. O mesmo vale para download recusado, host fora da base e
tempo esgotado: a mensagem já está no inbox quando o anexo é buscado, porque o ingest emite
`media.persist_requested` **depois** de gravar a linha (FR-025).

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

### Conexão NOVA já nasce no caminho da instalação

Conexão criada depois desta feature nasce com `ingest_path` seguindo o interruptor global: com
`GATEWAY_INBOUND_ENABLED=true` ela nasce `'gateway'`; desligado, nasce `'legacy'`
(`lib/gateway/caminho-de-ingestao.ts`). O default `'legacy'` da coluna continua valendo **só** para
as linhas que já existiam quando a migration `0116` foi aplicada — mudá-las em massa seria virar a
chave de todo mundo sem aviso.

Nascer sempre `'gateway'` seria pior que o default: com o interruptor desligado, a conexão apontaria
para uma rota que responde **404**, e o gateway **descarta 404 sem retentar** (contrato §5). A
conexão nasceria muda.

### Voltar atrás: o que fica em voo

Voltando para `'legacy'`, o que já estava em `webhook_events_log` com `status='received'` **continua
sendo recolhido pelo dreno** — ele filtra por `provider = 'gateway'`, não por `ingest_path`. Ou seja:
a reversão para o legado não abandona o que estava a meio caminho.

O que o gateway já tinha em fila e ainda vai tentar entregar vai tomar **409
`connection_not_migrated`** e ir para o descarte inspecionável (`<ENTREGA_FILA_DIR>/mortas/`). Isso é
deliberado: nesse estado o caminho legado está entregando as mesmas mensagens, então descartar não
perde nada — só para de bater numa porta que agora responde não. Se a reversão for longa, esvazie o
`mortas/` depois de conferir; ele não é apagado sozinho, de propósito.

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

**Nenhuma linha em `webhook_events_log`, e a conexão está em `'gateway'`.** Confira o interruptor
global antes de suspeitar da rede:

```sql
select count(*) from channel_sessions where ingest_path = 'gateway' and archived_at is null;
```

Se há conexões migradas e `GATEWAY_INBOUND_ENABLED=false`, a rota responde **404** e o gateway
descarta sem retentar. **Nada entra e nada volta.** O dreno abre aviso `gateway_inbound_down` na
Central a cada rodada (um por organização, enquanto houver um aberto), e `/api/v1/health` traz o
check `gateway`. O conserto é ligar a variável e reiniciar o app.

**Entregas tomando 429.** O teto de requisições por conexão está baixo demais para o tráfego real.
Ele nasce **acima** do alvo de rajada suportado (200 mensagens em 60 segundos); se está batendo
abaixo disso, algo foi reconfigurado. O gateway respeita `Retry-After` e reentrega — não se perde
mensagem por isso, mas o atraso é visível.

## Retenção de `webhook_events_log` (T066)

A tabela deixou de ser log e virou **fila de entrada**: passa a receber uma linha por evento de
todos os canais, com o `raw_body` inteiro. Sem política, ela cresce com todo o tráfego do produto e
vira o maior objeto do banco — e o `raw_body` guarda conteúdo de conversa de cliente, o que a torna
também um problema de LGPD, não só de disco.

A política, e o motivo de cada faixa:

| Idade | O que acontece | Por quê |
|---|---|---|
| 0–7 dias | linha completa, `raw_body` inteiro | é a janela em que alguém investiga "essa mensagem não chegou" com o payload na mão |
| 7–90 dias | `raw_body` esvaziado, metadados mantidos (`status`, `event_type`, `external_id`, `attempts`, `error_message`, `valid_signature`) | depois de uma semana ninguém relê o corpo; o que se pergunta é *se* chegou, *quando* e *por que foi recusada* — e isso são os metadados. É também o que sustenta o SC-012 (reconstruir uma recusa sem log de aplicação) |
| > 90 dias | `archived_at` carimbado; linha elegível para remoção | além disso o valor é estatístico, e estatística não precisa de linha por evento |

Faixa 2 é o ponto importante: **esvaziar o corpo não é o mesmo que apagar a linha**. Apagar
destruiria a prova de que a entrega existiu — que é justamente o que se procura num incidente.

Linha `dead` é **exceção**: não é esvaziada nem arquivada enquanto o aviso correspondente estiver
aberto na Central. Ela é o anexo do aviso; sem o corpo, "sua mensagem não chegou" fica sem o que
mostrar.

> **Estado**: política **declarada**, execução ainda não agendada. A coluna `archived_at` já existe.
> O cron de aplicação é trabalho separado — e enquanto ele não existe, esta seção é o que impede a
> tabela de crescer sem ninguém ter decidido nada.

## O que ainda não é do gateway

O **ciclo de vida da conexão** (ler QR, conectar, ver status, reconectar) continua pelo caminho
atual do CRM. Esta feature trata de **recebimento**. Enquanto o painel dos canais novos não existir,
eles não aparecem na tela de conexões.

O **envio** também segue pelo caminho atual.
