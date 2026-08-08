<!--
SYNC IMPACT REPORT
==================
Version change: TEMPLATE (não ratificada) → 1.0.0
Bump rationale: MAJOR inicial — primeira ratificação. Todos os placeholders do template
foram substituídos por princípios concretos derivados de CLAUDE.md, README.md e
docs/doctrine/sistema-vivo.md.

Princípios definidos (7, o template trazia 5 slots):
  - I.   Isolamento de Tenant é a Lei Zero (NOVO)
  - II.  Nada é Ilha — Sistema Vivo (NOVO)
  - III. Schema Viaja com o Clone (NOVO)
  - IV.  Prova pela Tela em Ambiente Fresco (NOVO)
  - V.   Evento na Fila, Nunca HTTP no Trigger (NOVO)
  - VI.  Contrato de API Estável e Auditado (NOVO)
  - VII. Interoperável por Contrato, Nunca por Acoplamento (NOVO)

Seções adicionadas:
  - Restrições de Stack e Configuração  (era [SECTION_2_NAME])
  - Fluxo de Desenvolvimento e Portões  (era [SECTION_3_NAME])
  - Governança                          (preenchida)

Seções removidas: nenhuma.

Templates / artefatos dependentes:
  ✅ .specify/templates/plan-template.md   — "Constitution Check" preenchido com os 7 gates
  ✅ .specify/templates/spec-template.md   — verificado, sem conflito (escopo/requisitos neutros)
  ✅ .specify/templates/tasks-template.md  — verificado, categorias de task compatíveis
  ✅ .claude/skills/speckit-*/SKILL.md     — verificados, sem referência a agente específico
  ✅ CLAUDE.md / README.md                 — são a FONTE desta constituição, não derivados;
                                             nenhuma edição necessária nesta ratificação

TODOs diferidos:
  - TODO(PACKAGE_ALIGNMENT): quatro desvios de configuração identificados em package.json
    (gov:verify sem test:shell; db:migrate stub com exit 0; aliases :webpack idênticos aos
    scripts base; @types/node ^20 sob engines node>=22). Ver "Restrições de Stack e
    Configuração". Correção pendente de decisão do mantenedor — não foi aplicada junto
    com a ratificação para não alterar semântica de portão sem revisão.

==================================================================================
EMENDA — 2026-08-07

Version change: 1.0.0 → 1.1.0
Bump rationale: MINOR — duas seções novas e quatro princípios novos. Nenhum princípio
existente foi removido ou redefinido; I–VII seguem íntegros, palavra por palavra.

Princípios adicionados:
  - VIII. O Usuário é o Corretor, e Ele Tem 10 Minutos (NÃO NEGOCIÁVEL)
  - IX.   Todo Agente Serve Vender ou Assistir
  - X.    Conhecimento de Operadora é Dado Curado, Nunca Código
  - XI.   Toda Entrega Nasce com Teste que Prova e que Vigia (NÃO NEGOCIÁVEL)

Seções adicionadas:
  - Missão e Escopo             — para quem é, por onde as mensagens entram, onde isso vai dar
  - Papéis, Ritmo e Método      — quem decide o quê, unidade de estimativa, forma do plano

Mudança de escopo declarada nesta emenda (o que acontece com o trabalho que dependia da
regra antiga):
  - O `gateway_go` deixa de ser "um projeto irmão com quem integramos" e passa a ser o
    **receptor geral de todo tráfego de entrada do CRM**. Consequências que já são dívida
    a partir de agora:
      (a) o gateway vira dependência de runtime do self-host — `docker-compose.prod.yml` e
          `install.sh` passam a ter de subi-lo, e esse custo entra no teto do Princípio VIII;
      (b) `app/api/v1/webhooks/waha/[token]/route.ts` vira caminho **legado**. Não é removido
          enquanto o caminho novo não estiver provado em produção — os dois coexistem, e a
          idempotência por `unique (organization_id, external_id)` é o que impede dupla
          ingestão durante a transição (Princípio V);
      (c) o Princípio VII continua valendo integralmente: o gateway **não** escreve no banco
          do CRM. Ele entrega envelope normalizado por contrato HTTP; quem persiste é o CRM.

Interpretações aplicadas ao ditado do dono do produto (registradas para conferência):
  • "HAG" → RAG.  • "SAP" → MCP (zero ocorrências de "SAP" no repo; `lib/mcp/server.ts` existe).
  • "cotaudo Simplificado" → Cotador Simplificado (`/root/PROJETOS/supabase_cotador`).
  • "multi-ente" → multi-tenant.  • "estruturas pré-pretas" → estruturas pré-prontas.

Divergência documental declarada:
  VISION.md e docs/prd/00-prd-master.md posicionam o produto como multi-nicho com persona
  primária "Operador BPO" de e-commerce. Esta emenda define o **nicho de validação** como
  corretor de plano de saúde. Não é contradição de arquitetura (multi-nicho segue como
  capacidade, via `vocabulary` por pipeline) — é mudança de prioridade de validação. Os dois
  documentos ficaram desatualizados.
  TODO(VISION_PRD_ALIGNMENT): alinhar VISION.md e docs/prd/00-prd-master.md ao nicho de
  validação.

Artefatos dependentes propagados:
  ✅ .specify/templates/plan-template.md — tabela do Constitution Check estendida de 7 para
                                           11 gates e fonte atualizada para v1.1.0
  ⚠️ CLAUDE.md — a doutrina de testes do Princípio XI é mais estrita que a seção "Testes"
                 atual. TODO(CLAUDE_MD_TESTES): refletir lá o teste-de-sabotagem e o
                 teste-de-efeito-de-configuração.

==================================================================================
EMENDA — 2026-08-07 (segunda do dia)

Version change: 1.1.0 → 1.2.0
Bump rationale: MINOR — um princípio novo, de processo de sessão. Nenhum princípio existente
foi removido ou redefinido; I–XI seguem íntegros, palavra por palavra.

Princípio adicionado:
  - XII. Contexto Antes de Ação (NÃO NEGOCIÁVEL)

Origem: pedido explícito do dono do produto — sessão que ainda não absorveu o planejamento
geral do sistema, e que ainda não leu `CLAUDE.md` nem `README.md`, faz essa leitura ANTES de
seguir com a ação pedida. A emenda transforma isso em regra com ordem de leitura, gatilho de
releitura e declaração verificável, para que "eu li" pare de ser afirmação implícita.

Seções alteradas:
  - "Governance" → subseção "Leitura de entrada" apontando para o Princípio XII, para que a
    regra apareça também onde um agente procura procedimento (e não só onde procura doutrina).

Seções removidas: nenhuma.

Artefatos dependentes propagados:
  ✅ .specify/templates/plan-template.md — Constitution Check estendido de 11 para 12 gates e
                                           fonte atualizada para v1.2.0

Divergência corrigida nesta emenda:
  O rodapé do arquivo dizia `Version: 1.0.0` enquanto o corpo já continha a emenda 1.1.0
  (Princípios VIII–XI). Rodapé passa a 1.2.0.

TODOs herdados, ainda abertos: TODO(PACKAGE_ALIGNMENT), TODO(VISION_PRD_ALIGNMENT),
TODO(CLAUDE_MD_TESTES).

==================================================================================
NOTA DE RECONCILIAÇÃO — 2026-08-07 (sem mudança de versão; segue 1.2.0)

As duas emendas acima foram escritas por sessões distintas trabalhando na MESMA árvore de
trabalho, e foram commitadas em `acdd63cd`, na branch `chore/spec-kit-constituicao`. Esse
commit ficou de fora do PR #7, que foi aberto de `f41bbe6c` — um commit antes dele. Ao trocar
para a `main` e puxar, o arquivo voltou ao estado 1.0.0, e outra sessão concluiu (errado) que a
emenda tinha sido perdida e a reescreveu do zero. A reescrita entrou na `main` como `b1606351`.

A reescrita ficou idêntica ao original no corpo inteiro — os 12 princípios, "Missão e Escopo",
"Papéis, Ritmo e Método" e o Definition of Done batem byte a byte, e o `plan-template.md`
também. O que ela perdeu foi metadado deste cabeçalho: os "Artefatos dependentes propagados" da
v1.1.0 (com o aviso do TODO(CLAUDE_MD_TESTES)), "Seções alteradas", "Seções removidas" e
"Divergência corrigida nesta emenda". Este commit restaura os quatro a partir de `acdd63cd`.

A mensagem de `b1606351` afirma que o trabalho foi perdido por `git restore` antes de ser
commitado. **É falso** — estava commitado em `acdd63cd` o tempo todo. Corrige-se aqui porque a
mensagem de commit já publicada não pode ser reescrita.

Lição registrada, porque custou retrabalho: arquivo rastreado que "voltou" ao conteúdo antigo
quase sempre está commitado em outra ref. `git log --all -- <arquivo>` antes de reescrever.

==================================================================================
EMENDA — 2026-08-08

Version change: 1.2.0 → 2.0.0
Bump rationale: MAJOR — redefinição incompatível do Princípio X. A versão anterior afirmava,
sem exceção, que "conteúdo de operadora é dado de tenant e entra no isolamento por
`organization_id` como qualquer outro". Esta emenda abre uma segunda camada, compartilhada
pela instalação e não pertencente a nenhuma organização. Doutrina e código escritos contra a
regra antiga passam a estar errados sobre onde o conteúdo pode viver — por isso MAJOR, e não
MINOR. Nenhum outro princípio foi removido ou redefinido; I–IX, XI e XII seguem íntegros,
palavra por palavra, e o título do Princípio X é preservado.

Princípio alterado:
  - X. Conhecimento de Operadora é Dado Curado, Nunca Código — corpo reescrito. O que passa a
    existir: as duas camadas (acervo do tenant × catálogo curado) e as SETE travas sob as quais
    a exceção ao Princípio I é aceitável. Faltando qualquer uma, a exceção não se aplica.

Origem: decisão do dono do produto registrada na sessão de clarificação da feature
`002-rag-por-operadora` em 2026-08-08. A instalação nova precisa já saber assistir antes de o
corretor carregar a primeira coisa (Princípio VIII), e isso só é possível com conteúdo que o
fabricante cura e distribui. A sessão reportou a divergência em vez de resolvê-la em silêncio,
conforme o Princípio XII, e a feature ficou bloqueada até esta emenda.

Plano de migração (exigência (c) da Governança):
  - **Nenhum código existente é invalidado.** Não há catálogo compartilhado no repositório hoje:
    todo conhecimento é tenant-scoped (`ai_knowledge_sources`, `ai_kb_versions`, `ai_kb_chunks`,
    `retrieve_top_k_chunks`). A emenda abre caminho, não pede refactor. Nenhuma tabela existente
    perde `organization_id` nem afrouxa RLS — a trava 3 proíbe exatamente isso.
  - **A dívida nasce com a primeira linha do catálogo, não com esta emenda.** No momento em que
    a partição compartilhada existir, o Princípio XI passa a exigir invariante em
    `tests/invariants/` para as travas 1, 2 e 3: escrita a partir de papel de tenant barrada por
    todos os caminhos; catálogo sem dado pessoal e sem identificador de organização; consulta
    que cruza as duas camadas devolvendo zero linhas de outra organização. Sem esses três, a
    exceção não pode ser considerada implementada.
  - **Trava 6 é responsabilidade do Princípio III.** O apêndice do `baseline.sql` que semeia o
    catálogo precisa ser idempotente **e** não-destrutivo — só acrescentar versão. Idempotência
    sozinha não basta: um `upsert` idempotente apagaria a correção local, que é justamente o que
    a trava proíbe.
  - **Nada a alinhar em documento derivado.** Varredura em `CLAUDE.md`, `AGENTS.md` e
    `docs/doctrine/` não encontrou nenhuma ocorrência de "operadora": nenhum deles repetia a
    regra antiga, e nenhum desatualiza com esta emenda.

Artefatos dependentes propagados:
  ✅ .specify/templates/plan-template.md — fonte atualizada para v2.0.0 e a pergunta do gate X
                                           reescrita para cobrir as duas camadas e as sete travas
  ✅ rodapé deste arquivo                 — Version 2.0.0, Last Amended 2026-08-08

Fora deste PR, de propósito: a spec `specs/002-rag-por-operadora/` que motivou a emenda segue na
branch da feature. A Governança proíbe emenda no mesmo PR da feature que a motivou. Depois do
merge, o item CHK028 do checklist daquela spec — reprovado hoje justamente por esta contradição —
volta a passar sem nenhuma mudança na spec.

TODOs herdados, ainda abertos: TODO(PACKAGE_ALIGNMENT), TODO(VISION_PRD_ALIGNMENT),
TODO(CLAUDE_MD_TESTES).

==================================================================================
EMENDA — 2026-08-08 (segunda do dia)

Version change: 2.0.0 → 2.1.0
Bump rationale: MINOR — orientação nova e material numa seção existente ("Fluxo de
Desenvolvimento e Portões"). Nenhum princípio foi adicionado, removido ou redefinido; I–XII
seguem íntegros, palavra por palavra, e a contagem de gates do Constitution Check não muda.

Seção alterada:
  - "Fluxo de Desenvolvimento e Portões" → subseção nova **"Cadência de commit"**, entre
    "Higiene de branch" e "Portões obrigatórios". Define a fase — não a task — como unidade de
    commit, com três exceções nomeadas e o que o commit de fase precisa ter rodado para existir.

Seções removidas: nenhuma.

Origem: pedido explícito do dono do produto — "não precisa ficar fazendo um commit a cada task
executada; quando executar uma fase inteira de uma spec, aí você faz um commit". A regra estava
implícita e cada sessão escolhia a sua, o que produziu tanto histórico picotado (um commit por
task, estados que não compilam) quanto trabalho perdido (nada commitado até a fase fechar). A
emenda fixa o padrão e, no mesmo movimento, protege o caso em que segurar o commit custa
trabalho.

Plano de migração (exigência (c) da Governança):
  - **Nenhum commit já publicado é invalidado.** A regra vale do merge em diante; histórico
    anterior não é reescrito — a "Higiene de branch" acima já proíbe reescrever a `main`.
  - **Sem efeito em portão de CI.** Nenhum job passa a reprovar por granularidade de commit; a
    regra é de método, verificada na revisão do PR, não por script.
  - **Conflito aparente com o Princípio XI, resolvido aqui:** juntar as tasks de uma fase num
    commit MUST NOT virar desculpa para adiar o teste. O teste da fase entra no commit da fase;
    fase cujo commit não carrega o teste que prova o que ela entregou não fechou.

Artefatos dependentes propagados:
  ✅ .specify/templates/plan-template.md — fonte atualizada para v2.1.0 (a tabela de gates não
                                           muda: esta emenda não cria princípio)
  ✅ rodapé deste arquivo                 — Version 2.1.0, Last Amended 2026-08-08

TODO(CLAUDE_MD_CADENCIA): `CLAUDE.md` não fala de cadência de commit em lugar nenhum — não
desatualiza com esta emenda, mas ganharia a regra na seção de fluxo. Fica como alinhamento de
documento derivado, fora deste PR.

TODOs herdados, ainda abertos: TODO(PACKAGE_ALIGNMENT), TODO(VISION_PRD_ALIGNMENT),
TODO(CLAUDE_MD_TESTES).
==================================================================================
EMENDA — 2026-08-08 (reconciliação de duas frentes)

Version change: 2.1.0 → 2.2.0
Bump rationale: MINOR — dois princípios novos (XIII, XIV) e expansão material de Missão e Escopo,
III, IV, VIII, XII e Restrições de Stack. Nenhum princípio removido; o X expandido pela 2.1.0
(spec 002) segue íntegro, palavra por palavra.

Origem: a v2.0.0 e a v2.1.0 foram escritas em paralelo, em branches diferentes, a partir da
v1.2.0 — a 2.0.0 na `feat/001-gateway-ingest-unificado` (virada para SaaS de instância única) e a
2.1.0 na frente da spec 002 (Princípio X, conhecimento de operadora). Nenhuma das duas viu a
outra. Esta emenda é a união: a 2.1.0 é a base, e o conteúdo da 2.0.0 foi reaplicado por cima.

Princípios adicionados (vindos da 2.0.0):
  XIII. Cobrança Mora no Cotador, e Só Lá
  XIV.  O Gateway é Serviço Único, Compartilhado e Sem Réplica

Seções substituídas pela redação da 2.0.0 (todas ampliam, nenhuma remove regra da 2.1.0):
  Missão e Escopo — SaaS de instância única; sem clone; sem versão de escape
  III  — "Schema Viaja com o Clone" → "Schema Muda por Migration, Nunca à Mão"
  IV   — "fresco" passa a significar CONTA nova, não instalação nova
  VIII — o relógio dos 10 minutos passa a contar do cadastro, não do login
  XII  — o baseline descrito como o que sobe ambiente do zero e o que o gate `invariants` aplica
  Restrições de Stack — deploy da nossa instância; gateway fora dele; expand/contract obrigatório

Seção preservada da 2.1.0 por ser a mais recente:
  Fluxo de Desenvolvimento e Portões — a "Cadência de commit" da 2.1.0 vence a da 2.0.0 (ela já
  traz as três exceções, incluindo o escape de árvore compartilhada e o trio da migration).
  Acrescentados a ela apenas os dois gates que III e IV passaram a exigir.

Seções removidas: nenhuma.

-->

# DeskcommCRM Constitution

Sistema operacional de vendas open source, multi-tenant, self-hosted, com agentes de IA
nativos e WhatsApp como canal primário. Esta constituição é a lei de arquitetura do repositório.
`CLAUDE.md`, `docs/doctrine/sistema-vivo.md` e `README.md` a detalham; onde divergirem, esta
constituição prevalece.

## Missão e Escopo

**O que estamos construindo.** Um CRM conversacional com agentes de IA que já tem WhatsApp, RAG
por tenant, runtime de agentes e o CRM exposto via MCP — e que precisa ficar **mais robusto**
antes de carregar operação real. O eixo desta fase é: RAG mais detalhado por cliente, autonomia
confiável de atendimento e resposta, e recebimento de mensagens pelo gateway multicanal que já
existe e já funciona (`/root/PROJETOS/gateway_go`).

**Para quem.** O nicho de validação é o **corretor de plano de saúde**. Ele não é desenvolvedor,
não é administrador de TI e não vai ler documentação. Multi-nicho continua sendo **capacidade
arquitetural** (`vocabulary` configurável por pipeline), não prioridade de validação: o que prova
que o produto está pronto é um corretor operando sozinho.

**Como o produto chega ao usuário: SaaS de instância única.** O CRM roda em **uma** instalação,
operada por nós. O usuário **se cadastra, usa e testa**; a assinatura vem depois, e é gerenciada
**no Cotador Simplificado** (Princípio XIII). Ninguém instala nada: não há VPS do cliente, não há
`install.sh` do usuário, não há "clone" com banco próprio.

A consequência que mais muda o dia a dia: **um bug em produção é bug de todo mundo ao mesmo
tempo**, e a correção também alcança todo mundo ao mesmo tempo. Isso remove a pior restrição da
doutrina antiga — não existe mais instalação velha em máquina que não podemos alcançar — e cria
outra, mais dura: **não há versão de escape**. Migration destrutiva não tem clone antigo para
servir de rede; ela roda no único banco que existe.

**Multi-tenant desde já — e agora com peso maior.** Todas as organizações dividem a MESMA
instância e o MESMO banco. Antes, isolamento furado vazava dados entre tenants de um mesmo
self-hoster; agora vaza entre clientes distintos que nunca ouviram falar um do outro. O
Princípio I não muda de texto, muda de consequência.

**Por onde as mensagens entram.** O `gateway_go` é o **receptor geral de todo o tráfego de entrada
do CRM**: mensagens de todos os canais (WhatsApp oficial e não-oficial, Instagram Direct e o que
vier depois) e **demais webhooks**. Ele recebe, autentica a origem, **normaliza para um envelope
único** e entrega ao CRM; o CRM **persiste no banco dele**. Código novo do CRM MUST NOT ler
payload cru de provedor — nem de WAHA, nem de uazapi, nem da Meta.

Ele é **serviço único, compartilhado e sem réplica**, e **não** é instalado junto com o CRM —
regime completo no Princípio XIV.

A fronteira que não se cruza: **o gateway MUST NOT escrever no banco do CRM**. Receber uma
mensagem aqui não é um `INSERT` — dispara agente, follow-up, guardrails, auditoria, `event_log` e
Realtime. Quem persiste é o CRM, pelo caminho dele, com o `organization_id` resolvido de fonte
confiável e nunca do corpo da requisição (Princípios I e VII).

**O que entregamos, em uma frase.** Automação e integração do WhatsApp com o CRM de forma
**inteligente e autônoma** — o agente atende, qualifica e move o funil junto com o humano, com as
estruturas já montadas (Princípio VIII). É isso que o usuário assina; o resto é meio.

**Onde isso vai dar.** O CRM evolui **independente** por enquanto. Quando estiver robusto, o
Cotador Simplificado migra para ele e aposenta o CRM interno que tem hoje. Toda decisão de
modelagem **considera** que um dia haverá importação de dados vindos de lá, mas nenhuma decisão é
**adiada** por causa disso.

**O que fica fora, e não é "por enquanto".** (a) Acoplamento ao Cotador em nível de schema, banco
ou FK cruzada — a ponte é contrato HTTP explícito, nada além. (b) **Cobrança**: assinatura,
plano, pagamento, cartão, nota fiscal e inadimplência não existem neste repositório
(Princípio XIII). (c) Distribuição para instalação alheia: kit de self-host, `install.sh` do
usuário e documentação de VPS deixam de ser produto.

## Core Principles

### I. Isolamento de Tenant é a Lei Zero (NÃO NEGOCIÁVEL)

Toda tabela tenant-aware MUST ter `organization_id uuid not null references organizations(id)
on delete cascade` e policy RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`.
Handler que usa service role MUST filtrar `organization_id` manualmente, resolvido de fonte
confiável (cookie, JWT, webhook secret, path token) — **nunca do body**. O backend MUST usar
`getUser()`; `getSession()` é proibido. Função nova em `public` MUST revogar `execute` das
duas origens (`public` e `anon`) antes de conceder a quem precisa.

**Rationale**: um vazamento entre tenants é irreversível e fatal num produto que hospeda dados
de terceiros sob LGPD. O gate mecânico é o teste de isolamento RLS do job `invariants`, que cria
duas organizações e prova zero linhas cruzadas — com caso de controle provando que as linhas
da org B existem.

### II. Nada é Ilha — Sistema Vivo (NÃO NEGOCIÁVEL)

Nenhuma peça — arquivo, módulo, tabela, tela, rota — existe de forma independente. Toda peça
MUST ter no mínimo **uma aresta de entrada e uma de saída** reais no grafo do sistema, e MUST
responder o Living System Checklist antes do merge: quem me alimenta, quem eu alimento, que
atividade/log eu emito, onde apareço na tela, por qual porta se chega até mim, qual meu
mecanismo anti-morte, onde se configura o que eu uso, qual a continuidade IA↔humano.
Toda mutação relevante MUST gerar atividade legível **na tela**, não só no banco. Todo estado
configurável MUST ter rota de leitura na UI, rota de escrita na UI, e falta de configuração
visível como item de inbox ou banner — nunca um `return` mudo no worker. Toda tela MUST estar
declarada em `lib/navigation/registry.ts` ou na allowlist com justificativa escrita. Peça nova
MUST entrar no mapa vivo (`docs/architecture/`) com ≥2 arestas.

**Rationale**: a missão do sistema é ser responsável pela linha do tempo inteira de uma demanda
até resolução ou encerramento declarado pelo lead. Feature que só recebe, ou só emite, ou existe
sem porta de acesso, é vazamento da missão. Gate mecânico:
`tests/unit/navegacao-completude.test.ts` — tela sem porta reprova o build.

### III. Schema Muda por Migration, Nunca à Mão (NÃO NEGOCIÁVEL)

Toda mudança de schema MUST sair como três artefatos juntos: (a) migration versionada em
`supabase/migrations/` no padrão `<timestamp>_<NNNN>_<slug>.sql`, idempotente e portável em
`psql` puro (sem `BEGIN`/`COMMIT` explícito, sem temp table fora de transação); (b) apêndice
idempotente e auto-curativo em `supabase/baseline.sql`; (c) linha em
`supabase/migrations/MANIFEST.md`. Migration que adiciona constraint MUST corrigir/deduplicar
os dados **antes** de criá-la. Migration já aplicada MUST NOT ser editada — corrige-se com
forward-fix. `ALTER`/`CREATE` solto em banco, sem arquivo correspondente, é proibido.

**Rationale (v2.0.0 — a regra ficou, o motivo mudou).** Até a v1.3.0 o motivo era o clone: o
self-hoster aplicava só o `baseline.sql`, e mudança fora dele não chegava a ninguém. Não há mais
clone. Os três artefatos continuam obrigatórios por três motivos que o SaaS **agrava**:

1. **Não há versão de escape.** Existe UM banco de produção. `ALTER` solto não tem clone antigo
   para servir de rede nem histórico para reconstruir o caminho — e "o que exatamente rodou
   naquele dia" vira arqueologia de log.
2. **O `baseline.sql` é o que sobe ambiente do zero**, e é o que `scripts/test-db.sh` aplica no
   job `invariants` (obrigatório na branch protection). Mudança ausente dele quebra o gate que
   prova o schema — e continua obrigatória a idempotência, porque o script aplica em modo
   install E update.
3. **Migration idempotente é o que torna o re-deploy seguro.** Numa instância única, o custo de
   uma migration que só roda uma vez é uma janela em que produção está pela metade.

O que MUDA: a exigência não é mais "o clone consegue atualizar", é "**a nossa** instância
consegue avançar sem perder dado nem exigir intervenção manual".

### IV. Prova pela Tela em Ambiente Fresco (NÃO NEGOCIÁVEL)

Feature nova ou fix de comportamento visível MUST ser provada dirigindo o browser (Playwright),
como um usuário leigo faria, num ambiente **fresco**. `curl` e chamada de API MUST NOT ser aceitos
como prova de UX — servem só como diagnóstico. Efeito colateral externo MUST ser provado com
receiver real, não mock. Medida de front-end MUST vir de ferramenta
(`getBoundingClientRect`/`getComputedStyle`), nunca a olho. Jornadas de primeira impressão
(criar conta, conectar canal, primeiro lead, primeiro convite) têm prioridade máxima e são `[P0]`
em `docs/testing/user-journey-map.md`.

**"Fresco" a partir da v2.0.0 = CONTA nova, não INSTALAÇÃO nova.** O ambiente do teste continua
sendo Postgres limpo do `baseline.sql` + `bootstrap-owner.ts` — o que muda é o que se simula
faltando. Antes era o env opcional que o self-hoster não preencheu; agora os envs são nossos e
conhecidos, e o que falta é o que o **usuário** ainda não fez: canal não conectado, base de
conhecimento vazia, agente sem capacidade marcada, nenhum lead, nenhum convite aceito. A tela MUST
ser provada nesse estado, e não só com dados de exemplo já semeados.

**Rationale**: a promessa mudou de dono, não de natureza. Em SaaS ninguém instala, mas todo mundo
**cadastra** — e a conta recém-criada, vazia, é a primeira coisa que o usuário vê. Testar só com
banco povoado esconde exatamente os defeitos dessa tela, que é a que decide se ele volta. Estado
vazio não é caso de borda: é o estado inicial de 100% dos usuários.

### V. Evento na Fila, Nunca HTTP no Trigger (NÃO NEGOCIÁVEL)

Trigger Postgres MUST NOT fazer chamada HTTP. Trigger emite linha em `event_log`; worker
(cron ou listener Realtime) consome e dispara o efeito colateral. Mensagem de WhatsApp e evento
externo MUST ter `unique (organization_id, external_id)` com captura de `code === '23505'` no
INSERT. POST de criação na API MUST aceitar `Idempotency-Key: <uuid>` (TTL 24h via Upstash).
Fila drenada MUST ter dono declarado: quem reagenda, quem falha, e o que aparece na Central
quando trava.

**Rationale**: HTTP dentro da transação espera rede segurando lock — é a falha mais cara possível
no banco. E entrega duplicada de mensagem no WhatsApp é pior que atraso: queima o número.

### VI. Contrato de API Estável e Auditado (NÃO NEGOCIÁVEL)

Rota pública MUST viver sob `/api/v1/`, com JSON snake_case, UUID v4, ISO-8601 UTC e dinheiro
em `_cents` + `currency` ISO-4217. Resposta MUST usar os helpers `ok()`/`fail()` de
`lib/api/wrappers.ts`. Todo input externo MUST ser validado com Zod. Mutação POST/PATCH/DELETE
bem-sucedida MUST emitir entrada em `api_audit_log` (append-only, fire-and-forget, p99 ≤500ms).
Rota pública MUST ter rate limit com headers `X-RateLimit-*` e `Retry-After` em 429. API key
MUST ir em header — **nunca** em query string. Bearer token MUST ser armazenado como hash
SHA256; o plaintext aparece uma única vez, na criação. `console.log` MUST NOT ser mergeado.

**Rationale**: a API é o contrato que o ecossistema — agentes MCP, automações, e o Cotador —
consome. Contrato instável ou não-auditado transforma cada integração em acoplamento frágil, e
credencial em query string vaza em log de proxy sem ninguém perceber.

### VII. Interoperável por Contrato, Nunca por Acoplamento

O CRM MUST expor sua capacidade por três superfícies, e apenas por elas: a API REST `/api/v1/`,
o MCP server, e os webhooks (entrada via fontes de captação, saída via automações). Sistema
externo — incluindo o **Cotador Simplificado**, projeto irmão com o qual este CRM será
integrado — MUST consumir essas superfícies. Acesso direto ao banco de um sistema pelo outro,
FK cruzando fronteira de produto, e schema compartilhado por conveniência são proibidos.
Toda entidade trocada MUST carregar `organization_id` e MUST ser rastreável de ponta a ponta:
a cotação nasce ligada a um lead/contato, a atividade da cotação aparece na timeline do CRM, e
o resultado (ganho/perdido) alimenta funil, métrica e relatório. Integração nova MUST responder
o Living System Checklist (Princípio II) do lado do CRM — inclusive as arestas que atravessam
a fronteira.

**Rationale**: a meta declarada é um sistema onde cotação, CRM, contatos, leads, vendas,
relatórios de marketing e importação de leads são uma coisa só do ponto de vista do usuário —
sem que isso signifique um monólito acoplado no nível do banco. Contrato explícito é o que deixa
os dois lados evoluírem e ainda assim entregarem a experiência integrada; acoplamento no banco
faz cada deploy de um quebrar o outro.

### VIII. O Usuário é o Corretor, e Ele Tem 10 Minutos (NÃO NEGOCIÁVEL)

A persona de validação é o corretor de plano de saúde: não é desenvolvedor, não é admin de TI,
não lê documentação, e o tempo dele é o recurso mais escasso do produto. **Teto duro**: do login
à **primeira conversa atendida por agente** em **≤10 minutos**, sem suporte humano e sem editar
arquivo nenhum. Feature nova MUST nascer com **estrutura pré-pronta que já funciona** — agente,
prompt, capacidades e funil vêm montados por padrão; configurar do zero é o caminho avançado,
nunca o padrão. Feature que só entrega valor depois de configuração longa está **incompleta**,
não "avançada": o template padrão faz parte da entrega, não de uma fase seguinte. A verificação é
a prova pela tela do Princípio IV, **cronometrada** — a contagem começa no login e termina na
primeira resposta do agente a uma mensagem real.

**Rationale (ajustado na v2.0.0)**: o teto não mudou; o relógio começa mais cedo. Antes contava do
login numa instalação já feita por alguém; agora conta do **cadastro**, e o usuário está em
período de teste decidindo se assina. O tempo até o primeiro valor **é** a taxa de conversão.
Configuração longa não é barreira de entrada — é o abandono antes da assinatura.

### IX. Todo Agente Serve Vender ou Assistir

O agente tem duas missões no escopo atual, e apenas duas: **converter** (informar o interessado,
qualificar e conduzir até a venda do plano) e **assistir** (orientar quem já é cliente do corretor
— segunda via de boleto, acesso à carteirinha, rede credenciada, dúvida de cobertura e uso).
Capacidade nova MUST declarar qual das duas serve; capacidade que não serve nenhuma MUST NOT
entrar. As duas MUST NOT ser fundidas, porque têm físicas opostas: **converter** tolera
proatividade e aproximação; **assistir** exige precisão e MUST NOT inventar. Resposta de
assistência sem respaldo no conhecimento do tenant MUST recusar e escalar ao humano.

**Rationale**: informação errada sobre boleto, carteirinha ou cobertura não é "resposta ruim", é
dano ao cliente final do corretor — e quem responde por isso é ele, não o fabricante do software.

### X. Conhecimento de Operadora é Dado Curado, Nunca Código

A informação específica de cada operadora de plano de saúde — como emitir boleto, onde acessar
carteirinha, rede, regras de uso — MUST viver como conteúdo versionado e curado no RAG. MUST NOT
viver em `if`, prompt hardcoded, tabela de código ou deploy. **Operadora nova = carregar conteúdo,
não fazer release**: se alguém precisa de deploy para atender uma operadora nova **na própria
instalação**, o desenho está errado. Toda resposta de assistência MUST ser rastreável ao trecho que
a originou — sem trecho, sem resposta (Princípio IX).

Esse conhecimento vive em **duas camadas**, e a diferença entre elas é de dono, não de formato:

- **Acervo do tenant** — o que o corretor carrega. É dado da organização e entra no isolamento por
  `organization_id` como qualquer outro (Princípio I), sem exceção.
- **Catálogo curado** — o que o fabricante mantém e distribui com o produto, para que uma instalação
  nova já saiba assistir antes de o corretor carregar a primeira coisa. É uma partição
  **compartilhada pela instalação** e a única do sistema que não pertence a nenhuma organização.

O catálogo curado é uma exceção **de mão única** ao Princípio I, e ela só é aceitável sob **todas**
as travas abaixo. Faltando qualquer uma, a exceção não vale e o conteúdo MUST voltar a ser dado de
tenant:

1. **Legível por todos, gravável por ninguém do tenant.** A escrita no catálogo MUST exigir papel de
   plataforma (`is_platform_admin`); qualquer outra origem MUST ser barrada, inclusive `admin` da
   organização e inclusive chamada direta às operações de dados.
2. **Sem dado de ninguém dentro.** O catálogo MUST conter apenas procedimento de operadora. Dado
   pessoal de cliente e dado pertencente a uma organização MUST NOT entrar nele — é isso que mantém
   a partição fora do alcance da LGPD e do Princípio I.
3. **Não afrouxa nenhuma tabela tenant-aware.** A exceção MUST ser uma partição própria. Retirar
   `organization_id` de tabela existente ou relaxar RLS para acomodá-la é proibido, e consulta que
   cruza as duas camadas MUST NOT poder devolver linha de outra organização.
4. **O tenant manda no que vale para ele.** Cada organização MUST poder desativar para si qualquer
   operadora ou material do catálogo, e material próprio dela MUST vencer o catálogo quando os dois
   afirmam coisas incompatíveis sobre o mesmo assunto. Quem conhece a regional é o corretor.
5. **A origem MUST dizer a camada.** A rastreabilidade exigida acima MUST identificar se o trecho
   veio do catálogo ou do acervo do tenant. A responsabilidade editorial é de pessoas diferentes nos
   dois casos, e sem essa marca ninguém sabe a quem cobrar a correção.
6. **Distribuir MUST NOT destruir.** A semeadura do catálogo viaja pelo caminho do Princípio III e
   MUST ser reaplicável: ela só acrescenta versão, e MUST NOT reescrever, apagar ou desativar
   material já existente na instalação — inclusive o que o administrador local editou. Atualização
   que apaga correção local é defeito, não efeito colateral aceitável.
7. **Nada volta.** Lacuna, pergunta de cliente, métrica de uso e telemetria de conteúdo MUST NOT
   atravessar a fronteira de uma instalação de volta ao fabricante. Quem instala um clone herda o
   papel de curador do catálogo dele e responde pelo que editar ali.

**Rationale**: são dezenas de operadoras, cada uma mudando processo no próprio ritmo. Qualquer
desenho que exija release por operadora transforma manutenção de conteúdo em fila de engenharia, e
a informação fica velha exatamente onde errar custa mais caro. A camada curada existe porque o
Princípio VIII cobra valor em 10 minutos: uma instalação que nasce sem saber nada obriga o corretor
a curar conteúdo antes de ver o produto funcionar, e ele não vai fazer isso. E a exceção é estreita
de propósito — a redação anterior deste princípio dizia que todo conteúdo de operadora é dado de
tenant, e ela estava certa sobre o risco: um acervo compartilhado é a primeira porta por onde o
isolamento vaza. As sete travas existem para que essa porta abra num sentido só.

### XI. Toda Entrega Nasce com Teste que Prova e que Vigia (NÃO NEGOCIÁVEL)

Nada é construído sem teste automatizado, e o teste MUST responder **duas perguntas distintas**:
**funciona?** (um teste exercita o comportamento novo pelo caminho que o usuário ou o sistema real
usa, e falharia se a feature não existisse) e **quebrou alguma coisa?** (a suíte inteira roda
antes de declarar pronto). Regras verificáveis:

- **Teste que passa com a implementação sabotada não é teste.** Antes de aceitar um teste como
  prova, quebra-se de propósito o código que ele deveria vigiar e confirma-se que ele fica
  vermelho. Sem esse passo, o teste é hipótese.
- **O gate certo por tipo de mudança**, porque o errado dá falso-verde: schema, RLS, tenancy,
  atribuição ou roteamento → `pnpm test:db`; UI ou fluxo de usuário → Playwright pela tela
  (Princípio IV); contrato externo → teste contra receptor real, não mock.
- **Bug entra com o teste que o reproduz primeiro** (vermelho), depois a correção (verde). Bug
  corrigido sem teste de regressão MUST NOT ser considerado pronto.
- **Invariante que só existe em prosa não existe.** Regra declarada nesta constituição ou no
  `CLAUDE.md` MUST virar teste em `tests/invariants/` ou deixa de ser chamada de invariante.
- **Configuração que a tela oferece MUST ter teste de efeito**: prova de que ligar a opção muda o
  comportamento, não apenas de que o valor foi gravado.
- Verde parcial MUST NOT ser reportado como verde. Declara-se qual suíte rodou e qual não rodou.

**Rationale**: três defeitos deste repositório atravessaram **todos os gates verdes**.
`rag_must_hit` é gravado pela tela e nenhum runtime o avalia. PDF de conhecimento sobe, responde
`201` e nunca vira conhecimento indexado. E a varredura de hardening só inspeciona função
`SECURITY DEFINER` **volátil** — o que deixou `retrieve_top_k_chunks`, que é estável, executável
por `authenticated` filtrando o tenant por parâmetro do chamador, contra o Princípio I. Nenhum dos
três é bug de código difícil: os três são bug de **teste que não existia**.

### XII. Contexto Antes de Ação (NÃO NEGOCIÁVEL)

Nenhuma sessão — humana ou agente — executa a ação pedida antes de ter absorvido o planejamento
geral do sistema. Antes da **primeira ação de consequência** de uma sessão (planejar, editar
arquivo, rodar comando que muda estado, decidir arquitetura, responder pergunta de convenção),
a sessão MUST ter lido, nesta ordem: **(1)** esta constituição, **(2)** `CLAUDE.md`,
**(3)** `README.md`. Ler ordenado importa: a constituição declara a lei, o `CLAUDE.md` a
detalha em convenção, e o `README.md` mostra o produto que o usuário final instala.

- **Declaração explícita.** A sessão MUST declarar em uma linha, antes de agir, que leu os três,
  citando o `Version` desta constituição. Sem essa linha, a ação é prematura: interrompe-se,
  faz-se a leitura, e refaz-se a decisão à luz do que foi lido — inclusive desfazendo o que já
  tiver sido escrito com premissa errada.
- **"É rapidinho" MUST NOT dispensar.** O tamanho do pedido não mede o risco. É justamente o
  ajuste pequeno que atropela invariante de RLS, de migration ou de navegação sem ninguém notar.
- **Contexto compactado, resumido ou retomado conta como sessão nova.** Se a sessão não tem
  certeza de que ainda carrega o conteúdo dos três documentos — resumo automático, retomada
  depois de dias, handoff de outro agente —, ela MUST reler antes de seguir. Na dúvida, relê.
- **Aprofundamento sob demanda**, além do trio obrigatório, conforme o que a task toca: schema,
  RLS ou tenancy → `docs/index.md` e `docs/current-state.md`; UI ou fluxo de usuário →
  `docs/testing/user-journey-map.md`; deploy → `docs/runbooks/deploy.md`; agente que não é o
  Claude Code → `AGENTS.md`. `docs/harness-audit.md` antes de tratar CI verde como prova.
- **Divergência entre documentos MUST ser reportada ao usuário antes de agir sobre ela**, nunca
  resolvida em silêncio. Precedência: esta constituição > `CLAUDE.md` > demais docs. Documento
  derivado que ficou para trás vira issue de alinhamento, não interpretação livre da sessão.
- A leitura MUST preceder também **estimativa e promessa**: prazo dado sem `docs/current-state.md`
  é chute sobre o que está pronto, incompleto ou quebrado.

**Rationale**: este repositório tem doutrina densa e não-óbvia — a tripla de artefatos de
migration, o `baseline.sql` que é o que sobe ambiente do zero e o que o gate `invariants` aplica,
`curl` que não prova UX, `test:unit` que não roda os invariantes. Nada disso é dedutível olhando o
código: quem começa a mexer sem ler produz trabalho que parece certo, passa nos gates errados e
quebra produção — que agora é a instância de **todos** os clientes. A leitura de entrada custa
minutos; a sessão que a pula custa retrabalho e regressão — e o usuário não deve ter de lembrar a
cada pedido que ela é obrigatória.

### XIII. Cobrança Mora no Cotador, e Só Lá (NÃO NEGOCIÁVEL)

Este repositório MUST NOT implementar assinatura, plano, preço, checkout, pagamento, cartão,
nota fiscal, cupom, dunning ou régua de inadimplência. MUST NOT armazenar dado de meio de
pagamento, em nenhuma forma, nem cifrado. A fonte da verdade sobre "esta organização está
paga?" é o **Cotador Simplificado**, e o CRM a consulta ou recebe **por contrato explícito**
(Princípio VII), tratando-a como dado externo com prazo de validade — nunca como coluna que
alguém daqui edita.

Quando o estado de assinatura não estiver disponível, o CRM MUST **degradar de forma legível ao
usuário** e MUST NOT bloquear atendimento em andamento por dúvida: mensagem de cliente que já
está em conversa não deixa de ser respondida porque uma consulta de cobrança falhou. Corte de
acesso é decisão do Cotador, comunicada, nunca inferida aqui.

**Rationale**: cobrança duplicada em dois sistemas é a receita conhecida para o cliente ser
cobrado duas vezes, ou ser cortado estando em dia — e o erro cai sobre uma pessoa real, não
sobre uma linha de log. Um dono só para essa verdade elimina a classe inteira de defeito. E
manter dado de pagamento fora deste repositório retira dele um alvo que ele não precisa carregar.

### XIV. O Gateway é Serviço Único, Compartilhado e Sem Réplica (NÃO NEGOCIÁVEL)

O `gateway_go` roda como **uma instância**, operada por nós, **compartilhada por todos os
tenants**, e **não** é instalado junto com o CRM. Consequências que são regra, não observação:

- O CRM MUST NOT supor que o gateway está na mesma máquina, rede ou ciclo de deploy. Sem
  `localhost`, sem nome de serviço de compose, sem "ele sobe junto". O endereço é configuração.
- O gateway MUST NOT entrar no compose de produção do CRM, e o deploy de um MUST NOT exigir o
  deploy do outro. Os dois versionam separado — daí a compatibilidade para frente do envelope
  (versão maior é aceita, campo desconhecido é preservado) ser obrigatória, e não zelo.
- **Sem réplica = ponto único de falha declarado.** Toda mensagem que passa por ele MUST
  sobreviver a ele estar fora do ar: entrega com retentativa durável e fila persistida em disco
  do lado do gateway, e dreno periódico do lado do CRM. Caminho que perde mensagem quando um
  dos dois lados reinicia MUST NOT ser aceito como pronto, ainda que passe nos testes.
- A queda do gateway MUST ser **visível** — para nós, em alerta; e para o usuário afetado, na
  Central, dizendo que o canal parou de receber (Princípio II). Silêncio é proibido: o sintoma
  natural é "as mensagens pararam", sem lugar nenhum para olhar.
- Sendo compartilhado, um tenant MUST NOT conseguir degradar outro: teto por conexão, e não
  global nem por IP — todas as entregas vêm do mesmo endereço.

**Rationale**: um serviço único sem réplica é uma escolha legítima de custo no estágio atual,
mas só é honesta se a durabilidade estiver do lado de fora dele. Sem isso, "sem réplica" vira
"toda mensagem recebida durante o reinício foi perdida", e mensagem perdida é cliente sem
resposta — o defeito mais caro deste produto e o único que o usuário não tem como detectar.

## Restrições de Stack e Configuração

**Stack canônica** (desvio exige justificativa registrada na Complexity Tracking do plano):
Next.js 16 App Router + React 19 + TypeScript 6 estrito; Tailwind + shadcn/ui (`new-york`,
neutral); Supabase (Postgres + RLS + `vector`) para DB, Auth (`@supabase/ssr`), Realtime e
Storage; WAHA Plus engine NOWEB para WhatsApp; `event_log` + workers para filas (Inngest e
Trigger MUST NOT entrar no MVP); Upstash Redis para rate limit; Vercel AI SDK v7 via AI Gateway;
Zod para validação; Sentry com `beforeSend` sanitizado.

**Configuração de pacote e scripts** — regras verificáveis:

- `package.json` MUST declarar `packageManager` e `engines.node`, e as versões de `@types/*`
  MUST corresponder ao runtime declarado em `engines`.
- Script de portão MUST executar o que seu nome promete. Script que imprime TODO e sai com
  código 0 é falso-verde e MUST NOT existir — ou implementa, ou remove, ou sai diferente de 0.
- Alias de script MUST diferir do script base em comportamento. Dois nomes para o mesmo comando
  mentem sobre existir uma alternativa.
- `gov:verify` MUST ser o conjunto exato dos checks locais rápidos que o job `verify` do CI roda,
  e sua descrição MUST declarar o que **não** cobre (`test:db`, `test:e2e`).
- Dependência nova MUST ser justificada contra a doutrina DIRC (Duplicar, Integrar, Referenciar,
  Calcular) aplicada a pacotes: existe capacidade equivalente já no repo?
- Env var nova MUST entrar em `.env.example` **e** em `lib/env.ts` (validação Zod que lança no
  startup se faltar crítica).

**Deploy (v2.0.0 — instância única, nossa)**: o alvo do deploy é a **nossa** instalação, não a
VPS de um cliente. Na máquina com proxy reverso próprio, todo `up -d` MUST levar os dois arquivos
de compose (`docker-compose.prod.yml` + `docker-compose.traefik.yml`) — omitir o segundo recria o
contêiner sem as labels de roteamento e o domínio inteiro responde 404 com o contêiner `healthy`,
porque o healthcheck é probe TCP e não sabe nada de roteamento. Após deploy, o domínio MUST
responder 307, não 404. O caminho normal MUST NOT construir imagem na máquina de produção
(commit → CI → GHCR → pull); build local é exceção de emergência e é dívida declarada, porque
existe só naquele disco.

O **gateway não entra nesse deploy** (Princípio XIV): ele tem ciclo próprio, e exigir os dois
juntos recria o acoplamento que a separação existe para desfazer.

**Deploy agora é irreversível na prática.** Não há instalação antiga em máquina alheia para servir
de comparação, e não há usuário rodando versão anterior. Mudança de schema destrutiva MUST ter
caminho de volta pensado ANTES (coluna nova em vez de renomeada, leitura tolerante aos dois
formatos, remoção só depois de a escrita nova estar em produção) — o padrão expand/contract, e não
o `ALTER` direto que "já está testado".

**Anti-patterns proibidos** (lista completa em `CLAUDE.md`): string que deveria ser FK; duplicação
sem source of truth; evento sem consumer; campo sincronizado por cron quando devia ser trigger;
`jsonb` lock-in; cascade fantasma; polimórfico sem padronização; trigger com HTTP; service role
sem filtro de org; `getSession()` no backend; API key em query string; bearer plaintext no banco;
`console.log` mergeado.

## Papéis, Ritmo e Método

**Quem decide o quê.** O dono do produto decide **o quê**: escopo, prioridade, prazo, custo,
posicionamento. O desenvolvedor decide **o como**: arquitetura, ferramenta, ordem de execução,
desenho de dados. Escolha técnica MUST NOT voltar ao dono como pergunta — volta como
**recomendação única e justificada**, com as alternativas descartadas em uma linha cada. Pergunta
bloqueante (parar sem entregar nada até ter resposta) é reservada ao caso em que qualquer
suposição tornaria o trabalho inútil se errada, ou inseguro; fora disso assume-se o padrão
razoável, declara-se a suposição por escrito, e entrega-se. Decisão de negócio genuína é
apresentada com a recomendação do desenvolvedor **já formada**, nunca como impasse.

**Ritmo: duas jornadas é o teto.** O incremento padrão cabe em até **duas jornadas de trabalho** e
é **utilizável sozinho** ao fim delas. Trabalho maior MUST ser fatiado, nunca adiado nem
transformado em projeto de semanas. Estimativa MUST ser dada em **jornadas de trabalho deste time**
(dono + agente), nunca em "dias-dev" de uma equipe humana hipotética — a unidade errada infla o
número em ordem de grandeza e trava decisão de negócio por medo de um custo que não é o real.
Quando o risco domina o custo (contrato externo desconhecido, integração nunca exercitada), a
primeira fatia MUST ser um **spike de prova ponta a ponta**, curto, cujo único produto é eliminar
a incerteza. Não se estima o desconhecido: mede-se.

**Forma do plano e da tarefa.** Todo plano abre pelo **resultado observável**, nunca por lista de
arquivos ou de camadas. Toda tarefa carrega três coisas: **arquivo alvo**, **mudança concreta** e
**como se prova que funcionou** — tarefa sem critério de prova MUST NOT entrar na lista. A ordem é
por **risco decrescente**: o que pode invalidar o plano inteiro vem primeiro. Se a execução
precisa reabrir uma decisão, o plano estava incompleto.

**Reusar antes de escrever.** Antes de criar peça nova, verifica-se nesta ordem: já existe
seam/adapter no repo? → existe pronto num projeto irmão em `/root/PROJETOS/`? → dá para derivar do
que existe? Só então se escreve. Dependência, camada, tabela ou serviço novo MUST ser justificado
**no plano** (Complexity Tracking), não descoberto no diff.

**Rationale**: a análise do `gateway_go` encontrou 1.323 linhas de normalização de canal já
escritas e testadas, que rebaixaram uma migração de "ALTA" para "MÉDIA-ALTA". Isso foi resultado
de procurar antes, não de sorte — por isso virou passo obrigatório.

## Fluxo de Desenvolvimento e Portões

**Higiene de branch**: `main` é produção e fonte da verdade. Antes de qualquer trabalho, a branch
MUST ser atualizada com a `main` (`git fetch origin && git merge origin/main`; fast-forward se
não tem commit próprio). `reset --hard`/force para "atualizar" MUST NOT ser usado. Branch ou
worktree com working tree sujo que não é seu MUST NOT ser tocada — cheque `git status` e
`git worktree list`, e avise. Conflito ao atualizar interrompe e é resolvido com cabeça, nunca
escolhendo um lado no automático.

**Cadência de commit**: a unidade de commit é a **fase**, não a task. Uma fase inteira de um plano
— as fases de `tasks.md` no fluxo Spec Kit, ou o marco equivalente num plano sem fases — fecha com
**um** commit, carregando todas as tasks dela. Commit a cada task MUST NOT ser o padrão: enche o
histórico de estados intermediários que não compilam, não passam nos portões e não são reversíveis
sozinhos, e transforma revisão de PR em arqueologia.

Três exceções, e são exceções mesmo:

- **Trabalho que atravessa mais de uma jornada sem fechar a fase MUST ser commitado assim mesmo**,
  rotulado como parcial na mensagem. A árvore de trabalho é compartilhada entre sessões e
  worktrees, e sessão que compacta, troca de branch ou restaura arquivo perde o que não está
  commitado. Trabalho perdido é pior que histórico feio.
- **Mudança de doutrina** — esta constituição, `CLAUDE.md`, `AGENTS.md`, `docs/doctrine/` — MUST
  ser commitada assim que fica pronta, sem esperar fase. É a regra que governa o resto do
  trabalho; ela não fica refém dele.
- **Migration versionada** MUST sair no mesmo commit que o apêndice do `baseline.sql` e a linha do
  MANIFEST (Princípio III). Se a fase ainda não fechou, o commit de schema sai sozinho — os três
  artefatos nunca se separam.

O commit de fase MUST ter rodado antes os portões que o tipo da mudança exige (`pnpm typecheck`,
`pnpm lint`, `pnpm test:unit`; mais `pnpm test:db` se tocou schema, RLS, RBAC, escopo, roteamento,
follow-up, webhooks ou automações). Commit de fase é entrega verificada, não "salvar arquivo". A
mensagem MUST nomear o **resultado observável** da fase, nunca a lista de arquivos ou o intervalo
de IDs de task. E juntar tasks num commit MUST NOT adiar teste: o teste que prova a fase entra no
commit da fase (Princípio XI).

**Rationale**: quem lê este histórico é o revisor do PR e o self-hoster que precisa achar onde
algo quebrou. Um commit por fase é a menor unidade que alguém consegue reverter inteira sem
quebrar o meio; um commit por task é ruído com custo de bisect.

**Portões obrigatórios na branch protection da `main`**:

- `verify` — typecheck + lint + lint:channels + test:unit + test:shell
- `invariants` — `pnpm test:db`: Postgres limpo, `baseline.sql` em modo install
  (`ON_ERROR_STOP=1`) e update (idempotência), + a suíte de invariantes incluindo isolamento RLS
- `build-and-size` — `pnpm build` em Node 22

`e2e` roda mas ainda não segura merge. `pnpm test:unit` sozinho MUST NOT ser lido como
"está tudo verde": `tests/invariants/**` está excluído do `vitest.config.ts` de propósito e só
roda via `pnpm test:db`. Ao mexer em schema, RLS, RBAC, atribuição, escopo, roteamento,
follow-up, webhooks ou automações, `pnpm test:db` MUST rodar localmente antes do PR.

**Definition of Done** — uma task só fecha com os 14 itens do `CLAUDE.md` respondidos, dos quais
estes são consequência direta desta constituição: migration versionada + baseline + MANIFEST
(Princípio III); RLS testada se toca tabela tenant-aware (I); audit log emitido em mutação (VI);
Zod em todo input externo (VI); prova pela tela em ambiente fresco se tocou UI (IV); Living
System Checklist respondido (II); tela nova com porta declarada (II). A partir da v1.1.0 soma-se
um item ao fecho: **teste que prova a feature nova e suíte inteira verde**, com o gate escolhido
pelo tipo da mudança e o teste confirmado por sabotagem (Princípio XI). Entrega sem esse item
MUST NOT ser declarada pronta, ainda que os 14 itens anteriores estejam respondidos.

A partir da v2.0.0 somam-se dois: **estado vazio provado** quando a mudança tem tela (IV — a conta
recém-criada é o estado inicial de 100% dos usuários), e **caminho de volta declarado** quando a
mudança altera schema (III — instância única não tem versão de escape).

## Governance

Esta constituição **supersede** qualquer outra prática do repositório. Onde `CLAUDE.md`,
`AGENTS.md`, docs de PRD/spec ou hábito de sessão divergirem dela, ela vence — e a divergência
vira issue para alinhar o documento derivado.

**Emenda**: exige (a) PR dedicado alterando este arquivo, (b) justificativa escrita do que muda
e por quê, (c) plano de migração quando a emenda invalida código ou doutrina existente, e
(d) propagação para os artefatos dependentes listados no Sync Impact Report. Emenda que remove
ou redefine princípio MUST NOT ser aplicada no mesmo PR que a feature que a motivou.

**Versionamento** (semântico): MAJOR para remoção ou redefinição incompatível de princípio ou
regra de governança; MINOR para princípio ou seção nova, ou expansão material de orientação;
PATCH para esclarecimento, redação e correção sem efeito semântico.

**Conformidade**: todo plano gerado por `/speckit-plan` MUST passar pelo Constitution Check antes
da Fase 0 e de novo após a Fase 1. Violação MUST ser registrada na tabela Complexity Tracking do
plano, com a alternativa mais simples que foi rejeitada e o porquê — violação não documentada
reprova a revisão. Complexidade MUST ser justificada, nunca presumida.

**Leitura de entrada**: toda sessão começa lendo esta constituição, depois `CLAUDE.md`, depois
`README.md`, e só então age — inclusive quando o pedido parece pequeno, e de novo quando o
contexto foi compactado ou retomado. A regra completa, com a declaração exigida e o
aprofundamento por tipo de task, está no Princípio XII.

**Orientação de runtime**: `CLAUDE.md` (convenções detalhadas e Definition of Done),
`AGENTS.md` (mesmo contrato em forma portável para outros agentes),
`docs/doctrine/sistema-vivo.md` (invariantes do Princípio II),
`docs/index.md` (índice dos docs com regra de precedência),
`docs/current-state.md` (o que está pronto, incompleto e quebrado).

**Version**: 2.2.0 | **Ratified**: 2026-08-07 | **Last Amended**: 2026-08-08
