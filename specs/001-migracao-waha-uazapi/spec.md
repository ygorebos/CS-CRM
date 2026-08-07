# Feature Specification: Recebimento unificado pelo gateway — envelope normalizado e ingest único

**Feature Directory**: `specs/001-migracao-waha-uazapi/`

**Created**: 2026-08-07

**Status**: Draft

**Input**: Decisão do dono do produto em 2026-08-07: *"vamos passar a utilizar o Gateway Go como o
receptor geral de todas as mensagens e demais WebHooks e normalização dessas informações que vão
ser salvas no banco de dados aqui do CRM."*

**Missão que serve (Princípio IX)**: as duas. Sem recebimento confiável não existe nem *converter*
nem *assistir* — é a tubulação de onde ambas bebem.

**Onde cai no teto de 10 minutos (Princípio VIII)**: no trecho mais crítico da jornada de
estreia — *conectar canal → primeira mensagem aparece*. Esta feature **não pode** acrescentar
nenhum passo de configuração ao corretor: se ele precisar saber que existe um gateway, a feature
falhou.

**Análises que a fundamentam**: [`analise-complexidade.md`](./analise-complexidade.md) (caminho
direto à uazapi, descartado) e
[`analise-gateway-go-recebimentos.md`](./analise-gateway-go-recebimentos.md) (arquitetura A,
recomendada e agora ratificada na constituição v1.1.0).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A primeira mensagem real atravessa a costura nova (Priority: P1)

Um corretor com um número já conectado recebe uma mensagem de WhatsApp de um interessado. A
mensagem entra pelo gateway, é normalizada e aparece no inbox do CRM — com contato, conversa e
corpo corretos — sem que o corretor tenha feito nada diferente do que já fazia.

**Why this priority**: é a costura inteira em um fio. Enquanto ela não fecha, todo o resto da
feature é hipótese. É também o spike que o Princípio "duas jornadas é o teto" exige quando o risco
domina o custo: se a costura não fechar, o aprendizado custou uma fatia e não o projeto.

**Independent Test**: mandar uma mensagem real de um celular para o número conectado e verificar,
**pela tela do inbox**, que ela aparece com o texto certo, no contato certo, uma única vez.
Reenviar o mesmo evento e confirmar que continua uma só.

**Acceptance Scenarios**:

1. **Given** um canal conectado a uma organização, **When** chega uma mensagem de texto de um
   número novo, **Then** o inbox do CRM mostra a mensagem com um contato criado, uma conversa
   aberta e o corpo idêntico ao enviado.
2. **Given** a mesma mensagem já ingerida, **When** o gateway reentrega o mesmo evento, **Then** o
   inbox continua com exatamente uma mensagem e nenhum erro é reportado ao gateway.
3. **Given** um contato que já existe com nome definido por um humano no CRM, **When** chega
   mensagem dele, **Then** o nome definido pelo humano **não** é sobrescrito pelo nome que veio do
   canal.
4. **Given** a mensagem entregue ao CRM, **When** a ingestão termina, **Then** a cadeia viva
   dispara como no caminho antigo — agente responde se configurado, atividade aparece na timeline,
   e o evento fica registrado para auditoria.

---

### User Story 2 - Nenhuma mensagem se perde quando o CRM fica fora do ar (Priority: P2)

O CRM fica indisponível por alguns minutos (deploy, reinício, queda). As mensagens que chegaram
nesse intervalo entram no inbox assim que o CRM volta, sem intervenção de ninguém.

**Why this priority**: é o que separa "funciona na demo" de "pode carregar operação real". O
encaminhamento atual do gateway é `fire-and-forget` com timeout de 5 segundos e o erro vira apenas
uma linha de log — CRM fora do ar por 30 segundos significa mensagem perdida **para sempre**, e
mensagem perdida no WhatsApp é venda perdida sem ninguém saber que existiu.

**Independent Test**: derrubar o CRM, enviar N mensagens reais, subir o CRM, e verificar pela tela
que as N aparecem no inbox, na ordem, sem duplicata.

**Acceptance Scenarios**:

1. **Given** o CRM indisponível, **When** chega uma mensagem, **Then** a entrega é registrada como
   pendente e reagendada — nada é descartado em silêncio.
2. **Given** entregas pendentes acumuladas, **When** o CRM volta, **Then** todas são entregues e
   cada uma aparece uma única vez no inbox.
3. **Given** uma entrega que falhou além do limite de tentativas, **When** o limite é atingido,
   **Then** ela vai para uma fila de descarte visível e **alguém é avisado** — não some.
4. **Given** o CRM respondendo lentamente, **When** a entrega excede o tempo limite, **Then** ela é
   tratada como falha reagendável e não como sucesso.

---

### User Story 3 - Webhook forjado não entra, e não entra em tenant alheio (Priority: P2)

Alguém que descobriu a URL de recebimento do CRM tenta injetar uma mensagem falsa. A tentativa é
recusada. E uma entrega legítima destinada à organização A nunca aparece na organização B.

**Why this priority**: mesma prioridade do P2 anterior porque é a mesma classe de dano — só que
irreversível. O CRM tem webhook fail-closed por doutrina, e a versão fail-open que existiu antes
permitia injetar mensagem falsa em CRM alheio. O encaminhamento do gateway hoje **não assina
nada**: adotá-lo como está reabriria exatamente esse buraco.

**Independent Test**: um receptor/emissor HTTP real dispara três requisições contra a rota nova —
sem assinatura, com assinatura errada, e com assinatura válida de outro tenant. As três são
recusadas; a quarta, legítima, é aceita.

**Acceptance Scenarios**:

1. **Given** a rota de recebimento do CRM, **When** chega uma entrega sem prova de autenticidade,
   **Then** é recusada e nada é gravado.
2. **Given** a rota, **When** chega uma entrega com prova inválida ou expirada, **Then** é recusada
   e nada é gravado.
3. **Given** uma entrega válida, **When** o corpo indica uma organização diferente da que a
   credencial identifica, **Then** vale a credencial e a tentativa é recusada e registrada.
4. **Given** o segredo de assinatura ausente na configuração, **When** chega qualquer entrega,
   **Then** o CRM recusa tudo (fecha), nunca aceita tudo.

---

### User Story 4 - Canal novo chega ao mesmo inbox sem código de ingestão novo (Priority: P3)

Uma mensagem de Instagram Direct chega ao inbox do corretor pelo mesmo caminho da mensagem de
WhatsApp, e é atendida pelo mesmo agente, no mesmo lugar.

**Why this priority**: é o retorno do investimento. O gateway já tem quatro normalizadores
escritos e testados; se o CRM tiver um ingest contra um contrato único, canal novo passa a custar
aproximadamente zero aqui. Depende de US1 e por isso vem depois — mas é a razão pela qual a
arquitetura foi escolhida.

**Independent Test**: entregar ao CRM um envelope normalizado de um canal diferente de WhatsApp e
verificar pela tela que a conversa aparece no inbox identificada com o canal correto, sem nenhuma
linha de ingestão específica daquele canal.

**Acceptance Scenarios**:

1. **Given** um canal suportado pelo gateway e ainda desconhecido do CRM, **When** chega um
   envelope normalizado dele, **Then** a mensagem entra no inbox identificada pelo canal de origem.
2. **Given** um tipo de mensagem que o CRM não reconhece, **When** ele chega, **Then** a mensagem é
   preservada com o conteúdo disponível e sinalizada como tipo não suportado — **nunca descartada**.
3. **Given** uma mensagem de grupo, **When** ela chega, **Then** o CRM segue a doutrina vigente
   para grupos e a decisão é registrada de forma auditável, em vez de falhar silenciosamente.

---

### User Story 5 - Mídia recebida abre no CRM (Priority: P3)

O interessado manda uma foto do documento, ou um áudio. O corretor abre o anexo dentro do CRM e
ele carrega.

**Why this priority**: no nicho, foto de carteirinha e áudio são o formato dominante da conversa
real. Mas depende de US1 e tem risco próprio: a garantia atual contra requisição forjada para a
rede interna depende de a origem da mídia estar na rede interna, o que deixa de ser verdade
quando a origem passa a ser o gateway.

**Independent Test**: enviar imagem, áudio e documento reais; abrir os três pela tela do CRM;
confirmar que carregam e que o endereço servido expira.

**Acceptance Scenarios**:

1. **Given** uma mensagem com imagem, **When** ela é ingerida, **Then** o arquivo fica acessível
   pelo CRM por endereço temporário e assinado, e não por endereço público permanente.
2. **Given** um envelope cuja referência de mídia aponta para um destino não permitido, **When** o
   CRM tenta buscar o arquivo, **Then** a busca é recusada e a mensagem entra sem o anexo, com o
   motivo registrado.
3. **Given** falha ao baixar a mídia, **When** a ingestão termina, **Then** a mensagem entra assim
   mesmo com marcação de anexo indisponível — a conversa nunca some por causa do arquivo.

---

### User Story 6 - Status de entrega e mensagem digitada no celular ficam corretos (Priority: P4)

O corretor vê que a mensagem foi entregue e lida. E quando ele responde pelo celular, em vez de
pelo CRM, essa resposta aparece na conversa do CRM sem virar duplicata.

**Why this priority**: é acabamento de confiança, não de tubulação — a conversa já funciona sem
isso. Mas sem isso o corretor deixa de confiar no que a tela mostra, e volta pro celular.

**Independent Test**: enviar pelo CRM e conferir a evolução do estado na tela; depois responder
pelo celular e conferir que aparece uma vez só, do lado certo.

**Acceptance Scenarios**:

1. **Given** uma mensagem enviada pelo CRM, **When** chega a confirmação de entrega e depois a de
   leitura, **Then** o estado exibido evolui e nunca regride.
2. **Given** uma resposta digitada pelo corretor no celular, **When** ela é ingerida, **Then**
   aparece uma única vez na conversa, atribuída ao corretor.
3. **Given** uma confirmação de estado para uma mensagem que o CRM ainda não conhece, **When** ela
   chega, **Then** é tratada sem erro e sem criar mensagem fantasma.

---

### Edge Cases

- **Entrega fora de ordem**: a confirmação de leitura chega antes da mensagem. O estado não pode
  regredir quando a mensagem chegar depois.
- **Mesmo evento por dois caminhos durante a transição**: o caminho legado e o gateway entregam a
  mesma mensagem. A idempotência por identificador externo é a única coisa que impede duplicata —
  e precisa valer para os dois caminhos.
- **Envelope válido para uma conexão que o CRM não conhece**: chega assinatura correta mas a
  conexão não está mapeada para nenhuma organização. Recusa explícita e visível, nunca adivinhação.
- **Mesmo contato chegando com duas grafias de identificador** (número canônico × identificador
  interno do canal): não pode partir o histórico em duas conversas.
- **Envelope com campo novo que o CRM não conhece**: versão nova do gateway não pode derrubar a
  ingestão do CRM.
- **Corpo gigante ou mídia enorme**: limite explícito, recusa clara, sem estourar memória.
- **Rajada** (campanha respondida por muita gente ao mesmo tempo): a fila absorve sem perder, e o
  ritmo de resposta do agente continua obedecendo os limites anti-banimento existentes.
- **Relógio dessincronizado** entre gateway e CRM: a validade da assinatura não pode recusar
  entrega legítima por diferença pequena de horário, nem aceitar reenvio antigo.
- **Gateway reiniciado com entregas pendentes em memória**: pendência precisa sobreviver ao
  reinício, ou a garantia da US2 é falsa.

## Requirements *(mandatory)*

### Functional Requirements

**Contrato de entrega**

- **FR-001**: O gateway MUST entregar ao CRM o **envelope normalizado**, não o corpo cru do
  provedor. Entrega de corpo cru MUST NOT ser aceita pela rota nova.
- **FR-002**: O envelope MUST identificar, no mínimo: origem do canal, conexão de origem,
  identificador externo único da mensagem, sentido, tipo, conteúdo, referências de mídia, estado de
  entrega, código e detalhe de erro quando houver, marcação de grupo e momento de ocorrência.
- **FR-003**: O envelope MUST ser versionado, e o CRM MUST aceitar campos desconhecidos sem falhar
  (compatibilidade para frente).
- **FR-004**: O CRM MUST expor **uma única** rota de recebimento para todo o tráfego vindo do
  gateway, e **um único** caminho de ingestão a partir dela — independentemente do canal.
- **FR-005**: Código novo do CRM MUST NOT interpretar payload cru de provedor. Os caminhos legados
  existentes continuam válidos até serem desligados (FR-030).

**Autenticidade e isolamento**

- **FR-006**: O gateway MUST assinar cada entrega, e o CRM MUST verificar a assinatura com
  comparação resistente a análise de tempo.
- **FR-007**: O CRM MUST ser **fail-closed**: segredo ausente, malformado ou assinatura inválida
  resultam em recusa. MUST NOT existir modo que aceite entrega não verificada.
- **FR-008**: A assinatura MUST cobrir o corpo **e** um instante de emissão, e entregas fora da
  janela de validade MUST ser recusadas (proteção contra reenvio).
- **FR-009**: A organização de destino MUST ser resolvida de fonte confiável — a credencial e o
  mapeamento de conexão — e **NUNCA** do corpo da entrega.
- **FR-010**: Entrega cuja conexão não esteja mapeada para nenhuma organização MUST ser recusada com
  motivo explícito e registrada, nunca associada por aproximação.
- **FR-011**: O segredo de assinatura MUST ser único por conexão (ou por organização), de modo que
  vazamento em um tenant não permita injetar em outro.

**Confiabilidade da entrega**

- **FR-012**: O CRM MUST responder à entrega **antes** de executar a cadeia de efeitos (ACK
  primeiro). Processamento MUST ocorrer fora do ciclo de resposta.
- **FR-013**: O gateway MUST persistir cada entrega pendente antes de tentar enviá-la, e a
  pendência MUST sobreviver ao reinício do processo.
- **FR-014**: Falha de entrega MUST ser reagendada com espera crescente, até um limite configurável
  de tentativas.
- **FR-015**: Entrega que esgotou as tentativas MUST ir para uma fila de descarte inspecionável, e
  MUST gerar aviso operacional — nunca sumir em log.
- **FR-016**: A entrega MUST ser idempotente ponta a ponta: reentregar o mesmo evento MUST NOT
  produzir segunda mensagem no inbox, e o CRM MUST responder sucesso à reentrega.
- **FR-017**: O CRM MUST manter registro auditável de cada entrega recebida (aceita ou recusada),
  suficiente para reconstruir o que aconteceu.

**Ingestão e dados**

- **FR-018**: A ingestão MUST criar ou reaproveitar contato e conversa e gravar a mensagem, com
  isolamento por organização em toda escrita.
- **FR-019**: Nome de contato definido por um humano MUST NOT ser sobrescrito por nome vindo do
  canal. O nome vindo do canal é armazenado à parte.
- **FR-020**: Quando o identificador de contato for canonicalizado durante a ingestão, o valor
  **resultante** MUST ser o usado para gravar a mensagem, para não partir o histórico.
- **FR-021**: Tipo de mensagem desconhecido MUST ser preservado com o conteúdo disponível e
  sinalizado, nunca descartado.
- **FR-022**: A ingestão MUST disparar a mesma cadeia viva do caminho atual — turno do agente,
  reatividade de follow-up, guardrails, atividade na timeline, auditoria e evento na fila.
- **FR-023**: Confirmação de estado MUST atualizar a mensagem correspondente sem regredir o estado,
  e MUST ser tolerada quando a mensagem ainda não é conhecida.
- **FR-024**: Mensagem originada do próprio número por fora do CRM MUST aparecer uma única vez, do
  lado correto da conversa.
- **FR-025**: Mídia MUST ser trazida para o armazenamento do CRM e servida por endereço temporário
  assinado; destino de download não permitido MUST ser recusado. Falha de mídia MUST NOT impedir a
  entrada da mensagem.

**Operação e produto**

- **FR-026**: O gateway MUST poder operar em modo que **normaliza e entrega sem persistir** em
  banco próprio, para poder ser embarcado na instalação do CRM.
- **FR-027**: A instalação self-host MUST subir o gateway junto do CRM, sem passo manual adicional
  para o corretor, e a ausência do gateway MUST ser visível como problema de configuração na tela —
  nunca como silêncio.
- **FR-028**: O corretor MUST NOT precisar conhecer, configurar ou nomear o gateway em nenhum
  momento da jornada de estreia.
- **FR-029**: Os dois caminhos de recebimento (legado e gateway) MUST poder coexistir, com chave de
  corte por conexão, permitindo migrar uma conexão por vez e voltar atrás.
- **FR-030**: O desligamento do caminho legado MUST ser um passo explícito e posterior, condicionado
  a evidência de que o caminho novo funciona em produção.

**Prova (Princípio XI)**

- **FR-031**: Cada história MUST ter teste automatizado que falharia se a feature não existisse, e
  os testes MUST ser confirmados por sabotagem deliberada do código que vigiam.
- **FR-032**: A recusa de entrega não autêntica e o não-vazamento entre organizações MUST ser
  cobertos por teste de invariante executado no portão que roda contra banco real.
- **FR-033**: O efeito colateral externo (entrega HTTP do gateway ao CRM) MUST ser provado com
  emissor e receptor reais, não com simulação.

### Key Entities

- **Envelope normalizado**: a unidade de informação que o gateway entrega. Representa um
  acontecimento de canal — mensagem nova, mudança de estado de entrega, ou marca de leitura — em
  vocabulário único, independente do provedor de origem.
- **Entrega**: uma tentativa de levar um envelope do gateway ao CRM. Tem estado (pendente, entregue,
  falha, descartada), contagem de tentativas e momento da próxima tentativa. É o que garante a US2.
- **Mapeamento conexão → organização**: a ligação entre uma conexão de canal conhecida pelo gateway
  e a organização do CRM que a possui. É a fonte confiável do isolamento (FR-009) e o que impede
  entrega cruzar tenant.
- **Segredo de assinatura**: credencial compartilhada entre gateway e CRM, por conexão, usada para
  provar autenticidade da entrega.
- **Registro de recebimento**: trilha auditável do que chegou, o que foi aceito, o que foi recusado
  e por quê.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Uma mensagem real enviada a um número conectado aparece no inbox do CRM em **até 5
  segundos** em 95% dos casos, medido pela tela.
- **SC-002**: **Zero** mensagens duplicadas em um teste que reentrega deliberadamente 100% dos
  eventos de uma sessão de conversa.
- **SC-003**: **Zero** mensagens perdidas em um teste com o CRM indisponível por 5 minutos: 100%
  das mensagens enviadas no intervalo aparecem no inbox após o retorno.
- **SC-004**: **100%** das tentativas de entrega sem assinatura, com assinatura inválida e com
  assinatura de outro tenant são recusadas; nenhuma grava dado.
- **SC-005**: **Zero** linhas de uma organização visíveis para outra, provado com duas organizações
  reais recebendo tráfego simultâneo, com caso de controle mostrando que as linhas da segunda
  existem.
- **SC-006**: O corretor completa *login → canal conectado → primeira mensagem atendida pelo agente*
  em **≤10 minutos**, cronometrado em instalação fresca — **sem regressão** em relação ao tempo
  medido antes desta feature.
- **SC-007**: **Zero** passos novos na jornada de estreia atribuíveis ao gateway, verificado
  contando os passos da tela antes e depois.
- **SC-008**: Um canal adicional suportado pelo gateway passa a chegar ao inbox com **zero** linhas
  de código de ingestão específicas daquele canal.
- **SC-009**: **100%** das mensagens com anexo abrem pela tela do CRM; falha de anexo nunca impede a
  mensagem de aparecer.
- **SC-010**: Em rajada de 200 mensagens em 60 segundos, **100%** entram no inbox e nenhuma é
  entregue em duplicata.
- **SC-011**: A suíte inteira do repositório fica verde, e cada teste novo desta feature fica
  vermelho quando o código que ele vigia é sabotado — **100%** dos testes novos confirmados assim.
- **SC-012**: Toda entrega recusada é explicável a partir do registro auditável, sem consultar log
  de aplicação: **100%** das recusas de um teste de segurança são reconstruídas a partir do registro.

## Assumptions

- **O gateway é código próprio e pode virar dependência de runtime do CRM.** Ele tem imagem
  container própria e será embarcado na instalação, não consumido como serviço de terceiro. Isso
  responde a decisão nº 1 da análise: **um gateway por instalação**, não um compartilhado — um
  gateway compartilhado faria o CRM self-hosted de um cliente mandar tráfego para infraestrutura
  nossa, o que mata a independência do self-host e cria dado pessoal em trânsito por terceiro.
- **"Demais webhooks" significa tráfego de canal conversacional.** Entram: mensagens, estados de
  entrega e marcas de leitura de qualquer canal. **Não** entram: webhooks de e-commerce e os
  retornos de LGPD exigidos em endereços fixos por plataformas externas — o gateway não tem
  normalizador para eles, roteá-los por ali seria custo sem ganho, e alguns não podem mudar de
  endereço. Se a intenção for literalmente todos, é uma feature separada e precisa ser dita.
- **O ciclo de vida da conexão (conectar número, ler QR, ver status, reconectar) fica FORA desta
  feature.** Ela trata de **recebimento**. Consequência declarada: enquanto o painel de conexão dos
  provedores novos não existir, esses provedores **não são oferecidos na tela**, e a jornada de
  estreia continua rodando sobre o provedor que já é conectável hoje — é assim que o teto de 10
  minutos fica preservado em vez de quebrado.
- **A doutrina atual de grupos é mantida** (o CRM não vincula conversa de grupo ao CRM), mesmo o
  gateway sabendo tratá-los. Mudar isso é decisão de produto separada.
- **O caminho legado não é removido nesta feature.** Ele é desligado depois, com evidência.
- **Envio continua pelo caminho atual nesta feature.** A costura de envio já existe no CRM e não é
  o gargalo; unificar envio pelo gateway é fatia posterior.
- **Instalações existentes precisam de caminho de atualização** que não perca mensagem durante a
  virada — daí a chave de corte por conexão (FR-029).
