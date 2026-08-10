# Armadilhas de execução

Cada entrada aqui foi **paga**: alguém perdeu tempo, ou quase mandou defeito para a `main`, e o
sintoma não apontava para a causa. O objetivo do arquivo não é listar bugs — é evitar que a mesma
hora seja gasta duas vezes.

**Como usar**: antes de escrever teste de banco, de mexer em `baseline.sql` ou de concluir que
algo "está verde", passe os olhos nos títulos. Antes de fechar uma sessão em que algo custou mais
de 20 minutos para ser entendido, **acrescente a entrada** — com sintoma, causa e a regra que
sobrevive ao caso particular.

**Formato**: sintoma (o que você vê) → causa (o que é de verdade) → conserto → **a regra**. A
regra é a parte que importa; o resto é o contexto que a torna crível.

Ordenado por gravidade: as primeiras passam verde escondendo defeito real.

---

## 1. Teste que verifica "foi barrado" e passa mesmo quando NÃO foi

**Sintoma** — o invariante de RLS fica vermelho em N casos, todos do tipo "esta escrita deveria
ser recusada". A escrita, no banco, É recusada quando você tenta à mão.

**Causa** — o helper `sql()` chama `psql` **sem** `-v ON_ERROR_STOP=1`. Sem essa flag o psql
segue depois do erro e **sai com código 0**; `execFileSync` não levanta exceção; o `try/catch` que
esperava a recusa recebe sucesso e conclui que a escrita passou.

**Conserto** — `-v ON_ERROR_STOP=1` na lista de argumentos, como em
`tests/invariants/rls-isolation.test.ts`.

**A regra** — *o modo de falha oposto é o perigoso.* Aqui o teste falhava dizendo "a escrita
passou" quando ela não passava, e isso é barulhento e barato. Mas o mesmo helper, num teste
escrito como "espero que a escrita FUNCIONE", ficaria **verde com o catálogo aberto**. Todo helper
que traduz erro de banco em valor de retorno MUST ser exercitado nas duas direções antes de virar
base de asserção.

---

## 2. Migration que lê coluna criada por uma migration posterior

**Sintoma** — nenhum. Em banco novo a função nem cria e a cadeia para com erro claro; em banco que
já tem parte do schema, ela **cria filtrando só metade** e todo o resto passa verde.

**Causa** — ordenação. Na spec 002, `fn_buscar_lastro` (0123) lê `ai_knowledge_sources.scope_id` e
`ai_chunks.scope_id`, que estavam planejados para duas migrations à frente. O caso ruim
não é a falha: é a função criada **sem o filtro do lado do tenant**, que responde, ancora e vaza
entre escopos com a suíte inteira verde.

**Conserto** — as colunas foram trazidas para a 0118. Achado na análise cruzada, antes da execução.

**A regra** — antes de escrever uma migration que cria função, **liste as colunas que a função
lê** e confirme que cada uma nasce numa migration de número MENOR. Ordenação de migration não é
organização: é a diferença entre falhar alto e mentir baixo.

---

## 3. A precedência de camada esconde vazamento de escopo

**Sintoma** — você sabota o filtro de escopo da busca e o teste de vazamento **continua verde**.

**Causa** — `fn_buscar_lastro` remove os trechos de catálogo de um balde quando existe trecho do
tenant no MESMO balde. Se o tenant tem material próprio ali, o trecho vazado sai do conjunto
**junto com o legítimo**. O vazamento existe e é invisível.

O mesmo mecanismo escondeu, no mesmo dia, o corte de validade: o material vencido estava num balde
que a precedência já esvaziava, e o teste "material vencido não ancora" passava pelo motivo
errado.

**Conserto** — casos com o tenant SEM material naquele balde, e o material vencido duplicado no
balde `todos`. Em `tests/invariants/busca-escopo-nao-vaza.test.ts`.

**A regra** — quando o sistema tem uma regra que **remove** linhas do resultado, todo teste de
"isto não pode aparecer" MUST ter um caso em que a regra de remoção **não está armada**. Senão
você está medindo a remoção, não o filtro.

---

## 4. Sabotagem que derruba só um caso quando a trava tem dois donos

**Sintoma** — a sabotagem de uma policy deixa **1** teste vermelho, e o arquivo tem 9. Parece
cobertura fina; é cobertura ausente.

**Causa** — na T036, sabotar `tenant_isolation_ai_chunks_all` derrubava quase nada porque as
travessias por escopo passam pelo espelho (`ai_chunks.scope_id = knowledge_scopes.id`), e a RLS de
`knowledge_scopes` já as segurava sozinha. O teste dependia de **uma** das duas policies de que a
trava depende.

**Conserto** — o caso do balde "vale para todos", onde as camadas se unem sem escopo para costurar
e `ai_chunks` é a última linha de defesa.

**A regra** — sabote **cada** peça de que a trava depende, uma por vez, e conte os vermelhos. Peça
cuja sabotagem não derruba nada não está sendo testada — e um dia alguém a remove "porque nenhum
teste reclamou".

---

## 5. `drop index` só na migration não alcança instalação nova

**Sintoma** — clone atualizado e instalação fresca divergem a partir do mesmo arquivo. O bug só
aparece para o usuário novo, que é justamente quem o produto precisa conquistar.

**Causa** — o `baseline.sql` é um dump seguido de apêndice. O dump **recria** o índice, e o
apêndice roda depois. Um `drop index` que exista só em `migrations/` nunca alcança quem instalou
do baseline.

**Conserto** — `drop index if exists` também no apêndice. Vigiado por
`tests/invariants/indice-unico-de-fontes-removido.test.ts`, que mede pelo **efeito** (duas fontes
ativas do mesmo tipo convivem), não por `pg_indexes` — olhar só o catálogo de índices ficaria
verde se alguém recriasse a mesma restrição com outro nome ou como constraint.

**A regra** — toda mudança **subtrativa** de schema (drop de índice, constraint, coluna, default)
MUST aparecer no apêndice do baseline, não só na migration. Mudança aditiva perdoa o esquecimento;
subtrativa não.

---

## 6. A cadeia de migrations não sobe do zero

**Sintoma** — `supabase db push` num banco vazio termina com 0 tabelas.

**Causa** — as 10 primeiras migrations são stubs `SELECT 1;`. Quem instala aplica
`supabase/baseline.sql`, e é o baseline que cria as 96 tabelas.

**Conserto** — nenhum; é o desenho. Mas a consequência precisa ser dita em voz alta: **o banco de
desenvolvimento na nuvem e a produção self-hosted nasceram os dois do baseline**, e nenhum dos
dois tem `supabase_migrations.schema_migrations`. "Aplicar as migrations de dev em produção" não é
o procedimento — o procedimento é o `update.sh` re-aplicando o baseline com o apêndice.

**A regra** — antes de propor "rodar as migrations lá", confira se o alvo tem ledger de migration.
Sem ledger, o veículo é o baseline.

---

## 7. Container órfão do `test:db` depois de uma interrupção

**Sintoma** — `Bind for 127.0.0.1:54329 failed: port is already allocated`.

**Causa** — `scripts/test-db.sh` remove o container num `trap ... EXIT`. Interrupção que mata o
processo com SIGKILL não executa trap, e o container fica de pé segurando a porta.

**Conserto** — `docker ps --format '{{.Names}} {{.Ports}}' | grep 543` e `docker rm -f <nome>`.

**A regra** — porta ocupada depois de interromper um gate é quase sempre órfão seu, não outra
sessão. Confira antes de mudar de porta: mudar de porta esconde o vazamento e deixa o container
consumindo memória até o fim do dia.

---

## 8. Comentário dentro de union TypeScript quebra o extrator de vocabulário

**Sintoma** — `tests/invariants/vocabulario-banco-x-typescript.test.ts` reprova dizendo que faltam
valores que **estão** no arquivo.

**Causa** — o extrator lê o texto do union. Um comentário entre os membros faz ele perder o membro
seguinte — e, no caso medido, perdeu dois de uma vez.

**Conserto** — comentário **acima** do `type`, nunca entre os membros.

**A regra** — vocabulário duplicado entre banco e TypeScript é sincronizado por leitor de texto,
não por parser. Trate o corpo do union como dado, não como código comentável.

---

## 9. `afterAll` apagando na ordem errada com FK `on delete restrict`

**Sintoma** — a suíte passa e o `afterAll` explode:
`update or delete on table "catalog_scopes" violates foreign key constraint`.

**Causa** — a FK `catalog_materials → catalog_scopes` é `on delete restrict` **de propósito**:
material curado não some porque alguém apagou uma linha de escopo.

**Conserto** — apague filhos antes de pais. Os trechos vão por cascade a partir do material.

**A regra** — `on delete restrict` é decisão de produto, e limpeza de teste MUST respeitá-la em
vez de pedir cascade. Se a limpeza dá trabalho, é sinal de que a FK está protegendo algo.

---

## 10. A porta de uma tela não é o item da barra lateral

**Sintoma** — o E2E falha ao clicar num item de menu que existe no `registry.ts`.

**Causa** — `lib/navigation/registry.ts` filtra por papel. O grupo `ia` **não renderiza para o
papel `agent`** — quem atende no dia a dia não vê o item. A porta real da Central é o sino do
cabeçalho.

**Conserto** — o spec passou a usar o sino, com contador.

**A regra** — "tela tem porta" (Princípio II) só é verdade **para o papel que vai usá-la**.
Verifique o `minRole` do grupo antes de escrever a navegação do teste — e desconfie quando a porta
que você imaginou só existe para `admin`.

---

## 11. `supabase gen types` de outra versão da CLI empobrece o arquivo

**Sintoma** — o `lib/database.types.ts` regenerado perde o bloco
`__InternalSupabase: { PostgrestVersion }`.

**Causa** — versões diferentes da CLI emitem cabeçalhos diferentes.

**Conserto** — regenerar, **conferir o conjunto de tabelas antes e depois** (nenhuma pode sumir) e
reinserir o bloco preservado. Na medição de 2026-08-08 o arquivo commitado estava atrasado em 6
tabelas que já existiam no banco — o diff só foi seguro porque a comparação era de conjuntos, não
de linhas.

**A regra** — arquivo gerado MUST ser diffado por **conteúdo semântico** (que tabelas/funções
entram e saem) antes de substituir o anterior. `git diff` de 600 linhas geradas não é revisão.

---

## 12. Chave de IA: são duas, e o agente não lê a do gateway

**Sintoma** — a chave está no `.env.local` e o agente segue dizendo que não há credencial.

**Causa** — há dois caminhos distintos. **Embeddings** (`lib/ai/embed.ts`) aceitam
`AI_GATEWAY_API_KEY` ou `OPENAI_API_KEY`. O **agente** (`lib/agent-engine/edge/llm/credentials.ts`)
não lê a chave do gateway em caminho nenhum: ele resolve BYOK por organização em
`ai_provider_credentials` e, na falta, cai em `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

**Conserto** — `OPENAI_API_KEY` sozinha cobre os dois. A do gateway sozinha **não** cobre o agente.

**A regra** — antes de afirmar qual variável destrava um caminho, **procure a variável no módulo
que executa aquele caminho**. Credencial BYOK cifrada com o `AI_CRED_AES_KEY` de outra instalação
não decifra aqui — copiar a linha do banco de produção não funciona.

---

## 13. O MCP de desenvolvimento pode estar apontando para outro banco

**Sintoma** — nenhum, até uma migration ser aplicada no banco errado.

**Causa** — `mcp__supabase__get_project_url` devolvia `lkyhirtrbmahyyvghitk` (o `db_cotador`,
**produção de outro produto**) enquanto o banco do CRM é `dxkzmolfjcmhqlcteswu`.

**Conserto** — confirmar o alvo antes de qualquer escrita, e preferir `psql`/`--db-url` com a
connection string explícita a `apply_migration` por MCP.

**A regra** — ferramenta de banco sem alvo verificado é ferramenta apontada para onde ela estava
ontem. `get_project_url` custa uma chamada; restaurar backup de produção alheia custa o dia.

---

## 14. Invariante que passa sozinho e falha no `test:db` inteiro

**Sintoma** — `pnpm test:db <arquivo>` verde; `pnpm test:db` vermelho no mesmo arquivo. O par
pior possível, porque o verde local vem antes do vermelho do CI e induz a procurar no lugar errado.

**Causa** — os invariantes compartilham **um** Postgres, e o `vitest.db.config.ts` roda os arquivos
em sequência **sem limpar entre eles**. Duas consequências:

- **Contagem global mente.** `select count(*) from catalog_scopes` inclui o que outros arquivos
  criaram. Aqui isso quebrou o teste da semeadura: `fn_sincronizar_escopos_do_catalogo` espelha
  **todo** escopo ativo, então cada escopo esquecido por outro arquivo virava um espelho a mais.
- **Arquivo sem `afterAll` estraga o vizinho.** O arquivo que vazou o escopo passava; quem falhava
  era outro, por um motivo que não tinha nada a ver com ele.

**Conserto** — dois, e os dois: toda asserção escopada às fixtures **do próprio arquivo** (`where
slug like 'exemplo-%'`), e `afterAll` apagando o que o arquivo criou.

**A regra** — em invariante de banco, contagem global é asserção sobre a suíte inteira, não sobre a
sua feature. Escope sempre — mesmo quando o arquivo roda sozinho hoje, porque o vizinho que vai
quebrá-lo ainda não foi escrito. E rode `pnpm test:db` **inteiro** antes de dar por pronto: o
arquivo isolado não exercita a interferência, que é justamente o que o CI vai exercitar.

---

## 15. União fechada num arquivo compartilhado trava trabalho paralelo

**Sintoma** — dois agentes trabalhando em rotas diferentes entregam, os dois, um
`as AuditAction` e uma "dívida declarada" no comentário. Nenhum dos dois errou.

**Causa** — `lib/audit/actions.ts` é uma união fechada de literais. Toda rota nova precisa
acrescentar membro. Sob a regra de conjunto de escrita disjunto (constituição, "Trabalho em
paralelo"), **nenhum** agente paralelo pode tocá-lo — e o cast é a saída honesta que sobra a eles.

O detalhe que torna isso perigoso em vez de meramente feio: `api_audit_log.action` é `text`
**sem CHECK**. A linha gravada fica certa, o teste passa, e a única coisa que se perdeu é a
proteção contra o próximo desenvolvedor inventar um código que ninguém consegue consultar depois.
Dívida que não dói é dívida que fica.

**Conserto** — o orquestrador acrescenta os membros na integração e apaga os casts. Nas
constantes, `as const satisfies Record<string, AuditAction>` (ou anotação direta) em vez de cast:
assim inventar um código inexistente reprova o `typecheck` em vez de gravar trilha órfã.

**A regra** — antes de fanear trabalho, **liste os arquivos-união** que as tarefas vão querer
estender (`lib/audit/actions.ts`, vocabulários de `kind`, registries). Eles são do orquestrador
por definição. Instrua os agentes a **declarar** o membro que precisariam, em vez de descobrir o
impedimento no meio — e feche a lista na integração, no mesmo commit.

---

## 16. MCP de produto ≠ MCP de desenvolvimento

**Sintoma** — confusão sobre "o MCP" ao discutir arquitetura.

**Causa** — são duas coisas sem interseção. O **MCP do produto** (`lib/mcp/server.ts`,
`app/api/v1/mcp/`, 20 módulos em `lib/mcp/tools/`) é feature: escopo por tenant, vai no pacote,
é o que o cliente usa. O **MCP de desenvolvimento** (`@supabase/mcp-server-supabase`) é
ferramental de quem programa e **nunca** é distribuído.

**A regra** — ao falar de MCP, diga qual. Uma decisão tomada sobre o errado vira feature que
ninguém pediu ou credencial de dev num pacote de cliente.
