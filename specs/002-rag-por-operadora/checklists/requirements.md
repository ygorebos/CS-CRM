# Checklist de Qualidade de Requisitos: RAG por operadora de plano de saúde

**Propósito**: auditar a **qualidade da spec** antes de ela ir a plano — completude, clareza,
consistência, mensurabilidade e conformidade constitucional. Este checklist avalia **o documento**,
não a implementação. Nenhum item aqui se verifica rodando código.

**Criado**: 2026-08-07
**Feature**: [spec.md](../spec.md)
**Como usar**: cada item é uma pergunta que se responde lendo apenas a spec. Um item que exige
abrir o código para responder está mal escrito e deve ser reescrito.

---

## A. Conformidade constitucional (bloqueante)

- [x] CHK001 A spec declara, no cabeçalho, **qual missão do princípio IX** ela serve, e a
  declaração é inequívoca (uma das duas, não "as duas") — exigência do Fluxo de Trabalho.
- [x] CHK002 A spec declara **onde a feature cai no teto de 10 minutos** do princípio VIII, com
  número, e não apenas "não impacta".
- [x] CHK003 Existe requisito garantindo que nenhuma tela da feature vire pré-requisito do
  onboarding, de modo que o teto de 10 minutos não seja consumido por ela. → FR-031, SC-011
- [x] CHK004 Existe requisito de **estrutura pré-pronta que já funciona** sem configuração
  (princípio VIII): a instalação nova atende antes de qualquer material ser carregado. → FR-030
- [x] CHK005 A regra "assistência sem respaldo recusa e escala" (princípio IX) aparece como
  **requisito do sistema**, não como orientação ao modelo. → FR-009, FR-010
- [x] CHK006 A regra "toda resposta de assistência é rastreável ao trecho que a originou"
  (princípio X) aparece como requisito **verificável**, com sujeito e objeto claros. → FR-021..024
- [x] CHK007 A regra "operadora nova = carregar conteúdo, não fazer deploy" (princípio X) tem
  requisito **e** critério de sucesso mensurável. → FR-002, SC-010
- [x] CHK008 O isolamento por organização (princípios X e XI) é requisito explícito e não é dado
  como implícito por o sistema já ser multi-tenant. → FR-019, SC-007
- [x] CHK009 A spec não embute nenhuma suposição sobre o schema de sistema externo nem exige
  leitura direta do banco de outro sistema em runtime (princípio XI). → A-12, Fora de escopo
- [x] CHK010 Decisão de negócio genuína é apresentada **com recomendação do desenvolvedor já
  formada**, nunca como catálogo neutro de opções (princípio I). → Q1, Q2

## B. Completude do escopo

- [x] CHK011 As duas missões do princípio IX estão tratadas: o que a feature faz com assistência
  **e** o que ela explicitamente não faz com conversão. → FR-020, A-15
- [x] CHK012 Existe requisito cobrindo o ciclo completo do material: carregar → processar →
  entrar em vigor → atualizar → remover.
- [x] CHK013 Existe requisito cobrindo o estado "acervo vazio" (instalação fresca), e ele é
  descrito como estado **correto**, não como erro. → FR-014, Edge Cases
- [x] CHK014 Existe requisito cobrindo o que o corretor vê quando algo dá errado na carga, com
  exigência de motivo compreensível. → FR-005, FR-007
- [x] CHK015 Existe mecanismo anti-morte declarado: a feature diz como o acervo continua sendo
  alimentado depois da primeira semana. → FR-028, FR-029, US5
- [x] CHK016 A spec declara o que fica **fora de escopo**, com justificativa, em vez de deixar a
  ausência ambígua.
- [x] CHK017 Toda suposição adotada está registrada em Assumptions e identificada como suposição,
  não como fato medido.
- [x] CHK018 Afirmações apresentadas como medidas trazem a referência `arquivo:linha` ou a
  consulta que as produziu, e são distinguíveis das suposições.

## C. Clareza e ausência de ambiguidade

- [x] CHK019 Nenhum requisito usa qualificador vago sem número ou critério ("rápido", "amigável",
  "robusto", "sempre que possível", "quando apropriado").
- [x] CHK020 Cada requisito tem **sujeito** identificável (quem faz) e **objeto** verificável (o
  que precisa ser verdade).
- [x] CHK021 Os termos centrais da feature — "afirmação de assistência", "âncora", "operadora",
  "material", "trecho", "acervo" — estão definidos em Key Entities ou no próprio requisito, e são
  usados com o mesmo sentido em todo o documento.
- [x] CHK022 Requisitos proibitivos ("não pode") são tão específicos quanto os permissivos, e não
  se limitam a negar genericamente.
- [x] CHK023 O documento tem **no máximo 3** marcadores `[NEEDS CLARIFICATION]`, e cada um
  corresponde a uma decisão que muda escopo de verdade. → 1 marcador (FR-017/Q1); Q2 registrada
  como pergunta em aberto sem marcador inline
- [x] CHK024 A spec descreve **o quê** e **por quê**, não **como**: não nomeia framework, tabela,
  arquivo, biblioteca ou estrutura de dados como solução.

## D. Consistência interna

- [x] CHK025 Nenhum requisito contradiz outro (em especial: a exigência de âncora × a exigência de
  não travar a conversão × o teto de 10 minutos).
- [x] CHK026 Os cenários de aceite das histórias são coerentes com os requisitos funcionais — não
  há cenário exigindo comportamento que nenhum FR sustenta.
- [x] CHK027 Cada critério de sucesso corresponde a ao menos um requisito, e nenhum requisito
  crítico ficou sem forma de medir.
- [ ] CHK028 As Assumptions não contradizem os requisitos nem a constituição, e nenhuma delas
  "resolve" por conta própria uma pergunta que ficou marcada como em aberto.
  → **reprovado na rodada 3**: A-10 contradiz o princípio X, que declara conteúdo de operadora como
  dado de tenant. A contradição é deliberada, está declarada no topo da spec e tem caminho de
  resolução (emenda em PR próprio), mas enquanto a emenda não entra o item é falso. Reavaliar
  depois da emenda.
- [x] CHK029 Os edge cases não introduzem comportamento novo que os requisitos não cobrem — ou, se
  introduzem, o requisito correspondente existe.

## E. Mensurabilidade dos critérios de sucesso

- [x] CHK030 Todo critério de sucesso é **agnóstico de tecnologia**: não menciona componente,
  serviço, biblioteca nem métrica interna do sistema.
- [x] CHK031 Todo critério de sucesso é mensurável por observação externa — por quem usa ou por
  quem cronometra —, sem instrumentação privilegiada.
- [x] CHK032 Os critérios que expressam invariante de segurança usam **zero / 100%**, e não uma
  meta percentual que tolera dano. → SC-001, SC-002, SC-005, SC-007
- [x] CHK033 Os critérios de tempo trazem número absoluto e o ponto de início e fim da contagem.
  → SC-003, SC-004, SC-011
- [x] CHK034 Existe critério que prova a **não-regressão** do que já funciona (conversão, teto de
  10 minutos, respostas da operadora já carregada). → SC-004, SC-006, SC-011
- [x] CHK035 Existe critério que prova que a configuração oferecida na tela tem efeito real —
  fechando a classe de defeito "opção de segurança que não faz nada". → SC-012

## F. Cobertura de cenários

- [x] CHK036 Há história para o **corretor** (quem carrega) e para o **cliente final** (quem
  pergunta), e as duas são independentemente testáveis.
- [ ] CHK037 As histórias estão priorizadas, e a P1 sozinha entrega valor observável — cabe no
  ritmo de duas jornadas do princípio II.
  → **reprovado na rodada 3**: a P1 passou de três histórias para quatro (US1, US2, US3, US7) e
  ganhou a camada curada inteira — superfície de curadoria, semeadura versionada que nunca
  sobrescreve, precedência entre camadas e vínculo cliente↔operadora por duas vias. Continua
  priorizada e entregando valor observável, mas **não cabe em duas jornadas**. O fatiamento é
  trabalho do plano, não da spec — por isso o item fica aberto em vez de a spec ser reescrita.
- [x] CHK038 Edge case "operadora sem conteúdo" está coberto.
- [x] CHK039 Edge case "conteúdo desatualizado" está coberto, incluindo o caso de o material
  vencido ser o **único** que responderia.
- [x] CHK040 Edge case "pergunta que cruza duas operadoras" está coberto, com regra explícita
  contra fundir.
- [x] CHK041 Edge case "cliente pergunta algo fora do plano dele" está coberto, incluindo a
  proibição de afirmar cobertura por analogia.
- [x] CHK042 Edge case "operadora do cliente desconhecida" está coberto, com proibição explícita de
  o sistema adivinhar.
- [x] CHK043 Edge case "falha durante o processamento" está coberto, com garantia de que o acervo
  anterior sobrevive.
- [x] CHK044 Edge case "acervo grande" está coberto com número.

## G. Prontidão para o plano

- [x] CHK045 Cada requisito é testável: dá para escrever um teste que falha se ele for violado.
- [x] CHK046 A spec permite executar sem reabrir decisão (princípio III) — o que sobrou aberto
  está isolado nas perguntas Q1/Q2 e não bloqueia as demais histórias.
- [x] CHK047 A spec identifica o item de **maior risco** (a regra dura de recusa) e o coloca na
  P1, e não no fim — ordem por risco decrescente.
- [x] CHK048 A spec não promete comportamento que dependa de o modelo lembrar de colaborar:
  toda garantia dura está expressa como verificação do sistema. → FR-010

---

## Notas de execução

Duas rodadas, ambas em 2026-08-07, sobre a spec deste diretório.

- **Rodada 1** — 48 itens verificados lendo a spec inteira; **8 reprovações**: CHK019, CHK021,
  CHK026, CHK027 (dois requisitos sem medida), CHK029 (dois edge cases sem requisito), CHK030,
  CHK033. Detalhe em "Achados".
- **Rodada 2** — spec corrigida (5 requisitos e 5 critérios novos ou reescritos); **48/48
  aprovados**. Contagens conferidas mecanicamente ao fim: **35 FR**, **16 SC**, **1** marcador
  `[NEEDS CLARIFICATION]`.
- **Rodada 3** (2026-08-08) — reavaliação após a sessão de clarificação que trocou o eixo da
  feature: o conhecimento de operadora passou a ter **duas camadas** (catálogo curado pelo
  fabricante, compartilhado e distribuído com o produto; acervo próprio do corretor, isolado por
  organização, com precedência). **46/48 aprovados**; **2 reprovações novas**: CHK028 e CHK037,
  ambas consequência direta da mudança de eixo e ambas com caminho de resolução declarado.
  Contagens conferidas mecanicamente: **41 FR**, **21 SC**, **18 Assumptions**, **0** marcadores
  de clarificação pendentes.

## Achados

### Rodada 1 — o que reprovou e como foi corrigido

1. **CHK033 + CHK019 — SC-006 era um critério de tempo sem número.** A redação original dizia que
   o tempo de resposta "permanece dentro do mesmo limite praticado hoje pelo produto" — o que não
   é mensurável, porque esse limite não foi medido em lugar nenhum e eu não iria inventá-lo.
   **Correção**: SC-006 passou a exigir que o p95 **não cresça mais que 25%** em relação à mesma
   bateria com 1 operadora, e que a medição com 1 operadora seja registrada como linha de base na
   primeira execução. O critério vira a diferença, que é medível, em vez de um absoluto suposto.
2. **CHK026 — a US1 tinha cenário que nenhum requisito sustentava.** O cenário 3 mandava o corretor
   conferir a resposta "pela própria tela de teste", e nenhum FR falava de superfície de teste.
   Pior: a investigação mediu que a superfície de teste existente hoje roda por um caminho que
   **não** executa a cadeia de vetos de envio (`lib/ai/agents/avaliar-resposta-de-teste.ts:5-16`) —
   ou seja, o cenário, do jeito que estava, provaria a coisa errada. **Correção**: FR-034 (a
   superfície de teste exerce a mesma regra de lastro, ou declara o que não avaliou) + SC-015, e o
   cenário passou a admitir conversa real **ou** superfície de teste.
3. **CHK029 — o edge case de materiais contraditórios criava comportamento sem requisito.** Ele
   dizia que o agente ancora no mais recente e registra a divergência; isso estava só em
   Assumptions (A-14), e suposição não é requisito testável. **Correção**: FR-035 + SC-016.
4. **CHK029 — o edge case "fora do horário do corretor" também.** Ele prometia ao cliente uma
   "expectativa honesta" de atendimento que nenhum FR exigia. **Correção**: incorporado a FR-011.
5. **CHK027 — FR-013 (busca indisponível) não tinha critério de sucesso.** É justamente o caminho
   em que o sistema hoje instrui o agente a "responder com o que já sabe", então deixá-lo sem
   medida seria deixar o pior modo de falha sem prova. **Correção**: SC-002 passou a exigir o
   mesmo resultado **com a falha induzida**.
6. **CHK027 — FR-023 (rastreabilidade sobrevive à atualização do material) não tinha critério.**
   **Correção**: incorporado a SC-008, com 100%.
7. **CHK030 — SC-007 vazava forma de implementação.** A redação falava em "a operação de busca ser
   chamada informando o identificador da outra organização", que descreve a interface e não o
   comportamento. **Correção**: reescrito como "alguém tenta deliberadamente consultar o acervo se
   identificando como a outra organização" — a mesma ameaça, sem prescrever o desenho.
8. **CHK021 — "âncora" era usado sem definição.** O termo aparece em requisito e em critério, mas
   Key Entities só definia "Resposta Ancorada". **Correção**: a entidade **Trecho** passou a
   declarar que é ela que serve de âncora, e o que a âncora prova.

### Rodada 2 — verificações que passaram, e que vale registrar por quê

- **CHK023**: a spec ficou com **1** marcador `[NEEDS CLARIFICATION]` inline (Q1, em FR-017),
  abaixo do teto de 3 — confirmado por contagem. Q2 está na seção de perguntas em aberto **sem**
  marcador inline porque não trava requisito nenhum: ela decide o **conteúdo de fábrica**, não o
  comportamento exigido. Tudo o mais virou Assumption declarada (15 delas), conforme o princípio I.
- **CHK024**: a spec cita `arquivo:linha` apenas na seção de evidência ("o problema, medido"), que
  é justificativa do porquê. Nenhum requisito, critério ou entidade nomeia arquivo, tabela,
  componente ou biblioteca como solução.
- **CHK032**: SC-001 ficou como invariante (100% / zero), e não como a meta de 95% que o enunciado
  original sugeria. Para assistência, 5% de respostas sem lastro significa informação errada sobre
  boleto ou cobertura chegando ao cliente final — exatamente o dano que o princípio IX existe para
  impedir. Uma meta percentual aqui institucionalizaria o dano.
- **CHK035**: este item nasceu de uma medição, não de teoria — existe hoje uma opção "Exigir
  citação da base" editável na tela, salva no banco, e sem nenhum efeito em runtime. Um checklist
  que não vigiasse essa classe de defeito deixaria a feature nova repeti-la. Coberto por FR-015 +
  SC-012.
- **CHK037**: a US1 sozinha (carregar uma operadora e obter uma resposta ancorada e rastreável) é
  entregável, demonstrável e cabe no ritmo de duas jornadas do princípio II; as demais ampliam.
  *(Superado na rodada 3 — ver abaixo.)*

### Rodada 3 — o que a mudança de eixo quebrou, e o que ela consertou

**As duas reprovações novas**

1. **CHK028 — a spec agora contradiz o princípio X, de propósito.** O princípio diz que conteúdo de
   operadora "é dado de tenant e entra no isolamento por `organization_id` como qualquer outro"; a
   decisão do dono do produto cria um catálogo curado pelo fabricante, compartilhado por todas as
   organizações da instalação. Não é ambiguidade da spec, é mudança de doutrina — e a Governança
   exige que ela entre como **emenda em PR próprio, anterior à feature**. O item fica aberto até lá.
   A spec já declara o alcance exato que a emenda precisa cobrir, para que ela não seja escrita
   larga demais: partição somente-leitura para o tenant, sem dado de ninguém dentro, sem afrouxar o
   isolamento de nenhuma tabela tenant-aware.
2. **CHK037 — "simplificar" aumentou o primeiro corte.** A intenção declarada era tirar trabalho do
   corretor, e ela foi atendida (a instalação nasce sabendo). Mas as respostas escolhidas mantiveram
   a camada do corretor **e** acrescentaram a camada curada, a superfície de curadoria, a semeadura
   versionada e o vínculo cliente↔operadora por duas vias. O resultado líquido é um escopo maior que
   o da spec original, não menor. Registrado aqui em vez de silenciado porque o plano precisa
   começar pelo fatiamento, e um checklist verde teria escondido exatamente isso.

**O que a mudança consertou, e vale registrar**

- **CHK004 e CHK013 ficaram mais fortes.** Antes, "estrutura pré-pronta que já funciona" significava
  um agente que sabe recusar; agora a instalação nasce com conteúdo que ancora resposta de verdade
  (FR-030, SC-017). O estado de fábrica deixou de ser "recusa tudo".
- **CHK023 zerou.** O único marcador de clarificação pendente (o vínculo cliente↔operadora, em
  FR-017) foi respondido; a spec não tem mais nenhum.
- **CHK024 continua válido por pouco, e por escolha.** O nome do artefato de schema e do atualizador
  aparece **apenas** na seção de evidência e no registro literal das perguntas da sessão de
  clarificação. Nenhum requisito, critério, entidade ou cenário de aceite nomeia arquivo: todos
  falam em "artefato de schema que o instalador e o atualizador aplicam". Isso foi corrigido durante
  a rodada, não nasceu assim.
- **CHK027 exigiu quatro critérios novos.** FR-036 a FR-039 nasceram sem medida e ganharam SC-018,
  SC-020, SC-021 e uma cláusula em SC-008; FR-040 (o RAG de aprendizado não ancora assistência)
  ganhou cláusula em SC-001. Requisito novo sem critério é a forma mais comum de a spec parecer
  completa e não ser.
- **CHK029 pegou dois edge cases sem requisito**, os dois criados nesta rodada: desativar para o
  próprio tenant uma operadora que veio do catálogo (virou cláusula em FR-008) e o administrador de
  plataforma enxergar as lacunas da instalação dele (virou cláusula em FR-028).

---

## Rodada 4 — 2026-08-08, depois da análise cruzada e da clarificação

Executada sobre a spec já com plano e tarefas escritos. A análise cruzada achou 19 defeitos nos
três artefatos; três perguntas foram ao dono do produto. **Contagem inalterada: 46/48.** Os dois
itens abertos continuam abertos pelo mesmo motivo — nenhuma das respostas os tocava.

**O que mudou na spec, e o que isso fez com o checklist**

- **FR-042 nasceu, e ele existe por causa de uma resposta.** O dono do produto escolheu que escopo
  do catálogo **nasce inativo** — contra a recomendação do desenvolvedor, que era nascer ativo pela
  primeira impressão. A escolha é defensável (o agente não fala de operadora que aquele corretor não
  vende) e o custo dela é real: a instalação fresca só responde assistência depois de um passo.
  FR-042 é o que impede esse custo de virar defeito — a recusa passa a dizer que a resposta existe
  no produto e está a um clique. Sem ele, CHK004 e CHK013 teriam **regredido** nesta rodada.
- **FR-030, SC-011 e SC-017 foram reescritos** para contar o passo de ativação em vez de escondê-lo.
  SC-017 ganhou o lado negativo: antes de ligar, 100% de recusas **com** o aviso de FR-042.
- **FR-037 ganhou "adotado localmente".** A clarificação anterior tinha deixado um buraco que
  ninguém viu: "a semeadura só acrescenta versão" mais "o desempate é por recência" significa que a
  versão nova, sempre mais recente, apagaria a correção local **no comportamento** enquanto o banco
  continuava intacto. SC-018 passaria e o requisito falharia. SC-018 passou a medir a resposta, não
  só as linhas.
- **CHK027 continua verde por pouco**: FR-042 nasceu com medida no mesmo movimento (cláusula em
  SC-017), em vez de virar o quinto requisito sem critério da spec.

**Por que os dois itens seguem reprovados**

1. **CHK028** — a emenda existe (v2.0.0, commit `3c2a06b4`) e ganhou uma segunda em cima
   (v2.1.0, `259a3e0f`), mas **nenhuma foi mergeada**. Enquanto a `main` disser que conteúdo de
   operadora é dado de tenant, A-10 a contradiz. O item vira verde no merge, sem tocar na spec.
2. **CHK037** — o fatiamento em cinco (F1…F5) responde ao *ritmo*, mas o item pergunta pela **P1
   como conjunto**, e ela continua sendo quatro histórias. O que mudou é que agora existe um MVP
   nomeado que cabe: a US2 sozinha, sem tabela nova. Manter reprovado é mais honesto que redefinir
   o item para caber na resposta.
