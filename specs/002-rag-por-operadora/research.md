# Research — RAG por operadora

**Fase 0** do plano. Cada decisão traz o que foi escolhido, por quê, e a alternativa rejeitada com
o motivo. Onde há medição, ela vem com `arquivo:linha` — o resto está declarado como suposição.

A spec entrou nesta fase **sem nenhum `[NEEDS CLARIFICATION]`**: os dois pontos em aberto (o
vínculo cliente↔operadora e a distribuição do conteúdo curado) foram respondidos na sessão de
clarificação de 2026-08-08. Não há incógnita de produto aqui — só de desenho.

---

## D1 — Onde vive o catálogo curado

**Decisão**: partição própria, três tabelas novas **sem `organization_id`** —
`catalog_scopes`, `catalog_materials`, `catalog_chunks`. RLS ligada com policy de leitura para
`authenticated` e escrita condicionada a `fn_is_platform_admin()`.

**Racional**: a trava 3 do Princípio X v2.0.0 proíbe relaxar RLS de tabela tenant-aware para
acomodar a camada nova. `ai_chunks` tem `organization_id uuid NOT NULL`
(`supabase/baseline.sql:1070`) e policy de isolamento por `fn_user_org_ids()`. Uma partição própria
mantém aquela policy intocada, concentra o risco de vazamento em três tabelas novas, e torna o
invariante de isolamento escrevível em um lugar só.

**Alternativa rejeitada**: tornar `ai_chunks.organization_id` nullable e usar `NULL` como "linha do
catálogo". Rejeitada porque é exatamente o que a trava 3 proíbe: a policy de `ai_chunks` teria de
passar a aceitar linhas sem dono, e a partir daí qualquer erro de policy em qualquer tabela
tenant-aware vira vazamento entre organizações. Também degradaria o teste de isolamento existente,
que hoje prova "zero linhas cruzadas" sem exceções a explicar.

---

## D2 — Como a busca junta as duas camadas

**Decisão**: função SQL nova — `fn_buscar_lastro(p_agent_id, p_scope_id, p_embedding, p_k,
p_threshold)` — que faz `union all` sobre `ai_chunks` (camada do tenant) e `catalog_chunks` (camada
curada), devolvendo a camada de cada linha. **Ela não recebe `organization_id` do chamador**: o
tenant e o acervo ativo são **derivados de `p_agent_id`** (`ai_agents.organization_id` e
`ai_agents.active_kb_version_id`). É revogada de `public`, `anon` e `authenticated`, ficando só com
`service_role`.

**Corrigido na revisão de brechas de 2026-08-08 (brecha 7).** A primeira redação dizia "deriva de
`fn_user_org_ids()`/`auth.uid()`", e isso **não funcionaria**: o chamador real é o agent-engine,
que fala com o banco por Pool `pg` com credencial de serviço (`search-knowledge.ts:65`) — não há
sessão de usuário, `auth.uid()` é NULL, e a função devolveria vazio sempre. Derivar de `p_agent_id`
resolve e mantém a exigência: o chamador **aponta um agente**, resolvido server-side a partir da
conversa, em vez de **afirmar um tenant**. A diferença é a de FR-019 — o isolamento não depende de
o chamador informar corretamente o próprio tenant.

**Racional**: duas coisas empurram para isso.

Primeiro, o isolamento. A função atual tem a assinatura
`retrieve_top_k_chunks(p_organization_id, p_kb_version_id, ...)`
(`supabase/baseline.sql:8644`) e o próprio comentário dela admite o problema: *"Caller must validate
p_organization_id matches authenticated tenant"* (`:917`). Ela é `SECURITY DEFINER` e está
concedida a `authenticated` (`:3709`). O Princípio XI cita esse caso como um dos três defeitos que
atravessaram todos os gates verdes. FR-019 e SC-007 exigem que o isolamento **não dependa** de o
chamador informar corretamente o próprio tenant — logo, a função nova não pode nascer com o mesmo
vício.

Segundo, a testabilidade. A precedência de camada e o filtro por operadora são invariantes de
segurança da feature (SC-005, SC-019). Em SQL eles são exercitáveis pelo `pnpm test:db`, que é o
gate certo para schema e RLS. Montados em TypeScript, ficariam fora do gate que os vigiaria.

**Medido antes de decidir**: revogar `authenticated` é seguro. Os únicos chamadores da função atual
são `workers/ai-response-worker.ts:506` (admin client), `lib/ai/knowledge/busca.ts:68` (recebe o
client de fora, e o único caminho que a usa é o MCP, que monta `createAdminClient()` em
`lib/mcp/server.ts:39`) e `lib/agent-engine/agent/search-knowledge.ts:65` (Pool `pg` direto).
Nenhum chamador `authenticated` existe.

**Alternativa rejeitada**: acrescentar parâmetros à `retrieve_top_k_chunks`. Rejeitada porque
manteria a assinatura que confia no chamador e faria a feature que mais precisa de isolamento
provado nascer sobre a função que menos o garante. A existente permanece, para não quebrar
caminhos vivos, mas perde o grant a `authenticated` no mesmo apêndice — é forward-fix, não edição
de migration aplicada.

---

## D3 — Onde entra o veto de lastro

**Decisão**: gate novo `assistance_grounding` em `BEFORE_SEND_GATES`
(`lib/agent-engine/guardrails/before-send.ts:537`), na posição **(2.5)** — depois de `lgpd`, antes
de `pacing`. `BEFORE_SEND_CHAIN_VERSION` vai de 6 para 7. O gate nasce **desarmado por default**,
como o `internal_vocabulary` fez na v6 (`:514`), e só o caminho do agente o arma.

**Racional**: a cadeia é dado declarativo iterado pelo runner e a ordem é invariante de segurança
declarada (`:521-534`). Uma mensagem que **não pode ser dita** não deve ser avaliada quanto a
horário e ritmo — por isso antes de `pacing`. Depois de `lgpd` porque conformidade legal e opt-out
continuam sendo primeira linha.

Nascer desarmado é o que permite a fatia F1 entrar sem mudar o destino de nenhum envio que já
existe fora do caminho do agente — o mesmo padrão que a v6 usou, e que deixa o trace medindo antes
de o veto morder.

**Alternativa rejeitada**: validar lastro dentro do `search-knowledge` ou do prompt. Rejeitada por
FR-010, que exige verificação determinística e independente da colaboração do modelo. Instrução de
prompt é exatamente o que existe hoje (`lib/agent-engine/agent/inbound-turn.ts:204-206`) e é o que
não funcionou.

---

## D4 — Como o sistema decide que a mensagem é "afirmação de assistência"

**Decisão**: classificação **determinística** sobre o texto de saída, com viés declarado para o
lado seguro (A-03): léxico de procedimento (boleto, segunda via, carteirinha, rede credenciada,
carência, reembolso, cobertura, prazo, canal de atendimento) **mais** presença de nome de operadora
conhecida do acervo. Na dúvida, é assistência. O resultado do modelo não entra na decisão.

**Racional**: FR-010 é explícito — a verificação é condição de envio e não pode depender do modelo.
Um classificador por LLM introduz uma chamada que pode falhar, e falha de classificador em modo
aberto significa afirmação factual saindo sem lastro, que é o dano que a feature existe para
impedir. O custo do viés é escalação desnecessária, que A-03 já declarou como o lado certo do erro.

**Alternativa rejeitada**: classificador por LLM no turno. Rejeitada por falhar aberto e por
transformar uma trava de segurança em mais uma chamada de rede dentro do caminho de envio.

**Suposição declarada**: o léxico do primeiro corte é pt-BR e cobre o vocabulário de plano de
saúde. Ampliá-lo é acrescentar termo, não mudar desenho — e o léxico vive em constante
compartilhada, nunca em literal espalhado, pela mesma razão que o vocabulário de canal já vive
(doutrina de vocabulário aberto do `CLAUDE.md`).

---

## D5 — Como a citação deixa de ser enfeite

**Decisão**: as citações passam a entrar **no `insert` da mensagem**, não num `update` posterior.
O gate de D3 exige `citations.length > 0` para afirmação de assistência, e o registro é condição de
envio (FR-024).

**Racional**: hoje a citação é carimbada depois que a mensagem já saiu, com o comentário explícito
*"citação é enriquecimento, não invariante — falha só loga"*
(`lib/agent-engine/agent/inbound-turn.ts:1494`). Isso torna SC-001 impossível de garantir: uma falha
no `update` deixa uma afirmação de assistência enviada e sem âncora, e ninguém fica sabendo. Como o
requisito diz "ou a resposta é rastreável, ou ela não é enviada", o registro tem de acontecer antes
do envio, no mesmo caminho que o cria.

**Alternativa rejeitada**: manter o `update` e acrescentar retry. Rejeitada porque retry reduz a
frequência do buraco sem fechá-lo, e SC-001 é invariante (zero), não meta percentual.

---

## D6 — Como o catálogo chega ao clone, e com quais embeddings

**Decisão**: semeadura no apêndice do `baseline.sql`, com **embeddings pré-computados** escritos
como literal `vector(1536)`, e `insert ... on conflict do nothing` sobre `(slug, version)`. Cada
trecho guarda o `embedding_model` que o gerou. Um worker re-embeda **só** quando o modelo
configurado difere do registrado.

**Racional**: três exigências se cruzam aqui.

FR-030 e SC-017 pedem que a instalação fresca **já responda**. SQL não chama API de embedding, então
ou o vetor viaja pronto, ou a primeira impressão depende de um worker rodar com chave de IA válida.

A trava 6 do Princípio X proíbe sobrescrever. `on conflict do nothing` sobre `(slug, version)` é
idempotente **e** não-destrutivo: reaplicar não muda nada, e conteúdo novo chega como versão nova.
Um `on conflict do update` seria igualmente idempotente e apagaria a correção local — idempotência
sozinha não satisfaz a trava.

Reprodutibilidade: com o vetor viajando pronto, todo clone tem exatamente o mesmo índice. Um
self-hoster que relata "ele não acha isto" descreve um estado reproduzível aqui.

**Custo declarado**: ~12 KB por trecho em texto (1536 floats). Para ~100 trechos, ~1,2 MB no
`baseline.sql`. É acréscimo real num arquivo que já é grande, e entra como dívida declarada, não
como detalhe.

**Alternativa rejeitada**: indexar no primeiro boot. Rejeitada por quebrar SC-017 no minuto zero,
por amarrar a primeira impressão a uma chave de IA que pode estar errada, e por fazer cada clone
gerar um índice ligeiramente diferente.

---

## D7 — Precedência entre camadas na recuperação

**Decisão**: quando **qualquer** trecho do acervo do tenant, do escopo em questão, passa o limiar
para aquela pergunta, os trechos do catálogo **do mesmo balde** não ancoram aquela resposta.
Aproxima-se "mesmo assunto" por "ambos acima do limiar para a mesma pergunta".

**Balde** = ou o escopo específico, ou "vale para todas" — nunca os dois juntos. Material do
corretor sobre a Operadora A suprime o material curado **da Operadora A**, e **não** suprime o
material "vale para todas"; e vice-versa (**brecha 8**, corrigida em 2026-08-08). Sem essa
separação, um texto do corretor sobre o horário de atendimento dele apagaria o procedimento de
boleto da operadora, ou o contrário — dois conteúdos com propósitos diferentes disputando o mesmo
lugar.

**Racional**: FR-035 manda a camada do tenant vencer o catálogo na contradição, e detectar
"contradição sobre o mesmo assunto" de forma exata exigiria comparar semântica de afirmações — que
é justamente o tipo de julgamento que esta feature não faz (A-11, A-14). A regra escolhida é
mecânica, explicável ao corretor em uma frase ("o que você escreveu sobre essa operadora vale mais
que o que veio com o produto") e verificável por teste.

**Trade-off declarado**: um trecho do tenant marginalmente relevante pode ofuscar um trecho do
catálogo melhor. Mitigações: o limiar já corta o irrelevante, e a rastreabilidade de FR-039 mostra
ao corretor exatamente qual trecho ancorou, o que torna o caso visível e corrigível. É o mesmo
raciocínio de A-11: quem escreveu responde pelo conteúdo.

**Alternativa rejeitada**: bônus de pontuação para a camada do tenant. Rejeitada por exigir um
número mágico que ninguém sabe calibrar e que mudaria o resultado de forma invisível a cada ajuste.

---

## D8 — A identidade da operadora, e onde o contato aponta

**Decisão**: tabela `knowledge_scopes` **por tenant** (com `organization_id` e RLS), em que cada
linha ou aponta para uma `catalog_scopes` (`catalog_scope_id` preenchido) ou é do próprio corretor
(`NULL`). `contacts` ganha FK para `knowledge_scopes`, mais a coluna que diz de qual origem o
vínculo veio.

As linhas espelho do catálogo são materializadas por uma função SQL idempotente, chamada (a) na
criação da organização e (b) no fim do apêndice de semeadura, para toda organização existente — é o
que faz operadora nova chegar a clone antigo no `update.sh`.

**Racional**: o contato precisa apontar para **uma** coisa, e ela precisa ser tenant-aware para não
abrir buraco no Princípio I. Um ponteiro direto para `catalog_scopes` colocaria uma FK de tabela
tenant-aware para tabela sem dono, e a desativação por tenant (trava 4) não teria onde morar.
A tabela espelho resolve as duas: `is_active` por tenant é a desativação, e `display_name` por
tenant permite renomear sem tocar no catálogo.

Guardar o código de registro oficial (ANS) na `catalog_scopes` é a única concessão a uma importação
futura, conforme A-12 — chave estável, sem FK, sem leitura do banco do Cotador.

**Alternativa rejeitada**: `contacts.operadora` como texto. Rejeitada pelo anti-pattern nº 1 do
`CLAUDE.md` — string que deveria ser FK — e porque "mesma operadora escrita de dois jeitos" viraria
duas operadoras na hora de filtrar a busca, quebrando SC-005 em silêncio.

---

## D11 — O nome estrutural não é "operadora"

*(Decisão acrescentada na revisão de brechas de 2026-08-08 — brecha 11.)*

**Decisão**: as tabelas se chamam `knowledge_scopes` e `catalog_scopes`; as colunas, `scope_id`.
"Operadora" é **rótulo de vocabulário**, resolvido na exibição pelo mesmo mecanismo configurável que
já renomeia lead/deal/won/lost por pipeline.

**Racional**: FR-033 exige que o rótulo seja configurável e não um conceito cravado — outro nicho
(clínica com convênios, distribuidora com fornecedores) usa o mesmo mecanismo com outro nome, **sem
mudança de estrutura**. FR-041 reforça: a estrutura não pode assumir o recorte do primeiro catálogo.
A própria spec já dá o nome certo ao batizar a entidade "Operadora (**Escopo de Conhecimento**)".

Uma tabela chamada `operadoras` cumpriria a letra de FR-033 (dá para trocar o rótulo na tela) e
falharia no espírito: o schema passaria a afirmar que o produto é de plano de saúde, e o primeiro
clone de clínica teria de conviver com isso ou pagar uma migration de renome.

**Alternativa rejeitada**: manter `operadoras` e trocar só o rótulo na UI. Rejeitada por custo
assimétrico — a mudança é gratuita agora, enquanto isto é documento, e cara depois que houver
migration aplicada, `database.types.ts` gerado, RLS nomeada e rota publicada.

---

## D9 — O acervo do tenant deixa de ter 4 slots

**Decisão**: remover o índice único `ai_knowledge_sources_unique_per_agent (agent_id, source_type)
WHERE is_active` (`supabase/baseline.sql:2286`) e acrescentar `scope_id` a
`ai_knowledge_sources`. O acervo continua sendo **um por agente** (A-04): `ai_knowledge_versions`
mantém `ai_kbv_one_active_per_agent` (`:2278`), e a reconstrução total a cada mudança
(`workers/rag-indexer.ts:277-294`) continua valendo.

**Racional**: é o índice que hoje torna "operadora nova = carregar conteúdo" estruturalmente
impossível — duas FAQs ativas no mesmo agente violam a unicidade. O eixo novo é a operadora
**dentro** do acervo, não a repartição do acervo (A-04), então nada além desse índice precisa cair.

**Consequência que a migration tem de tratar**: soltar um índice único é seguro, mas
`ai_knowledge_sources.scope_id` nasce nulo nas linhas existentes, e material sem escopo declarado é
proibido por FR-001. A migration marca as linhas legadas como "vale para todas" — que é o
comportamento mais próximo do que elas têm hoje (um acervo único, sem eixo) e não perde conteúdo de
ninguém.

**Onde o `drop index` tem de morar** (**brecha 10**, corrigida em 2026-08-08): no **apêndice do
`baseline.sql`**, não só na migration. O snapshot do baseline **recria** esse índice
(`supabase/baseline.sql:2286`) em toda instalação nova, e o apêndice roda depois dele. Sem o
`drop index if exists` lá, o clone recém-instalado nasceria com o índice que impede a segunda
operadora, enquanto o clone atualizado não teria — duas realidades a partir do mesmo arquivo, e o
defeito apareceria só para quem instalou do zero.

**Alternativa rejeitada**: acervo por operadora (uma `ai_knowledge_versions` ativa por operadora).
Rejeitada por A-04 e porque multiplicaria por N o custo de reconstrução, que hoje já é total a cada
mudança.

---

## D10 — Como a extração de PDF passa a persistir

**Decisão**: `lib/ai/rag/ingest/policy.ts` passa a gravar o texto extraído como itens indexáveis do
material, em vez de extrair só para validar e devolver a contagem (`:94-126`). O indexador deixa de
ler exclusivamente pares pergunta/resposta (`workers/rag-indexer.ts:313`) e passa a aceitar as duas
formas.

**Racional**: é o defeito medido nº 5 da spec, e é o pior modo de falha do produto hoje — o PDF
sobe, a tela diz 201, e o conteúdo nunca vira trecho. Um usuário que não lê documentação acredita
que ensinou o agente. FR-004 e SC-014 fecham essa classe: material aceito vira conteúdo buscável ou
falha visivelmente.

**Alternativa rejeitada**: recusar PDF e aceitar só pares pergunta/resposta. Rejeitada porque o
material que o corretor mais tem é PDF (A-08), e "recuse o que ele tem" não é simplificação, é
transferir o trabalho de digitação para quem tem 10 minutos.

---

## Riscos que a execução deve vigiar

1. **A emenda constitucional é pré-requisito de processo.** Nada em F2 pode ser mergeado antes de a
   v2.0.0 entrar na `main`. Não é risco técnico, é ordem de PR — e está na Complexity Tracking.
2. **A classificação de D4 é a peça com maior chance de errar na prática.** Ela decide quando o veto
   morde. O trace do gate precisa registrar o veredito desde a fatia F1, para que o ajuste do léxico
   seja feito sobre medição e não sobre impressão.
3. **O tamanho do `baseline.sql` (D6)** cresce com o catálogo. Se o catálogo passar de poucas
   operadoras, a decisão de carregar embeddings prontos precisa ser reaberta — e o gatilho para
   reabri-la é o arquivo, não o número de operadoras.
4. **SC-006 não tem linha de base.** A primeira execução com 1 operadora É a medição de referência.
   Registrá-la é tarefa da fatia que a exercita, não suposição a herdar — e **antes da semeadura**,
   porque depois dela "1 escopo" já não existe (revisão cruzada de 2026-08-08).

---

## D12 — A edição local trava as versões que chegam depois

**Decisão**: editar um material `seed` marca o `slug` como **adotado localmente** (`adopted_at`,
`adopted_by`); toda versão semeada que chegar depois entra `inert = true` — fora da busca e fora do
desempate por recência —, visível na curadoria para ser aceita.

**Racional**: `on conflict do nothing` resolve *apagar*, não resolve *vencer*. Como a versão que
chega por release é sempre a mais recente, o desempate de FR-035 a faria ganhar da correção local:
a edição continuaria no banco e pararia de ser usada. SC-018 passaria contando linhas enquanto
FR-037 falhava respondendo — a pior forma de defeito, a que tem teste verde. O gatilho para achar
isto foi cruzar duas regras que tinham sido escritas em momentos diferentes.

**Alternativa rejeitada**: chave global "esta instalação não aceita atualizações do catálogo".
Congela o catálogo inteiro por causa de uma correção pontual, e transforma quem consertou uma frase
em quem não recebe mais nada. O estado é por material (A-21).

## D13 — Escopo do catálogo nasce desligado, e a recusa diz isso

**Decisão**: `knowledge_scopes.is_active` nasce `false` para espelho do catálogo e `true` para
escopo que o corretor criou. E a recusa por falta de lastro passa a dizer, quando é o caso, que
existe escopo no catálogo cobrindo o assunto (FR-042).

**Racional**: decisão do dono do produto, **contra** a recomendação do desenvolvedor — que era
nascer ligado, porque a primeira impressão manda (Princípio VIII). O argumento vencedor é de
negócio e é bom: o agente não deve falar de operadora que aquele corretor não vende. O custo é real
e foi absorvido em vez de escondido — FR-030, SC-011 e SC-017 passaram a contar o passo de ativação.

**O que torna a decisão segura**: FR-042. Sem ele, a instalação fresca recusa tudo e o corretor
conclui que o produto não sabe nada, quando ele sabe e ninguém ligou. Uma decisão de produto que
cria um estado silencioso precisa nascer com a superfície que o quebra.

**Alternativa rejeitada**: ativar só os materiais "vale para todas". Cria duas categorias de
comportamento que o corretor tem de deduzir sozinho, e o pior estado — "responde algumas coisas e
não outras, sem dizer por quê" — é justamente o que FR-042 existe para evitar.

## D14 — O primeiro catálogo é de exemplo, e diz isso de si mesmo

**Decisão**: os materiais semeados na primeira entrega são de exemplo — poucos escopos,
procedimentos genéricos, cada um identificado como exemplo no próprio corpo.

**Racional**: a estrutura é o que a fatia prova; o conteúdo é editorial (A-16) e entra depois por
release, sem tocar em schema. Implementar a semeadura contra conteúdo que ainda não existe é
descobrir o formato errado com o schema já de pé.

**Alternativa rejeitada**: esperar o conteúdo real das operadoras do Ceará antes de escrever a
semeadura. Bloqueia F2 e F3 por uma dependência que não é técnica, e o formato do bloco semeado não
muda por causa do texto que vai dentro dele.
