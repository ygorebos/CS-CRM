# CLAUDE.md — DeskcommCRM

> Instruções pra futuras sessões Claude trabalhando neste repo. Leitura obrigatória antes de qualquer task de código.

**Este arquivo é a doutrina — a autoridade final sobre convenção e anti-pattern.** Complementos, na ordem em que ajudam:

- [`AGENTS.md`](AGENTS.md) — mesmo contrato em forma portável (para Codex/Cursor/Copilot e afins). É derivado deste arquivo, não o substitui. **Ao mudar doutrina aqui, verifique se `AGENTS.md` desatualizou.**
- [`docs/index.md`](docs/index.md) — índice dos 123 docs, com regra de precedência quando dois docs discordam. Use antes de sair varrendo `docs/`.
- [`docs/current-state.md`](docs/current-state.md) — o que está pronto, incompleto e quebrado. **Leia antes de estimar ou prometer qualquer coisa.**
- [`docs/harness-audit.md`](docs/harness-audit.md) — onde a verificação tem buraco. Importante: `pnpm gov:verify` **não** cobre `test:db` nem `test:e2e` — verde ali não é prova para mudança de schema ou de UI.
- [`docs/threat-model.md`](docs/threat-model.md) — superfície de ataque real da instância.
- [`docs/doctrine/armadilhas-de-execucao.md`](docs/doctrine/armadilhas-de-execucao.md) — sintomas cujo
  diagnóstico já foi pago uma vez, com a regra que sobrevive ao caso. **Leia antes de escrever teste de
  banco, mexer no `baseline.sql` ou concluir que algo "está verde"** — várias das entradas descrevem
  defeitos que passam verde. Ao gastar mais de 20 minutos entendendo um sintoma, acrescente a entrada.
- [`.specify/memory/constitution.md`](.specify/memory/constitution.md) — **v2.3.1, autoridade acima deste arquivo em caso de conflito.** Onde este arquivo ainda disser "self-host", vale a constituição.

---

## Visão (1 parágrafo)

DeskcommCRM é um sistema operacional de vendas com agentes de IA nativos — nicho de validação: **corretor de plano de saúde**; multi-nicho segue como capacidade (`vocabulary` por pipeline), não como prioridade. WhatsApp é o canal primário, e todo tráfego de entrada chega pelo `gateway_go`. Agentes com RAG por tenant atendem, qualificam e movem o funil junto com humanos; CRM inteiro exposto via MCP. **Entrega: SaaS de instância única, operada por nós** — o usuário se cadastra, usa e testa; ninguém instala nada. **Cobrança não mora aqui**: assinatura é gerenciada no Cotador Simplificado (Princípio XIII). Multi-tenant com RLS desde o dia 1 — e agora todas as organizações dividem o MESMO banco, então isolamento furado vaza entre clientes distintos. LGPD nativa. Posicionamento completo: `VISION.md`.

---

## Stack canônica

- **Frontend:** Next.js 16 App Router (Turbopack) + React 19 + TypeScript 6 estrito + Tailwind + shadcn/ui (style: `new-york`, neutral)
- **Backend:** Next.js Route Handlers (mesmo repo); workers via `event_log` table + cron
- **DB:** Supabase (Postgres). RLS em toda tabela tenant-aware. Extensions: `uuid-ossp`, `pgcrypto`, `vector`
- **Auth:** Supabase Auth via `@supabase/ssr`. Cookie SameSite=Strict, HttpOnly, Secure
- **Realtime:** Supabase Realtime (postgres_changes + broadcast)
- **Storage:** Supabase Storage (bucket `whatsapp-media` privado, URLs assinadas)
- **WhatsApp:** WAHA Plus, engine NOWEB
- **Filas/eventos:** `event_log` table + workers (não usar Inngest/Trigger no MVP)
- **Rate limit:** Upstash Redis sliding window
- **AI:** Vercel AI Gateway (Anthropic primário; OpenAI backup pra embeddings); strings tipo `"anthropic/claude-sonnet-4-6"`
- **Validação:** Zod em todo input externo (request body, webhook payload, env)
- **Observability:** Sentry com `beforeSend` sanitizado

---

## Convenções críticas (NÃO NEGOCIÁVEIS)

### Multi-tenancy
- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware
- RLS policy `tenant_isolation_<tabela>_all` aplicada via helper `fn_user_org_ids()`
- Service role bypassa RLS — handlers que usam admin client **DEVEM** filtrar `organization_id` manualmente, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **NUNCA do body**
- Toda query que cruza tabelas tenant-aware filtra `organization_id` explicitamente
- Teste de isolamento (cria 2 tenants, verifica não-vazamento) é obrigatório no CI antes de merge

### Idempotência & event sourcing leve
- Mensagens WhatsApp e eventos externos: `unique (organization_id, external_id)` + captura `code === '23505'` no INSERT
- POSTs de criação na API aceitam header `Idempotency-Key: <uuid>` (TTL 24h via Upstash)
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker (cron / Realtime listener) consome e dispara side effect

### API REST `/api/v1/`
- Versionamento por path. JSON snake_case. UUID v4. ISO-8601 UTC. Dinheiro em `_cents` + `currency` ISO-4217
- Wrapper sucesso: `{ data, meta?: { cursor, has_more, total } }`
- Wrapper erro: `{ error: { code, message, details? } }` — usar helpers `ok()` / `fail()` de `lib/api/wrappers.ts`
- Paginação: cursor opaco base64+HMAC por default
- Auth dual: cookie session (frontend) OU `Authorization: Bearer tok_...` (server-to-server)
- **API key NUNCA em query string** (vaza em logs Vercel/CF). Sempre header
- Plaintext de bearer token mostrado **uma vez** na criação; depois apenas hash SHA256 no DB
- Rate limit headers: `X-RateLimit-*` + `Retry-After` em 429
- `X-Request-Id` em toda response (correlaciona com audit log)

### Auth & RBAC
- Sempre `getUser()` (valida JWT no backend). NUNCA `getSession()` (confia no cookie local)
- 4 roles dentro do tenant: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4)
- Super-admin de plataforma é uma role transversal — `is_platform_admin` (decisão final na Spec 01)
- MFA TOTP **forçado** pra `admin` e super-admin
- Permissão por pipeline (`user_pipeline_access`) **NÃO** entra no MVP

### Audit log
- Toda mutação POST/PATCH/DELETE bem-sucedida → 1 entrada em `api_audit_log` (fire-and-forget, p99 ≤500ms)
- Audit é append-only. Sem RLS de UPDATE/DELETE. Edição apenas via DBA manual
- Retenção 5 anos. Hot 90 dias, cold (S3) o resto
- Falha de write em audit gera alerta Sentry, não bloqueia mutação principal

### LGPD
- Anonimização preferida sobre delete. Nome do contato vira `Cliente Anonimizado #N`
- Cascade de redact: contact + conversations + messages (mídia removida do storage) + activities (preserva timestamps)
- Reversão de anonimização: 403 `lgpd_anonymization_irreversible`
- SLA: data_request entregue D+7; redact executado D+15
- Action audit obrigatória: `lgpd.data_request_received`, `lgpd.export_generated`, `lgpd.redact_executed`, `lgpd.consent_changed`

### Gateway (`gateway_go`) — porta de entrada de TODO tráfego
- É o **receptor geral**: mensagens de todos os canais (WhatsApp oficial e não-oficial, Instagram Direct, o que vier) e demais webhooks. Recebe, autentica a origem, **normaliza para um envelope único** e entrega ao CRM
- **Código novo do CRM NÃO lê payload cru de provedor** — nem WAHA, nem uazapi, nem Meta. Só envelope
- **O gateway NUNCA escreve no banco do CRM.** Quem persiste é o CRM, com `organization_id` resolvido de fonte confiável (path token / segredo), nunca do corpo
- **Instância única, compartilhada, sem réplica, deploy separado.** Sem `localhost`, sem nome de serviço de compose — endereço é configuração. Não entra no `docker-compose.prod.yml` do CRM
- **Sem réplica = SPOF declarado:** mensagem tem de sobreviver ao gateway reiniciar — retentativa durável + fila em disco do lado dele, dreno periódico do lado do CRM. Queda vira alerta pra nós **e** aviso na Central pro usuário; silêncio é proibido
- Teto de taxa **por conexão**, nunca global nem por IP (todas as entregas vêm do mesmo endereço)

### Cobrança — não mora aqui
- Assinatura, plano, preço, checkout, pagamento, cartão, nota fiscal, dunning: **nada disso existe neste repo**. Dono é o **Cotador Simplificado**
- "Esta org está paga?" vem por contrato HTTP explícito, tratado como dado externo com validade — nunca coluna que alguém daqui edita
- Consulta de cobrança que falha **degrada de forma legível e não corta atendimento em andamento**

### WAHA (canal, atrás do gateway)
- Plus obrigatório (Core não suporta multi-tenant, sem retry, sem S3)
- Engine NOWEB default; WEBJS apenas se precisar stickers animados / botões
- Auth: env do WAHA recebe **hash SHA512 hex** da api key; cliente envia plaintext em `X-Api-Key`
- Webhooks: HMAC SHA512 com `crypto.timingSafeEqual`
- Anti-banimento: throttle 1 msg/1.2s + jitter ≤800ms. Campanha 1 msg/5s. Warm-up 7-14d. Spinning de copy. Janela 7h-22h, evitar domingo
- STOP detection: regex `/STOP|PARAR|SAIR|UNSUBSCRIBE/i` no inbound → `is_blocked=true` automaticamente
- Mídia: subir pro Supabase Storage primeiro, passar URL ao WAHA (não inline base64)
- Multi-device: assinar `message.any` (não só `message`); tratar `fromMe=true` sem duplicar
- Grupos: SKIP CRM binding se `chatId.endsWith('@g.us')`. Sender é `p.author`, não `p.from`
- Cron `recover-stuck-messages` (`app/api/v1/cron/recover-stuck-messages/route.ts`, agendado no `scheduler` do `docker-compose.prod.yml`): marca `status='sending'` há >5min como `failed` **e abre aviso na Central** (`agent_inbox_items` kind `message_send_stuck`). Não toca em `queued`: esse estado tem dono (o agent-engine reagenda por `SEND_QUEUED_RETRY_MS`), e falhá-lo perderia mensagem que ia sair. Não reenvia — envio em dobro é pior que não-envio

### Doutrina DIRC (antes de adicionar campo)
- **D**uplicar — vive aqui mesmo?
- **I**ntegrar — vem de outra tabela via FK?
- **R**eferenciar — só ponteiro?
- **C**alcular — pode ser computado on-demand?

### Modelagem
- 5 tabelas core CRM: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities` (polimórfica timeline), `crm_lead_links` (polimórficos vínculos)
- `position_in_stage numeric` (fractional indexing via `midpoint()`) — **NUNCA `int`**
- `external_id` nullable (mensagem outbound `sending` ainda não tem ID WAHA)
- `type` é `text` + `check constraint`, **não enum** (enum é difícil de estender)
  - **Exceção deliberada — colunas de vocabulário ABERTO:** onde o banco pode ter linhas com valor
    legado (ex.: `crm_lead_activities.type`), o CHECK **não** entra: a constraint quebraria a
    re-aplicação do `baseline.sql` em modo update — que é o que o job `invariants` roda e o que a
    nossa instância recebe a cada deploy —, e a doutrina de migrations proíbe. Nesses casos o vocabulário vive só no
    TypeScript, o emissor usa **constante compartilhada, nunca string literal**, e a coluna fica
    **fora** do invariante `tests/invariants/vocabulario-banco-x-typescript.test.ts` — que cobre
    apenas colunas que JÁ têm CHECK. Ver o cabeçalho desse arquivo antes de "completar" o schema.
- `tags text[]` + GIN index; promove pra coluna gerada apenas quando vira hot path
- `custom_fields jsonb` com schema declarativo em `pipeline.settings.fields`; Zod construído dinamicamente
- `vocabulary jsonb` em pipeline permite renomear lead/deal/won/lost (e-commerce: lead=Cliente, deal=Pedido, won=Pago, lost=Cancelado)

---

## Anti-patterns proibidos

1. String que deveria ser FK (ex: `owner_email text` em vez de `owner_user_id uuid`)
2. Duplicação sem source of truth declarado
3. Evento sem consumer (emite e ninguém escuta)
4. FK ausente que vira inferência por nome
5. Campo sincronizado por cron quando devia ser realtime/trigger
6. `jsonb` lock-in (UI lê path direto sem schema central)
7. Cascade fantasma (deletar contact cascade em messages perde histórico)
8. Polimórfico sem padronização (`target_kind` cada lugar grava diferente)
9. **Trigger Postgres faz HTTP** (letal — espera rede dentro da transação)
10. Service role usado em request handler sem filtrar `organization_id` manualmente
11. `getSession()` no backend
12. API key em query string
13. Bearer plaintext armazenado no DB (deve ser hash SHA256)
14. `console.log` deixado em código merged (use logger estruturado ou Sentry breadcrumb)
15. Código novo do CRM lendo **payload cru de provedor** (WAHA/uazapi/Meta) em vez do envelope do gateway
16. Supor o gateway na mesma máquina/rede/deploy (`localhost`, nome de serviço de compose, "sobe junto")
17. Dado de cobrança (plano, assinatura, pagamento, cartão) modelado neste repo — o dono é o Cotador
18. Mudança destrutiva de schema sem caminho de volta (renomear coluna, dropar coluna em uso) — instância única não tem versão de escape

---

## Paths importantes

| Path | Conteúdo |
|---|---|
| `docs/prd/00-prd-master.md` | Visão geral, escopo MVP, KPIs |
| `docs/prd/01-prd-platform-base.md` | Auth, tenancy, RBAC, LGPD framework |
| `docs/prd/02-...06-` | Customer 360, WhatsApp, Pipeline, IA-RAG, Nuvemshop |
| `docs/specs/` | Specs técnicas detalhadas (schema SQL, payloads exatos) |
| `docs/business-rules/` | Regras de negócio fora do código |
| `docs/research/reference-synthesis.md` | Arquitetura herdada do curso WAHA |
| `tasks/todo.md` | Workflow de construção atual |
| `lib/api/wrappers.ts` | `ok()`, `fail()`, tipos `ApiSuccess<T>` / `ApiError` |
| `lib/api/errors.ts` | Códigos de erro canônicos |
| `lib/env.ts` | Validação Zod das env vars (lança no startup se faltar crítica) |
| `lib/supabase/{browser,server,admin}.ts` | Clients canônicos |
| `app/api/v1/health/route.ts` | Health check (Supabase + Redis + WAHA) |
| `supabase/migrations/` | Schema versionado |
| `docs/runbooks/deploy.md` | **Deploy em produção — leia ANTES de mexer na instância** |
| `/root/PROJETOS/gateway_go` | Gateway multicanal (repo irmão, deploy separado) |
| `specs/001-migracao-waha-uazapi/` | Spec viva: ingestão unificada pelo gateway |

---

## Deploy em produção (NÃO NEGOCIÁVEL)

**O alvo do deploy é a NOSSA instalação — uma só.** Não existe VPS de cliente, não
existe clone rodando versão anterior. Duas consequências que mandam no dia a dia:
bug em produção é bug de todo mundo ao mesmo tempo (e o fix também), e **não há
versão de escape** — mudança destrutiva de schema roda no único banco que existe.

**O gateway NÃO entra neste deploy** (Princípio XIV): `gateway_go` é serviço único,
compartilhado, sem réplica, com ciclo próprio. Nada de `localhost` nem nome de
serviço de compose para alcançá-lo — o endereço é configuração.

**Na máquina de produção (proxy reverso próprio), todo `up -d` leva os DOIS arquivos
de compose:**

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app
```

Omitir `-f docker-compose.traefik.yml` recria o contêiner sem as labels de
roteamento; o Traefik da hospedagem deixa de enxergá-lo e **o domínio inteiro
responde `404 page not found`** — com o contêiner `healthy`, porque o
healthcheck é um probe TCP interno e não sabe nada de roteamento.

Depois de qualquer deploy, confirme que o domínio responde **307** (redireciona
pro login) e não 404. Verificações e o caso de build local em
`docs/runbooks/deploy.md`.

O caminho normal **não constrói nada na máquina de produção**: commit → push → PR →
merge na `main` → o CI publica no GHCR → a máquina puxa. Imagem construída lá é
exceção de emergência e é dívida: existe só naquele disco e qualquer `up -d` sem
`APP_PULL_POLICY=never` a substitui em silêncio.

**Expand/contract é obrigatório em mudança destrutiva.** Coluna nova em vez de
renomeada, leitura tolerante aos dois formatos, remoção só depois de a escrita nova
estar em produção. Com instância única, `ALTER` direto "que já está testado" é uma
janela em que produção fica pela metade e não tem para onde voltar.

---

## Como rodar local

```bash
nvm use                    # node 22
npm install
cp .env.example .env.local  # preencher
docker compose up -d        # WAHA local
npm run dev                 # http://localhost:3000
```

Ver `README.md` pra detalhes de setup.

---

## Testes

```bash
pnpm typecheck   # tsc --noEmit (estrito)
pnpm lint        # eslint next/core-web-vitals
pnpm test:unit   # Vitest (NÃO inclui tests/invariants/** — ver abaixo)
pnpm test:db     # Postgres efêmero + baseline install/update + 364 invariantes
pnpm test:e2e    # Playwright (requer dev server)
```

**Os invariantes não estão no `test:unit`.** `vitest.config.ts` exclui `tests/invariants/**` de propósito: essa suíte precisa de um Postgres real e roda via `vitest.db.config.ts`, orquestrada por `scripts/test-db.sh`. Rodar só `pnpm test:unit` e concluir "está tudo verde" é um falso verde — o isolamento RLS não foi exercitado.

Checks **obrigatórios** na branch protection da `main` (verificado na configuração, não só no papel):

- **`verify`** (`ci.yml`) — typecheck + lint + test:unit.
- **`invariants`** (`ci.yml`) — `pnpm test:db`: sobe `pgvector/pgvector:pg17`, aplica `supabase/baseline.sql` em modo install (`ON_ERROR_STOP=1`) e update (idempotência), e roda os testes de invariante, incluindo o de isolamento RLS entre 2 organizações.
- **`build-and-size`** (`perf.yml`) — `pnpm build` em Node 22.

Check **não-obrigatório** (roda, mas não segura merge):

- **`e2e`** (`e2e.yml`) — sobe Supabase local, aplica o `baseline.sql` e roda **28 das 32 specs** Playwright. As 4 de fora: `followup-journey` e `webhooks` (precisam de WAHA), `vps-fresh-onboarding` (WAHA + Redis + Resend + Nuvemshop — é a P0 da doutrina de QA Visual) e `capacidades-do-agente`, que está fora porque **reprova de verdade**: ligar o pacote "Atender" enche o teto de 20 capacidades e a UI desabilita o checkbox da capacidade crítica que o próprio desenho manda marcar à mão. O `e2e` **ainda não é obrigatório** — o conjunto de specs mudou em 2026-08-05, então as execuções verdes anteriores eram de outro conjunto e não servem de prova de estabilidade deste (issue #63).

Ao mexer em schema, RLS, RBAC, atribuição, escopo, roteamento, follow-up, webhooks ou automações: rode `pnpm test:db` **localmente** antes de abrir PR. É o único caminho que exercita o `baseline.sql` — que é o que sobe ambiente do zero e o que a nossa instância recebe re-aplicado a cada deploy.

---

## QA Visual com Recursos Reais — DOUTRINA (SaaS de instância única)

**O produto é a experiência de quem se cadastra.** Toda feature nova (ou fix de comportamento visível) DEVE ser provada como um **usuário leigo a usaria de verdade** — pelo frontend, numa **conta recém-criada** — antes de "pronto". Não é opcional; é critério de aceite de toda sessão que toca UI ou fluxo de usuário.

**O que "recurso real" significa (e o que NÃO conta):**
- **Conta.** Prova pela tela, dirigindo o browser (Playwright), logando com conta de teste real. `curl`/chamada de API **não** provam UX — validam o backend, mas não o que o usuário vê, clica e entende. Use curl só como diagnóstico.
- **Banco fresco.** Postgres limpo aplicado do `supabase/baseline.sql` (não das `migrations/` — a cadeia fresh não sobe) + `scripts/bootstrap-owner.ts`. O ambiente do teste = o que uma organização recém-criada tem: sem os seus dados, sem os seus atalhos.
- **"Fresco" = CONTA nova, não INSTALAÇÃO nova.** Os envs agora são nossos e conhecidos; o que falta no teste é o que o **usuário** ainda não fez: canal não conectado, base de conhecimento vazia, agente sem capacidade marcada, nenhum lead, nenhum convite aceito. **Prove o estado vazio** — ele não é caso de borda, é o estado inicial de 100% dos usuários, e é a tela que decide se ele volta. Testar só com banco povoado esconde exatamente esses defeitos.
- **Dependências de verdade.** WAHA/gateway local, Redis local (`redis` + `serverless-redis-http`), cron drain via endpoint.
- **Efeito colateral externo provado com receiver real.** Webhook outbound, envio — suba um receiver HTTP de verdade e prove o que chegou (ou que foi barrado). Mock não estressa o egress real (anti-SSRF, projeção de payload, https em prod).

**Prioridade: primeira impressão acima de tudo.** Onboarding e as primeiras ações (cadastro, conectar canal, primeiro lead, primeiro convite) são a primeira impressão do usuário — bug ali é abandono, e em SaaS o abandono acontece antes de qualquer assinatura. Teste esses caminhos primeiro e com o maior rigor.

**Registro obrigatório (senão o progresso é invisível):**
- Mapa de jornadas vivo em `docs/testing/user-journey-map.md` — casos por jornada, prioridade (`[P0]` primeira impressão), e achados. Atualize quando adicionar cobertura ou achar bug.
- Specs em `tests/e2e/*.spec.ts` que dirigem o **frontend** (não só API). Evidência visual (screenshot/trace) em `.superpowers/evidence/`.
- Bug achado executando → **conserta na causa raiz**, com migration versionada se tocar schema (ver doutrina abaixo), commit próprio, e re-teste verde como prova.

**Medidas de front-end por ferramenta, nunca a olho** (`getBoundingClientRect`/`getComputedStyle` no Playwright). Ver `feedback_protocolo_execucao_visivel` na memória.

**Receita de ambiente fresco (não-óbvia):** banco = `baseline.sql` num Supabase local **pg17** (`config.toml major_version = 17`; o baseline usa `GRANT MAINTAIN`, privilégio pg17+); `next build` + `next start` (produção — `next dev` compila lento demais e o Turbopack quebra `cookies()`); **worktree com `node_modules` real, nunca symlink** (Turbopack rejeita symlink "out of filesystem root") e **fora de `/tmp`** (é limpo no meio da sessão — commite cada marco). Detalhes em [[project_invite_e2e_and_bugs]].

---

## Higiene de branches — DOUTRINA (NÃO NEGOCIÁVEL)

**`main` é produção e é a fonte da verdade. Toda branch começa e se mantém atualizada com a `main`.** Trabalho iniciado numa branch atrasada gera conflito e retrabalho — é a causa número um de "cagada" em ambiente multi-sessão. Regra:

1. **ANTES de começar QUALQUER trabalho numa branch, atualize-a com a `main`:** `git fetch origin && git merge origin/main` (traz produção pra dentro). Se a branch ainda não tem commits próprios, é fast-forward puro (`git merge --ff-only origin/main`). Não codar antes disso.
2. **NUNCA `reset --hard`/force pra "atualizar"** — apaga trabalho. Só dois caminhos: **fast-forward** (branch sem commits próprios) ou **merge da `main` pra dentro** (preserva os dois lados). `main` nunca é reescrita.
3. **NUNCA toque numa branch/worktree com working tree sujo que não é seu.** Antes de atualizar qualquer branch, cheque `git status` e `git worktree list` — se está suja e é de outra sessão, **deixe quieto** e avise. Merge só entra em árvore limpa.
4. **Quando uma feature entra na `main`, todas as outras branches ficam atrasadas na hora.** Quem for retomar qualquer uma delas aplica a regra 1 primeiro. Ao fim de uma feature, considere propagar a `main` para as branches vivas limpas (FF as sem trabalho próprio; merge nas divergentes limpas; pular as sujas/conflitantes e reportar).
5. **Conflito ao atualizar = pare e resolva com cabeça** (ou escale), nunca escolha um lado no automático numa branch que não é sua. Preservar trabalho > branch "verde rápido".

---

## Migrations & Banco — DOUTRINA (instância única)

**Toda mudança de schema DEVE sair como migration versionada.** **Nunca** aplique `ALTER`/`CREATE` solto no banco sem o arquivo correspondente. Isto é critério de aceite de TODA sessão, não opcional.

Até a v1.3.0 da constituição o motivo era o clone. Não há mais clone — e os três artefatos (migration + apêndice no baseline + MANIFEST) continuam obrigatórios por motivos que o SaaS **agrava**: (1) **não há versão de escape** — existe UM banco de produção, e `ALTER` solto não tem clone antigo de rede nem histórico para reconstruir o que rodou; (2) o `baseline.sql` é o que **sobe ambiente do zero** e o que `scripts/test-db.sh` aplica no job `invariants`, obrigatório na branch protection; (3) migration idempotente é o que torna re-deploy seguro — numa instância única, migration que só roda uma vez é uma janela com produção pela metade. Mudança destrutiva exige **caminho de volta declarado** (expand/contract).

Processo padrão (siga sempre):

1. **Arquivo versionado** em `supabase/migrations/` com o padrão do repo: `<timestamp>_<NNNN>_<slug>.sql` (ex.: `20260706210000_0027_whatsapp_conversation_unification.sql`). `NNNN` é o próximo número sequencial (veja o último em `ls supabase/migrations/`).
2. **Idempotente sempre que possível**: `add column if not exists`, `create ... if not exists`, `create or replace function`. Uma migration deve poder ser re-aplicada sem quebrar nem duplicar efeito.
3. **Portável em `psql` puro** (o `baseline.sql` é aplicado por `psql` no CI e no ambiente fresco, sem MCP/CLI Supabase): **sem** `create temporary table ... on commit drop` fora de transação explícita; **sem** `BEGIN`/`COMMIT` explícito (o runner já envolve em transação, como as demais migrations). Prefira CTEs, subqueries de janela e colunas-mapa (ex.: `is_merged_into`) a temp tables.
4. **Data migrations genéricas**: se a migration corrige/deduplica dados, escreva pensando em QUALQUER estado do banco — **nunca hardcode IDs de organização** (o banco é compartilhado por todos os tenants; ID fixo conserta um e ignora os outros). Repointe FKs conferindo o catálogo (`information_schema` FK map) para não perder histórico.
5. **Registre no MANIFEST**: adicione uma linha em `supabase/migrations/MANIFEST.md` (tabela "Applied") descrevendo versão, nome e o QUÊ/PORQUÊ.
6. **Reflita no `supabase/baseline.sql` (OBRIGATÓRIO — é o que sobe ambiente do zero e o que o gate `invariants` aplica).** O baseline é um dump `--schema-only` + um **apêndice idempotente** no fim do arquivo (blocos rotulados `-- ---- <coisa> (migration NNNN) ----`). `scripts/test-db.sh` aplica **só o baseline.sql**, em modo install (banco novo, `ON_ERROR_STOP=1`) **e** update (re-aplica em banco existente, **sem** `ON_ERROR_STOP`) — os dois têm que passar. Então toda mudança de schema pós-snapshot DEVE ser acrescentada ao apêndice, **idempotente e auto-curativa**: `add column if not exists`, `create ... if not exists`, `create or replace function`, e — se a mudança adiciona constraint — **deduplicar/corrigir os dados ANTES** de criar a constraint (senão a re-aplicação num banco com dado sujo quebra). Sem isto, o ambiente fresco não recebe a mudança e o gate reprova.
7. **Aplique e prove**: aplique via `supabase db push` (⚠️ **não** pelo MCP autenticado do Supabase — ele aponta para o banco de produção do **Cotador**, não para o do CRM), capture o estado ANTES/DEPOIS e prove invariantes (ex.: contagem de linhas que não pode mudar). Se mexeu em contrato, regenere `lib/database.types.ts`. Valide o baseline num Postgres descartável (`pgvector/pgvector:pg17` + extensões) aplicando `install` (fresh, `ON_ERROR_STOP=1`) e `update` (re-aplicar, sem a flag) — ambos têm que passar. É o que `pnpm test:db` faz.
8. **Backfill de dados quebrados existentes**: constraint nova falha se os dados atuais a violam — a migration (e o apêndice do baseline) deve deduplicar/corrigir ANTES de criar a constraint.
9. **Função nova em `public` nasce EXPOSTA — revogue as DUAS origens.** Toda `create function` no schema `public` termina com:

   ```sql
   revoke execute on function public.fn_x(...) from public, anon;
   grant  execute on function public.fn_x(...) to <só quem precisa>;
   ```

   São duas origens distintas de `EXECUTE`, e tratar só uma deixa a função exposta com o gate verde: **(A)** o grant direto a `anon` do `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon` do baseline, que vale para toda função criada depois dele — isto é, para todo apêndice novo — e que `revoke from public` **não** remove; **(B)** o grant a `PUBLIC` que o Postgres dá a qualquer função ao criá-la, que `revoke from anon` **não** remove. Sem os dois, o PostgREST expõe a função como RPC alcançável pela anon key, que vai para o browser. Vigiado por `tests/invariants/hardening-definer-varredura.test.ts`, que varre todas as `security definer` de `public` (issue #128 — a versão anterior checava uma lista fixa de 6, e 8 de 25 estavam expostas).

**Resumo do fluxo de uma mudança de schema:** arquivo em `migrations/` (fonte da verdade p/ Supabase CLI) **+** apêndice idempotente no `baseline.sql` (p/ ambiente fresco e p/ o gate `invariants`) **+** linha no MANIFEST. Os dois artefatos de schema andam juntos. Nunca edite migrations já aplicadas — corrija com uma "forward-fix" nova (e mais um apêndice no baseline).

---

## Skills relevantes a usar (Claude Code)

- `superpowers:brainstorming` — antes de implementar feature não-trivial
- `superpowers:writing-plans` — pra task com mais de 1 etapa de DB/API
- `superpowers:test-driven-development` — feature crítica (LGPD, RLS, anti-banimento)
- `superpowers:systematic-debugging` — bugs reportados
- `superpowers:verification-before-completion` — antes de declarar "pronto"
- `tomik-db-doctrine` — referência cruzada de doutrina de schema
- `supabase:supabase` — qualquer task com Supabase
- `vercel:nextjs` — App Router, Server Components, edge runtime
- `vercel:ai-gateway` — config de fallback de provider
- `frontend-design` — UI distinta (não cair em shadcn-default genérico)

---

## Definition of Done

Antes de declarar uma task pronta:

1. `npm run typecheck` passa zerado
2. `npm run lint` zerado
3. Testes unit/e2e relevantes existem e passam
4. RLS testada se feature toca tabela tenant-aware
5. Audit log emitido se há mutação relevante
6. Rate limit aplicado se rota é pública
7. Zod valida todo input externo
8. Sem `console.log` esquecido
9. Env vars novas adicionadas em `.env.example` + `lib/env.ts`
10. Doc atualizada se mudou contrato (PRD/spec)
11. **Mudança de schema saiu como migration versionada + apêndice no `baseline.sql` + linha no MANIFEST** (ver Doutrina de Migrations), e **destrutiva tem caminho de volta declarado** (expand/contract) — instância única não tem versão de escape
12. **Se tocou UI/fluxo de usuário: provado pela tela como um leigo faria**, numa **conta nova** e **no estado vazio** (sem canal, sem conhecimento, sem lead), com evidência visual (ver Doutrina de QA Visual com Recursos Reais) — curl não conta
13. **Living System Checklist respondido** (ver `docs/doctrine/sistema-vivo.md`) — a feature não é ilha: tem entrada + saída, emite atividade/log, aparece na tela, tem mecanismo anti-morte, e o mapa vivo (`docs/architecture/`) reflete peça nova com ≥2 arestas
14. **Tela nova tem porta** — declarada em `lib/navigation/registry.ts` com seu grupo, ou na allowlist de `tests/unit/navegacao-completude.test.ts` **com justificativa escrita**. Ter tela e ser alcançável são coisas diferentes: o CI reprova tela que existe mas em que só se chega digitando a URL

Um staff engineer aprovaria? Se não, itera.
