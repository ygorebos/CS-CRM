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
-->

# DeskcommCRM Constitution

Sistema operacional de vendas open source, multi-tenant, self-hosted, com agentes de IA
nativos e WhatsApp como canal primário. Esta constituição é a lei de arquitetura do repositório.
`CLAUDE.md`, `docs/doctrine/sistema-vivo.md` e `README.md` a detalham; onde divergirem, esta
constituição prevalece.

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
System Checklist respondido (II); tela nova com porta declarada (II).

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

**Orientação de runtime**: `CLAUDE.md` (convenções detalhadas e Definition of Done),
`AGENTS.md` (mesmo contrato em forma portável para outros agentes),
`docs/doctrine/sistema-vivo.md` (invariantes do Princípio II),
`docs/index.md` (índice dos docs com regra de precedência),
`docs/current-state.md` (o que está pronto, incompleto e quebrado).

**Version**: 1.0.0 | **Ratified**: 2026-08-07 | **Last Amended**: 2026-08-07
