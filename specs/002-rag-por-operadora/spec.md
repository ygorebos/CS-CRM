# Especificação de Feature: RAG por operadora de plano de saúde

**Branch da feature**: `002-rag-por-operadora`
**Criada**: 2026-08-07
**Status**: Draft
**Entrada**: "O agente precisa assistir cliente de plano de saúde com conhecimento **por operadora**
(segunda via de boleto, carteirinha, rede credenciada, cobertura). Sem respaldo no conhecimento do
tenant, recusa e escala. Toda resposta de assistência é rastreável ao trecho que a originou.
Operadora nova = carregar conteúdo, não fazer deploy."

---

## Declaração constitucional (obrigatória — Fluxo de Trabalho)

**Missão do princípio IX que esta feature serve: ASSISTIR.**
Ela existe para atender quem **já é cliente** do corretor — segunda via de boleto, acesso à
carteirinha, rede credenciada, dúvida de cobertura e uso do plano. A missão **converter** é
afetada apenas por omissão deliberada: nada nesta feature pode tornar a venda mais lenta ou mais
travada, e a exigência de lastro **não se aplica** ao discurso comercial (ver FR-020).

Por que a distinção importa aqui: **assistir e converter têm físicas opostas.** Errar o dia do
vencimento de um boleto ou dizer que um procedimento está coberto quando não está não é "resposta
ruim" — é dano ao cliente final, e quem responde por ele é o corretor. Por isso, nesta feature,
**recusar é um resultado de sucesso**, e improvisar é o defeito.

**Onde ela cai no teto de 10 minutos (princípio VIII): FORA do caminho crítico, por desenho.**

- Do login à primeira conversa atendida por agente, **esta feature não acrescenta nenhum passo
  obrigatório**. Uma instalação recém-criada, sem acervo nenhum, precisa continuar atendendo em
  ≤10 minutos — o agente simplesmente **recusa assistência e escala**, que é o comportamento
  correto de quem ainda não tem conhecimento carregado (FR-021).
- O que entra no cronômetro é um teto **próprio e separado**: carregar a **primeira operadora**,
  do login ao primeiro trecho buscável, em **≤5 minutos** (SC-003) — e a **segunda em ≤2 minutos**
  (SC-004), porque a partir dela o custo é o de repetir, não o de aprender.
- Consequência de desenho, não negociável: **nenhuma tela desta feature pode ser pré-requisito de
  publicar o agente.** Se carregar operadora virar etapa de onboarding, o teto de 10 minutos cai.

---

## Por que esta feature existe (o problema, medido no repositório)

Esta seção existe porque três das decisões abaixo seriam erradas sem ela. Cada afirmação foi
medida em `fix/waha-media-storage` (`b990bd28`); o resto está declarado em **Assumptions**.

### 1. O agente pode inventar hoje, e nada o impede

- A defesa anti-invenção que existe é **texto de prompt**: `lib/agent-engine/agent/inbound-turn.ts:204-206`
  ("não invente o que não encontrar") e `lib/agent-engine/playbooks/platform.md:30-33`.
- A cadeia determinística que veta envio — `lib/agent-engine/guardrails/before-send.ts:536-547`,
  versão 6 (`:518`) — tem 10 gates sobre conformidade, canal, preço e vocabulário. **Nenhum sobre
  lastro factual.**
- Quando a base de conhecimento cai, a mensagem devolvida ao modelo **manda seguir**:
  `lib/agent-engine/agent/search-knowledge.ts:108` — *"responda com o que você já sabe e não invente fatos"*.
- Quando o agente **não tem** base ativa, a ferramenta de busca é simplesmente **removida do turno**
  (`lib/agent-engine/agent/inbound-turn.ts:1833-1835`) e o agente segue respondendo, sem base, sem aviso.

### 2. A trava que resolveria isso já é oferecida ao usuário — e é config morta

- O guardrail **`rag_must_hit`** ("só responda se houver citação", com `min_citations`) está
  definido em `lib/ai/guardrails-schema.ts:40-44`, é **editável na tela** em
  `components/ai/GuardrailsEditor.tsx:198-214`, é validado por Zod e é salvo no banco.
- **Nenhum runtime o avalia.** A função que o aplicaria (`validateGuardrails`) existe apenas na
  spec, em `docs/specs/05-spec-ai-rag-handoff.md:1174-1195`, e nunca foi implementada. O campo é
  carregado em memória (`workers/ai-response-worker.ts:435`) e descartado.
- Ou seja: **hoje o corretor pode marcar "Exigir citação da base", salvar, ver o guardrail listado
  na tela — e nada acontece.** Isso é pior que a ausência da trava: é falso verde configurável pelo
  próprio usuário.

### 3. A citação existe, mas é descritiva — nunca decide nada

- As citações são montadas a partir do **resultado da busca** e carimbadas na mensagem **depois**
  de ela já ter sido enviada: `lib/agent-engine/agent/inbound-turn.ts:1484-1501`, com o comentário
  explícito em `:1494` — *"citação é enriquecimento, não invariante — falha só loga"*.
- Portanto elas registram **o que foi recuperado**, não **o que fundamentou a resposta**. Se o
  modelo não chamar a busca, a resposta sai com zero citações e nada a barra.
- Na tela, a citação vive atrás de um **toggle de depuração** (`hooks/ai/useDebugToggle.ts:5-10`,
  `components/inbox/MessageBubble.tsx:40-43`).

### 4. "Operadora nova = carregar conteúdo" é hoje estruturalmente impossível

- O banco impõe **uma fonte ativa por tipo por agente**:
  `ai_knowledge_sources_unique_per_agent UNIQUE (agent_id, source_type) WHERE is_active` —
  `supabase/baseline.sql:2286`. Duas FAQs ativas no mesmo agente violam o índice.
- A tela reforça: **4 slots fixos** (`faq`, `policy`, `conversations`, `catalog`), **um material por
  slot** — `app/app/ai/knowledge/sources/_client.tsx:22` e `:56-68` — presa ao agente `is_default`
  (`app/app/ai/knowledge/sources/page.tsx:24-27`).
- A busca recebe **um único acervo** e não filtra por nada além dele: a função de recuperação
  aceita `organization_id` e `kb_version_id`, devolve `metadata` e **nunca a filtra** —
  `supabase/baseline.sql:8644-8660`.
- O acervo é **um por agente** (`ai_kbv_one_active_per_agent UNIQUE (agent_id) WHERE is_active`,
  `supabase/baseline.sql:2278`) e é **reconstruído inteiro** a cada mudança
  (`workers/rag-indexer.ts:295-420`, racional em `:277-294`).
- **Consequência medida:** hoje o corretor não consegue ter o material da Operadora A e o da
  Operadora B convivendo. Carregar a segunda apaga a primeira, ou é recusada pelo índice único.

### 5. O material que o corretor mais tem — PDF — é aceito e descartado em silêncio

- O upload de PDF/Markdown extrai o texto **apenas para validar** e devolve só a contagem:
  `lib/ai/rag/ingest/policy.ts:94-126` (não persiste nada).
- O indexador, ao reconstruir o acervo, lê **exclusivamente pares pergunta/resposta**
  (`workers/rag-indexer.ts:313`) e, não achando nenhum, encerra com `skip("no_content_to_index")`
  (`:325`).
- **Resultado medido:** um PDF de operadora sobe, a tela diz 201 Created, e o conteúdo **nunca vira
  trecho buscável**. É o pior modo de falha possível para um usuário que não lê documentação: ele
  acredita que ensinou o agente.
- Metadados que existem e **morrem na ingestão**: `ai_faq_items.tags` e `.locale`
  (`supabase/baseline.sql:1092-1093`) nunca chegam ao trecho (`workers/rag-indexer.ts:334, 376`).

### 6. O sistema já sabe quando faltou conhecimento — e não age no ato

- Toda busca grava `hits`, `top_score` e `threshold` em `knowledge_searches`
  (`lib/agent-engine/agent/search-knowledge.ts:85-90`).
- Isso já é agregado em "perguntas sem resposta" e "quase acertou"
  (`lib/ai/evolution/aggregate.ts:88-90, 153, 223-224`) e mostrado ao dono em
  `components/ai/EvolutionGaps.tsx:100-123`: *"cada um deles é uma conversa em que o agente teve
  que improvisar ou passar adiante."*
- **O sistema confessa, a posteriori, que improvisou.** Falta transformar essa medição em decisão
  no momento da resposta.

### 7. O banco do Cotador Simplificado serve à venda, não à assistência

Medido por consulta somente-leitura ao banco de produção do Cotador:

| O que | Medida |
|---|---|
| Linhas em `logo_operadoras` | 753 (744 não deletadas) |
| Delas, `tipo_empresa = 'operadora'` | **244** |
| Operadoras com tabela comercial ativa | **176** |
| Operadoras com `site_oficial` preenchido | **1** |
| Operadoras com `telefone` preenchido | **0** |
| `saude_carencias` com `descricao` útil | 78 de 673 |
| `saude_carencias` com `regras_aceitacao` | 97 de 673 |
| Documentos em `arquivos_tabelas` (com URL, versão e vigência) | 2.758 — Geral 2.225 · Tabela de Preços 385 · Rede de Atendimento 135 · Carência 8 · Coparticipação 4 · Reembolso 1 |
| Rede credenciada (`local_cobert_plano` × `local_atendimento`) | 1.218.921 × 10.516 |

**Leitura:** há muita matéria-prima **comercial** (planos, preços, carências, rede, tabelas) e
**nenhum** conteúdo de assistência — nada sobre emissão de boleto, segunda via ou carteirinha, e
nem sequer telefone de operadora. O Cotador alimentaria a missão **converter**; a missão
**assistir**, que é o alvo desta feature, **teria que ser curada do zero de qualquer forma**.
Isso decide o escopo (ver "Fora de escopo" e Assumption A-12).

---

## User Scenarios & Testing *(obrigatório)*

Personas:

- **Corretor** — dono da instalação, papel de gestor. Não é desenvolvedor, não lê documentação.
- **Cliente** — pessoa que já tem plano contratado pelo corretor e escreve no WhatsApp.
- **Interessado** — pessoa que ainda não é cliente (missão converter). Aparece só para provar que
  esta feature não a atrapalha.

### User Story 1 — O corretor ensina a primeira operadora e vê o agente usá-la (Prioridade: P1)

O corretor entra no sistema, escolhe "Operadoras", digita o nome da operadora com que trabalha
(ela ainda não existe em lugar nenhum), cola ou envia o material que já tem sobre ela — o passo a
passo da segunda via de boleto, onde fica a carteirinha, o telefone da central — e salva. Em
seguida ele pergunta ao agente, pela própria tela de teste, "como tiro a segunda via do boleto da
[operadora]?" e recebe a resposta **com o trecho que a originou visível ao lado**.

**Por que esta prioridade**: é o coração da feature. Sem ela nada mais existe, e é o momento em
que o corretor decide se o produto funciona.

**Teste independente**: instalação fresca, sem material nenhum. Carregar uma operadora e obter uma
resposta ancorada prova a feature inteira ponta a ponta, sem depender de nenhuma outra história.

**Cenários de aceite**:

1. **Dado** um tenant sem nenhuma operadora cadastrada, **quando** o corretor digita um nome de
   operadora que não existe e salva, **então** a operadora passa a existir para aquele tenant, sem
   nenhum deploy, migration, reinício ou edição de arquivo.
2. **Dado** um material carregado para a Operadora A, **quando** a carga termina, **então** a tela
   mostra o material como **pronto** com a contagem de trechos, ou como **falhou com o motivo em
   português** — nunca como "salvo" sem ter virado conteúdo buscável.
3. **Dado** um material pronto da Operadora A, **quando** o corretor pergunta ao agente algo
   coberto por ele — pela conversa real ou por qualquer superfície de teste que o produto ofereça
   —, **então** a resposta cita ao menos um trecho, e o corretor consegue abrir o texto exato desse
   trecho e ver de qual material e de que data ele veio.
4. **Dado** um arquivo que o sistema não consegue transformar em texto, **quando** o corretor o
   envia, **então** ele é recusado **na hora**, com motivo compreensível e instrução do que fazer —
   nunca aceito para falhar depois em silêncio.

---

### User Story 2 — O cliente pergunta e é atendido com informação verdadeira (Prioridade: P1)

Um cliente do corretor manda mensagem: "perdi meu boleto deste mês, como faço?". O agente
identifica que a pergunta é de **assistência**, descobre de qual operadora é o plano daquele
cliente, busca **apenas** no material daquela operadora, e responde com o procedimento exato,
citando a fonte. Se o material daquela operadora não cobre a pergunta, ele **não tenta**: diz que
vai confirmar com uma pessoa e passa a conversa adiante.

**Por que esta prioridade**: é o valor entregue ao cliente final e a razão do princípio IX. Uma
resposta errada aqui é dano, não inconveniência.

**Teste independente**: com uma operadora carregada, duas perguntas — uma coberta pelo material,
outra não — provam os dois lados da regra na mesma sessão.

**Cenários de aceite**:

1. **Dado** um cliente cuja operadora é conhecida e cujo material cobre a pergunta, **quando** ele
   pergunta sobre segunda via, **então** o agente responde com base no material e a resposta fica
   permanentemente associada aos trechos que a fundamentaram.
2. **Dado** um cliente cuja operadora é conhecida e cujo material **não** cobre a pergunta,
   **quando** ele pergunta, **então** o agente **não responde a afirmação factual**: ele diz, em
   linguagem que o cliente entende e sem vocabulário interno do sistema, que vai confirmar, e a
   conversa é escalada para o corretor.
3. **Dado** o cenário anterior, **quando** a escalação acontece, **então** o corretor recebe um
   aviso acionável contendo a pergunta original, a operadora envolvida e o motivo ("não há material
   sobre isto") — suficiente para ele responder e para saber o que carregar depois.
4. **Dado** que a base de conhecimento está indisponível por falha técnica, **quando** o cliente
   faz uma pergunta de assistência, **então** o agente trata como ausência de lastro e escala —
   **nunca** responde "com o que já sabe".
5. **Dado** um cliente que pergunta algo de assistência, **quando** a resposta é enviada,
   **então** é impossível que ela tenha sido enviada sem ao menos um trecho âncora registrado.

---

### User Story 3 — O corretor confere de onde veio a resposta (Prioridade: P1)

Depois que o agente respondeu a um cliente, o corretor abre a conversa e vê, **sem precisar ligar
nenhum modo de depuração**, de qual material e de qual trecho aquela resposta saiu. Se a
informação estiver errada, ele corrige o material e sabe exatamente qual corrigir.

**Por que esta prioridade**: é a exigência literal do princípio X ("toda resposta de assistência é
rastreável ao trecho que a originou") e é o que torna o erro **corrigível**. Sem isso, o corretor
descobre o erro pelo cliente irritado e não sabe onde mexer.

**Teste independente**: uma resposta de assistência já enviada basta; a rastreabilidade se verifica
sozinha na tela.

**Cenários de aceite**:

1. **Dado** uma resposta de assistência enviada, **quando** o corretor a abre na conversa,
   **então** a origem aparece por padrão, sem ativar nenhuma opção escondida.
2. **Dado** a origem exibida, **quando** o corretor a abre, **então** ele vê o texto do trecho, o
   material de onde veio, a operadora e a data da última atualização daquele material.
3. **Dado** um material que foi substituído por uma versão mais nova, **quando** o corretor abre
   uma resposta antiga, **então** ele ainda enxerga qual conteúdo estava valendo quando a resposta
   foi dada — a rastreabilidade não é apagada por uma atualização posterior.
4. **Dado** uma resposta que **não** é de assistência (uma saudação, uma pergunta de qualificação
   de venda), **quando** o corretor a abre, **então** a ausência de origem é normal e não é
   sinalizada como problema.

---

### User Story 4 — O corretor acrescenta a segunda operadora sem parar nada (Prioridade: P2)

O corretor fechou parceria com mais uma operadora. Ele repete o que fez na primeira vez. Enquanto
o novo material é processado, o agente **continua atendendo** com o que já tinha. Ao fim, as duas
operadoras convivem, e uma pergunta sobre a Operadora B nunca é respondida com material da A.

**Por que esta prioridade**: é a prova do princípio X ("operadora nova = carregar conteúdo") e o
ponto exato em que o desenho atual quebra hoje (uma fonte ativa por tipo por agente).

**Teste independente**: com uma operadora já carregada, adicionar a segunda e fazer perguntas
cruzadas prova convivência e não-vazamento.

**Cenários de aceite**:

1. **Dado** um acervo com a Operadora A funcionando, **quando** o corretor carrega a Operadora B,
   **então** nenhuma pergunta sobre a A deixa de ser respondida, em nenhum momento do processo —
   não existe janela em que o agente fica sem base.
2. **Dado** duas operadoras carregadas que descrevem o **mesmo** procedimento de formas
   **diferentes**, **quando** um cliente da B pergunta sobre esse procedimento, **então** a
   resposta é ancorada exclusivamente em material da B.
3. **Dado** N operadoras carregadas, **quando** o corretor abre a tela de conhecimento, **então**
   ele vê todas, com o estado de cada uma — sem limite fixo de quantas cabem na tela.
4. **Dado** um material que se aplica a **todas** as operadoras (um texto do próprio corretor sobre
   horário de atendimento dele, por exemplo), **quando** o corretor o marca assim, **então** ele
   pode ancorar respostas de qualquer operadora.

---

### User Story 5 — O sistema mostra ao corretor o que falta carregar (Prioridade: P2)

Depois de alguns dias, o corretor abre a tela e vê a lista das perguntas de clientes que o agente
teve de escalar por falta de material, agrupadas por operadora e por assunto. Cada linha é um
convite direto: "3 clientes da Operadora A perguntaram sobre reembolso e você não tem material
sobre isso."

**Por que esta prioridade**: é o mecanismo anti-morte da feature (Living System Checklist). Um
acervo que ninguém alimenta apodrece, e o corretor não tem como adivinhar o que está faltando.

**Teste independente**: provocar duas recusas por falta de material e verificar que elas aparecem
agrupadas e acionáveis.

**Cenários de aceite**:

1. **Dado** perguntas de assistência recusadas por falta de lastro, **quando** o corretor abre a
   tela de conhecimento, **então** elas aparecem agrupadas por operadora e por assunto, com
   contagem e com o texto real de ao menos uma pergunta de exemplo.
2. **Dado** uma lacuna listada, **quando** o corretor carrega material que a cobre, **então** a
   lacuna deixa de ser listada como pendente.
3. **Dado** perguntas que **quase** encontraram material (encontraram algo próximo, mas insuficiente),
   **quando** o corretor abre a tela, **então** elas aparecem **separadas** das que não encontraram
   nada — porque as ações são opostas: uma pede material novo, a outra pede material melhor.

---

### User Story 6 — Material vencido não vira resposta (Prioridade: P3)

O corretor carregou em janeiro a tabela de rede credenciada de uma operadora e marcou que ela vale
até junho. Em julho, um cliente pergunta se determinado hospital está na rede. O agente **não**
responde com o material vencido: escala, e o corretor recebe o aviso de que aquele material
precisa ser atualizado — aviso que ele já vinha recebendo desde antes do vencimento.

**Por que esta prioridade**: informação desatualizada sobre rede e cobertura é indistinguível de
informação inventada para quem recebe. Mas é P3 porque exige que o corretor tenha adotado o hábito
de datar o material, o que só faz sentido depois das histórias anteriores funcionarem.

**Teste independente**: carregar um material já vencido e verificar que ele nunca ancora resposta.

**Cenários de aceite**:

1. **Dado** um material com validade expirada, **quando** um cliente pergunta algo que só esse
   material cobriria, **então** o agente escala como se não houvesse material — o vencido não
   ancora.
2. **Dado** um material se aproximando do vencimento, **quando** o prazo definido se aproxima,
   **então** o corretor é avisado antes, com nome do material e operadora.
3. **Dado** um material sem validade declarada, **quando** ele é usado, **então** ele ancora
   normalmente — datar é opcional, e não datar não pode travar o corretor apressado.

---

### Edge Cases

**Ausência e cobertura**

- **Operadora sem material nenhum**: cliente identificado como sendo dessa operadora faz pergunta
  de assistência → recusa e escalação imediatas, com o aviso ao corretor nomeando a operadora. O
  agente **não** cai no material de outra operadora nem no material "vale para todas" para
  improvisar um procedimento específico.
- **Tenant sem operadora nenhuma (instalação fresca)**: toda assistência é recusada e escalada, e
  a conversão continua funcionando integralmente. Esta é a configuração de fábrica, e ela é
  correta — não é um estado de erro.
- **Material existe, mas nada nele responde à pergunta**: idêntico a "sem material" do ponto de
  vista do cliente (recusa + escalação), e **diferente** do ponto de vista do corretor: entra na
  lista de lacunas como "quase acertou" (US5, cenário 3).

**Identidade e escopo**

- **Operadora do cliente desconhecida**: o agente pergunta **uma vez**, em linguagem natural, de
  qual plano se trata. Sem resposta utilizável, escala. Ele **nunca** escolhe uma operadora por
  conta própria, nem quando o tenant só tem uma carregada — "só existe uma" não é prova de que é a
  daquele cliente.
- **Pergunta que cruza duas operadoras** ("meu plano é o X e o da minha mãe é o Y, os dois cobrem
  fisioterapia?"): o agente responde **por operadora, separadamente**, cada parte com sua própria
  âncora; a parte sem lastro é recusada **isoladamente**, sem contaminar a parte que tem lastro.
  Fundir duas operadoras numa resposta única é proibido.
- **Cliente pergunta algo fora do plano dele** (um procedimento que o plano contratado não cobre,
  ou de outro produto da mesma operadora): se o material do tenant permite afirmar que não está
  coberto, o agente afirma com âncora. Se o material só cobre o plano genérico e não o específico
  do cliente, isso **não é lastro suficiente** — recusa e escala. O erro caro aqui é afirmar
  cobertura por analogia.
- **Interessado (não-cliente) faz pergunta de assistência**: tratado como assistência (a regra é a
  natureza da afirmação, não o cadastro de quem pergunta) — sem lastro, recusa. A conversa segue
  disponível para a conversão.

**Conteúdo**

- **Dois materiais da mesma operadora se contradizem**: o agente ancora no mais recente e a
  contradição é registrada para o corretor. Ele **não** escolhe pelo que parece mais relevante nem
  apresenta as duas versões ao cliente.
- **Material vencido é o único que responde**: recusa (US6).
- **Arquivo sem texto extraível** (PDF que é só imagem): recusado no envio, com motivo e instrução.
  Já é o comportamento medido hoje, e precisa ser preservado.
- **Material carregado com conteúdo de outra operadora por engano**: fora do alcance do sistema
  detectar; mitigado pela rastreabilidade (US3), que faz o corretor descobrir na primeira resposta
  errada e saber exatamente onde corrigir.

**Operação e limites**

- **Falha durante o processamento do material**: o acervo anterior continua valendo por inteiro. É
  proibido que uma carga com problema deixe o agente sem base ou com base parcial.
- **Corretor remove uma operadora com conversa em andamento**: o material dela para de ancorar
  respostas novas imediatamente; as respostas já dadas continuam rastreáveis.
- **Acervo cresce (dezenas de operadoras)**: o tempo até a resposta ao cliente não pode degradar
  além do limite de SC-006, e nenhuma operadora antiga pode deixar de ser encontrada.
- **Pergunta de assistência fora do horário do corretor**: a recusa acontece igual; o cliente
  recebe uma expectativa honesta de quando será atendido, e o aviso espera o corretor.
- **Pergunta chega em áudio ou imagem**: se o conteúdo puder ser transformado em pergunta, a mesma
  regra vale integralmente. A modalidade da pergunta não afrouxa a exigência de lastro.

---

## Requirements *(obrigatório)*

### Requisitos funcionais

**Acervo por operadora — o corretor carrega, o sistema organiza**

- **FR-001**: Todo material de conhecimento **DEVE** declarar a qual operadora se aplica, ou
  declarar-se explicitamente aplicável a **todas**. Material sem essa declaração não pode ser
  aceito.
- **FR-002**: O corretor **DEVE** poder criar uma operadora nova apenas informando o nome dela pela
  tela, e o material dela passa a valer **sem** deploy, reinício, migration, edição de arquivo ou
  intervenção de suporte.
- **FR-003**: O acervo de um tenant **DEVE** suportar N operadoras e N materiais por operadora,
  sem limite estrutural imposto por tela ou por regra de unicidade. Carregar um material **NÃO
  PODE** desativar, apagar ou substituir outro material não relacionado.
- **FR-004**: Todo material aceito **DEVE** virar conteúdo buscável **ou** falhar de forma
  visível. É **proibido** aceitar material e descartá-lo em silêncio — a tela nunca pode indicar
  sucesso para conteúdo que não foi indexado.
- **FR-005**: A tela **DEVE** mostrar, por material, um estado inequívoco em português — carregado,
  processando, pronto (com contagem de trechos), ou falhou (com motivo acionável e o que fazer).
- **FR-006**: Substituir ou atualizar o material de uma operadora **NÃO PODE** produzir nenhuma
  janela em que o agente responda sem base, nem degradar o acervo das demais operadoras. Se o
  processamento falhar, o acervo anterior permanece valendo por inteiro.
- **FR-007**: O sistema **DEVE** declarar, **antes** do envio, quais formatos e qual tamanho máximo
  são aceitos, e recusar o que estiver fora com mensagem que diz o que fazer em seguida.
- **FR-008**: Remover ou desativar uma operadora **DEVE** tornar o material dela inerte para
  respostas novas **imediatamente**, preservando a rastreabilidade das respostas já dadas.

**A regra dura de assistência — sem lastro, não responde**

- **FR-009**: Toda mensagem enviada ao cliente que contenha uma **afirmação de assistência** —
  procedimento de cobrança ou segunda via, acesso a carteirinha, rede credenciada, cobertura,
  carência, reembolso, prazos, canais ou regras de uso de uma operadora — **DEVE** estar ancorada
  em ao menos um trecho do acervo do próprio tenant. Sem âncora, a mensagem **NÃO PODE** ser
  enviada.
- **FR-010**: A verificação de FR-009 **DEVE** ser executada pelo sistema como condição de envio,
  de forma determinística e independente da colaboração do modelo. Instrução de prompt **NÃO**
  satisfaz este requisito.
- **FR-011**: Quando FR-009 barra uma resposta, o sistema **DEVE** produzir, ao cliente, uma frase
  que ele entenda, sem vocabulário interno do produto (nomes de papéis, de ferramentas, de tabelas,
  de similaridade ou de "base de conhecimento"), informando que a informação será confirmada por
  uma pessoa e, quando o sistema souber, a expectativa realista de quando isso acontece.
- **FR-012**: Quando FR-009 barra uma resposta, o sistema **DEVE** escalar a conversa para
  atendimento humano e abrir um aviso acionável para o corretor contendo, no mínimo: a pergunta
  original do cliente, a operadora envolvida (ou a informação de que ela é desconhecida) e o motivo
  da recusa.
- **FR-013**: Indisponibilidade da busca de conhecimento **DEVE** ser tratada como ausência de
  lastro (recusa + escalação). É **proibido** instruir o agente a responder "com o que já sabe" em
  contexto de assistência.
- **FR-014**: A ausência total de acervo no tenant **DEVE** produzir o mesmo comportamento de
  FR-009 — recusa e escalação —, nunca a supressão silenciosa da verificação.
- **FR-015**: Quando o corretor liga uma exigência de lastro pela tela, ela **DEVE** ter efeito
  observável no comportamento do agente. Configuração de segurança oferecida na interface e não
  aplicada em runtime é defeito, não pendência.

**Escopo por operadora — a resposta certa da operadora certa**

- **FR-016**: A busca que fundamenta uma resposta de assistência **DEVE** ser restrita ao material
  da operadora do cliente somada ao material marcado como "vale para todas". Trecho de outra
  operadora **NÃO PODE** ancorar a resposta, em nenhuma circunstância.
- **FR-017**: Quando a operadora do cliente não é conhecida, o sistema **DEVE** perguntar uma vez,
  em linguagem natural. Sem resposta utilizável, escala. O sistema **NÃO PODE** inferir a operadora
  por ser a única cadastrada, pela mais usada, ou por semelhança de texto.
  [NEEDS CLARIFICATION: por qual caminho o vínculo cliente↔operadora chega ao CRM — (a) o corretor
  registra no cadastro do cliente/lead; (b) o agente pergunta na conversa e grava com confirmação;
  (c) ambos, com (a) tendo precedência. A escolha muda o escopo: (a) exige campo e tela de cadastro,
  (b) exige gravação a partir da conversa e política de reconfirmação.]
- **FR-018**: Pergunta que envolve mais de uma operadora **DEVE** ser respondida por operadora,
  separadamente, cada parte com sua própria âncora; a parte sem lastro é recusada isoladamente.
  Fundir material de operadoras diferentes numa afirmação única é **proibido**.
- **FR-019**: Material de operadora **DEVE** ser dado do tenant e **NÃO PODE** ser alcançável por
  outra organização, por nenhum caminho — inclusive por chamada direta às operações de busca com
  identificador de organização escolhido por quem chama. O isolamento **NÃO PODE** depender de o
  chamador informar corretamente o próprio tenant.
- **FR-020**: A exigência de lastro **NÃO** se aplica ao discurso de conversão. O agente **DEVE**
  continuar qualificando, informando e conduzindo a venda em tenant sem acervo nenhum — sob as
  travas comerciais que já existem hoje.

**Rastreabilidade**

- **FR-021**: Toda resposta de assistência enviada **DEVE** guardar, de forma permanente e
  associada à mensagem, quais trechos a fundamentaram, de quais materiais e de qual versão do
  acervo.
- **FR-022**: O corretor **DEVE** conseguir, a partir da conversa e **sem ativar nenhum modo de
  depuração**, abrir a origem de uma resposta de assistência e ler o texto exato do trecho, o
  material, a operadora e a data da última atualização daquele material.
- **FR-023**: A rastreabilidade **DEVE** sobreviver à atualização do material: uma resposta antiga
  continua apontando para o conteúdo que estava valendo quando ela foi dada.
- **FR-024**: A falha em registrar a rastreabilidade de uma resposta de assistência **NÃO PODE**
  ser tratada como enriquecimento opcional: ou a resposta é rastreável, ou ela não é enviada.

**Validade do conteúdo**

- **FR-025**: Material **DEVE** poder declarar uma data de validade ou de próxima revisão. Declarar
  é **opcional**; não declarar **NÃO PODE** impedir o uso.
- **FR-026**: Material com validade expirada **NÃO PODE** ancorar resposta de assistência — o
  comportamento é idêntico ao de material ausente.
- **FR-027**: O sistema **DEVE** avisar o corretor **antes** do vencimento de um material,
  identificando material e operadora.

**Aprendizado e primeira impressão**

- **FR-028**: Toda recusa por falta de lastro **DEVE** ser registrada e apresentada ao corretor
  agrupada por operadora e por assunto, com contagem e ao menos uma pergunta real de exemplo.
- **FR-029**: O sistema **DEVE** distinguir, nessa apresentação, "não há nada sobre isto" de "há
  algo próximo, mas insuficiente" — são diagnósticos com ações opostas.
- **FR-030**: Uma instalação nova **DEVE** nascer com um agente pré-configurado para o corretor de
  plano de saúde, que já sabe conduzir a venda e já sabe recusar assistência sem lastro, **sem**
  que nenhum material tenha sido carregado.
- **FR-031**: Nenhuma tela ou passo desta feature **PODE** ser pré-requisito para publicar o agente
  ou para atender a primeira conversa. Carregar operadora é caminho de aprofundamento, nunca de
  entrada.
- **FR-032**: Carregar, editar ou remover material de operadora **DEVE** exigir papel de gestor ou
  superior, e toda mutação **DEVE** ser auditada.
- **FR-033**: O rótulo "operadora" **DEVE** ser vocabulário configurável, não um conceito cravado.
  Outro nicho (clínica com convênios, distribuidora com fornecedores) usa o mesmo mecanismo com
  outro nome, sem mudança de estrutura.
- **FR-034**: Qualquer superfície em que o corretor testa o agente **DEVE** exercer a mesma regra
  de lastro que vale na conversa real — ou declarar, na própria tela, o que ela **não** avaliou.
  Uma tela de teste que aprova uma resposta que a conversa real barraria é pior que não ter tela de
  teste: ela dá confiança falsa a quem não tem como conferir.
- **FR-035**: Quando dois materiais **da mesma operadora** afirmam coisas incompatíveis sobre o
  mesmo assunto, o sistema **DEVE** ancorar no mais recente e **DEVE** registrar a divergência para
  o corretor. Apresentar as duas versões ao cliente é **proibido**.

### Key Entities

- **Operadora (Escopo de Conhecimento)** — a que um material se aplica. Pertence a um tenant, é
  criada pelo corretor digitando o nome, e é o eixo pelo qual a busca de assistência é restringida.
  Atributos que importam: nome exibido, se está ativa, e um identificador oficial opcional (o
  código de registro da operadora) que serve como chave estável para uma futura correlação com
  dados externos. Um material especial pode declarar-se aplicável a **todas** as operadoras.
- **Material de Conhecimento** — a unidade que o corretor carrega e reconhece ("o PDF da rede
  credenciada da Operadora A"). Pertence a exatamente uma operadora (ou a todas), tem um estado de
  processamento visível, uma data de última atualização e uma validade opcional. É a unidade que o
  corretor corrige quando descobre um erro.
- **Trecho** — a menor unidade recuperável e citável, derivada de um material. É o que serve de
  **âncora**: quando um trecho fundamenta uma afirmação de assistência, ele é a prova de que
  aquela afirmação veio do acervo do corretor e não do modelo. Carrega consigo a operadora a que
  pertence, para que a restrição de escopo seja verificável no próprio trecho e não apenas por
  associação.
- **Acervo Publicado** — o conjunto de trechos que está valendo para um agente num dado momento.
  Existe para que atualizar um material não deixe o agente sem base, e para que uma resposta antiga
  continue rastreável ao conteúdo da época.
- **Vínculo Cliente ↔ Operadora** — qual operadora é a do plano daquele contato. É o que separa
  "assistir" de "converter" na prática e o que restringe a busca. Pode ser desconhecido, e
  desconhecido é um estado tratado, não um erro.
- **Resposta Ancorada** — o registro permanente que liga uma mensagem enviada aos trechos que a
  fundamentaram e à versão do acervo vigente. É o artefato que torna o princípio X verificável.
- **Lacuna de Conhecimento** — a pergunta de assistência que foi recusada por falta de lastro,
  classificada por operadora, por assunto e por tipo (nada encontrado × encontrado insuficiente).
  É o insumo do corretor para saber o que carregar.
- **Aviso de Escalação** — o item acionável que chega ao corretor quando o agente recusa, contendo
  pergunta, operadora e motivo. Reusa o mecanismo de avisos que já existe.

---

## Success Criteria *(obrigatório)*

Todos medidos pela tela, em ambiente fresco estilo VPS, com conta real — nunca por chamada de API.

### Resultados mensuráveis

- **SC-001 (invariante, não meta)**: **100%** das mensagens de assistência enviadas a clientes
  carregam ao menos um trecho âncora registrado e recuperável. A medida aceitável de mensagens de
  assistência sem âncora é **zero** — não 95%, não 99%.
- **SC-002**: Em um lote de **20 perguntas de assistência não cobertas** pelo acervo, **20**
  resultam em recusa + escalação, e **0** resultam em afirmação factual sobre a operadora. O mesmo
  resultado se repete quando a falha é **induzida** — com a consulta ao acervo indisponível de
  propósito, as 20 continuam terminando em recusa, e nenhuma em "respondo com o que eu sei".
- **SC-003 (primeira impressão, cronometrado)**: um corretor que nunca usou o sistema carrega a
  **primeira** operadora — do login ao primeiro trecho buscável — em **≤5 minutos**, sozinho, sem
  documentação, sem suporte e sem editar arquivo nenhum.
- **SC-004**: a **segunda** operadora é carregada em **≤2 minutos**, e durante todo o processo
  **100%** das perguntas sobre a primeira continuam sendo respondidas — zero janela sem base.
- **SC-005 (não-vazamento entre operadoras)**: com duas operadoras cujos materiais descrevem o
  mesmo procedimento de formas diferentes, **100%** das respostas ancoram em material da operadora
  correta. Trechos da operadora errada em respostas: **zero**.
- **SC-006 (escala)**: com **20 operadoras** carregadas, **100%** das perguntas que eram
  respondidas com 1 operadora continuam sendo respondidas, e o tempo até a resposta chegar ao
  cliente **não cresce mais que 25%** em relação à mesma bateria de perguntas com 1 operadora,
  medido no percentil 95. A medição com 1 operadora é registrada como linha de base na primeira
  execução — o critério é a diferença, não um número absoluto herdado de suposição.
- **SC-007 (isolamento entre corretores)**: em teste com duas organizações, **zero** trechos de uma
  aparecem em qualquer resposta ou consulta ao acervo da outra — inclusive quando alguém tenta
  deliberadamente consultar o acervo se identificando como a outra organização.
- **SC-008 (rastreabilidade)**: a partir de uma conversa, o corretor chega ao texto do trecho que
  originou a resposta em **no máximo 3 interações de tela**, com o modo de depuração **desligado**.
  O mesmo vale para uma resposta dada **antes** de o material ter sido atualizado: ela continua
  levando ao conteúdo que estava valendo na época, em **100%** dos casos.
- **SC-009 (conteúdo vencido)**: material com validade expirada ancora **zero** respostas, e
  **100%** dos materiais com validade declarada geram aviso ao corretor antes de vencer.
- **SC-010 (sem deploy)**: em ambiente fresco, **100%** das operadoras criadas pela tela passam a
  funcionar sem nenhum reinício, build, migration manual ou intervenção de suporte. Operadoras que
  exigiram release: **zero**.
- **SC-011 (o teto de 10 minutos é preservado)**: em instalação fresca **sem nenhum material
  carregado**, o percurso do login à primeira conversa atendida por agente continua ocorrendo em
  **≤10 minutos**, e o agente responde a mensagens de conversão normalmente.
- **SC-012 (a configuração não mente)**: com a exigência de lastro **ligada** na tela, o
  comportamento do agente muda de forma observável na conversa; com ela **desligada** (se
  desligável), também. Nenhuma opção de segurança visível na tela pode ficar sem efeito.
- **SC-013 (o corretor sabe o que fazer)**: após 10 recusas por falta de lastro, o corretor
  identifica na tela, sem ajuda, ao menos um assunto concreto que precisa carregar, e a lacuna
  desaparece da lista depois que ele carrega o material correspondente.
- **SC-014 (nada aceito em silêncio)**: em um lote de materiais que inclui casos inválidos
  (arquivo sem texto extraível, formato não suportado, arquivo acima do limite), **100%** terminam
  em estado explícito — pronto com contagem de trechos, ou falha com motivo em português. Materiais
  em estado "salvo mas sem conteúdo buscável": **zero**.
- **SC-015 (o teste não mente)**: a mesma pergunta feita na superfície de teste e na conversa real
  produz o mesmo **veredito de lastro** (responde ancorado × recusa) em **100%** dos casos; ou a
  superfície de teste declara na tela, antes do resultado, o que ela não avaliou.
- **SC-016 (contradição não vira improviso)**: com dois materiais da mesma operadora afirmando
  coisas incompatíveis, **100%** das respostas ancoram no mais recente, **zero** apresentam as duas
  versões ao cliente, e a divergência aparece para o corretor.

---

## Assumptions

Toda suposição abaixo é uma decisão tomada para não bloquear a entrega. Cada uma é revisável pelo
dono do produto; nenhuma é resultado de medição, exceto onde indicado.

- **A-01 — "Assistir" é orientar, não executar.** O agente **explica** como o cliente obtém a
  segunda via, onde acessa a carteirinha e o que a rede cobre. Ele **não** emite boleto, não acessa
  portal de operadora e não se integra a sistema de operadora. Integração com operadora é outro
  produto e outro risco.
- **A-02 — A regra de lastro é por afirmação, não por conversa.** Uma saudação, uma pergunta de
  qualificação ou um pedido de dado do cliente não exigem âncora. O que exige é a **afirmação
  factual sobre a operadora**. Sem isso, o agente não conseguiria nem cumprimentar.
- **A-03 — A classificação do que é "afirmação de assistência" pode errar, e o erro tem lado
  certo.** Classificar como assistência algo que não era custa uma escalação desnecessária;
  classificar como conversa comum uma afirmação factual custa uma informação errada ao cliente. Na
  dúvida, o sistema trata como assistência.
- **A-04 — O acervo continua sendo por agente, não por organização.** É o modelo que já existe
  (medido: `supabase/baseline.sql:2278`), e mudá-lo agora é escopo que não serve à história P1. O
  eixo novo é a **operadora dentro do acervo**, não a repartição do acervo.
- **A-05 — Uma pergunta, uma operadora.** O agente pergunta a operadora **uma única vez** por
  conversa quando ela é desconhecida; sem resposta utilizável, escala. Repetir a pergunta irrita e
  não converge.
- **A-06 — Publicação do material é automática.** Terminado o processamento com sucesso, o material
  entra em vigor sem um passo extra de "publicar". Exigir aprovação manual protegeria contra o
  próprio corretor e custaria minutos que o princípio VIII não tem. O corretor pode remover ou
  substituir a qualquer momento.
- **A-07 — Papel exigido é gestor ou superior**, alinhado ao que já vale para conhecimento hoje.
- **A-08 — Formatos de entrada do primeiro corte**: texto colado na tela e arquivo de documento
  legível como texto. Áudio, planilha e página web ficam para depois. O limite de tamanho e a lista
  de formatos são os que o produto já pratica.
- **A-09 — A escalação reusa o mecanismo de handoff e de avisos que já existe.** Esta feature não
  inventa fila, canal de notificação nem tela de atendimento.
- **A-10 — A lista de operadoras é dado do tenant.** Dois corretores que trabalham com a mesma
  operadora mantêm materiais independentes, conforme o princípio X. Não há acervo compartilhado
  entre organizações.
- **A-11 — A confiabilidade da resposta é responsabilidade editorial do corretor.** O sistema
  garante que a resposta veio do material dele e que ela é rastreável; ele garante que o material
  está certo. O produto não valida a veracidade do conteúdo carregado.
- **A-12 — O banco do Cotador Simplificado não é fonte desta feature (medido).** Ver a tabela de
  medições: ele tem farto material **comercial** e **nenhum** material de assistência (1 operadora
  com site, 0 com telefone, nada sobre boleto ou carteirinha). Além disso, o princípio XI proíbe
  leitura direta em runtime. A única concessão de desenho é reservar, na entidade Operadora, o
  identificador oficial de registro, para que uma importação futura tenha chave estável — decisão
  que **considera** a integração sem **adiar** nada por causa dela.
- **A-13 — O material "vale para todas as operadoras" existe e é minoria.** Serve para o que é do
  corretor (horário de atendimento, canais dele, política própria), não para procedimento de
  operadora.
- **A-14 — "Mais recente" é a data de atualização do material, não um juízo de qualidade.** A
  regra em si virou requisito (FR-035); o que fica como suposição é o critério de desempate:
  o sistema não avalia qual conteúdo é melhor, apenas qual é mais novo.
- **A-15 — O invariante de rastreabilidade vale para assistência.** Respostas de conversão não
  precisam de âncora e não são bloqueadas por falta dela.

---

## Fora de escopo (declarado, para não voltar como surpresa)

- **Importação de dados do Cotador Simplificado** — justificada em A-12. Fica de fora inteira, e
  não bloqueia nada aqui.
- **Integração com sistemas de operadora** (emitir boleto, consultar carteirinha, checar rede em
  tempo real) — A-01.
- **Conteúdo de operadoras real distribuído junto com o produto** — ver a pergunta em aberto Q2.
  Enquanto ela não é respondida, o produto entrega o acervo vazio com um modelo de preenchimento.
- **Repartir o acervo por agente ou dar a cada agente um subconjunto de operadoras** — A-04.
- **Cotação, precificação e comparação de planos** (missão converter, outro recorte).
- **Correção automática ou verificação de veracidade do material carregado** — A-11.
- **Multi-idioma no acervo** — o nicho de validação é pt-BR.

---

## Perguntas em aberto

Apenas as que mudam escopo de verdade. Todo o resto está assumido acima.

**Q1 — Por onde entra o vínculo cliente ↔ operadora?** (referenciada em FR-017)

- **(a)** O corretor registra a operadora no cadastro do cliente/lead. Exige campo e tela; é
  confiável e é trabalho recorrente do corretor.
- **(b)** O agente pergunta na conversa e grava a resposta. Custa zero cadastro, mas depende do
  cliente responder e exige política de reconfirmação.
- **(c)** Os dois, com o cadastro tendo precedência sobre o que veio da conversa.

  *Recomendação do desenvolvedor:* **(c)**, começando por **(b)** — porque (b) sozinho já
  desbloqueia a história P1 sem exigir que o corretor cadastre a carteira inteira antes de ver
  valor, e (a) entra como precedência quando o cadastro existir. A escolha muda o escopo do primeiro
  corte, por isso está aqui e não em Assumptions.

**Q2 — O produto distribui conteúdo pré-carregado de operadoras reais?**

- **(a)** Não: o acervo nasce vazio, com um modelo de preenchimento e um exemplo fictício. O
  corretor carrega o que sabe.
- **(b)** Sim: o produto embarca material das operadoras maiores, copiado para o tenant na
  instalação.

  A diferença não é técnica, é de **responsabilidade editorial e de risco jurídico**: em (b) um
  procedimento de boleto errado embarcado no produto vira erro do fabricante, replicado em todas as
  instalações; e o conteúdo desatualiza sem que ninguém seja dono da atualização. Em (a) o teto de
  5 minutos de SC-003 fica mais apertado, porque o corretor parte do zero.

  *Recomendação do desenvolvedor:* **(a)**, com um modelo de preenchimento bom o bastante para que
  o corretor só precise substituir os valores. É decisão do dono do produto.
