# Feature Specification: Envio e conexão pelo gateway — o CRM para de falar WAHA

**Feature Directory**: `specs/004-envio-pelo-gateway/`

**Created**: 2026-08-08

**Status**: Draft

**Input**: Decisão do dono do produto em 2026-08-08: *"se vamos utilizar o gateway para os
recebimentos, também vamos usá-lo para se conectar às APIs de WhatsApp e envio de mensagem.
Precisamos planejar a migração completa para o gateway."*

**Missão que serve (Princípio IX)**: as duas. Recebimento sem envio é caixa de correio; a spec 001
trouxe a mensagem para dentro e esta devolve a resposta. Sem ela o agente lê e não fala.

**Onde cai no teto de 10 minutos (Princípio VIII)**: em cheio. A frente de **conexão** É o passo 2
do onboarding (`app/onboarding/page.tsx:16-22`) — o momento em que o corretor aponta o celular para
um QR code. Trocar quem gera esse QR é mexer no trecho da jornada de estreia com maior taxa de
abandono. Esta feature não pode acrescentar nenhum passo, nem trocar o vocabulário da tela.

**Numeração**: esta é a spec **004**, não 002. `002-rag-por-operadora` e
`003-estruturas-agente-pre-prontas` já existiam na `main` quando o pedido foi feito.

**Antecessora**: [`specs/001-migracao-waha-uazapi/`](../001-migracao-waha-uazapi/) — recebimento
unificado, 76 de 82 tarefas, mesclada na `main` em 2026-08-08. Esta spec **herda** dela o envelope
normalizado, a rota assinada `/api/v1/webhooks/gateway/[token]`, a coluna de corte `ingest_path` e
a coluna `gateway_connection_id`.

**Fio da meada**: [`docs/migracao-para-o-gateway.md`](../../docs/migracao-para-o-gateway.md) — o
estado das três frentes num só lugar, atravessando as duas specs.

> ### ⚠️ Decisão de 2026-08-08 que muda o alvo desta spec
>
> O dono do produto decidiu **forkar o gateway**: haverá duas versões, uma apontada para o banco do
> Cotador Simplificado e outra para o **banco do CRM**. Na versão do CRM o gateway grava conexão,
> instância, mensagem, conversa e contato **direto no banco do CRM** — WhatsApp e demais canais.
>
> O desenho, as quatro pendências resolvidas e o preço estão em
> [**`decisao-escrita-direta.md`**](decisao-escrita-direta.md). **Leia antes de trabalhar em F1.**
>
> Três consequências para o texto abaixo, sem reescrevê-lo ainda:
>
> 1. **F1 muda de forma.** Provisionar deixa de ser só rota HTTP no gateway e passa a poder ser
>    função no CRM. A dependência externa continua existindo — o que muda é onde a linha nasce.
> 2. **A entrada da spec 001 fica sem uso no caminho do gateway** (rota assinada, ACK-primeiro,
>    `webhook_events_log` como fila). O que esta spec herda de 001 encolhe para o **envelope de
>    saída**, o `ingest_path` e o `gateway_connection_id`.
> 3. **A doutrina foi emendada** — constituição **v2.3.0** (2026-08-08) nomeou a **quarta
>    superfície** (função `security definer` versionada) e a cercou com seis travas; `CLAUDE.md` e
>    `AGENTS.md` propagados. ⚠️ **A permissão é condicional**: sem T011 (invariante que reprova
>    grant de tabela) e T016 (sem HTTP na função), a superfície volta a ser proibida.

---

## As três frentes (e por que a ordem não é escolha)

O pedido tem três partes. Elas **não são paralelas** — a primeira é pré-requisito das outras duas,
e essa dependência é a descoberta mais cara deste levantamento.

| # | Frente | Onde mora o trabalho | Estado hoje |
|---|---|---|---|
| **F1** | **Provisionamento** — existir uma conexão que o gateway saiba resolver | **`gateway_go`** (repo irmão) — e, pela decisão de 2026-08-08, o registro passa a nascer no **banco do CRM** | **Não existe.** Bloqueia F2 e F3 |
| **F2** | **Envio** — o CRM manda mensagem pelo gateway em vez de pelo WAHA | CRM (adapter novo atrás do seam que já existe) | Superfície do gateway pronta; falta o adapter e desarmar dois desvios |
| **F3** | **Conexão** — o corretor pareia um número novo pelo gateway, pela tela | CRM + `gateway_go` | Gateway tem QR/status/desconectar; falta criar a conexão e falta a tela não falar "WAHA" |

### Por que F1 bloqueia

Toda rota de envio do gateway começa resolvendo a conexão contra a tabela `wa_connections` do
**Supabase do Cotador Simplificado** (`internal/resolver/connection.go:145-172`). Sem essa linha, o
resolver devolve erro genérico, vira **502**, e nenhuma chamada ao provedor acontece
(`internal/resolver/errors.go:76-82`). É o único passo duro do caminho de envio: a janela de 24h, a
persistência no inbox e a auditoria de template já toleram falha de banco, o resolver não.

E **nenhuma rota do gateway cria essa linha**. O inventário de acessos mostra 9 leituras e 3
atualizações de `status` em `wa_connections`, e **zero `Insert`/`Upsert`**. Hoje a linha nasce à mão,
do lado do Cotador.

O `ModeRelay` **não resolve isso**. Ele está declarado (`internal/config/config.go:79-83`) e
testado, mas **nenhum handler, processor ou camada de persistência o consulta** — `grep -rn
"IsRelay()" --include="*.go"` só acha `internal/config/`. Seu único efeito real é deixar de exigir
`SUPABASE_URL` no boot: o processo sobe sem banco e então todo o resolver chama um PostgREST de URL
vazia. Ou seja, o relay foi desenhado para cortar a **escrita** best-effort no inbox e nunca
endereçou a **leitura obrigatória** da conexão.

**Consequência de escopo:** F1 é trabalho no `gateway_go`, não neste repo. Esta spec declara o
contrato que o CRM precisa e trata a implementação do outro lado como dependência externa
rastreada — do mesmo jeito que o Princípio VII manda tratar o Cotador.

### O que já está pronto e não precisa ser reescrito

- **O caminho de volta do ACK já existe.** O gateway devolve confirmação de entrega como envelope
  `envelope_v1` assinado, com `delivery.status` (`internal/envelope/envelope.go:205-216`) e
  `event_kind: "status_update"`. O CRM já recebe e trata isso: `lib/gateway/ingest.ts:92` roteia
  para `atualizarEstado` (`:289`), que tem guarda contra regressão de estado (`:278-288`,
  `:316-321`) — proteção que o ACK do WAHA **não** tem (`lib/waha/ingest.ts:657-677`). Migrar o
  envio herda um ACK melhor do que o atual, de graça.
- **O seam de canal já existe.** `getAdapter(provider)` em `lib/channels/index.ts:27`, com
  `whatsapp_uazapi: null` deixado de propósito e fail-closed (`:17`, `:47-51`).
- **As colunas já existem.** `channel_sessions.gateway_connection_id` e `ingest_path` nasceram na
  migration 0119, com o CHECK de `provider` já ampliado para seis valores.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A resposta do agente sai pelo gateway e chega no celular do cliente (Priority: P1)

Um cliente manda mensagem. Ela entra pelo gateway (spec 001). O agente responde. A resposta sai
**pelo gateway**, chega no WhatsApp do cliente, e aparece no inbox do CRM como enviada — sem que
ninguém tenha configurado nada além do que já configurava.

**Why this priority**: é a costura inteira num fio, igual à US1 da spec 001. Enquanto ela não fecha,
as outras duas frentes são hipótese. É também o menor pedaço que já entrega valor: um canal
migrado que recebe **e** responde é um canal que atende de verdade.

**Independent Test**: com uma conexão de gateway provisionada, mandar mensagem de um celular real
para o número, deixar o agente responder, e conferir **no celular** que a resposta chegou — e **na
tela do inbox** que a bolha está lá com estado `enviada`.

**Acceptance Scenarios**:

1. **Given** um canal com `ingest_path='gateway'` e `gateway_connection_id` preenchido, **When** o
   CRM envia uma mensagem de texto, **Then** ela chega no celular do destinatário e a linha no CRM
   fica `sent` com `external_id` preenchido pelo `message_id` que o gateway devolveu.
2. **Given** o mesmo canal, **When** o gateway recusa o envio (conexão desconectada, credencial
   rejeitada), **Then** a mensagem fica `failed` com código legível **e** o motivo aparece para
   quem estava na tela — não some num log.
3. **Given** um canal ainda em `ingest_path='legacy'`, **When** o CRM envia, **Then** o envio
   continua pelo WAHA, sem mudança de comportamento — os dois caminhos coexistem canal a canal.
4. **Given** o gateway fora do ar, **When** o CRM tenta enviar, **Then** a mensagem fica em estado
   que **tem dono** (reagendável), nunca num estado órfão, e o aviso da queda aparece na Central.

---

### User Story 2 - O visto azul volta a ser verdade (Priority: P1)

O corretor olha a conversa e vê um tique, dois tiques, dois tiques azuis — e eles significam o que
sempre significaram: enviada, entregue, lida. Numa mensagem que saiu pelo gateway.

**Why this priority**: é o que o corretor usa para decidir se cobra o cliente de novo. Estado de
entrega errado não é cosmético — é o corretor mandando "viu minha mensagem?" para quem já
respondeu, ou desistindo de quem nunca recebeu.

**Independent Test**: enviar pelo gateway, deixar o celular do destinatário receber e abrir, e
conferir pela tela que a bolha percorre enviada → entregue → lida na ordem, sem voltar atrás.

**Acceptance Scenarios**:

1. **Given** uma mensagem enviada pelo gateway, **When** o gateway encaminha o `status_update` com
   `delivered`, **Then** a bolha na tela mostra entregue e `delivered_at` é gravado.
2. **Given** a mesma mensagem já marcada `read`, **When** chega fora de ordem um `status_update` de
   `sent`, **Then** a tela **não regride** — continua lida.
3. **Given** uma falha de entrega reportada depois de `delivered`, **When** o envelope traz
   `failed` com `error_code`, **Then** o estado passa a falha e o motivo fica visível.
4. **Given** um `status_update` de mensagem que o CRM não conhece, **When** ele chega, **Then**
   nenhuma mensagem fantasma é criada.

---

### User Story 3 - Trocar de caminho não queima o número (Priority: P1)

Depois da migração, o ritmo de envio do número migrado é **o mesmo ou mais conservador** que antes:
espaçamento entre mensagens, jitter, teto diário de aquecimento e janela de horário continuam
valendo.

**Why this priority**: mesma prioridade da costura, e por um motivo brutal: **o gateway não tem
nenhum controle de vazão**. Nem por conexão, nem global, nem por IP — verificado por varredura no
repo inteiro. Todo o anti-banimento vive no CRM. Um envio que passe a sair por um caminho que
escapa da cadeia `before_send` manda o número para o banimento, e número banido é a operação
inteira parada, sem caminho de volta.

**Independent Test**: disparar N mensagens pelo caminho novo e medir os intervalos reais entre as
saídas (carimbo no `pacing_ledger` e no provedor), confirmando que respeitam o espaçamento
configurado e a janela de horário. Sabotar o gate e confirmar que o teste fica vermelho.

**Acceptance Scenarios**:

1. **Given** um canal migrado, **When** o agente responde em várias bolhas, **Then** o intervalo
   entre elas obedece ao espaçamento anti-banimento configurado para aquele canal.
2. **Given** um canal migrado fora da janela de horário, **When** uma automação tenta enviar,
   **Then** o envio é adiado para a próxima janela, não recusado nem disparado assim mesmo.
3. **Given** um canal migrado, **When** a recuperação automática de mensagens presas age, **Then**
   ela envia **pelo gateway** — não pelo caminho antigo — e continua respeitando o espaçamento.
4. **Given** um canal migrado, **When** alguém envia pelo compositor da tela ou por integração
   externa, **Then** esse envio passa pelas mesmas travas de vazão que o envio do agente.

> O cenário 4 nomeia dívida que **já existe hoje** e não nasce aqui: o compositor humano, a
> ferramenta externa e o runtime antigo não passam por trava de vazão nenhuma. A migração não pode
> piorar isso, e é a oportunidade certa de fechar — mas fechar é decisão de escopo, não
> consequência automática (ver Assumptions).

---

### User Story 4 - O corretor conecta um número novo e nunca ouve a palavra "gateway" (Priority: P1)

Conta nova, nenhum número conectado. O corretor abre o passo de conectar WhatsApp, vê um QR code,
aponta o celular, e em segundos a tela diz que está conectado. Ele não sabe — e não precisa saber —
qual provedor está por trás.

**Why this priority**: é o passo 2 de 6 do onboarding e o ponto onde o corretor decide se o produto
funciona. Vale o mesmo P1 do envio porque **sem conectar não existe nem receber nem enviar**: é a
única porta de entrada de um número novo.

**Independent Test**: numa conta recém-criada, em ambiente fresco e estado vazio, percorrer o
onboarding pela tela até o QR aparecer, cronometrando; e depois repetir pela Central de Conexões.

**Acceptance Scenarios**:

1. **Given** uma organização sem nenhum canal, **When** o corretor pede para conectar um número,
   **Then** um QR code aparece na tela dentro do tempo que aparece hoje, e o texto ao redor dele
   não nomeia nenhum provedor.
2. **Given** o QR na tela, **When** o corretor pareia pelo celular, **Then** a tela detecta a
   conexão sozinha e segue o fluxo — sem ele precisar recarregar ou clicar em "já configurei".
3. **Given** um QR que expirou, **When** o corretor pede um novo, **Then** um novo aparece sem
   perder a conexão em criação.
4. **Given** a conexão criada, **When** o provisionamento no gateway falha no meio, **Then** o CRM
   **não deixa linha órfã** — ou a conexão nasce inteira, ou não nasce, e o erro é legível.
5. **Given** um canal conectado pelo gateway, **When** o corretor abre a Central de Conexões,
   **Then** vê estado, número e saúde do canal com o mesmo vocabulário de hoje.

---

### User Story 5 - Dá para voltar atrás, canal por canal (Priority: P2)

Um canal migrado apresenta problema. Quem opera devolve **aquele** canal ao caminho antigo sem
tocar nos outros e sem perder mensagem que estava em voo.

**Why this priority**: instância única, sem versão de escape (Princípio III). Migração de canal de
comunicação sem caminho de volta é aposta, não engenharia. É P2 e não P1 porque só passa a valer
depois que existe algo migrado.

**Independent Test**: migrar um canal, enviar mensagens, voltá-lo ao caminho antigo no meio do
tráfego, conferir que nada se perdeu nem duplicou, e migrar de novo.

**Acceptance Scenarios**:

1. **Given** dois canais na mesma organização, um migrado e outro não, **When** ambos enviam,
   **Then** cada um sai pelo seu caminho e nenhum vaza para o outro.
2. **Given** um canal migrado com mensagens em voo, **When** ele volta ao caminho antigo, **Then**
   as em voo terminam seu ciclo e as novas saem pelo caminho antigo — sem duplicata.
3. **Given** um canal que voltou ao caminho antigo, **When** chega um `status_update` atrasado do
   gateway referente a mensagem antiga, **Then** ele é aplicado ou descartado de forma definida, e
   nunca cria mensagem nova.

---

### User Story 6 - Mídia enviada abre no celular do cliente (Priority: P2)

O corretor anexa um PDF de proposta, uma foto de carteirinha ou grava um áudio. O cliente recebe e
abre.

**Why this priority**: proposta de plano de saúde é PDF e áudio é como corretor trabalha. Texto sem
mídia é meio canal.

**Independent Test**: enviar imagem, PDF e áudio pelo caminho novo, para um celular real, e abrir
cada um no aparelho.

**Acceptance Scenarios**:

1. **Given** um canal migrado, **When** o corretor envia imagem, documento e áudio, **Then** os
   três chegam abríveis no celular do destinatário, com o nome de arquivo preservado no documento.
2. **Given** um áudio gravado no navegador, **When** ele é enviado, **Then** chega como mensagem de
   voz reproduzível, não como anexo genérico.
3. **Given** uma mídia cuja referência temporária expira, **When** o envio demora mais que a
   validade, **Then** a falha é detectada e reportada — não fica pendurada em silêncio.

---

### Edge Cases

- **O gateway aceita e o provedor recusa depois.** A resposta síncrona do gateway só diz "o
  provedor aceitou" e devolve um id; a falha real pode chegar minutos depois, no envelope. O CRM
  precisa aceitar que `sent` é provisório.
- **`connection_id` apontando para conexão de outra organização.** O gateway resolve o dono a partir
  da conexão, nunca do corpo — `organization_id` no fork do CRM, `escritorio_id` no do Cotador
  (tradução na §3c da [decisão](decisao-escrita-direta.md)) — mas quem escolhe qual `connection_id`
  mandar é o CRM. Se ele mandar o errado, a mensagem sai pelo número errado, para o cliente certo.
  Essa é a pior falha possível desta feature.
- **Duas jornadas de conexão divergentes.** Onboarding e Central de Conexões hoje criam sessão por
  rotas diferentes, com nomes de sessão de formatos diferentes, e as rotas do onboarding **não
  checam papel nenhum** enquanto as da Central exigem `admin`. Migrar as duas separadamente
  duplicaria o defeito.
- **Vocabulário de estado do canal.** Os cinco estados que a tela sabe traduzir são os do WAHA. O
  gateway devolve estado do outro provedor. Estado desconhecido não pode virar tela em branco.
- **Recuperação automática falando o dialeto errado.** A rotina que redirige mensagem presa monta
  a chamada crua para o WAHA e ignora completamente o seam de canal. Num canal migrado ela envia
  para o lugar errado — ou para lugar nenhum — em silêncio.
- **Mensagem já enviada quando o canal troca de caminho.** Confirmação de entrega pode chegar pelo
  caminho que não é mais o do canal.
- **Grupo.** O gateway entrega `is_group`; o CRM descarta grupo na entrada. O envio para grupo
  precisa continuar impossível pelo caminho novo, e não virar erro obscuro.

---

## Requirements *(mandatory)*

### Frente 1 — Provisionamento e escrita (fork do gateway apontado para o CRM)

> Reescrita em 2026-08-08 pela [decisão de escrita direta](decisao-escrita-direta.md). A versão
> anterior (FR-001 a FR-004 pedindo contrato HTTP com o gateway dono do próprio armazenamento) está
> preservada no histórico do git; o `gateway-provisioning-v1.md` segue válido como contrato HTTP,
> mas deixou de ser o único caminho.

**Superfície de escrita**

- **FR-001**: A escrita do gateway no banco do CRM MUST passar **só por função versionada**
  (`security definer`). O fork MUST NOT receber grant de tabela nem a `service_role` key do CRM —
  escrever tabela crua tem de falhar em desenvolvimento, não em produção.
- **FR-002**: O fork MUST autenticar-se com papel Postgres dedicado, com `EXECUTE` apenas nas
  funções desta frente. Um invariante MUST reprovar se esse papel ganhar qualquer grant de tabela.
- **FR-003**: Toda função nova MUST revogar `EXECUTE` de `public` **e** de `anon` — são duas origens
  distintas de grant, e tratar só uma expõe a função como RPC alcançável pela anon key.

**Resolução de tenant**

- **FR-004**: A `organization_id` MUST ser resolvida **dentro do banco**, a partir da conexão pela
  qual a mensagem chegou (`channel_sessions.gateway_connection_id`). O corpo da chamada MUST NOT
  decidir tenant — mesma regra do recebimento de hoje.
- **FR-005**: Conexão inexistente, arquivada ou de outra organização MUST recusar a escrita com erro
  **definitivo**, distinguível de falha transitória, para o gateway não retentar para sempre o que
  nunca vai passar. A taxonomia MUST ser explícita e ter só duas classes no contrato:
  **definitivo** (conexão desconhecida, arquivada, de outro dono, corpo inválido — o gateway
  descarta e registra) e **transitório** (banco indisponível, tempo esgotado, conflito de
  serialização — o gateway retenta com recuo). Erro sem classe declarada MUST ser tratado como
  transitório pelo gateway — errar para o lado de retentar perde menos que errar para o lado de
  descartar.

**Idempotência**

- **FR-006**: A idempotência MUST continuar sendo a constraint `unique (organization_id,
  external_id)` do banco. A função de ingestão MUST tratar a duplicata como **sucesso**, devolvendo
  o identificador da mensagem já existente e sinalizando que era repetida.
- **FR-007**: A função de ingestão MUST tornar a constraint imediata antes do insert. **Medido**:
  `on conflict` não funciona contra constraint `DEFERRABLE`, índice único imediato adicional não
  resolve, e o `exception when unique_violation` sem isso não captura — o erro estoura no `COMMIT` e
  mata a transação inteira.

**Cadeia viva**

- **FR-008**: A ingestão de mensagem **recebida** MUST emitir o pedido de turno do agente na
  **mesma transação** do insert — ou os dois acontecem, ou nenhum. Emissão em viagem separada MUST
  NOT ser usada: morrer no meio deixa mensagem sem atendimento e sem ninguém perceber.
- **FR-009**: O eco do próprio envio MUST NOT pedir turno de agente — pedir faria o agente responder
  a si mesmo.
- **FR-010**: Função desta frente MUST NOT fazer HTTP. Efeito colateral sai por `event_log`,
  consumido por worker (anti-pattern 9).

**Ciclo de vida da conexão**

- **FR-011**: MUST existir caminho para **criar** a conexão de canal e devolver seu identificador,
  e para **encerrar/desprovisionar**, de modo que apagar um canal no CRM não deixe instância órfã no
  provedor.
- **FR-012**: A criação MUST ser tudo-ou-nada: instância criada no provedor com registro falhando
  MUST desfazer a instância antes de reportar erro.

> **FR-011/FR-012 e FR-030/FR-033/FR-036 descrevem a mesma coisa por lados diferentes, de
> propósito.** A F1 declara a **capacidade** (existe caminho, e ele é atômico); a F3 declara a
> **jornada** (o corretor consegue pelo tela, sem passo a mais). Uma pode passar com a outra
> falhando — capacidade sem tela é backend mudo, tela sem capacidade é botão que mente. Por isso
> são requisitos separados e não uma duplicação a fundir. **A prova, porém, é compartilhada**:
> quem satisfaz FR-012 satisfaz o backend de FR-033, e o teste de tudo-ou-nada roda uma vez só.

**Durabilidade — as duas pontas, porque o Princípio XIV exige as duas**

> A versão anterior deste bloco dizia que a fila do gateway passava a ser "a **única** rede contra
> perda". Isso **contraria o Princípio XIV por escrito**, não apenas de espírito: ele exige
> *"entrega com retentativa durável e fila persistida em disco do lado do gateway, **e dreno
> periódico do lado do CRM**"*. Derrubar a ponta do CRM é derrubar um MUST. Corrigido abaixo.

- **FR-013**: A fila em disco do gateway MUST sobreviver a reinício do processo, MUST ter teto de
  tamanho declarado e MUST alarmar quando parar de drenar. É a ponta de **empurrar**.
- **FR-013a**: O CRM MUST ter uma **reconciliação periódica** que pergunta ao gateway o que ele
  entregou numa janela e detecta o que falta, gravando o que faltar pelo mesmo caminho da ingestão
  normal (idempotente por FR-006, então reconciliar duas vezes não duplica). É a ponta de **puxar**,
  e é o que o Princípio XIV chama de dreno do lado do CRM.

  **Por que puxar não é redundância de empurrar**: a fila do gateway só protege contra o CRM estar
  fora do ar. Não protege contra o gateway perder a fila, contra a entrega ser aceita e a transação
  falhar depois, nem contra defeito no próprio empurrador. A ponta que puxa é a única que enxerga
  mensagem que **nunca chegou a existir** do lado do CRM — e essa é exatamente a falha que o
  usuário não tem como detectar, pela qual XIV existe.

  A janela de reconciliação MUST cobrir com margem o maior tempo tolerado de indisponibilidade do
  CRM, e a divergência encontrada MUST virar alerta — reconciliar em silêncio esconde justamente o
  defeito que se queria medir.

**Enquanto não existir**

- **FR-014**: Enquanto esta frente não estiver pronta, o CRM MUST recusar criar canal com caminho de
  gateway com erro legível, em vez de criar linha que nunca vai enviar. Falha silenciosa aqui é
  canal morto na mão do corretor.

### Frente 2 — Envio

- **FR-015**: O CRM MUST enviar mensagem pelo gateway para canais marcados com caminho de gateway,
  e continuar enviando pelo caminho antigo para os demais — a chave de corte é **por canal**, a
  mesma que o recebimento já usa.
- **FR-016**: O envio pelo gateway MUST entrar como um tradutor de canal atrás do seam existente,
  sem que nenhuma feature do CRM passe a nomear provedor (doutrina de restrição de canal).
- **FR-017**: O CRM MUST identificar a conexão de destino pelo identificador de conexão gravado no
  próprio canal, resolvido de fonte confiável, **nunca** de corpo de requisição.
- **FR-018**: A credencial de acesso ao gateway MUST viajar em cabeçalho, nunca em query string, e
  MUST ser configuração — o endereço do gateway não é `localhost` nem nome de serviço de compose
  (Princípio XIV).
- **FR-019**: O identificador devolvido pelo gateway MUST ser gravado como referência externa da
  mensagem, e MUST casar com o identificador que volta nas confirmações de entrega. Se não casar, a
  confirmação não acha a mensagem e o visto nunca chega.
- **FR-020**: Toda saída de mensagem por canal migrado MUST passar pelas mesmas travas de vazão e
  janela que hoje protegem o envio do agente — **inclusive** a rotina de recuperação de mensagens
  presas, que hoje fala direto com o provedor antigo.
- **FR-021**: O CRM MUST tratar a resposta de sucesso do gateway como **aceite provisório**: o
  estado definitivo vem pela confirmação assíncrona.
- **FR-022**: Falha de envio MUST produzir estado com dono declarado — reagendável ou falho — e
  nunca um estado órfão sem quem o resolva.
- **FR-023**: Queda ou indisponibilidade do gateway MUST virar alerta para a operação **e** aviso
  na Central para o usuário (Princípio XIV). Silêncio é proibido.
- **FR-024**: Mídia MUST ser entregue ao gateway por referência de endereço, não embutida no corpo,
  e a validade dessa referência MUST ser de **no mínimo 1 hora** a partir da emissão. O número não é
  arbitrário: cobre a retentativa do gateway (fila em disco, FR-013) somada ao tempo de busca do
  provedor, com margem para o CRM ter reiniciado no meio. Referência que expira antes vira anexo
  que não abre no celular do cliente — e o CRM não fica sabendo, porque para ele o envio deu certo.
- **FR-025**: O envio para conversa de grupo MUST permanecer impedido pelo caminho novo, com o
  mesmo desfecho de hoje.

### Frente 3 — Conexão

- **FR-030**: O corretor MUST conseguir parear um número novo pela tela, pelo gateway, com QR code,
  **sem** nenhum passo a mais do que o fluxo atual e **sem** que a tela nomeie provedor.
- **FR-031**: A tela MUST detectar sozinha que a conexão foi estabelecida, sem exigir recarregar
  nem confirmar manualmente.
- **FR-032**: O CRM MUST traduzir os estados de conexão do gateway para o vocabulário que a tela já
  usa, e estado desconhecido MUST cair num estado seguro e legível — nunca tela vazia.
- **FR-033**: Criar canal MUST ser tudo-ou-nada: se o provisionamento falhar, não sobra linha
  órfã no CRM nem instância órfã no provedor.
- **FR-034**: As duas portas de conexão (onboarding e Central de Conexões) MUST convergir para o
  mesmo caminho de criação — a divergência atual não pode ser duplicada no caminho novo.
- **FR-035**: A criação de canal MUST exigir papel de administrador nas duas portas. Hoje a porta
  do onboarding não exige papel nenhum; migrar sem corrigir carrega o furo para o caminho novo.
- **FR-036**: Desconectar e reconectar um número MUST funcionar pela tela no canal migrado, com os
  mesmos desfechos de hoje.
- **FR-037**: Cada canal MUST continuar tendo seu próprio segredo de recebimento — a migração não
  pode reintroduzir segredo global.

### Transversais

- **FR-040**: Qualquer estado novo de canal ou de mensagem MUST sair como migration versionada, com
  apêndice idempotente no baseline e linha no manifesto (Princípio III).
- **FR-041**: A feature MUST ser reversível por canal, sem tocar nos demais e sem perder mensagem
  em voo.
- **FR-042**: Nenhum código novo do CRM MUST ler payload cru de provedor — só o envelope
  (anti-pattern 15). O vigia mecânico atual cobre apenas o caminho de recebimento; o caminho de
  envio MUST passar a ser coberto.
- **FR-043**: Toda mudança de canal (criar, migrar, reverter, apagar) MUST gerar registro de
  auditoria.
- **FR-044**: A configuração de endereço e credencial do gateway MUST estar declarada na validação
  de ambiente e no exemplo de configuração, e a ausência dela MUST falhar de forma legível no
  momento certo.

### Key Entities

- **Canal (conexão de número)**: já existe. Ganha significado novo em duas colunas que já nasceram
  na spec 001 — a que diz por qual caminho o canal recebe, e a que guarda o identificador da
  conexão do lado do gateway. Esta spec passa a **escrever** a segunda, que hoje só é preenchida
  por semente de teste.
- **Mensagem de saída**: já existe. Muda quem produz a referência externa e por qual caminho o
  estado evolui.
- **Envelope de confirmação de entrega**: já existe e já é consumido — vem do gateway assinado,
  carrega estado de entrega e código de erro.
- **Conexão do lado do gateway**: entidade que **não** mora neste repo. O CRM guarda apenas o
  ponteiro para ela. Nenhuma chave estrangeira atravessa a fronteira de produto (Princípio VII).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Mensagem enviada por canal migrado chega ao celular do destinatário em **100%** de 20
  tentativas reais, com p95 do tempo entre o clique e a chegada **≤ 5 s**.
- **SC-002**: **100%** das mensagens enviadas por canal migrado terminam com referência externa
  preenchida e estado final coerente — zero mensagens paradas em estado sem dono.
- **SC-003**: Estado de entrega alcança o valor final correto em **≥ 99%** das mensagens de uma
  rodada de 20, e **zero** regressões de estado observadas na tela.
- **SC-004**: O intervalo medido entre saídas consecutivas por canal migrado respeita o
  espaçamento configurado em **100%** das amostras de uma rajada de 50 mensagens; **zero** envios
  fora da janela de horário.
- **SC-005**: **Zero** envios por canal migrado saindo por caminho que escapa das travas de vazão —
  provado por varredura mecânica, não por inspeção.
- **SC-006**: Numa conta nova, o QR code aparece na tela em **≤ 15 s** a partir do clique, e a
  jornada login → primeira conversa atendida continua **≤ 10 min**, com contagem de passos de tela
  **idêntica** à de antes da feature.
- **SC-007**: **Zero** ocorrências de nome de provedor em texto visível ao usuário nas telas de
  conexão e onboarding.
- **SC-008**: Falha de provisionamento em **10 de 10** tentativas forçadas não deixa canal órfão no
  CRM nem instância órfã no provedor.
- **SC-009**: Reverter um canal ao caminho antigo no meio de tráfego preserva **100%** das
  mensagens em voo e produz **zero** duplicatas — provado com contagem antes/depois.
- **SC-010**: Imagem, documento e áudio enviados por canal migrado abrem no aparelho do
  destinatário em **3 de 3** tipos testados.
- **SC-011**: Com o gateway derrubado, **100%** das tentativas de envio terminam em estado
  reagendável e **um** aviso aparece na Central — nenhuma mensagem perdida em silêncio.
- **SC-012**: A suíte inteira passa, e **cada teste novo desta feature foi confirmado por
  sabotagem** — ficou vermelho quando a implementação foi quebrada de propósito (Princípio XI).

---

## Assumptions

- **A frente 1 é dependência externa e será rastreada como tal.** A implementação do
  provisionamento vive no `gateway_go`. Esta spec declara o contrato; o cronograma dela não está
  sob controle deste repo. Se F1 não sair, F2 e F3 não têm ambiente possível — do mesmo jeito que
  hoje bloqueiam as últimas tarefas da spec 001.
- **A dívida de vazão do compositor humano, da integração externa e do runtime antigo é
  pré-existente.** A migração não a cria e não pode agravá-la. Fechá-la aqui é escopo adicional
  desejável, mas declarado à parte para não inflar esta feature.
- **O canal de validação é WhatsApp não-oficial via gateway.** Instagram, Messenger e canal oficial
  já aparecem no vocabulário, mas esta spec não os entrega.
- **A coexistência é por canal e por tempo indeterminado.** Não há data para desligar o caminho
  antigo. Ele sai quando o último canal migrar, não antes.
- **O gateway não ganha controle de vazão.** Ele não tem nenhum hoje, e o lugar certo desse
  controle é o CRM, que é quem conhece aquecimento, janela e histórico do número. Esta spec assume
  que continua assim.
- **Números de teste**: o par autorizado para prova real é o número conectado da conta de teste e o
  destino já usado na spec 001.
- **Nada de cobrança entra aqui** (Princípio XIII). Se um dia o envio depender de assinatura ativa,
  isso chega por contrato HTTP do Cotador, com degradação legível.

---

## Fora de escopo

- Implementar o provisionamento **dentro** do `gateway_go` — é o outro repo.
- Desligar o caminho antigo ou remover o cliente do provedor atual.
- Migrar Instagram, Messenger ou canal oficial.
- Unificar as três implementações independentes de controle de vazão que hoje coexistem.
- Qualquer coisa de assinatura, plano ou pagamento.

---

## Estado da entrega (2026-08-08)

**Fases 0–5: completas.** As três frentes (escrita direta no banco, envio, conexão) mais as
transversais, com 4 migrations (0127–0130) cada uma com a tripla completa, e sabotagem executada em
cada fatia.

**Fase 6 (execução medida): 9 de 10.** T060, T061, T062, T064, T065, T066, T067, T068, T069 medidas
com número real, gateway real e provedor real. T063 em 2 de 5 casos — o ambiente sobe por script, o
gap de produto foi encontrado e corrigido, e o caso do QR segue sem diagnóstico.

### O que a execução achou, e nenhum teste unitário acharia

Cinco defeitos de PRODUTO, todos na **costura** entre peças que passavam individualmente:

1. **Botão de conectar morto na instalação migrada** — a tela perguntava pelo transporte antigo em
   vez de perguntar se existe *algum* caminho de provisionamento. Tela certa, botão certo, e o
   corretor sem conseguir clicar.
2. **Reconciliação olhando o passado imediato** — o provedor leva ~25 min para indexar mensagem
   enviada por API. Varrer até `agora` declararia faltante tudo o que acabou de sair, em toda
   rodada, e o alarme de divergência viraria ruído constante.
3. **Estado do gateway nunca chegando à coluna que a tela lê** — a linha nascia `STARTING` e nada a
   movia.
4. **`select` sem a coluna que o próprio ramo novo precisa** — o mesmo modo de falha que a T035 já
   havia custado uma vez.
5. **Impasse `created` × `SCAN_QR_CODE`** — a tela esperava um estado que só mudava por causa do
   pedido que ela não fazia.

**A lição de método** está em `CLAUDE.md` › "Como medir sem produzir verde falso": as regras vieram
de quatro verdes falsos meus nesta mesma sessão, e cada uma é barata de seguir e cara de descobrir.

### O que falta, e de que depende

| Item | Depende de |
|---|---|
| T063 (3 casos) | Diagnóstico do caso do QR — ler `test-results/**/error-context.md` |

Nada mais. As oito outras tarefas da fase estão medidas, e o que restou não é bloqueio de recurso.
