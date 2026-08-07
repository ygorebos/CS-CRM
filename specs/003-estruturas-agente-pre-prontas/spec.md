# Feature Specification: Estruturas de agente pré-prontas (templates de partida)

**Feature Directory**: `specs/003-estruturas-agente-pre-prontas`
**Created**: 2026-08-07
**Status**: Draft
**Constituição**: v1.1.0 (`.specify/memory/constitution.md`)
**Input**: "Não vamos abandonar a autonomia do usuário. Estamos dando um template de início bem completo." — dono do produto. Foco: pequeno corretor de plano de saúde e pequenas e médias empresas; PMEs conectam mais de um número, com usuários de níveis de permissão distintos.

---

## Declarações obrigatórias da constituição

A constituição exige que toda spec responda duas perguntas no cabeçalho, sob pena de não ir a plano (`.specify/memory/constitution.md:236-237`).

### Qual missão do princípio IX cada template serve

**Cada template de partida declara UMA das duas missões — converter ou assistir — e nenhum template declara as duas.**

Isso não é preferência de desenho: é o que a aritmética do produto permite. O teto de capacidades por agente é 20 (`lib/mcp/tools/selecao-por-pacote.ts:24`), e a união das jornadas necessárias a cada missão passa desse teto:

| Combinação de jornadas | Vagas exigidas | Teto 20 |
|---|---|---|
| "Atender e responder" sozinha | 18 (17 automáticas + 1 crítica) | cabe |
| Atender + Vender (perfil converter completo) | **25** | estoura |
| Atender + Reter | **24** | estoura |
| Atender + Escalar (perfil assistir completo) | **25** | estoura |
| Atender + Vender + Escalar | **32** | estoura |

*(Medido em 2026-08-07 varrendo `lib/mcp/tools/catalogo/*.ts` — 51 capacidades, o mesmo número que `lib/mcp/tools/index.ts:80` declara. Os totais por pacote batem com o registro do próprio código em `lib/mcp/tools/selecao-por-pacote.ts:134-138`.)*

Consequência direta para esta feature: **um template não pode ser "ligue tudo"**. Ele é uma seleção curada de capacidades que cabe no teto e que serve a missão declarada. O princípio IX diz que converter e assistir "têm físicas opostas e não são fundidas" (`constitution.md:196-197`); o teto de 20 é a prova mecânica disso.

### Onde a feature cai no teto de 10 minutos do princípio VIII

**Esta feature É o teto de 10 minutos.** O princípio VIII exige que "toda feature nasce com estrutura pré-pronta que já funciona — agente, prompt, capacidades e funil vêm montados por padrão" (`constitution.md:175-176`). Hoje isso não acontece: o agente criado pelo onboarding nasce com **zero capacidades** e a instalação fresca nasce com um funil de e-commerce (evidência na seção "Estado medido hoje").

A feature entrega o passo que falta entre "o corretor terminou o wizard" e "o agente respondeu a primeira mensagem". Ela é medida pelo relógio do princípio VIII: login → primeira conversa atendida por agente, ≤10 minutos, sem suporte humano e sem editar arquivo nenhum.

---

## Estado medido hoje (por que esta feature existe)

Tudo abaixo foi medido no repositório em 2026-08-07 (HEAD `b990bd28`). Cada linha é verificável.

1. **O agente do onboarding nasce mudo.** O passo "Configurar IA" cria o agente e a v1 sem nunca gravar `tool_ids` (`app/actions/onboarding/createDefaultAgent.ts:98-116`), e o default da coluna é `'{}'` (`supabase/baseline.sql:997`). Zero capacidades = o agente não consegue nem ler o histórico da conversa nem enviar resposta.
2. **Não existe template de partida — existem 3 strings de prompt.** As únicas "opções" são `ecommerce_friendly`, `ecommerce_professional`, `support_minimal`, com corpo de um parágrafo cada, hardcoded em `app/actions/onboarding/createDefaultAgent.ts:16-20`. Nenhuma serve corretor de plano de saúde. Busca por "template"/"preset"/"pacote" em `app/onboarding`, `app/api/v1/onboarding`, `scripts/` e `supabase/` não encontra estrutura de partida nenhuma.
3. **O funil que nasce pronto é de e-commerce.** O trigger `fn_seed_default_pipeline_for_org` cria o pipeline "Pedidos" com 8 etapas — Carrinho abandonado, Aguardando pagamento, Pago, Em separação, Enviado, Entregue, Pós-venda, Cancelado (`supabase/baseline.sql:682-713`). Para um corretor de plano de saúde, esse funil está errado do primeiro clique.
4. **Pular o WhatsApp deixa o agente rascunho para sempre.** Sem canal, a v1 não publica (`app/actions/onboarding/createDefaultAgent.ts:87-88`) e o agente fica invisível para os dois runtimes. O único aviso é um badge "Rascunho" numa tela que o corretor ainda não visitou.
5. **A missão "assistir" é impossível hoje.** Ela exige resposta rastreável a um trecho do conhecimento do tenant (`constitution.md:210`), e o agente nasce sem base de conhecimento (`active_kb_version_id` NULL). Sem trecho, o princípio IX manda recusar e escalar — ou seja, hoje o agente de assistência recusaria tudo.
6. **O caminho medido até a primeira resposta é ≥8 telas** (login, welcome, WhatsApp, IA, time, done, gate de MFA obrigatório para o dono, inbox) e, se o WhatsApp for pulado, é **infinito** — nenhuma tela do wizard prova que o agente funciona, e não existe checklist de primeiros passos depois dele.
7. **O que já existe e serve de fundação** (princípio VI — reusar antes de escrever): jornadas de capacidade em linguagem de dono de negócio (`lib/mcp/tools/pacotes.ts:40-83`), a regra pura de ligar/desligar jornada com reserva de vaga para a capacidade crítica (`lib/mcp/tools/selecao-por-pacote.ts`), catálogo de skills de plataforma com **fork-on-install** e origem registrada (`lib/ai/skills/install.ts:79-107`), versões imutáveis + publicação por ponteiro (`lib/agent-engine/agent/playbook.ts:87-108`; `lib/agent-engine/agent/agent-config.ts:1-15`), e o painel que diz o que cada capacidade fez e o que fazer com isso (`lib/ai/agents/uso-de-capacidades.ts`).

**Correção de um dado da doutrina, encontrada ao medir:** `CLAUDE.md:217`, `AGENTS.md:74`, `AGENTS.md:136` e `docs/current-state.md:128` afirmam que a spec e2e `capacidades-do-agente` reprova por causa do teto de 20. **Isso não é mais verdade**: o defeito (issue #162) foi corrigido em `bf20db49` e a spec roda no CI (`.github/workflows/e2e.yml:240`). Esta feature parte da regra já corrigida (reserva de vaga em `vagasExigidasPeloPacote`), não a reinventa. A doutrina desatualizada é dívida separada, registrada em Dependências.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - O corretor sozinho, do login à primeira conversa atendida (Priority: P1)

Ana é corretora de plano de saúde, trabalha sozinha, não é desenvolvedora e não vai ler documentação. Ela acabou de receber o acesso da instalação dela. Ela quer que o WhatsApp dela comece a responder quem pergunta preço de plano — hoje, agora, sem configurar nada.

**Why this priority**: é a primeira impressão do produto e o único cenário que o princípio VIII cronometra. Se este falha, nada mais importa — o corretor abandona.

**Independent Test**: numa instalação fresca estilo VPS, com o relógio rodando desde o login, uma pessoa que nunca viu o produto escolhe um template, conecta o número e recebe uma resposta do agente a uma mensagem real. Entregue sozinho, sem nenhuma das outras histórias.

**Acceptance Scenarios**:

1. **Given** uma instalação fresca onde o corretor acabou de logar pela primeira vez, **When** ele chega ao passo de configurar o atendimento, **Then** ele vê uma lista curta de estruturas de partida descritas no que elas fazem pelo negócio dele (não em nome técnico), cada uma dizendo se serve para **vender** ou para **atender quem já é cliente**.
2. **Given** que o corretor escolheu a estrutura "Corretor de plano de saúde — vender", **When** ele confirma, **Then** o sistema deixa montado, de uma vez: a persona do agente, as capacidades que a missão exige, o funil com as etapas e o vocabulário do ramo, e o acompanhamento que impede um interessado de morrer sem resposta.
3. **Given** que a estrutura foi instalada, **When** o corretor chega ao fim do fluxo, **Then** existe exatamente **uma** decisão de segurança que ele precisa tomar à mão — autorizar o agente a falar com o cliente de verdade — e ela é apresentada com o que acontece se ele autorizar e o que acontece se não.
4. **Given** que o corretor autorizou o envio e conectou o número, **When** uma pessoa manda a primeira mensagem para esse número, **Then** o agente responde, e o corretor vê essa resposta acontecendo numa tela, sem precisar procurar onde.
5. **Given** que o corretor **não** conectou nenhum número, **When** ele instala uma estrutura, **Then** o sistema diz na hora, na tela, que o agente ainda não vai responder e o que falta para ele responder — nunca termina em silêncio com um agente rascunho.

---

### User Story 2 - A estrutura é inspecionável e editável depois de instalada (Priority: P1)

Ana usou o template por dois dias. Ela quer mudar o jeito de falar do agente (o template diz "prezado", ela fala "oi"), tirar uma capacidade que ela não quer e renomear uma etapa do funil. Ela não quer permissão de ninguém, e não quer perder o resto.

**Why this priority**: é a exigência literal do dono do produto — "não vamos abandonar a autonomia do usuário". Um template que não pode ser mudado falha o requisito. Sem esta história, a feature entrega uma gaiola.

**Independent Test**: com um template já instalado, abrir a tela do agente e alterar persona, capacidades e funil, salvar, e provar que a alteração vale no próximo atendimento — sem desinstalar nada.

**Acceptance Scenarios**:

1. **Given** um template instalado, **When** o corretor abre o agente, **Then** ele vê, item por item, **tudo** que o template ligou: a persona, cada capacidade (com o que ela faz em português e o risco dela), as etapas do funil, e o acompanhamento — nada aplicado que ele não consiga ver numa tela.
2. **Given** que o corretor está olhando essa lista, **When** ele muda qualquer item, **Then** a mudança é salva e passa a valer, sem exigir permissão especial além do papel que ele já tem e sem quebrar o restante do template.
3. **Given** que o corretor mudou itens, **When** ele volta a essa tela depois, **Then** o sistema mostra claramente **o que veio do template e o que foi ele que mudou** — a origem de cada item continua legível.
4. **Given** um template instalado, **When** o corretor tenta ligar capacidades além do que o agente suporta, **Then** o sistema recusa **antes** de aplicar, dizendo quantas vagas faltam — nunca aplica pela metade nem deixa uma escolha visível e impossível de fazer.
5. **Given** um template instalado, **When** alguém edita o catálogo de origem daquele template (numa atualização do produto), **Then** a instalação do corretor **não muda sozinha** — o que ele configurou continua valendo até ele decidir o contrário.

---

### User Story 3 - Voltar atrás: desfazer e trocar de template sem perder customização (Priority: P1)

Ana instalou o template de vendas, editou a persona e apagou duas capacidades. Duas semanas depois ela percebe que o negócio dela é mais atender cliente antigo do que vender. Ela quer trocar de template. Ela tem medo de perder o texto que escreveu.

**Why this priority**: o medo de não conseguir voltar é o que impede o corretor de experimentar. Sem caminho de volta, o template pré-pronto vira decisão irreversível — e decisão irreversível é o oposto de autonomia.

**Independent Test**: instalar template A, customizar, trocar por template B, e provar que a customização de A não foi perdida e que dá para voltar ao estado anterior.

**Acceptance Scenarios**:

1. **Given** um template instalado e customizado, **When** o corretor pede para desfazer a instalação, **Then** o agente volta ao estado imediatamente anterior à instalação, e o sistema diz o que foi removido antes de remover.
2. **Given** um template instalado e customizado, **When** o corretor escolhe **outro** template, **Then** o sistema mostra, **antes de aplicar**, o que vai mudar, o que vai sair e **o que ele customizou que seria sobrescrito** — e só aplica depois da confirmação.
3. **Given** que o corretor confirmou a troca, **When** a troca termina, **Then** o texto e as escolhas que ele havia customizado continuam recuperáveis, e o sistema oferece um caminho de uma ação para voltar ao estado anterior à troca.
4. **Given** que o corretor voltou atrás, **When** há uma conversa em andamento naquele momento, **Then** a conversa não quebra nem perde histórico: ela passa a ser tratada pela configuração nova a partir do próximo turno.
5. **Given** qualquer instalação, troca ou desfazer, **When** a operação termina, **Then** ela fica registrada como atividade legível — quem fez, quando, qual template, e o que mudou.

---

### User Story 4 - A PME: várias conexões, vários usuários, papéis distintos (Priority: P2)

Uma corretora com 6 pessoas tem três números de WhatsApp: um para vendas, um para atendimento de clientes antigos e um do sócio. Cada número tem um comportamento diferente. Nem todo mundo da equipe pode mexer na configuração.

**Why this priority**: é o segundo público declarado pelo dono, e é o que separa "ferramenta de uma pessoa" de "produto de empresa". Depende da história 1 estar de pé, mas não a bloqueia.

**Independent Test**: numa organização com três conexões, instalar templates diferentes em cada uma, e provar que a configuração de uma não vaza para a outra; e que um usuário de papel baixo enxerga sem poder mudar.

**Acceptance Scenarios**:

1. **Given** uma organização com três números conectados, **When** o administrador instala um template em cada número, **Then** cada número passa a se comportar segundo o seu template, e mudar um **não** altera os outros.
2. **Given** três templates instalados em três números, **When** uma mensagem chega em um deles, **Then** ela é atendida pelo comportamento daquele número — nunca pelo de outro.
3. **Given** um usuário com papel de apenas leitura, **When** ele abre a tela do agente, **Then** ele **vê** a estrutura instalada por inteiro e **não consegue** alterá-la, e a tela explica que ele não tem permissão em vez de falhar em silêncio ou dizer "salvo" sem salvar.
4. **Given** um usuário sem permissão de configurar, **When** ele tenta instalar, trocar ou desfazer um template por qualquer caminho, **Then** a operação é recusada e a recusa fica registrada.
5. **Given** uma organização com vários números, **When** o administrador olha a lista de conexões, **Then** ele vê qual estrutura está valendo em cada uma, sem precisar abrir uma por uma.

---

### Edge Cases

- **Template que estouraria o teto de capacidades.** Um template curado hoje pode passar do teto amanhã, se o catálogo crescer. A instalação precisa ser recusada **antes** de aplicar qualquer parte, com o número de vagas que faltam — nunca aplicada pela metade, e nunca deixando visível uma escolha que o produto não permite fazer (foi exatamente o defeito da issue #162, já corrigido em `bf20db49` para o caso do clique manual; o template não pode reintroduzi-lo por outro caminho).
- **Template que liga só parte de uma jornada.** Como nenhuma jornada inteira cabe junto com outra, um template curado deixará jornadas em estado "parcial" na tela. "Parcial" não pode parecer defeito: a tela precisa dizer que a seleção é deliberada e do template, não uma configuração pela metade.
- **Duas conexões com templates diferentes na mesma organização.** É o caso normal da PME, não a exceção. Trocar o template do número de vendas não pode tocar no número de atendimento, nem no funil, nem nas conversas em andamento do outro número.
- **Template instalado sem nenhum número conectado.** O agente não pode responder. O sistema tem de dizer isso na hora, com o que falta, e reabrir o caminho — em vez de terminar com um agente rascunho silencioso, que é o comportamento medido hoje.
- **Usuário sem permissão tentando editar o template.** Precisa ser recusado de verdade, não visualmente. A doutrina registra o caso em que uma tela dizia "salvo" e nada era gravado, porque o UPDATE casava zero linhas por RLS (`docs/doctrine/restricao-de-canal.md:137-141`) — a recusa tem de ser visível e auditável.
- **Template desatualizado depois de um update do sistema.** A instalação do corretor nunca muda sozinha. O sistema avisa que existe versão nova da origem, mostra o que mudou, e deixa a decisão com o humano. Um clone que atualizou o código mas ainda tem catálogo antigo continua funcionando com o que instalou.
- **Capacidade que sai do catálogo entre a instalação e hoje.** O agente pode ter uma capacidade instalada que não existe mais. A tela precisa mostrar a linha (não sumir com ela) e dizer o que fazer — o padrão já adotado em `lib/ai/agents/uso-de-capacidades.ts:170-175`.
- **Dois administradores instalando templates no mesmo número ao mesmo tempo.** O último a confirmar não pode sobrescrever em silêncio o trabalho do primeiro; a segunda operação precisa perceber que a base mudou.
- **Conexão arquivada depois do template instalado.** O agente daquele número para de receber. Isso precisa aparecer como trabalho visível, não como ausência silenciosa de mensagens.
- **Template da missão "assistir" instalado numa organização sem conhecimento carregado.** O princípio IX proíbe improviso: o agente recusa e escala. O template precisa deixar esse estado explícito ("este agente ainda não sabe nada sobre as suas operadoras — carregue o conteúdo aqui"), senão o corretor lê a recusa como produto quebrado.
- **Reinstalar o mesmo template duas vezes.** Repetir a operação não pode duplicar funil, capacidades ou acompanhamento.

---

## Requirements *(mandatory)*

### Functional Requirements

**Catálogo e forma do template**

- **FR-001**: O sistema DEVE oferecer um catálogo de estruturas de partida, cada uma descrita em linguagem de dono de negócio (o que ela faz pelo negócio), disponível a toda instalação sem configuração prévia.
- **FR-002**: Cada estrutura DEVE declarar explicitamente **qual das duas missões** ela serve — converter (vender) ou assistir (atender quem já é cliente) — e essa declaração DEVE estar visível ao corretor antes de ele escolher.
- **FR-003**: Nenhuma estrutura PODE declarar as duas missões ao mesmo tempo.
- **FR-004**: Uma estrutura DEVE poder trazer montados, no mínimo: persona/instrução do agente, seleção de capacidades, funil com etapas e vocabulário do ramo, e mecanismo de acompanhamento que impeça uma demanda aberta de ficar sem próximo passo.
- **FR-005**: Toda estrutura DEVE caber no teto de capacidades por agente, e isso DEVE ser verificado mecanicamente na integração contínua — uma estrutura que não cabe reprova o build, e não chega ao corretor.
- **FR-006**: A verificação de FR-005 DEVE contar também as capacidades de risco crítico que a estrutura propõe, mesmo as que exigem marcação humana do corretor — reservar a vaga é o que mantém a escolha possível. (Regra já existente no produto; ver Assumption 11.)

**Instalação**

- **FR-007**: O corretor DEVE conseguir instalar uma estrutura em uma única confirmação, sem preencher formulário técnico e sem editar arquivo.
- **FR-008**: A instalação DEVE ser tudo-ou-nada: se qualquer parte não puder ser aplicada, nada é aplicado, e o motivo é dito em português na tela.
- **FR-009**: Nenhuma estrutura PODE, por si só, dar ao agente o direito de enviar mensagem ao cliente final. Essa autorização DEVE exigir marcação humana explícita, apresentada com a consequência ("o cliente recebe de verdade e não dá para desfazer").
- **FR-010**: Instalar a mesma estrutura mais de uma vez no mesmo destino DEVE ser inofensivo — sem duplicar funil, capacidades ou acompanhamento.
- **FR-011**: Se não houver canal conectado no momento da instalação, o sistema DEVE informar na tela que o agente ainda não responderá, dizer o que falta, e oferecer o caminho — nunca concluir em silêncio.
- **FR-012**: Toda instalação, troca e desfazer DEVE gerar registro de auditoria e atividade visível na linha do tempo, com quem fez, quando, qual estrutura e o que mudou.

**Autonomia: inspecionar e editar (não-negociável)**

- **FR-013**: Depois de instalada, **todo** item que a estrutura aplicou DEVE ser visível ao corretor numa tela, item por item, com explicação em português do que faz e do risco que carrega.
- **FR-014**: Todo item aplicado por uma estrutura DEVE ser editável pelo corretor com o mesmo papel que já autoriza configurar o agente — sem permissão extra, sem desinstalar a estrutura, e sem quebrar os demais itens.
- **FR-015**: A tela DEVE distinguir, para cada item, **o que veio da estrutura** e **o que o corretor mudou depois**.
- **FR-016**: Editar um item aplicado por uma estrutura NÃO PODE desfazer os outros itens dela.
- **FR-017**: Uma alteração feita pelo corretor DEVE passar a valer no próximo atendimento, sem exigir reinício do sistema.
- **FR-018**: Quando a seleção de capacidades de uma estrutura cobre só parte de uma jornada, a tela DEVE indicar que a seleção é deliberada da estrutura — nunca apresentá-la como configuração incompleta.

**Voltar atrás (não-negociável)**

- **FR-019**: O corretor DEVE conseguir desfazer a instalação de uma estrutura e voltar ao estado imediatamente anterior a ela.
- **FR-020**: Antes de desfazer ou trocar, o sistema DEVE mostrar o que será alterado e **explicitamente o que o corretor customizou que seria sobrescrito**, e só prosseguir com confirmação.
- **FR-021**: Trocar de estrutura NÃO PODE destruir o que o corretor customizou: o conteúdo customizado DEVE continuar recuperável depois da troca.
- **FR-022**: Depois de uma troca, DEVE existir um caminho de uma ação para retornar ao estado anterior à troca.
- **FR-023**: Desfazer ou trocar NÃO PODE quebrar conversa em andamento nem apagar histórico; a configuração nova passa a valer a partir do turno seguinte.

**Atualização da origem**

- **FR-024**: Uma estrutura já instalada NUNCA PODE mudar de comportamento por causa de atualização do produto ou do catálogo de origem. A instalação é independente da origem a partir do momento em que é feita.
- **FR-025**: Quando a origem de uma estrutura instalada tiver versão mais nova, o sistema DEVE avisar, mostrar o que mudou, e deixar a adoção como decisão humana explícita.
- **FR-026**: Uma instalação cuja origem saiu do catálogo DEVE continuar funcionando e sendo editável.

**Múltiplas conexões e permissão**

- **FR-027**: Uma organização DEVE poder ter estruturas diferentes em conexões diferentes ao mesmo tempo.
- **FR-028**: Instalar, trocar ou desfazer estrutura numa conexão NÃO PODE alterar o comportamento de nenhuma outra conexão da mesma organização.
- **FR-029**: A lista de conexões DEVE mostrar qual estrutura está valendo em cada uma, sem exigir abrir uma por uma.
- **FR-030**: Instalar, trocar e desfazer estrutura DEVEM exigir papel de configuração; usuários de papel inferior DEVEM ver a estrutura por inteiro em modo leitura.
- **FR-031**: A recusa por falta de permissão DEVE ser visível ao usuário e registrada — nunca uma tela que declara sucesso sem gravar.
- **FR-032**: Nenhuma estrutura, item de estrutura ou registro de instalação PODE ser visível ou alcançável de outra organização.

**Missão "assistir" e conhecimento**

- **FR-033**: Estruturas da missão "assistir" DEVEM deixar explícito, na instalação, que a qualidade da resposta depende do conteúdo carregado pelo corretor, e apontar o caminho para carregá-lo.
- **FR-034**: Uma estrutura de "assistir" instalada sem conteúdo carregado DEVE fazer o agente recusar e escalar ao humano, e essa recusa DEVE aparecer ao corretor como trabalho visível (com o que carregar), não como falha muda.
- **FR-035**: Nenhuma estrutura PODE embutir informação específica de operadora de plano de saúde como parte fixa do produto — conteúdo de operadora é dado curado por tenant (princípio X). Uma estrutura pode trazer o **esqueleto** (que perguntas o conteúdo responde), nunca as respostas.

**Porta e visibilidade**

- **FR-036**: A tela de escolha e a tela de gestão das estruturas DEVEM ser alcançáveis pela navegação declarada do produto, não apenas digitando a URL.
- **FR-037**: O caminho de escolher uma estrutura DEVE estar presente **tanto** no primeiro uso (fluxo de entrada) **quanto** depois, para quem pulou ou quer trocar.

### Key Entities

- **Estrutura de partida (template)** — o item do catálogo. Tem nome legível, descrição em linguagem de negócio, **missão declarada** (converter | assistir), público-alvo (corretor individual | PME), e um conjunto de componentes. Vive no catálogo do produto, disponível a todas as organizações.
- **Componente da estrutura** — cada peça que a estrutura aplica: persona/instrução, seleção de capacidades, funil (etapas + vocabulário), acompanhamento anti-morte, esqueleto de conhecimento. Cada componente sabe dizer o que faz e qual o risco.
- **Instalação da estrutura** — o resultado de aplicar uma estrutura a um destino. Guarda a origem (qual estrutura, qual versão dela), o momento, quem instalou, e é **independente da origem** a partir daí.
- **Destino da instalação** — o par agente + conexão. É o que permite a PME ter comportamentos diferentes por número.
- **Customização** — a diferença entre o que a estrutura aplicou e o que está valendo agora. É o que a tela precisa distinguir (FR-015) e o que a troca não pode destruir (FR-021).
- **Ponto de retorno** — o estado anterior a uma instalação ou troca, suficiente para o corretor voltar atrás.
- **Aviso de origem mais nova** — o sinal de que existe versão mais recente da estrutura instalada, com o que mudou. Nunca aplica sozinho.
- **Autorização de fala** — a marcação humana explícita que permite ao agente enviar mensagem ao cliente final. Nunca vem ligada por estrutura.
- **Papel do usuário na organização** — quem pode instalar/trocar/desfazer e quem só pode ver. Hoje o produto tem 4 papéis hierárquicos por organização (`viewer` < `agent` < `manager` < `admin`), e a permissão é por organização, não por conexão (ver Assumptions).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** (o teto do princípio VIII): numa instalação fresca estilo VPS, uma pessoa que nunca viu o produto vai do **login à primeira conversa atendida pelo agente em ≤10 minutos**, cronometrado, sem suporte humano e sem editar nenhum arquivo.
- **SC-002**: da escolha da estrutura até o agente estar pronto para responder, o corretor toma **no máximo 3 decisões** (qual estrutura, em qual número, autorizar o agente a falar com o cliente). Hoje esse número é indefinido, porque o caminho não existe.
- **SC-003**: **100% dos itens** que uma estrutura aplica são visíveis numa tela a **no máximo 1 clique** a partir do agente. Zero itens aplicados sem superfície.
- **SC-004**: **100% do conteúdo customizado pelo corretor sobrevive** a uma troca de estrutura, verificado comparando o conteúdo antes e depois da troca.
- **SC-005**: desfazer uma instalação devolve o agente ao estado anterior em **no máximo 2 ações**, e **0 conversas em andamento** são interrompidas ou perdem histórico.
- **SC-006**: **0 instalações parciais**. Toda estrutura que não cabe no teto de capacidades é recusada antes de aplicar qualquer parte, informando quantas vagas faltam.
- **SC-007**: **0 estruturas** que, sozinhas, dão ao agente o direito de enviar mensagem ao cliente final.
- **SC-008**: numa organização com 3 conexões, instalar/trocar/desfazer estrutura em uma delas produz **0 alterações** de comportamento nas outras duas.
- **SC-009**: **0 mudanças de comportamento sem ação humana** decorrentes de atualização do produto ou do catálogo, em organizações com estruturas já instaladas.
- **SC-010**: **0 casos** de operação recusada por permissão em que a tela declara sucesso; **100% das recusas** são visíveis ao usuário e registradas.
- **SC-011**: **0 vazamentos** entre organizações, provados por teste de isolamento com duas organizações.
- **SC-012**: numa instalação fresca, o corretor consegue apontar **em ≤30 segundos**, olhando a tela, "o que meu agente sabe fazer" e "o que ele não pode fazer" — medido por observação de uso, não por opinião.
- **SC-013**: **100% das instalações, trocas e desfazeres** aparecem na linha do tempo como atividade legível.

---

## Assumptions

Suposições declaradas conforme o princípio I: onde não havia resposta, assumiu-se o padrão razoável em vez de bloquear.

1. **"Até 20 usuários" não existe como limite — o 20 é o teto de CAPACIDADES do agente.** Medido: `TETO_TOOLS_POR_AGENTE = 20` em `lib/mcp/tools/selecao-por-pacote.ts:24`. Busca por limite de usuários por organização (`max_users`, `seat`, `user_limit`, `quota`) não encontra nada; `organizations` (`supabase/baseline.sql:1744-1764`) e `user_organizations` (`:1852-1865`) não têm coluna de assento nem contador. O único "20" perto de usuários é o **lote de convites por requisição** (`lib/schemas/team.ts:22`, "cole até 20 emails"), que não limita o total — dá para convidar 20, depois mais 20. **Assumido: esta feature não introduz nem pressupõe limite de usuários.**
2. **Também não existe limite de conexões por organização.** O handler de criação insere sem contar nada (`app/api/v1/channel-sessions/route.ts:59-113`), e o hardcode antigo que limitava a 1 número por organização foi removido (`:94`). **Assumido: multi-conexão é ilimitada, e a feature é desenhada para N conexões.**
3. **Permissão é por organização, não por conexão.** Não existe nenhum vínculo usuário↔conexão no produto: `channel_sessions` não tem coluna de dono (a DDL completa está em `supabase/baseline.sql:1313-1337`; `created_by` é rastro de auditoria e ninguém filtra por ele), não existe tabela de junção, a RLS é só por `organization_id` (`:3313`), e a listagem filtra só por organização (`lib/channels/selectable.ts:56`). **Assumido para o v1: o controle é o papel de 4 níveis por organização.** O pedido do dono ("permissões vinculadas a usuários diferentes") é maior que isso — ver Q3.
4. **O vínculo comportamento↔número já existe e é a base da história 4.** A versão publicada do agente é presa a uma conexão (`ai_agent_versions.channel_session_id`, `NOT NULL`, `supabase/baseline.sql:998`), e o runtime resolve o agente por organização + conexão (`lib/agent-engine/agent/agent-config.ts:169-183`). **Assumido: "template por conexão" se apoia nisso, não cria eixo novo.**
5. **O padrão de "instalar e ficar independente" já existe no produto e é o modelo desta feature.** O catálogo de skills tem escopo de plataforma e instala por cópia, registrando a origem (`lib/ai/skills/install.ts:79-107`), com tela em `/app/ai/skills`. **Assumido: reusar esse padrão (princípio VI) em vez de inventar um mecanismo novo de template.**
6. **Desfazer e trocar se apoiam em versão imutável + ponteiro, que já é como o produto publica configuração** (`lib/agent-engine/agent/playbook.ts:87-108`; contrato de ponteiro publicado em `lib/agent-engine/agent/agent-config.ts:1-15`). **Assumido: voltar atrás é mover ponteiro, não editar histórico** — por isso SC-005 pede ≤2 ações.
7. **A estrutura não atualiza sozinha.** Assumido pelo mesmo motivo que o fork-on-install existe: a cópia da organização é independente, e mudança na origem não pode alterar produção de ninguém. O aviso de versão nova (FR-025) é a compensação.
8. **O corretor que instala é administrador da própria organização.** Numa instalação self-host, o primeiro usuário nasce `admin` e platform admin (`scripts/bootstrap-owner.ts:111-158`). **Assumido: o caminho padrão do corretor sozinho não esbarra em permissão.**
9. **O funil e o vocabulário fazem parte da estrutura.** Justificado por medição: o funil que nasce pronto hoje é de e-commerce ("Pedidos", 8 etapas, `supabase/baseline.sql:682-713`), errado para corretor. Deixar o funil de fora tornaria o template incompleto na primeira tela que o corretor abre depois do inbox.
10. **A estrutura não carrega conhecimento de operadora.** Imposto pelo princípio X (`constitution.md:202-213`): conteúdo de operadora é dado curado por tenant, e resposta de assistência sem respaldo recusa e escala. Uma estrutura de plataforma que afirmasse como emitir boleto de uma operadora específica seria informação errada em escala, com o corretor respondendo por ela.
11. **A regra de teto e reserva de vaga já está correta no produto e não é reescrita aqui.** O defeito da issue #162 foi corrigido em `bf20db49` e a spec e2e correspondente roda no CI (`.github/workflows/e2e.yml:240`). Esta feature herda `vagasExigidasPeloPacote` e a estende para o caso "estrutura inteira", em vez de recriar a regra.
12. **A estrutura precisa selecionar capacidades individualmente, não jornadas inteiras.** Medido nesta spec: nenhuma combinação de duas jornadas que inclua "Atender e responder" cabe em 20 vagas. **Assumido: o template define uma lista curada, e as jornadas aparecem como estado derivado (inclusive "parcial") — daí o FR-018.**

---

## Dependências e trabalho adjacente

- **Doutrina desatualizada (dívida separada, não bloqueia).** `CLAUDE.md:217`, `AGENTS.md:74`, `AGENTS.md:136` e `docs/current-state.md:128` ainda afirmam que a spec e2e `capacidades-do-agente` reprova pelo teto de 20; ela foi corrigida em `bf20db49` e roda no CI. Deve ser corrigido para que a próxima sessão não parta de premissa falsa.
- **O onboarding tem três definições paralelas de "quais são os passos"** (`app/onboarding/_components/Stepper.tsx:13-20`, `lib/schemas/onboarding.ts:27-34`, `app/onboarding/page.tsx:16-22`), que já divergem no caso Nuvemshop. Encaixar a escolha de estrutura no fluxo de entrada esbarra nisso.
- **O gate de verificação em duas etapas é obrigatório para o primeiro usuário** de toda instalação (`lib/auth/server.ts:158-160` + `scripts/bootstrap-owner.ts:111-158`) e consome parte dos 10 minutos do SC-001. A cronometragem precisa contá-lo, não ignorá-lo.
- **A prova do SC-001 exige ambiente fresco estilo VPS** (banco do `supabase/baseline.sql`, dependências como na VPS, envs opcionais ausentes), conforme a doutrina de QA Visual do `CLAUDE.md`.

## Fora de escopo

- Permissão por conexão ou por funil (não existe hoje; ver Q3 e Assumption 3).
- Limites de assentos, planos ou cobrança.
- Conteúdo específico de operadora de plano de saúde (princípio X — é dado curado por tenant).
- Editor de templates pelo próprio corretor (criar template novo do zero); esta feature entrega **escolher, instalar, editar o instalado e voltar atrás**.
- Migração automática de organizações já existentes para o novo catálogo de estruturas.
- Integração com o Cotador Simplificado (princípio XI — depois, por contrato HTTP).

## Living System Checklist (invariantes de `docs/doctrine/sistema-vivo.md`)

- **Quem me alimenta**: o catálogo de estruturas do produto + a escolha do corretor no fluxo de entrada + a lista de conexões da organização.
- **Quem eu alimento**: a configuração publicada do agente (persona, capacidades), o funil do CRM, o mecanismo de acompanhamento, e o painel de uso de capacidades.
- **Que atividade/log emito**: instalação, troca e desfazer como auditoria + atividade na linha do tempo (FR-012).
- **Onde apareço na tela**: tela de escolha, tela do agente (o que está instalado, item por item), e a lista de conexões (qual estrutura vale em cada número) (FR-013, FR-029, FR-036).
- **Mecanismo anti-morte**: a própria estrutura instala o acompanhamento que garante próximo passo para toda demanda aberta (FR-004); e o caso "instalada sem número" vira aviso visível, não silêncio (FR-011).
- **Continuidade IA↔humano**: a estrutura de "assistir" recusa e escala quando não tem respaldo, e a recusa vira trabalho visível com o que carregar (FR-034).

---

## Perguntas em aberto

Três decisões de escopo que mudam o produto e não têm padrão razoável a assumir. Todas com recomendação do desenvolvedor já formada, conforme o princípio I.

- **Q1 — Composição do catálogo v1.** [NEEDS CLARIFICATION: O catálogo de estruturas do v1 entrega **apenas** as duas do nicho de validação (corretor de plano de saúde: converter e assistir), ou mantém também as três opções de e-commerce/suporte que existem hoje no fluxo de entrada?] *Recomendação: entregar as duas do corretor e manter as de e-commerce como estruturas legadas visíveis, sem investimento — o nicho de validação é o corretor (`constitution.md:59-62`), mas apagar o caminho de quem já instalou o produto com perfil de loja quebraria instalação existente.*

- **Q2 — Conhecimento na estrutura de "assistir".** [NEEDS CLARIFICATION: A estrutura de "assistir" entrega apenas o **esqueleto** de conhecimento (as perguntas que o corretor precisa responder sobre as operadoras dele), ou também um conjunto inicial de conteúdo genérico sobre planos de saúde — que não é de operadora específica, mas passa a ser conteúdo do produto?] *Recomendação: só o esqueleto. Conteúdo genérico sobre plano de saúde vira, na conversa real, resposta sobre um plano específico — e o princípio IX diz que informação errada sobre boleto ou cobertura é dano ao cliente final, pelo qual o corretor responde.*

- **Q3 — Alcance de permissão para PME.** [NEEDS CLARIFICATION: O pedido "permissões vinculadas a usuários diferentes, cada um com nível distinto" é atendido pelos 4 papéis por organização que já existem, ou o v1 precisa introduzir permissão **por conexão** (o usuário X só enxerga e configura o número Y)?] *Recomendação: v1 com os 4 papéis por organização. Permissão por conexão é eixo novo de isolamento — muda RLS, listagem, roteamento e teste de isolamento — e vale como fatia própria depois que a estrutura pré-pronta estiver de pé. Medido: hoje não existe nenhum vínculo usuário↔conexão (`supabase/baseline.sql:1313-1337`, `:3313`; `lib/channels/selectable.ts:56`).*
