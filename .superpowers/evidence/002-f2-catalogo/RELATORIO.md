# Fatia F2 + F3 — "a instalação nasce sabendo, e nós curamos sem destruir"

**Spec** `specs/002-rag-por-operadora/` · **Branch** `feat/002-rag-por-operadora` · **2026-08-08**

Registra **o que foi medido** e, com o mesmo destaque, **o que não foi**. Relatório que só lista o
verde é o tipo de evidência que engana quem lê depois.

---

## O que foi medido

### Portões

| Portão | Resultado |
|---|---|
| `pnpm test:db` | **78 arquivos, 534 testes** — verde, com `baseline.sql` aplicado em install (`ON_ERROR_STOP=1`) e update |
| `pnpm typecheck` | limpo no conjunto commitado |
| `pnpm lint` | **0 erros** (186 avisos, todos pré-existentes) |
| `pnpm lint:channels` | ok — 61 arquivos de dívida conhecida, nenhum novo |

Antes desta fatia o `test:db` tinha 477 testes. A fatia acrescentou 57.

### O banco de dev da nuvem, medido antes de qualquer escrita

`dxkzmolfjcmhqlcteswu` era **exatamente** o `baseline.sql`: 96 tabelas, diferença zero em ambos os
sentidos, e **sem `supabase_migrations.schema_migrations`**. Ou seja: nasceu do baseline, igual à
produção self-hosted, e não tem ledger de migration.

Isso muda o procedimento de junção com produção, e está registrado em
`docs/doctrine/armadilhas-de-execucao.md` (entrada 6): o veículo é o `update.sh` re-aplicando o
baseline com o apêndice, não `supabase db push`.

As quatro migrations (0117–0120) foram aplicadas **e re-aplicadas** ali, com 15 verificações verdes
— incluindo sondagem em transação revertida, que não deixou linha nenhuma para trás.

### `fn_buscar_lastro` — 16 verificações de efeito

Vetores determinísticos (`v(i)` = 1 na posição `i`), porque o que se mede é a **regra**, não a
qualidade do embedding. Um teste que dependesse do modelo ficaria vermelho no dia em que a OpenAI
mudasse de versão.

Provado: escopo desligado não devolve material de escopo · trecho de outro escopo nunca ancora ·
material do corretor B nunca sai para o agente de A (com controle provando que a linha de B existe
**e** é alcançável por B) · material vencido não ancora · `p_scope_id` nulo devolve só "vale para
todos" · escopo de outro tenant não resolve · o catálogo ancora para quem não tem material próprio ·
precedência de camada dentro do balde · a função não é executável por `public`/`anon`/`authenticated` ·
`retrieve_top_k_chunks` perdeu `authenticated`.

### Sabotagem (Princípio XI)

| Sabotagem | Vermelhos | Onde |
|---|---|---|
| filtro de escopo do catálogo | 4 | `busca-escopo-nao-vaza` |
| precedência global em vez de por balde | 1 | idem |
| corte de validade | 1 | idem |
| inércia ignorada | 1 | `semeadura-nao-sobrescreve` |
| recorte por versão vigente removido | 4 | idem |
| `do nothing` → `do update` | 1 | `semeadura-do-catalogo-real` |
| guarda do trecho removida | 4 | idem |
| `organization_id` plantado no catálogo | 4 | `catalogo-sem-dado-de-ninguem` |
| policies de isolamento afrouxadas (3 eixos) | 3, 2, 5 | `isolamento-com-catalogo` |

Todas revertidas e re-verificadas verdes.

### Dois pontos cegos que a sabotagem revelou nos próprios testes

Registrados porque valem mais que os testes que eles corrigiram.

**A precedência de camada esconde vazamento.** Sabotar o filtro de escopo do catálogo deixou a
asserção mais óbvia **verde**: o corretor tinha material próprio naquele balde, e a precedência
removeu o trecho vazado junto com o legítimo. O mesmo mecanismo escondeu o corte de validade. O
conserto foi acrescentar casos em que o tenant **não** tem material no balde.

**Sabotagem que derruba 1 de 9 não é cobertura fina, é cobertura ausente.** No teste de isolamento,
afrouxar a policy de `ai_chunks` derrubava quase nada, porque as travessias por escopo já eram
seguradas pela policy de `knowledge_scopes`. A trava dependia de duas policies e o teste vigiava
uma. Conserto: o caso do balde "vale para todos", onde `ai_chunks` é a última linha.

---

## O achado que mede o produto, não a regra: âncora fraca é permissão indevida

Medido em 2026-08-08 contra o catálogo semeado, com **embeddings reais** (`text-embedding-3-small`)
e o limiar que o produto de fato usa (`ai_agents.config.rag_similarity_threshold = 0.40`, migration
0097). Cinco perguntas de cliente, escritas como um cliente escreve.

**Os dois lados de SC-017 funcionam.** Com todos os espelhos desligados — o estado de uma
instalação recém-criada — o material "vale para todos" responde: carência `0.616`, boleto `0.711`,
portabilidade `0.495`. Depois de **um** clique ligando o escopo A, "como consulto quais hospitais
atendem meu plano?" passa a ancorar em "Como consultar a rede credenciada" (`0.567`), material que
o corretor não carregou. É exatamente o que "a instalação nasce sabendo" promete.

**E o defeito.** "Como funciona o reembolso de consulta particular?" é assunto do escopo B, que
está desligado. O material certo é corretamente excluído — e o topo do resultado vira **"Como
consultar a rede credenciada", do escopo A, com `0.460`**. Acima do limiar. Antes de ligar
qualquer escopo, as mesmas duas perguntas ancoravam em "O que é carência", com `0.377` e `0.407`.

Isto **não é** defeito da busca por escopo: o filtro fez o que devia. É defeito do critério de
suficiência. O gate `assistance_grounding` da F1 pergunta *"existe âncora?"*, não *"a âncora fala do
que a afirmação diz?"*. Um texto sobre rede credenciada autoriza uma afirmação sobre reembolso, e a
resposta sai com citação — parecendo mais confiável, não menos.

Os números não separam sozinhos: a âncora correta mais fraca (`0.495`) está abaixo da âncora errada
mais forte que o limiar deixa passar seria preciso um corte entre `0.460` e `0.495` para acertar
estas cinco, e calibrar um limiar em cinco amostras é ajustar ao ruído. **Similaridade não é
aboutness**, e mexer no número não conserta a categoria de erro.

O caminho que cabe na arquitetura sem redesenho: a F1 já classifica o assunto da afirmação em sete
categorias (`lib/agent-engine/guardrails/lexico-assistencia.ts`). O gate pode exigir que o trecho
âncora caia na **mesma** categoria da afirmação, em vez de aceitar qualquer trecho acima do limiar.

Fica registrado como **T138**, aberto, com estes números — não foi consertado nesta fatia, e
declarar que a F2 está pronta sem dizer isto seria a mesma omissão que a spec 002 existe para
corrigir.

---

## Decisões de desenho que valem registro

**A-20 virou trava, não convenção.** "Espelho do catálogo nasce desligado" podia ser o `false` que a
função de sincronização escreve. Não é: é trigger `before insert`. Convenção que precisa ser
lembrada pela função, pela rota de curadoria, pelo onboarding e por todo script futuro é convenção
que um deles esquece — e o sintoma do esquecimento é o agente falando de operadora que o corretor
não vende, que nenhum teste de linha detecta.

**A segunda metade de FR-037, que não estava na tarefa.** Marcar a versão semeada nova como inerte
não faz a edição local vencer: a versão `seed` **anterior** continuava ancorando ao lado da local,
dizendo justamente o que o administrador corrigiu. A busca passou a considerar, por `slug`, apenas
a maior versão não-inerte.

**A inércia é gravada, não conferida na leitura.** Podia ser um `where` na busca. Não é, porque a
versão inerte precisa **aparecer na tela** para ser aceita — estado que só existe dentro de um
`where` não tem como ser mostrado, e `inert` viraria um jeito elegante de perder release.

**O catálogo nasce com exemplo, e o exemplo se declara no próprio corpo.** Não num comentário do
SQL: no texto que o cliente pode acabar lendo. Se o corretor publicar o agente sem trocar nada, o
pior que acontece é o cliente ler que aquilo é demonstração.

---

## O que ainda NÃO foi medido

| Item | Estado |
|---|---|
| **Qualquer coisa pela tela** | as telas de curadoria e de escopos estavam sendo escritas quando este relatório foi aberto. Nenhum Playwright rodou nesta fatia. O item 12 do Definition of Done está **aberto** |
| **SC-011** (ligar um escopo custa um passo, cronometrado) | não medido — depende da tela |
| **SC-006** (linha de base com 1 escopo) | **a janela fechou**: a tarefa mandava medir ANTES da semeadura, e a semeadura já entrou. É recuperável num banco fresco com exatamente um escopo ativo, mas não foi feito |
| **SC-001 / SC-002** (bateria de 20 perguntas) | não medidos. As chaves de IA agora existem e respondem, então o impedimento deixou de ser credencial e passou a ser a integração do agent-engine |
| **O turno real** | `fn_buscar_lastro` está provada por SQL; o agente ainda chamava `retrieve_top_k_chunks` quando este relatório foi aberto |
| **`.update({ embedding })` pelo PostgREST** no worker de reindexação | não exercitado contra Postgres real. Segue o idioma de `workers/rag-indexer.ts`, o que é precedente, não medição |
| **Corrida de dois `POST` com o mesmo nome de escopo** | o 409 é pré-checagem em aplicação; não há índice único em `(organization_id, lower(display_name))`. Fechar isso pede migration |

E a advertência que precisa sobreviver a esta sessão: **a regressão destas jornadas não é vigiada
por job nenhum na parte de UI.** O check `e2e` não é obrigatório na branch protection (issue #63).
O que está protegido é o banco, via `invariants`.
