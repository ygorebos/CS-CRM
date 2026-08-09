# Feature Specification: A virada de chave — o usuário novo e a conexão que já existe

**Feature Directory**: `specs/005-virada-de-chave/`

**Feature Branch**: `feat/005-virada-de-chave`

**Created**: 2026-08-09

**Status**: Draft

**Input**: Achados C1 e C3 da análise cruzada da spec 004, executada em 2026-08-09 com o ambiente
de pé. A 004 entregou o caminho pelo gateway e foi declarada completa (59 tasks, 0 pendentes);
esta spec existe porque **nenhum tráfego real atravessa esse caminho**, e por dois motivos que a
004 não cobriu.

**Antecessoras**: [`specs/001-migracao-waha-uazapi/`](../001-migracao-waha-uazapi/) (recebimento
unificado) e [`specs/004-envio-pelo-gateway/`](../004-envio-pelo-gateway/) (envio e conexão). Esta
spec **não reabre** nenhuma das duas: ela fecha os dois buracos que sobraram entre o que elas
construíram e o que uma pessoa consegue usar.

**Fio da meada**: [`docs/migracao-para-o-gateway.md`](../../docs/migracao-para-o-gateway.md).

---

## O que foi medido em 2026-08-09 (e é a razão desta spec)

Nada aqui é suposição. Cada linha abaixo saiu de uma leitura do código ou de uma consulta ao banco
de produção, no dia em que a 004 foi declarada pronta.

**A instalação inteira ainda fala WAHA:**

```
GET /api/v1/health → "gateway":{"status":"ok","error":"not_enabled","reason":"nao_configurado"}
.env, .env.local   → 0 linhas com GATEWAY_
channel_sessions   → 1 linha: provider='waha', ingest_path='legacy',
                     waha_session_name='org_753ba3a7', gateway_connection_id=null
```

Isso, por si, é configuração — não é escopo de spec. O que **é** escopo são os dois achados que
sobreviveriam a alguém preencher as variáveis hoje à noite.

### C1 — a porta do usuário novo não tem caminho pelo gateway

A Central de Conexões tem: `app/api/v1/channel-sessions/route.ts:74` decide por
`provisionamentoConfigurado()`. O onboarding **não tem ramo nenhum**:

| Arquivo | O que faz hoje |
|---|---|
| `app/onboarding/connect-whatsapp/page.tsx:13` | `wahaConfigured = getWahaClient() !== null` — a tela inteira depende do WAHA existir |
| `app/api/v1/onboarding/whatsapp/session/route.ts:129,171` | `getWahaClient()` sem alternativa |
| `app/api/v1/onboarding/whatsapp/qr/route.ts:24` | monta `${baseUrl}/api/${session}/auth/qr` — endereço do WAHA escrito à mão |

A T044 da 004 convergiu as duas portas, e convergiu de verdade — mas **na linha do banco**
(`criarConexaoDeCanal`), não no transporte. O onboarding passou a gravar `ingest_path` pelo
interruptor e a auditar `channel.connected`, e continua pareando pelo WAHA.

**Por que isso é P0 e não dívida:** o onboarding é o passo 2 do teto de 10 minutos (Princípio VIII)
e é a porta de **100% de quem se cadastra**. Numa instalação com o gateway ligado e o WAHA
desligado, a tela do usuário novo não mostra QR — mostra o aviso de "WAHA não configurado". O
corretor que acabou de se cadastrar não conecta, e o produto morre no primeiro minuto.

### C3 — a conexão que já existe não tem por onde migrar

A coluna de recebimento tem chave e ela funciona: `PATCH /api/v1/channel-sessions/[id]/ingest-path`
troca `legacy`⇄`gateway`, recusa com `channel_without_gateway_connection` se a linha não tem
`gateway_connection_id`, e audita `channel.migrated` / `channel.reverted`.

**A de envio não existe.** Quem escolhe o adapter é `lib/channels/index.ts`, e ele lê `provider`:

```ts
const ADAPTERS = { waha: wahaAdapter, whatsapp_uazapi: gatewayAdapter, … }
```

Uma linha `provider='waha'` continua enviando pelo WAHA mesmo com `ingest_path='gateway'`. E
trocar `provider` esbarra em `channel_sessions_provider_ref_check`: um `whatsapp_uazapi` **exige**
`gateway_connection_id` não-nulo. Não há rota, tela nem script que produza esse valor para uma
linha que já existe.

**O que isso implica, e é a parte desconfortável:** sessão pareada não se transfere entre
provedores. As credenciais do pareamento vivem no WAHA; o gateway pareia contra a uazapi. Migrar a
conexão viva **é parear o número de novo** — o que se preserva é a linha, o histórico e as
conversas, não a sessão. Qualquer desenho que prometa migração sem novo QR está prometendo o que o
WhatsApp não permite.

---

## User Scenarios & Testing

### User Story 1 — O corretor que acabou de se cadastrar (Priority: P1)

Alguém cria a conta, cai no onboarding e chega no passo "Conectar WhatsApp". Aponta a câmera,
pareia, e vai para o passo seguinte. Ele não sabe — e não deve saber — qual serviço gerou aquele
QR code.

**Por que P1**: é a primeira impressão, é o teto de 10 minutos, e hoje ela **não funciona** numa
instalação que virou a chave. Sem isto, ligar o gateway em produção quebra o cadastro de todo mundo
que chegar depois.

**Teste independente**: conta nova, banco fresco do `baseline.sql`, gateway configurado e WAHA
**ausente** do ambiente. A tela tem de mostrar QR e pareamento tem de concluir.

**Acceptance Scenarios**:

1. **Given** instalação com `GATEWAY_BASE_URL` + `GATEWAY_ADMIN_TOKEN` e sem `WAHA_API_BASE_URL`,
   **When** o usuário novo abre o passo de conectar WhatsApp, **Then** a tela mostra material de
   pareamento (QR e código), **e não** o aviso de transporte ausente.
2. **Given** o mesmo ambiente, **When** o pareamento conclui, **Then** a linha em
   `channel_sessions` nasce `provider` do gateway, `gateway_connection_id` preenchido e
   `ingest_path='gateway'`, com auditoria `channel.connected` e `origem='onboarding'`.
3. **Given** instalação **sem transporte nenhum** configurado, **When** o usuário abre o passo,
   **Then** a tela recusa com texto que diz o que falta — nunca tela vazia, nunca QR que não vai
   funcionar.
4. **Given** qualquer um dos ambientes acima, **When** o usuário percorre o passo inteiro,
   **Then** nenhuma palavra da tela nomeia provedor ("WAHA", "uazapi", "gateway").

---

### User Story 2 — O número que já está no ar (Priority: P2)

A organização já tem um número conectado e conversando. O operador decide passá-lo para o gateway.
Ele faz isso pela tela, com aviso claro de que vai precisar do celular de novo, e pode voltar atrás
se der errado.

**Por que P2**: atinge poucas organizações (hoje, uma) e não bloqueia usuário novo. Mas sem ela a
virada de chave é impossível de completar: a instalação fica metade num transporte e metade no
outro, para sempre.

**Teste independente**: conexão viva `provider='waha'` num ambiente com gateway; migrar; enviar e
receber; reverter; enviar e receber de novo.

**Acceptance Scenarios**:

1. **Given** conexão `provider='waha'`, `ingest_path='legacy'`, `status='WORKING'`, **When** o
   operador pede a migração, **Then** a tela explica que o número precisa ser pareado de novo e
   pede confirmação **antes** de mexer em qualquer coluna.
2. **Given** a confirmação dada, **When** o pareamento no gateway conclui, **Then** a MESMA linha
   passa a `provider` do gateway com `gateway_connection_id` preenchido, `ingest_path='gateway'`,
   e `waha_session_name` **preservado**.
3. **Given** a linha migrada, **When** alguém abre a conversa daquele número, **Then** o histórico
   anterior à migração continua lá, na mesma conversa.
4. **Given** a linha migrada, **When** o operador pede a reversão, **Then** a linha volta a
   `provider='waha'` / `ingest_path='legacy'` sem release e sem perder o `gateway_connection_id`.
5. **Given** a migração em curso (número ainda não pareado no gateway), **When** chega mensagem,
   **Then** ela não se perde e não entra em dobro.

---

### Edge Cases

- **Pareamento do onboarding abandonado** (usuário fecha a aba antes de escanear): a próxima
  visita cai na conexão que já começou, não cria órfã. O nome fixo `org_<8>` existe para isso e
  não muda.
- **Provisionamento falha no meio** (gateway responde 5xx depois de criar a instância): tudo ou
  nada, como a FR-033 da 004 — nenhuma linha meia-criada, nenhuma instância paga órfã.
- **Migração da conexão viva com o gateway fora**: recusa antes de tocar coluna, com texto que diz
  o que está fora.
- **Reversão com a sessão WAHA já deslogada**: a reversão troca as colunas e o número aparece como
  desconectado — é reversível, não é indolor. A tela tem de dizer isso.
- **Duas migrações concorrentes na mesma linha**: a segunda não pode produzir uma segunda instância
  paga.

---

## Requirements

### Bloco C1 — o onboarding pelo gateway

- **FR-001**: O onboarding MUST parear pelo gateway quando o gateway for o transporte configurado,
  **sem passo a mais** e **sem nomear provedor** na tela.
- **FR-002**: A existência do passo de conexão MUST NOT depender do WAHA estar configurado. Hoje
  depende (`app/onboarding/connect-whatsapp/page.tsx:13`).
- **FR-003**: A criação de conexão pelo onboarding MUST provisionar no gateway com a mesma
  semântica tudo-ou-nada da Central (spec 004, FR-033): falha de gravação desfaz a instância.
- **FR-004**: O onboarding MUST consumir o **mesmo** contrato de pareamento da Central
  (`GET /api/v1/channel-sessions/[id]/pairing`), com validade declarada, em vez do endereço do WAHA
  montado à mão.
- **FR-005**: Instalação **sem transporte nenhum** configurado MUST recusar na tela com texto que
  diz o que falta — nunca tela vazia, nunca QR que não vai funcionar.
- **FR-006**: As duas portas MUST continuar convergidas no que a spec 004 já convergiu
  (`criarConexaoDeCanal`, `ingest_path` pelo interruptor, auditoria, papel `admin`). Esta spec
  acrescenta transporte; não desfaz T044 nem T045.

### Bloco C3 — a conexão que já existe

- **FR-010**: MUST existir caminho para uma conexão viva passar a **enviar** pelo gateway. Hoje só
  o recebimento tem chave (`PATCH …/ingest-path`); o envio segue `provider`, e `provider` não tem
  como mudar.
- **FR-011**: A migração MUST preservar a linha em `channel_sessions` e todo o histórico ligado a
  ela — conversas, mensagens e atividades continuam na mesma conexão.
- **FR-012**: A migração MUST ter caminho de volta declarado e executável **sem release**:
  `waha_session_name` preservado na linha migrada, e reversão pela mesma tela.
- **FR-013**: A migração MUST ser **por conexão**, nunca em massa. Não existe operação que vire
  todas as conexões de uma organização (nem da instalação) de uma vez.
- **FR-014**: A tela MUST avisar, **antes** de qualquer escrita, que o número precisará ser pareado
  de novo, e MUST pedir confirmação explícita.
- **FR-015**: Migração e reversão MUST emitir auditoria distinguível (`channel.migrated` /
  `channel.reverted` já existem para `ingest_path`; a troca de `provider` precisa aparecer no mesmo
  registro).
- **FR-016**: A janela entre "instância provisionada" e "número pareado" MUST NOT perder mensagem
  nem produzir envio em dobro.
- **FR-017**: Migração concorrente na mesma conexão MUST NOT provisionar duas instâncias pagas.

---

## Success Criteria

- **SC-001**: Numa instalação com gateway configurado e **sem WAHA**, uma conta recém-criada chega
  do cadastro ao número pareado em ≤10 minutos, pela tela, sem ajuda.
- **SC-002**: Nenhuma conexão criada pelo onboarding nasce fora do transporte que a instalação está
  usando de verdade — medido pelo par (`provider`, `ingest_path`) das linhas novas.
- **SC-003**: Percorrendo o onboarding inteiro, o texto visível não contém "WAHA", "uazapi" nem
  "gateway".
- **SC-004**: A conexão viva migra e volta, e nas duas direções o envio e o recebimento funcionam,
  medidos com número real.
- **SC-005**: Na janela de migração, 0 mensagem perdida e 0 mensagem em dobro.
- **SC-006**: O histórico anterior à migração continua visível na mesma conversa depois dela.
- **SC-007**: Toda prova de tela desta spec fica **vermelha sob sabotagem** (Princípio XI).

---

## Fora de escopo

- **Ligar o gateway em produção** (variáveis, publicar o fork `feat/004-escrita-crm`, subir com
  `STORE_ALVO=crm`). É operação, não código — mas **bloqueia toda prova desta spec**. Está listado
  nas pré-condições da Fase 2 das tasks.
- **T060, T061, T067 da spec 004** (p95 do envio, estado final, mídia no aparelho). Continuam
  daquela spec e continuam esperando número real.
- **Os outros canais do gateway** (`whatsapp_cloud`, `instagram`, `messenger`). Seguem sem adapter
  de envio, deliberadamente (`lib/channels/index.ts:22`).
- **Migração automática de conexões existentes no deploy.** FR-013 a proíbe: virada em massa numa
  instância única não tem para onde voltar.
