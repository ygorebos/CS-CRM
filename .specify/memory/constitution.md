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

**Multi-tenant desde já.** N instâncias e números conectados, pertencentes a empresas vindas do
Cotador Simplificado ou a clientes diretos, isolados por `organization_id` com RLS (Princípio I).

**Por onde as mensagens entram.** O `gateway_go` é o **receptor geral de todo o tráfego de entrada
do CRM**: mensagens de todos os canais (WhatsApp oficial e não-oficial, Instagram Direct e o que
vier depois) e **demais webhooks**. Ele recebe, autentica a origem, **normaliza para um envelope
único** e entrega ao CRM; o CRM **persiste no banco dele**. Código novo do CRM MUST NOT ler
payload cru de provedor — nem de WAHA, nem de uazapi, nem da Meta.

A fronteira que não se cruza: **o gateway MUST NOT escrever no banco do CRM**. Receber uma
mensagem aqui não é um `INSERT` — dispara agente, follow-up, guardrails, auditoria, `event_log` e
Realtime. Quem persiste é o CRM, pelo caminho dele, com o `organization_id` resolvido de fonte
confiável e nunca do corpo da requisição (Princípios I e VII).

**Onde isso vai dar.** O CRM evolui **independente** por enquanto. Quando estiver robusto, o
Cotador Simplificado migra para ele e aposenta o CRM interno que tem hoje. Toda decisão de
modelagem **considera** que um dia haverá importação de dados vindos de lá, mas nenhuma decisão é
**adiada** por causa disso.

**O que fica fora por enquanto.** Acoplamento ao Cotador em nível de schema, banco ou FK cruzada.
A ponte é o gateway e contratos HTTP explícitos, nada além disso.

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

### III. Schema Viaja com o Clone (NÃO NEGOCIÁVEL)

Toda mudança de schema MUST sair como três artefatos juntos: (a) migration versionada em
`supabase/migrations/` no padrão `<timestamp>_<NNNN>_<slug>.sql`, idempotente e portável em
`psql` puro (sem `BEGIN`/`COMMIT` explícito, sem temp table fora de transação); (b) apêndice
idempotente e auto-curativo em `supabase/baseline.sql`; (c) linha em
`supabase/migrations/MANIFEST.md`. Migration que adiciona constraint MUST corrigir/deduplicar
os dados **antes** de criá-la. Migration já aplicada MUST NOT ser editada — corrige-se com
forward-fix. `ALTER`/`CREATE` solto em banco, sem arquivo correspondente, é proibido.

**Rationale**: o produto é distribuído open-source e o self-hoster aplica **só o
`baseline.sql`**, tanto no `install.sh` (banco novo) quanto no `update.sh` (banco existente).
Mudança que entra só em `migrations/` não chega a ninguém; mudança não-idempotente quebra o
`update.sh` de todo clone.

### IV. Prova pela Tela em Ambiente Fresco (NÃO NEGOCIÁVEL)

Feature nova ou fix de comportamento visível MUST ser provada dirigindo o browser (Playwright),
como um usuário leigo faria, num ambiente que imita instalação fresca: Postgres limpo aplicado
do `baseline.sql` + `bootstrap-owner.ts`, dependências como na VPS (WAHA, Redis, cron via
endpoint), e **com os envs opcionais ausentes**. `curl` e chamada de API MUST NOT ser aceitos
como prova de UX — servem só como diagnóstico. Efeito colateral externo MUST ser provado com
receiver real, não mock. Medida de front-end MUST vir de ferramenta
(`getBoundingClientRect`/`getComputedStyle`), nunca a olho. Jornadas de primeira impressão
(criar conta, conectar canal, primeiro lead, primeiro convite) têm prioridade máxima e são `[P0]`
em `docs/testing/user-journey-map.md`.

**Rationale**: num produto self-host, a experiência de quem instala **é** o produto. Bug de
primeira impressão é abandono, e é exatamente onde os envs opcionais ausentes escondem os
piores defeitos.

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

**Rationale**: num produto self-host distribuído para quem não é técnico, o tempo até o primeiro
valor **é** a taxa de adoção. Configuração longa não é barreira de entrada, é o abandono.

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
carteirinha, rede, regras de uso — MUST viver como conteúdo versionado e curado no RAG do tenant.
MUST NOT viver em `if`, prompt hardcoded, tabela de código ou deploy. **Operadora nova = carregar
conteúdo, não fazer release**: se o corretor precisa de deploy para atender uma operadora nova, o
desenho está errado. Toda resposta de assistência MUST ser rastreável ao trecho que a originou —
sem trecho, sem resposta (Princípio IX). Conteúdo de operadora é dado de tenant e entra no
isolamento por `organization_id` como qualquer outro (Princípio I).

**Rationale**: são dezenas de operadoras, cada uma mudando processo no próprio ritmo. Qualquer
desenho que exija release por operadora transforma manutenção de conteúdo em fila de engenharia,
e a informação fica velha exatamente onde errar custa mais caro.

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
migration, o `baseline.sql` como único caminho até o self-hoster, `curl` que não prova UX,
`test:unit` que não roda os invariantes. Nada disso é dedutível olhando o código: quem começa a
mexer sem ler produz trabalho que parece certo, passa nos gates errados e quebra o clone de
alguém. A leitura de entrada custa minutos; a sessão que a pula custa retrabalho e regressão em
produção — e o usuário não deve ter de lembrar a cada pedido que ela é obrigatória.

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

**Deploy**: em VPS com proxy reverso próprio, todo `up -d` MUST levar os dois arquivos de compose
(`docker-compose.prod.yml` + `docker-compose.traefik.yml`). Após deploy, o domínio MUST responder
307, não 404. Build na VPS é exceção de emergência e é dívida declarada.

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

**Version**: 1.2.0 | **Ratified**: 2026-08-07 | **Last Amended**: 2026-08-07
