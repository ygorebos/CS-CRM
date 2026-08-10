# Feature Specification: Tipos de mensagem do WhatsApp — envio completo e leitura fiel

**Feature Branch**: `006-tipos-de-mensagem-whatsapp`

**Created**: 2026-08-09

**Status**: Draft

**Input**: User description: "vamos analisar se todos os tipos de envios estão sendo possíveis serem feitos pelo whatsapp. Os que estiverem faltando, vamos implementar. E também vamos analisar como a visualização de resposta a mensagens, mensagem deletada, reação a mensagem etc aparecem e como podem ser feito o envio pelo usuário"

---

## Contexto medido (2026-08-09)

O levantamento abaixo foi feito lendo o código dos dois lados (CRM e porta de tráfego), não
por suposição. Ele é o motivo de cada requisito desta spec existir.

### O que o corretor consegue enviar hoje, pela tela

Texto, foto, vídeo, documento e áudio gravado. Mais nada. A resposta rápida do `/atalho`
é texto interpolado — não é um tipo de mensagem diferente.

### O que o canal de WhatsApp aceita receber do CRM

O canal aceita **17 formas de mensagem** e ainda um campo de **citação** (responder uma
mensagem específica). O CRM usa **5** delas e nunca preenche a citação.

### Os três buracos, por natureza

1. **Declarado e inenviável.** `localização` e `contato` já constam da lista de tipos que a
   API do CRM aceita, mas o pedido não tem onde carregar coordenada nem cartão de contato.
   Um envio desses hoje sai sem a carga obrigatória e o canal recusa. É pior que ausência:
   parece existir.
2. **Existe no canal, não existe aqui.** Citação, figurinha, menu de botões, botão de link,
   pedido de localização. O canal executa; o CRM nunca pede.
3. **Não existe em lugar nenhum ainda.** Reagir com emoji e apagar para todos: nem o CRM
   oferece, nem a porta de tráfego expõe a operação para conversa comum. **Por decisão de
   escopo, o ENVIO dessas duas fica fora desta spec** — ver "Fora de escopo".

### O que chega do cliente e some na tela

| O cliente faz | O que o CRM guarda | O que o corretor vê |
|---|---|---|
| Responde citando uma mensagem | o vínculo com a mensagem citada | **nada** — a citação é invisível; lê-se "pode ser" sem saber a qual pergunta |
| Reage com emoji | uma mensagem separada, cujo corpo é o emoji | um emoji **solto** na linha do tempo, como se fosse mensagem nova, sem dizer a quê reagiu |
| Apaga uma mensagem para todos | uma linha marcada como evento do sistema, sem corpo | uma **bolha em branco** |
| Manda localização | as coordenadas e o nome do lugar | uma **bolha em branco** |
| Manda um cartão de contato | o registro do tipo | uma **bolha em branco** ou um anexo sem arquivo |
| Clica num botão / edita a mensagem | uma linha marcada como evento do sistema | bolha muda ou em branco |

Bolha em branco não é detalhe estético: é o corretor perdendo o que o cliente disse, sem
nenhum sinal de que perdeu.

**Ler tudo isso não depende da porta de tráfego** — a informação já chega e já é guardada.
É por isso que a leitura é P1 e sobrevive inteira ao corte de escopo do envio.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Ler a conversa inteira, sem buraco (Priority: P1)

O corretor abre uma conversa em que o cliente citou uma mensagem antiga, reagiu com emoji a
uma proposta, mandou a localização da clínica e depois apagou uma mensagem. Ele entende
tudo isso pela tela: vê o trecho citado acima da resposta, vê o emoji preso à mensagem que
o recebeu, vê o lugar com nome e endereço, e vê o que foi apagado, marcado como apagado.

**Why this priority**: é o único item em que o defeito atual **perde informação do
cliente**. Enviar de menos é limitação; ler errado é atender errado. Vale para 100% das
conversas, incluindo as que já existem — não depende de nenhum envio novo nem de nenhuma
mudança na porta de tráfego.

**Independent Test**: numa conta nova, com um aparelho real do outro lado, o cliente
executa as seis ações da tabela acima. Cada uma tem representação própria e legível na
tela. Zero bolhas em branco.

**Acceptance Scenarios**:

1. **Given** uma conversa com uma mensagem antiga do corretor, **When** o cliente responde
   citando essa mensagem, **Then** a bolha da resposta mostra o trecho citado acima do
   texto, identificando de quem era.
2. **Given** uma mensagem do corretor visível na conversa, **When** o cliente reage com
   emoji, **Then** o emoji aparece **preso àquela mensagem** e **não** como uma mensagem
   nova na linha do tempo.
3. **Given** a reação já visível, **When** o cliente troca o emoji ou remove a reação,
   **Then** a tela reflete a troca ou a remoção, sem deixar o emoji antigo para trás.
4. **Given** uma mensagem qualquer da conversa, **When** o cliente a apaga para todos,
   **Then** a bolha passa a indicar explicitamente que a mensagem foi apagada pelo contato,
   **mantendo o conteúdo original visível e marcado**, com autor e horário preservados.
5. **Given** o cliente compartilhando a localização de uma clínica, **When** a mensagem
   chega, **Then** a bolha mostra nome e endereço do lugar e permite abrir o local num mapa.
6. **Given** o cliente enviando um cartão de contato, **When** a mensagem chega, **Then** a
   bolha mostra nome e telefone, e o corretor consegue copiar o telefone.
7. **Given** um tipo que o canal passe a entregar e que esta versão do CRM não conheça,
   **When** a mensagem chega, **Then** a bolha diz que chegou algo que ainda não sabemos
   exibir — nunca fica em branco.

---

### User Story 2 — Responder citando (Priority: P1)

Numa conversa com muitas idas e vindas, o corretor aponta a mensagem exata a que está
respondendo. O cliente recebe a resposta com a citação, como qualquer WhatsApp.

**Why this priority**: é a ação que o corretor mais sente falta em conversa longa, é a que o
canal já executa sem nenhum trabalho de terceiros, e sem ela toda resposta a um cliente que
mandou cinco perguntas seguidas fica ambígua.

**Independent Test**: numa conta nova, o corretor escolhe uma mensagem recebida, responde
citando e confere no aparelho real que a citação chegou apontando para a mensagem certa.

**Acceptance Scenarios**:

1. **Given** uma mensagem na conversa, **When** o corretor aciona "responder" nela, **Then**
   o campo de escrita mostra o trecho citado e de quem é, com opção de cancelar a citação.
2. **Given** a citação preparada, **When** o corretor envia, **Then** a mensagem chega ao
   aparelho do cliente **com** a citação apontando para a mensagem original.
3. **Given** a mensagem enviada com citação, **When** a tela atualiza, **Then** a própria
   bolha do corretor mostra o trecho citado, igual à do cliente.
4. **Given** uma mensagem cuja mídia ainda não terminou de baixar, **When** o corretor a
   cita, **Then** a citação identifica o tipo do anexo em vez de ficar vazia.
5. **Given** uma tentativa de citar uma mensagem que o canal não reconhece mais, **When** o
   envio falha, **Then** o corretor vê o motivo e a mensagem **não** sai sem a citação em
   silêncio.

---

### User Story 3 — Mandar o que o canal já sabe entregar (Priority: P2)

O corretor manda a localização do escritório, o cartão de contato de um consultor, e uma
figurinha — sem sair do CRM e sem descobrir do jeito ruim que o tipo "existe mas não vai".

**Why this priority**: fecha o buraco mais constrangedor do levantamento — dois tipos
anunciados pela API do CRM e impossíveis de enviar. Fica atrás de citar porque o uso diário
é menor.

**Independent Test**: numa conta nova, cada um dos três tipos é enviado pela tela e chega
íntegro ao aparelho real: o mapa abre no lugar certo, o contato entra na agenda, a figurinha
aparece como figurinha (não como imagem).

**Acceptance Scenarios**:

1. **Given** o corretor querendo mandar um endereço, **When** ele escolhe "localização" e
   informa o lugar, **Then** o cliente recebe uma localização que abre no mapa.
2. **Given** o corretor querendo indicar alguém, **When** ele escolhe "contato" e seleciona
   nome e telefone, **Then** o cliente recebe um cartão que salva na agenda.
3. **Given** um arquivo de figurinha, **When** o corretor o envia, **Then** ele chega **como
   figurinha**, sem moldura de imagem.
4. **Given** qualquer tipo oferecido na tela, **When** o corretor o envia, **Then** ele
   **nunca** é recusado pelo canal por falta de campo obrigatório.
5. **Given** um tipo que o canal daquela conversa não suporta, **When** o corretor abre as
   opções de envio, **Then** o tipo não aparece.

---

### User Story 4 — Botões e pedidos guiados (Priority: P3)

Em vez de pedir "responda 1, 2 ou 3", o corretor manda opções clicáveis, um botão que leva
ao formulário de cotação, ou um pedido de localização — e a resposta do cliente entra na
conversa de forma legível.

**Why this priority**: é ganho de conversão, não de correção. Fica por último porque a
resposta a um botão hoje entra como evento mudo do sistema — ou seja, **depende** da
User Story 1 estar pronta para não piorar a leitura da conversa.

**Independent Test**: numa conta nova, o corretor manda um menu de opções e um botão de
link; o clique do cliente aparece na conversa dizendo qual opção foi escolhida.

**Acceptance Scenarios**:

1. **Given** o corretor querendo oferecer opções, **When** ele monta um menu com até o
   limite do canal e envia, **Then** o cliente recebe opções clicáveis.
2. **Given** o menu entregue, **When** o cliente clica numa opção, **Then** a conversa mostra
   qual opção ele escolheu, em texto legível.
3. **Given** o corretor querendo levar o cliente a um formulário, **When** ele envia um botão
   de link, **Then** o cliente recebe o botão com o rótulo escrito pelo corretor.
4. **Given** o corretor precisando do endereço do cliente, **When** ele envia um pedido de
   localização, **Then** o cliente recebe o pedido e a localização respondida entra na
   conversa como localização legível (User Story 1).

---

### Edge Cases

- **Reação a mensagem que o CRM nunca viu** (anterior à conexão do canal, ou perdida): a
  reação não pode virar bolha solta nem sumir sem rastro.
- **Reação trocada e reação removida**: o canal reenvia o evento; o estado final na tela é o
  último, não a soma.
- **Citação de mensagem apagada**: a citação continua identificável, e o conteúdo citado
  segue a mesma regra da mensagem apagada (visível e marcado).
- **Citação de mensagem cuja mídia falhou ao baixar**: a citação não fica vazia.
- **Duas reações diferentes** (a do cliente e a de outro participante) na mesma mensagem.
- **Reação/citação chegando antes da mensagem-alvo** (fora de ordem na entrega): a tela não
  pode ficar com um órfão permanente.
- **Anonimização por LGPD de uma mensagem que é alvo de citação ou que foi apagada**: o que
  foi redigido não reaparece dentro do trecho citado nem sob a marca de "apagada" — a
  anonimização manda acima da preservação.
- **Contato bloqueado / anonimizado por LGPD**: nenhum envio novo escapa das travas que o
  envio de texto já respeita.
- **Conversa de grupo**: hoje o envio para grupo não é possível; as ações novas não podem
  aparecer habilitadas ali.
- **Tipo desconhecido futuro**: já coberto por US1-7 — nunca bolha em branco.

## Requirements *(mandatory)*

### Funcionais — leitura da conversa

- **FR-001**: O sistema DEVE exibir, em toda mensagem que responde a outra, o trecho citado e
  a identificação de quem escreveu o original, tanto em mensagem recebida quanto enviada.
- **FR-002**: O sistema DEVE exibir reações **presas à mensagem que as recebeu**, e NÃO como
  mensagem própria na linha do tempo.
- **FR-003**: O sistema DEVE refletir troca e remoção de reação, mantendo apenas o estado
  atual.
- **FR-004**: O sistema DEVE marcar visivelmente a mensagem que foi apagada para todos,
  preservando autor e horário original.
- **FR-005**: O conteúdo da mensagem apagada pelo contato DEVE **continuar visível na tela**,
  sob marca inequívoca de que foi apagado — o corretor precisa da evidência do que foi dito
  antes de o cliente voltar atrás. A marca DEVE deixar claro que o cliente já não vê aquilo
  no aparelho dele.
- **FR-006**: O sistema DEVE exibir localização recebida com nome e endereço do lugar, e
  oferecer abrir o local num mapa.
- **FR-007**: O sistema DEVE exibir cartão de contato recebido com nome e telefone, com o
  telefone copiável.
- **FR-008**: O sistema DEVE exibir, em texto legível, a opção que o cliente escolheu ao
  clicar num botão ou item de menu.
- **FR-009**: O sistema NÃO DEVE exibir bolha vazia em nenhuma hipótese: mensagem cujo tipo
  esta versão não sabe representar DEVE aparecer com um rótulo dizendo isso.
- **FR-010**: O sistema DEVE preservar a informação que hoje já chega e não é exibida —
  nenhum requisito acima pode ser atendido descartando dado do canal.

### Funcionais — envio

- **FR-011**: O corretor DEVE conseguir responder citando qualquer mensagem visível da
  conversa, a partir da própria mensagem.
- **FR-012**: O sistema DEVE entregar a citação ao canal; envio que perderia a citação DEVE
  falhar de forma legível em vez de sair sem ela.
- **FR-013**: O corretor DEVE conseguir enviar localização, informando o lugar.
- **FR-014**: O corretor DEVE conseguir enviar cartão de contato, com nome e telefone.
- **FR-015**: O corretor DEVE conseguir enviar figurinha, e ela DEVE chegar como figurinha.
- **FR-016**: O corretor DEVE conseguir enviar menu de opções, botão de link e pedido de
  localização.
- **FR-017**: Todo tipo oferecido na tela DEVE ser enviável de fato: nenhum tipo pode ser
  aceito pelo sistema e recusado pelo canal por falta de campo obrigatório. Tipo que o
  sistema aceita mas não consegue entregar DEVE deixar de ser aceito.
- **FR-018**: A tela DEVE oferecer apenas as ações que o canal daquela conversa suporta —
  a decisão vem da capacidade do canal, nunca do nome do provedor.
- **FR-019**: Ação indisponível por limite do canal DEVE dar motivo legível ao corretor;
  falha muda é proibida.
- **FR-020**: Todo envio novo DEVE respeitar as travas que o envio de texto já respeita:
  contato bloqueado, contato anonimizado, ritmo anti-banimento, janela de atendimento e
  permissão do usuário na conversa.
- **FR-021**: Todo envio novo DEVE deixar rastro auditável de quem enviou e quando, como
  qualquer outra mutação.
- **FR-022**: **Escopo entre repositórios**: esta spec muda **apenas o CRM** e se limita ao
  que a porta de tráfego já executa hoje. Reagir com emoji e apagar para todos **não são
  enviáveis** por esta entrega — ver "Fora de escopo".
- **FR-023**: O agente de IA NÃO DEVE ganhar automaticamente as capacidades novas: o que ele
  pode enviar continua sendo decisão explícita, fora desta spec.

### Fora de escopo (deliberado)

- **ENVIAR reação e apagar para todos.** A operação não existe na porta de tráfego para
  conversa comum, e criá-la é trabalho de outro repositório, com deploy próprio. Vira spec
  separada lá, e uma spec de consumo aqui depois. **Atenção**: *ler* reação e mensagem
  apagada do cliente **está dentro** desta spec (User Story 1) — a informação já chega.
- **Cobrança e pagamento** (botão de PIX, pedido de pagamento): dono é o Cotador
  Simplificado, não este repositório.
- **Status / stories**: é difusão, não conversa.
- **Carrossel** e **formulário de endereço**: o primeiro é exclusivo de um provedor e sem
  demanda no nicho; o segundo só funciona num país que não é o nosso.
- **Editar mensagem enviada**: primo de "apagar", mesmo motivo de escopo.
- **Grupos**: o envio para grupo já não existe hoje; esta spec não o abre.

### Key Entities

- **Mensagem**: o que foi dito, por quem, quando, em que forma (texto, foto, vídeo, áudio,
  documento, figurinha, localização, contato, menu, botão) e em que estado de entrega.
- **Citação**: o vínculo de uma mensagem com a mensagem anterior a que ela responde —
  precisa sobreviver ao alvo ser apagado ou anonimizado.
- **Reação**: emoji + quem reagiu + a qual mensagem. Tem no máximo um estado atual por
  autor e por mensagem; não é um evento acumulável.
- **Marca de apagada**: registro de que uma mensagem foi apagada no canal, com autor e
  momento — distinto de apagar a linha, e distinto de esconder o conteúdo.
- **Capacidade do canal**: o que cada canal permite (citar, figurinha, localização, contato,
  menu…), consultado antes de a tela oferecer a ação.
- **Lugar**: coordenada + nome + endereço, o suficiente para abrir num mapa.
- **Cartão de contato**: nome + telefone(s), o suficiente para salvar na agenda.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Numa conversa contendo um exemplar de **cada** forma que o canal entrega hoje,
  **zero** bolhas ficam em branco ou mudas.
- **SC-002**: 100% das reações e citações recebidas aparecem ligadas à mensagem certa —
  medido com um aparelho real do outro lado, não com dublê.
- **SC-003**: O corretor responde citando em **no máximo 2 ações** a partir da mensagem
  (acionar "responder" + enviar).
- **SC-004**: **Zero** recusas do canal por campo obrigatório ausente, em N envios cobrindo
  todos os tipos oferecidos na tela.
- **SC-005**: Mensagem apagada pelo contato aparece marcada na tela do corretor em **até 10
  segundos** após o apagamento — cronometrado por carimbo de quem não participa do laço de
  medição.
- **SC-006**: 100% dos tipos oferecidos na tela foram provados **numa conta nova, no estado
  vazio**, pelo navegador, com evidência visual — não por chamada de API.
- **SC-007**: **Zero** ações oferecidas na tela que o canal daquela conversa não suporta,
  verificado canal a canal.
- **SC-008**: Uma pessoa que nunca usou o sistema encontra "responder citando" numa mensagem
  **sem instrução**, na primeira tentativa.

## Assumptions

- O canal alvo é o WhatsApp entregue pela porta de tráfego única — é o único que a Central
  de Conexões oferece hoje. Onde a mesma capacidade existir em outros canais, ela vale por
  capacidade declarada, nunca por nome de provedor no meio da tela.
- Conversas de grupo continuam fora: o envio para grupo já é impedido hoje, e esta spec não
  muda isso.
- Mensagem apagada no WhatsApp **continua existindo no CRM** como registro, e agora também
  **continua legível na tela**, marcada. Sumir com a linha quebraria a auditoria e o
  histórico do lead; esconder o texto tiraria do corretor a evidência do que foi combinado.
- Anonimização por LGPD continua mandando acima de tudo: o que foi redigido não reaparece
  dentro de uma citação nem sob a marca de "apagada".
- Reação é estado, não histórico: a conversa mostra a reação atual, não a sequência de
  reações trocadas.
- O que o agente de IA pode enviar não muda por esta spec.
- Tipos exclusivos de um provedor entram apenas se o nicho (corretor de plano de saúde) usar
  — os que sobraram fora estão listados com o motivo.
- A porta de tráfego não muda nesta entrega. Qualquer requisito que exigisse mudança lá foi
  removido do escopo, não adiado em silêncio.
