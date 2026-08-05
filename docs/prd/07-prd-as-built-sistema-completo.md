---
type: prd
scope: as-built (sistema completo)
project: DeskcommCRM
version_do_produto: 1.1.0 (CHANGELOG, 2026-07-30)
audited_against: main @ 1c7d808 (2026-08-04)
status: draft
generated_by: análise estática read-only do repositório (Claude Code) — nenhum código alterado, nenhum teste executado, nenhum banco conectado
confidence: alta para inventário (contagens e nomes medidos com comandos); média para semântica de módulo (lida de código + comentários + docs)
---

# PRD As-Built — DeskcommCRM

> **O que este documento é.** Um PRD *reverso*: descreve o produto **como ele existe hoje no
> código**, não como foi planejado. Os PRDs `00`–`06` descrevem **intenção** por domínio; este
> descreve o **sistema inteiro entregue**, com o catálogo completo de funcionalidades, o modelo
> de dados, a superfície de API/telas, todas as opções configuráveis, e as opções de evolução
> em aberto com seus trade-offs.
>
> **Precedência:** este arquivo fica **abaixo** de `CLAUDE.md` e `docs/specs/` na regra de
> precedência de `docs/index.md`. Onde divergir de uma spec, a spec vence e este arquivo
> está desatualizado.
>
> **Método e limites.** Tudo marcado **[M]** foi *medido* nesta análise (comando shell ou leitura
> direta do arquivo). Tudo marcado **[I]** é *inferido* de nome de arquivo, comentário de código
> ou doc do repo. Tudo marcado **[R]** é *relatado* por outro documento (HANDOFF, current-state)
> e não re-verificado. Nada aqui foi provado por execução: não rodei testes, não subi o app, não
> abri conexão com banco.

---

## 1. Sumário executivo

**DeskcommCRM é um sistema operacional de vendas open-source (MIT), self-hosted, multi-tenant,
com agentes de IA nativos operando o CRM sobre WhatsApp.**

O que o diferencia de um CRM com bot acoplado é que o agente de IA é **operador de primeira
classe**: ele é `assignee` de conversa com as mesmas regras de governança de um humano, move
cards no funil, aplica tags, agenda follow-ups, abre casos para humanos decidirem, consulta uma
base de conhecimento por tenant (RAG) e opera o CRM através de um servidor **MCP** interno com
16 tools. A autonomia é limitada por guardrails auditáveis (janela de mensageria, promessas,
jailbreak, LGPD, orçamento por organização) e por gate humano nas decisões que importam.

**Modelo de negócio:** não há SaaS nem versão paga. Monetização é por infraestrutura — parceria
HostGator, VPS em São Paulo, instalação com um comando. O caminho genérico (`docker compose`
em qualquer VPS) nunca é sabotado. Ver `VISION.md`.

### Tamanho do sistema — [M] medido em `main @ 1c7d808`

| Métrica | Valor |
|---|---|
| Arquivos TS/TSX em `app` + `lib` + `components` + `workers` | **1.062** |
| Telas (`app/**/page.tsx`) | **86** |
| Route handlers (`app/api/**/route.ts`) | **179** |
| Server Actions (arquivos com `"use server"`) | 29 |
| Componentes React (`components/**/*.tsx`) | 149 |
| Hooks | 43 |
| Tabelas no schema `public` (aplicadas pelo `baseline.sql`) | **96** (+ `private.app_secrets`) |
| Migrations versionadas | 93 arquivos, até `0099_contacts_avatar` |
| Objetos no `baseline.sql` | 45 funções · **112 policies RLS** · 51 triggers · 186 índices |
| Arquivos de teste (`*.test.ts(x)`) | **284** (112 em `tests/unit`, 78 colocados em `lib/`, 62 invariantes de banco, resto espalhado) |
| Specs E2E Playwright | 22 (+ 5 em `tests/journeys/`) |
| Documentos `.md` em `docs/` | 135 |
| Workers `event_log` | 19 arquivos em `workers/` |
| Rotas de cron | 11 |
| Tools MCP expostas | 16 |

---

## 2. Personas e papéis

### 2.1 Papéis dentro do tenant — [M] `lib/auth/types.ts`, `lib/navigation/registry.ts`

Hierarquia por `ROLE_RANK`, escalar e comparável: `viewer` (1) < `agent` (2) < `manager` (3) < `admin` (4).

| Papel | Persona real | O que alcança (pela navegação) |
|---|---|---|
| `viewer` | Sócio, observador, auditor interno | Inbox, Radar, Respostas rápidas, Kanban, Contatos, Desempenho, Alertas de IA, Propostas, Perfil, Segurança, Notificações, Equipe |
| `agent` | Atendente | Tudo do viewer + Casos de IA |
| `manager` | Supervisor de atendimento | Tudo do agent + Funis, Agentes, Follow-ups, Roteadores, Credenciais, Conhecimento, Memória, Skills, Uso e orçamento, Webhooks, Evolução da IA, Audit Log |
| `admin` | Dono da instalação | Tudo + Conexões, Nuvemshop, Organização, Billing, LGPD, API Tokens. **MFA TOTP obrigatório** |

### 2.2 Papel transversal de plataforma

`is_platform_admin` (tabela `platform_admins`) — **não** é um quinto papel de tenant; é uma role
que atravessa organizações. Dá acesso à área `/admin`: gestão de tenants, suspensão, impersonate,
uso agregado, inbox e audit cross-tenant, incidentes, LGPD de plataforma. MFA obrigatório. [M]

### 2.3 Persona não-humana

**Agente de IA** — é `assignee` de conversa de primeira classe (`conversations.assignee_kind`
distingue `user` de `agent`, migration `0032`). Todas as transições de atribuição dele são
auditadas em `conversation_assignment_events` da mesma forma que as de um humano. [M]

---

## 3. Arquitetura

### 3.1 Stack — [M] `package.json`

| Camada | Escolha |
|---|---|
| Frontend | Next.js **16.2** App Router + React **19.2** + TypeScript **6** estrito |
| Estilo | Tailwind 3.4 + shadcn/ui (`new-york`, neutral) + Phosphor Icons + `next-themes` |
| Estado de servidor | TanStack Query 5 + Supabase Realtime |
| Backend | Route Handlers no mesmo repo + Server Actions |
| DB | Supabase / Postgres 17 + `pgvector` + RLS |
| Auth | Supabase Auth via `@supabase/ssr` |
| Storage | Supabase Storage (bucket privado `whatsapp-media`, URLs assinadas) |
| WhatsApp | WAHA Plus (engine NOWEB) **+** Meta Cloud API oficial (adapter próprio) |
| Filas | Tabela `event_log` + `job_queue` + workers acionados por cron |
| Rate limit | Upstash Redis (via `serverless-redis-http` no self-host) |
| IA | Vercel AI SDK v7, providers Anthropic / OpenAI / Google v4, via AI Gateway ou chave direta |
| Validação | Zod 4 em todo input externo |
| Observabilidade | Sentry 10 com `beforeSend` sanitizado (`lib/sentry/scrub.ts`) |
| PDF | `@react-pdf/renderer` (exports LGPD assinados PAdES) |
| Fluxo visual | `@xyflow/react` (editor de follow-up), `@hello-pangea/dnd` (kanban) |

### 3.2 Topologias de deploy suportadas — [M]

| Opção | Composição | Para quem |
|---|---|---|
| **A. VPS 1-comando (recomendada)** | `hostgator-setup-kit/install.sh` sobe `app` + `worker` + `waha` + `redis` + `srh` + `scheduler` + `caddy` (HTTPS automático) via `docker-compose.prod.yml`, aplica `baseline.sql`, gera segredos, cria o owner | Dono de PME que comprou VPS |
| **B. Self-host genérico** | Mesmo compose em qualquer VPS/Docker (`docs/deploy-selfhost/`) | Comunidade dev |
| **C. Vercel + VPS só pro WAHA** | App na Vercel (crons gerenciados), WAHA em VPS dedicada | Quem já vive na Vercel |
| **D. Dev local** | `pnpm dev` + `docker compose up -d` (só WAHA + worker) | Contribuidor |

**Nota crítica de instalação** [M]: o schema **não** sobe pela cadeia de migrations — as
migrations `0001`–`0009` e `0013` são stubs `SELECT 1;`. A fonte aplicável é
`supabase/baseline.sql` (8.775 linhas: dump `--schema-only` + apêndice idempotente auto-curativo).
`supabase db push` "passa" e deixa o banco vazio. Está documentado no README, mas é a maior
armadilha de primeira instalação do projeto.

### 3.3 Princípios arquiteturais aplicados

1. **Trigger Postgres nunca faz HTTP.** Trigger emite linha em `event_log`; worker consome e
   dispara efeito. É anti-pattern #9 da doutrina, e o schema respeita (todos os `trg_*_emit_*`
   escrevem em `event_log`). [M]
2. **Versão + ponteiro** para tudo que é publicável: agentes, conhecimento, playbooks,
   follow-up flows, skills, memória da org, templates de disclosure, tabela de promessas,
   knobs de reentrada. Cada par é `<coisa>_versions` + `<coisa>_pointers`, com imutabilidade de
   versão publicada garantida por migration (`0051`). Publicar é trocar ponteiro. [M]
3. **RLS em toda tabela tenant-aware**, via helper `fn_user_org_ids()`. Service role bypassa —
   handlers que usam admin client filtram `organization_id` manualmente, resolvido de fonte
   confiável (cookie/JWT/webhook secret/path token), nunca do body.
4. **Registro único de navegação** (`lib/navigation/registry.ts`): sidebar, hubs e paleta ⌘K são
   projeções puras de um array. Tela sem porta reprova no CI.
5. **Fractional indexing** (`position_in_stage numeric` + `midpoint()`) no kanban — nunca `int`.
6. **Vocabulário aberto vive no TypeScript**, vocabulário fechado vira CHECK no banco, e um
   invariante compara os dois lados (`tests/invariants/vocabulario-banco-x-typescript.test.ts`).

### 3.4 Stack por feature

A tabela da §3.1 lista o que o projeto usa. Esta seção responde uma pergunta diferente e mais
útil na hora de mexer no código: **qual tecnologia cada feature realmente usa.** Não é uniforme —
e a assimetria mais importante não aparece no `package.json`.

#### 3.4.1 Dois runtimes, dois acessos a banco — [M]

| Runtime | Como fala com o Postgres | Isolamento de tenant | Onde vive |
|---|---|---|---|
| **App Next.js** (telas, Server Actions, REST) | Supabase client — `lib/supabase/server` (144 arquivos), `admin` (170), `browser` (6) | RLS via `fn_user_org_ids()`; com service role, filtro manual de `organization_id` | `app/`, maior parte de `lib/` |
| **agent-engine** (motor de IA, follow-up, guardrails) | **`pg.Pool` direto** (`pg` importado em 57 arquivos) | **Não passa por RLS** — o `tenantId` entra como parâmetro do SQL em cada query | `lib/agent-engine/`, `lib/followup/`, `workers/agent-worker/` |

Consequência prática, e é a mais relevante deste PRD para quem for contribuir: **a rede de
segurança do multi-tenant é diferente nos dois lados.** No app, esquecer o filtro ainda deixa a
RLS trabalhar (a menos que o handler use service role). No agent-engine, esquecer o `tenantId`
numa query não tem segunda camada — só os invariantes de banco pegam. É a razão pela qual os 62
arquivos de `tests/invariants/` são o gate que mais importa neste repositório.

#### 3.4.2 Dois padrões de mutação — [M]

- **Server Actions** — 29 arquivos, concentrados em configuração e conta: `actions/auth` (9),
  `actions/settings` (6), `actions/onboarding` (5), `actions/shell` (2), `actions/integrations` (2),
  `actions/team`, mais credenciais e agentes de IA.
- **REST `/api/v1/`** — 179 handlers, tudo que é operacional: conversas, leads, mensagens, IA,
  crons, webhooks. É o que também serve integração server-to-server por bearer token.

Regra observada [I]: **o que um sistema externo precisa chamar vira REST; o que só a própria tela
faz pode ser Server Action.**

#### 3.4.3 Transversal a todas as features

Zod (111 arquivos) · TanStack Query · shadcn/ui + Radix + Tailwind + Phosphor Icons ·
`date-fns` · `sonner` (toasts) · `next-themes` · logger estruturado.

#### 3.4.4 A stack de cada feature

| Feature | Frontend específico | Backend / runtime | Dados | Externo |
|---|---|---|---|---|
| **Auth · MFA · convites** | `react-hook-form` + Zod | **Server Actions** + `@supabase/ssr` | Supabase Auth, `user_recovery_codes`, HMAC no token de convite | `qrcode` (QR do TOTP), **Resend** |
| **Inbox** | Realtime `postgres_changes`, `react-hotkeys-hook`, `@emoji-mart` no composer | Route Handlers REST | `conversations`, `messages`, `conversation_notes` | WAHA **ou** Meta Cloud API |
| **Kanban · funil** | `@hello-pangea/dnd`, Realtime, `react-hook-form` | REST | `position_in_stage numeric` + `midpoint()` | — |
| **Radar · score de lead** | TanStack Query | **Fórmula TypeScript pura** (`lib/leads/score-formula.ts`) — deliberadamente não é chamada de modelo | `crm_lead_scores`, `crm_lead_risk_states` | cron `risk-watcher` (15 min) |
| **Contatos · 360** | Realtime na timeline | REST | `contacts`, `orders` | Nuvemshop OAuth (segredo AES no banco) |
| **Agentes de IA (runtime)** | — | **Vercel AI SDK `ai` v7** (13 arquivos) + `@ai-sdk/anthropic\|google\|openai` v4 · executa sobre **`pg.Pool`** | `ai_agents` + `ai_agent_versions` | Anthropic / OpenAI / Google / OpenRouter via AI Gateway |
| **RAG · conhecimento** | upload pela tela | `pdfjs-dist` extrai PDF · chunker próprio · `retrieve_top_k_chunks` (**pgvector**) | `ai_chunks` com embedding | Supabase **Storage** · **Upstash Redis** (debounce de reindexação) |
| **Follow-up** | **`@xyflow/react`** (editor de grafo) | `pg.Pool` · claim atômico via `fn_claim_due_followup_enrollments` | `followup_flow_versions`/`_pointers`, `followup_enrollments` | cron 1 min |
| **Skills** | — | **`fflate`** descompacta o `.zip` do pacote | `skill_versions`/`_pointers`/`_activations` | Supabase Storage (`references/`, `assets/`) |
| **MCP** | — | **`@modelcontextprotocol/sdk`** em `/api/mcp` + `lib/mcp/server.ts` | 16 tools sobre as tabelas do CRM | hoje só consumo interno |
| **Automação · webhooks** | TanStack Query (3 abas) | `event_log` → cron `event-log-drain` · guard anti-SSRF no egress | `automation_rules`, `automation_rule_runs`, `webhook_sources` | HTTP de saída para o sistema do tenant |
| **LGPD** | — | **`@react-pdf/renderer`** + assinador **PAdES** · workers de export e redact | `lgpd_requests`, `storage_redaction_queue` | Storage (remoção de mídia), Resend; feriados BR em código |
| **Métricas · evolução da IA** | **`recharts`** | RPC `fn_attendant_metrics` | `metrics`, `llm_calls` | — |
| **Admin de plataforma** | `recharts` | cookie assinado de impersonate (`IMPERSONATE_COOKIE_SECRET`) | `platform_admins`, `incidents` | — |
| **Auto-atualização** | TanStack Query (polling do run) | máquina de estado em TS + `agent.sh` na VPS | `system_update_runs`, `system_version` | Docker / compose na VPS |
| **Contador de token** | **`gpt-tokenizer`** (`lib/ui/TokenCounter.tsx`) | — | — | — |
| **Observabilidade** | — | **`@sentry/nextjs`** + `beforeSend` com scrub | — | Sentry |

#### 3.4.5 ⚠️ Dependências declaradas e não usadas — [M]

| Pacote | Situação |
|---|---|
| `@tanstack/react-virtual` | **Zero referências** em `app`, `lib`, `components`, `hooks`, `workers`, `scripts`, `tests`. Nenhuma lista do produto é virtualizada |
| `pdf-parse` | Zero imports diretos — a extração de PDF usa `pdfjs-dist`. As 15 ocorrências são `@types/pdf-parse` e menções em comentário |

Nenhum dos dois quebra nada. Custam peso de bundle e superfície de supply chain sem
contrapartida. O caso do `react-virtual` importa por um segundo motivo: sua presença no
`package.json` fez a versão anterior deste documento afirmar que o inbox era virtualizado — não é.

---

## 4. Mapa funcional completo

Treze módulos. Para cada um: o que faz, onde vive, e o que é configurável.

### M1 — Plataforma, identidade e governança de acesso

**Telas** [M]: `/login`, `/login/mfa`, `/login/forgot`, `/login/recovery`, `/login/reset`,
`/signup`, `/team`, `/team/invite`, `/team/accept-invite/[token]`, `/app/settings/profile`,
`/app/settings/security`, `/app/settings/notifications`, `/app/settings/tenant`, `/app/audit`,
`/403`, `/500`, `/503`, `/account-suspended`.

**Funcionalidades**
- Signup com criação de organização e provisionamento do owner (`lib/auth/provision.ts`).
- Login por senha; **MFA TOTP obrigatório para `admin` e platform admin**; códigos de recuperação
  de uso único (`user_recovery_codes`).
- Recuperação de senha por e-mail (Resend) com fluxo separado de recuperação por código.
- Convite de equipe por token assinado (`lib/auth/invite-token.ts`), com aceite público
  em `/team/accept-invite/[token]`, expiração e revogação.
- RBAC server-side em toda a API via `requireRole` — 230 arestas no grafo, é convenção aplicada,
  não sugestão. Papel editável por `admin` (`PATCH /api/v1/team/[user_id]/role`), revogação de
  acesso (`/revoke`).
- **Audit log append-only** (`api_audit_log`): toda mutação POST/PATCH/DELETE bem-sucedida gera
  entrada, fire-and-forget. Sem RLS de UPDATE/DELETE. Exportável (`/api/v1/audit/export`).
- Sessões: revogação (`scripts/revoke-sessions.ts`), cookie `SameSite=Strict`, `HttpOnly`.
- Suspensão de conta com tela dedicada e motivo (`organizations.suspend_reason`, migration `0020`).

**Opções configuráveis**: papel por membro · limite de conversas simultâneas por atendente
(`/app/team`) · disponibilidade do atendente (`attendant_availability`, migration `0039`) ·
idioma, fuso e avatar por usuário · nome/logo da instalação (`APP_NAME`, `APP_LOGO_URL` —
white-label) · retenção de dados e encarregado de LGPD por organização.

### M2 — Atendimento (Inbox)

**Telas** [M]: `/app/inbox`, `/app/inbox/[id]`, `/app/radar`, `/app/templates`,
`/admin/inbox` e `/admin/inbox/[conversationId]` (visão de plataforma).

**Funcionalidades**
- Inbox de 3 painéis em tempo real (Supabase Realtime + `postgres_changes`), com contadores
  (`/api/v1/conversations/counts`) e atalhos de teclado (`react-hotkeys-hook`).
- Ciclo de posse da conversa: **claim / release / transfer / close**, cada transição auditada em
  `conversation_assignment_events` (migration `0031`). IA e humano usam o mesmo caminho.
- **Snooze** com watcher que desperta (`0062` + cron `snooze-watcher`).
- **Notas internas** por conversa (`conversation_notes`, `0063`), com CRUD próprio.
- **Tags de conversa** (`conversation_tags`, `0033`).
- Mídia: envio e recepção com persistência no Storage (`media-persist-worker`) e derivação
  (`media-derive-worker` — inclui vídeo via `ffmpeg` embutido na imagem).
- **Rascunho sugerido pela IA** (`/conversations/[id]/draft-reply`) — o agente propõe, o humano
  decide; respeita recusa registrada.
- **Reativar bot** numa conversa que foi para humano (`/reactivate-bot`).
- **Transparência de retenção anti-ban**: quando o sistema segura um envio, a conversa mostra o
  motivo em linguagem humana (`lib/inbox/retention-copy.ts`).
- **Opt-in de RAG por conversa** (`/usable-for-rag`, migration `0015`): decidir se aquela conversa
  pode virar conhecimento.
- **Radar** — leituras de risco: quem esfriou, ainda está aberto e não tem próximo passo.
- **Respostas rápidas** (`message_templates`, `0060`): scripts do atendente, com variáveis
  (`lib/inbox/template-vars.ts`), consumidos pelo composer. Distinto dos templates HSM da Meta.

**Opções configuráveis**: retenção por conversa · elegibilidade para RAG · tags · duração de
snooze · escopo de visualização por papel (`visibility_mode`, migrations `0035`/`0036`).

### M3 — Canais de mensageria

**Telas** [M]: `/app/connections`, `/app/settings/tenant/whatsapp`, `/app/settings/canal-oficial`,
`/onboarding/connect-whatsapp`.

**Dois provedores, um contrato** (`lib/channels/` com `capabilities.ts` + adapters):

| Provedor | Como conecta | Restrições |
|---|---|---|
| **WAHA** (`adapters/waha.ts`) | QR code, multi-número, engine NOWEB | Anti-banimento é responsabilidade do sistema |
| **Meta Cloud API** (`adapters/meta-cloud.ts`) | Credenciais oficiais + templates HSM aprovados | Janela de 24h, template obrigatório fora dela |

**Funcionalidades**
- Sessões multi-número (`channel_sessions`) com QR, reconexão, saúde
  (`channel_session_health`) e watchdog/reconciler no agent-engine.
- **Warm-up** de número novo (`channel_session_warmup`) — 7–14 dias de rampa.
- **Anti-banimento**: throttle + jitter, janela de horário, bloqueio de domingo, ritmo de
  campanha, spinning de copy (`lib/agent-engine/pacing/`, `spinning/`, `channel_knobs`).
- **STOP detection**: regex no inbound marca `is_blocked=true` automaticamente.
- **Grupos**: `chatId` terminando em `@g.us` não faz binding de CRM; o sender é `p.author`.
  Correção recente (`#120`): chatId irreconhecível não é mais silenciosamente tratado como grupo.
- Webhooks WAHA com HMAC SHA512 e `timingSafeEqual`, por token de path (`/webhooks/waha/[token]`).
- **Templates da Meta**: sincronização (`template-sync.ts`), hash de contrato
  (`contract-hash.ts`), binding, renderização e envio com desfecho registrado
  (migration `0088`, tela `/app/settings/canal-oficial`).
- `lint:channels` — script próprio de lint que impede um canal novo de nascer fora do contrato.

**Opções configuráveis** [M] `lib/ai/pacing-knobs.ts`: `throttle_ms`, `jitter_max_ms`,
`window_start_hour`, `window_end_hour`, `allow_sunday` — por sessão de canal, com bounds
validados e default global.

### M4 — CRM e funil

**Telas** [M]: `/app/kanban`, `/app/pipelines/[id]`, `/app/settings/tenant/pipelines`.

**Núcleo (5 tabelas)**: `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`
(timeline polimórfica), `crm_lead_links` (vínculos polimórficos).

**Funcionalidades**
- Kanban com drag-and-drop e **fractional indexing** (`position_in_stage numeric` + `midpoint()`).
- **Vocabulário por pipeline** (`vocabulary jsonb`): lead→Cliente/Paciente/Comprador,
  won→Pago/Agendado/Fechado. É o que torna o mesmo core multi-nicho.
- **Custom fields** declarativos em `pipeline.settings.fields`, com Zod construído dinamicamente.
- Ganhar / perder lead com **motivo de perda obrigatório** (trigger
  `trg_validate_lost_reason_required`).
- Movimentação em massa (`/leads/bulk`), timeline por lead, `crm_lead_activities` com
  vocabulário aberto (deliberadamente sem CHECK — ver doutrina de migrations).
- **Score do lead com evidência obrigatória** (`crm_lead_scores`, migrations `0074`–`0077`): é
  **fórmula, não chamada de modelo**, de propósito — o `reason` é derivado do cálculo, então
  "número sem porquê" é impossível por construção, e um humano pode discordar de *qual parcela*
  está errada. Lê commitments/objections de `lead_checkpoints` e `lead_state.qualification` (BANT).
- **Radar de risco** (`lib/leads/risk-radar.ts`, `crm_lead_risk_states`, migrations `0078`–`0081`): buckets
  `em_dia` / `em_voo` / `em_risco` / `critico`. A janela de esfriamento sai do **estágio**
  (`crm_stages.expected_duration_hours`), não de constante global. Lead com follow-up agendado
  conta como "em voo", não como risco.
- **Próxima ação** (`/leads/[id]/next-action`) e **proposta de reativação com prazo**
  (`crm_lead_reactivations`, migrations `0082`/`0083`).
- **Checkpoints de lead** (`lead_checkpoints`) e **estado do lead** (`lead_state`,
  `lead_state_transitions`).
- Criação e edição de etapas pela tela (`lib/leads/stage-editing.ts`); **não existe caminho de
  criação de funil pela UI** — só de etapas [R, `current-state.md`].

**Opções configuráveis**: vocabulário · etapas e ordem · `expected_duration_hours` por etapa ·
motivos de perda · campos customizados · mapeamento agente↔pipeline
(`/pipelines/[id]/agent-mapping`) · pipeline default.

### M5 — Contatos e Customer 360

**Telas** [M]: `/app/contacts`, `/app/contacts/[id]`, `/app/integrations/nuvemshop`,
`/onboarding/connect-nuvemshop`.

- Contato com `locale` (`0098`) e avatar sincronizado do WhatsApp (`0099` + cron
  `contact-avatars`).
- Timeline unificada (`/contacts/[id]/timeline`) e resumo de CRM (`/crm-summary`).
- Identity resolution **determinística** (por telefone normalizado, `lib/channels/phone-variants.ts`
  — que trata o nono dígito brasileiro). Probabilística está no roadmap, não entregue.
- **Nuvemshop**: OAuth com segredo encriptado no banco (`fn_encrypt_oauth`/`fn_decrypt_oauth`),
  ingestão de pedidos (`orders`) e produtos (`nuvemshop_products`), formatação de produto para
  RAG, e os três webhooks obrigatórios de LGPD da plataforma (`customer-data-request`,
  `customer-redact`, `store-redact`).

### M6 — Inteligência artificial (o núcleo do produto)

**Telas** [M] — 17: `/app/ai` (hub), `/agents`, `/agents/new`, `/agents/[id]`, `/routers`,
`/routers/[id]`, `/followups`, `/followups/[id]`, `/knowledge/sources`, `/memory`, `/skills`,
`/cases`, `/inbox` (alertas), `/proposals`, `/credentials`, `/usage`, `/evolution`.

#### M6.1 Agentes
- Agente = **doc versionado + ponteiro** (`ai_agents`, `ai_agent_versions`). Versão publicada é
  **imutável** (migration `0051`); publicar troca ponteiro via
  `fn_publish_ai_agent_version`. Duplicar, pausar, testar versão antes de publicar.
- **Opções por agente** [M] `lib/ai/agents/validation.ts`:

| Opção | Faixa / default |
|---|---|
| `system_prompt` | 10–20.000 chars |
| `provider` / `model` | Anthropic · OpenAI · Google · OpenRouter |
| `max_steps` | 1–25 (default 10) |
| `token_budget` | 1.000–500.000 (default 50.000) |
| `cost_budget_cents` | 1–10.000 (default 50) |
| `history_message_window` | 0–200 (default 20) |
| `history_token_window` | 0–50.000 (default 8.000) |
| `handoff_tool_enabled` | default `true` |
| `cases_enabled` | default `false` |
| `split_messages` / `split_max_chars` | default `false` / 600 (80–4.000) |
| `concurrency` | `one_per_conversation` (default) · `one_per_contact` |
| Gatilho | `ignore_groups` (true) · `ignore_self` (true) · `keyword_regex` · janela por timezone/dias da semana |

#### M6.2 Conhecimento (RAG)
- Fontes por tenant (`ai_knowledge_sources`), versionadas (`ai_knowledge_versions`), chunking
  próprio, embeddings via provider configurável, busca `retrieve_top_k_chunks` (pgvector) com
  **threshold calibrado** (migration `0097`).
- Extratores: Markdown e PDF. Upload direto pela tela. Reindexação sob demanda.
- Ingestão automática de **conversas resolvidas** (`lib/ai/rag/ingest/conversations.ts` + cron
  `kb-conversations-batch`) — o elo do flywheel — com opt-in por conversa.
- FAQ items (`ai_faq_items`) e política (`ingest/policy.ts`) como fontes de primeira classe.
- Busca registrada em `knowledge_searches` (`0086`) para medir o que o agente procurou e não achou.

#### M6.3 Memória da organização
`org_memory_versions` + `org_memory_pointers` + `org_memory_entries` (`0067`). Resolvida no
início de **cada** run, sem cache de processo — publicar significa "próximo turno já vê". Entra
no **prefixo estável** do prompt (determinístico byte-a-byte, o que preserva cache do provider).
Entradas vêm de duas origens: manual, ou proposta de flywheel aprovada.

#### M6.4 Skills
Pacote `.zip` com `SKILL.md` (frontmatter `name`, `description`, `matcher.any_keywords`) +
`references/` + `assets/`. Import, instalação, ativação por matcher de palavra-chave
(`skill_versions`/`skill_pointers`/`skill_activations`). São as ações que o agente executa sozinho.

#### M6.5 Roteador de intenção
`ai_routers` + `ai_router_members` (`0085`). Máximo **1 router ativo por sessão de canal**
(índice parcial). Classifica a intenção da mensagem e escolhe qual agente atende. Tabela
editável (não versão+ponteiro), auditada por trigger. Leitura defensiva do `config` jsonb:
shape errado cai no default e nunca derruba o turno. Decisões gravadas em `ai_router_decisions`.
Testável pela tela (`/routers/[id]/test`).

#### M6.6 Follow-up inteligente
Editor de **grafo visual** (`@xyflow/react`) versionado (`followup_flow_versions` +
`followup_flow_pointers`, `0054`/`0056`).

Tipos de nó [M] `lib/followup/graph-schema.ts`: `trigger` · `wait` (modo `fixed` ou `smart`) ·
`condition` (campos com operadores `eq`/`neq`/`gte`/`lte`/`contains`, combinador `and`/`or`) ·
`ai_classify` (alvo `last_reply` ou `summary`) · `action` (modo `ai_message` ou `template`) ·
`end` (desfecho `converted` / `exhausted` / `custom`). Arestas: `always` · `class_match` ·
`cond_result`.

Matrículas (`followup_enrollments`) com **exclusividade** garantida no banco (`0064`), claim
atômico de vencidas (`fn_claim_due_followup_enrollments`), eventos por matrícula, estatísticas
de desfecho, cancelamento, publish/rollback/disable de versão, e varredura de silêncio
(`silence-sweep.ts`). Worker próprio: cron `followup-flow-worker`, de minuto em minuto.

#### M6.7 Casos humanos (IA delega ao humano)
`agent_cases` + `agent_case_events` (`0066`, spec 15). Duas tools nativas: `open_human_case`
(agente registra o bloqueio, status `awaiting_human`) e `provide_case_update` (lead respondeu o
que o humano pediu, volta para `awaiting_human`). Toda transição é UPDATE condicional que nunca
pisa em estado terminal, com evento na mesma transação. Tela `/app/ai/cases` + resposta pela API.

#### M6.8 Handoff IA→humano
`lib/ai/handoff/` — gatilhos por regex, por sentimento (`ai-sentiment-worker` +
`ai-handoff-from-sentiment`) e por tool explícita do agente. Orquestrador registra motivo
(`handoff_reason`, migration `0011`).

#### M6.9 Guardrails — [M] `lib/agent-engine/guardrails/`
`before-send` (com traces em `before_send_traces`) · janela de mensageria ·
**motor de promessas** (tabela versionada de promessas + verificação semântica: o agente não
promete o que a operação não cumpre) · **promessa humana** · classificador de **jailbreak** ·
base legal **LGPD** · template de **disclosure** versionado (avisar que é IA).

#### M6.10 Orçamento, custo e uso
`ai_budgets` com trigger de consumo (`fn_update_budget_consumption`, `0022`), contagem por
`llm_calls` (`0095`), preços em `ai_pricing`/`ai_models`, invocações em `ai_invocations`,
agregação em `/app/ai/usage` e `/admin/usage`. Modelo default por organização (`0096`).
Circuit breaker de tool (`tool-breaker.ts`) e de saúde (`health/circuit.ts`).

#### M6.11 Flywheel e evolução
`flywheel_distiller_proposals` + `flywheel_judge_verdicts` + `judge_alignment_pool` +
`golden-candidates/`. Conversas viram propostas de melhoria do próprio agente; um juiz avalia;
o humano aplica como **versão nova** (`/proposals`, `apply-proposal.ts`, migration `0053`).
Painel `/app/ai/evolution` mostra se o agente está melhorando e onde erra.

#### M6.12 Credenciais de IA
`ai_provider_credentials` encriptadas (AES, `AI_CRED_AES_KEY`), view segura
`ai_provider_credentials_safe`, validação por provider (`provider-validators.ts`), revalidação
sob demanda, listagem de modelos disponíveis por provider. Runbook de rotação em `docs/runbooks/`.

### M7 — Automações e webhooks

**Tela** [M]: `/app/webhooks` (3 abas: Receber dados · Automações · Atividade).

- **Fontes de captação** (`webhook_sources`): endereço público
  `/api/v1/webhooks/in/<token>`, aceita JSON e `x-www-form-urlencoded`, entra direto no
  funil/estágio escolhido. Segredo encriptado no banco (`0041`). Log em `webhook_events_log`.
- **Regras QUANDO / SE / ENTÃO** (`automation_rules`, `0038`). Nasce **pausada** até o tenant revisar.
  - Ações [M] `lib/automation/actions/`: `add-tag` · `assign-owner` · `create-or-move-lead` ·
    `send-whatsapp` · `call-webhook` (saída).
  - Condições com combinadores, template de mensagem com variáveis, throttle próprio.
- **Atividade** (`automation_rule_runs`): timeline de cada execução com resultado por ação e
  **reenvio manual** quando a chamada externa falha.
- **Guard anti-SSRF** no egress (`lib/automation/outbound-url.ts` + `agent-engine/edge/egress.ts`),
  com spec E2E dedicada (`vps-webhook-outbound-ssrf.spec.ts`).
- Drenagem: `event_log` → cron `event-log-drain` (a cada minuto). Sem esse cron, eventos empilham
  e nenhuma automação roda — é o modo de falha silenciosa mais comum de uma instalação nova.

### M8 — LGPD

**Telas** [M]: `/app/lgpd/requests`, `/app/lgpd/requests/[id]`, `/admin/lgpd`,
`/admin/lgpd/requests/[id]`.

- `lgpd_requests` com fluxo aprovar → preview → executar.
- **Export**: coletor (`export-collector.ts`) → PDF renderizado (`pdf-renderer.tsx`) →
  **assinado PAdES** (`pades-signer.ts`, `LGPD_SIGNING_KEY`) → link expirável
  (`LGPD_EXPORT_EXPIRES_HOURS`).
- **Redact em cascata** (`fn_lgpd_cascade_redact_contact`, `0019`): contato + conversas +
  mensagens + mídia do storage + activities (preserva timestamps). Nome vira
  `Cliente Anonimizado #N`. Reversão retorna 403 `lgpd_anonymization_irreversible`.
- **Fila de redação de storage** (`storage_redaction_queue`, `0018`) drenada por cron a cada 5 min.
- **SLA**: data_request D+7, redact D+15, com watcher diário (`lgpd-sla-watcher`) que considera
  **feriados brasileiros** (`holidays-br.ts`) e alarma antes de estourar.
- Máscara de dados sensíveis (`mask.ts`), CPF encriptado (`CPF_ENCRYPTION_KEY`), anonimização de
  nomes próprios pt-BR no pipeline de IA (`lib/ai/anonymize/`).
- Actions auditadas obrigatórias: `lgpd.data_request_received`, `lgpd.export_generated`,
  `lgpd.redact_executed`, `lgpd.consent_changed`.

### M9 — Observabilidade e métricas

- `/app/metrics` — funil e performance por atendente nos últimos 30 dias
  (`fn_attendant_metrics`, `0037`), com heartbeat a cada 5 min.
- `/app/audit` — audit log do tenant; `/admin/audit` — cross-tenant.
- **Incidentes** (`incidents`, `0021`): central de avisos com severidade, detalhe e resolução,
  tanto no tenant quanto no admin.
- `/api/v1/health` — Supabase + Redis + WAHA.
- Sentry com scrub: CPF, telefone e e-mail substituídos, headers sensíveis removidos, token de
  webhook/convite redigido da URL. Sem performance e sem replay no DSN da comunidade.
  Desligável com `SENTRY_DSN=off`.
- Métricas internas do agent-engine (`obs/metrics.ts`), logger estruturado
  (zero `console.log` no código merged).

### M10 — Administração de plataforma

**Telas** [M] 19 sob `/admin`: dashboard (KPIs), tenants (lista, detalhe, novo, saúde),
usuários, platform-admins, inbox, audit (lista e detalhe), incidents, lgpd, usage, forbidden.

- Criar tenant, ver saúde por tenant, **suspender / reativar** com motivo.
- **Impersonate** com cookie próprio assinado (`IMPERSONATE_COOKIE_SECRET`), início e fim
  auditados.
- Uso agregado de IA por organização.
- Promoção/remoção de platform admins.

### M11 — API pública e MCP

**REST `/api/v1/`** — 179 handlers [M]. Contrato:
- JSON snake_case, UUID v4, ISO-8601 UTC, dinheiro em `_cents` + `currency`.
- Sucesso `{ data, meta?: { cursor, has_more, total } }`; erro `{ error: { code, message, details? } }`
  via helpers `ok()`/`fail()`.
- Paginação por cursor opaco base64+HMAC.
- Auth dual: cookie de sessão ou `Authorization: Bearer tok_...`. Plaintext do token mostrado
  **uma vez**; no banco só SHA256 (`api_tokens`, tela `/app/settings/api-tokens`, com revogação).
- `X-Request-Id` em toda resposta. `X-RateLimit-*` + `Retry-After` em 429.
- ⚠️ `Idempotency-Key` está implementado em **1 rota**, não em todos os POSTs de criação, apesar
  de a doutrina pedir [R, `current-state.md` §4.6].

**MCP** — `/api/mcp` e `/api/v1/mcp/tools`, 16 tools [M]:

`crm_list_pipelines` · `crm_create_lead` · `crm_get_lead` · `crm_list_leads` · `crm_update_lead` ·
`crm_move_lead_stage` · `crm_get_contact` · `crm_search_contacts` · `crm_get_conversation` ·
`crm_get_conversation_history` · `crm_list_conversations` · `crm_send_whatsapp_message` ·
`crm_assign_conversation` · `crm_manage_tags` · `crm_get_queue_status` ·
`crm_request_human_handoff`.

Hoje é **interno** (consumido pelo agent-engine via `edge/crm/mcp-client.ts`). O contrato de
governança para agentes externos existe como documento (`docs/specs/14`); a exposição pública é
roadmap.

### M12 — Self-host, atualização e marca

- `hostgator-setup-kit/`: `install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `healthcheck.sh`,
  `supabase-provision.sh`, `reset-mfa.sh`, `reset-password.sh`, `agent.sh`, `test-validators.sh`.
- `install.sh` pergunta só o que é do dono (domínio, chaves Supabase, chave de IA, senha de admin),
  valida cada resposta, gera os demais segredos, aplica `baseline.sql`, sobe a stack com HTTPS
  (Caddy) e instala os crons.
- **Atualização pela própria tela** (v1.1.0, migrations `0089`/`0090`/`0093`/`0094`):
  `/app/settings/atualizacao` mostra a versão instalada, o que muda, quanto tempo fica fora do ar,
  faz backup antes, e reporta o desfecho. Máquina de estado estrita [M] `lib/system/update-run.ts`:
  `dispatched` → `success` | `failed` | `failed_rolled_back`; run terminal é imutável (retry do
  agente após reinício é recusado, não reescreve a história); sem notícia em 15 min vira desfecho
  desconhecido. Passos: `backup` → `codigo` → `banco`.
- **White-label** (`docs/white-label.md`): `APP_NAME` + `APP_LOGO_URL`, uma instalação por cliente
  ou compartilhada, com orientação de operação de revenda.
- `CHANGELOG.md` com seção **⚠️ Requer atenção** para mudanças que exigem ação manual antes de
  `update.sh`.

### M13 — Onboarding

**Telas** [M] 7: `/onboarding`, `/welcome`, `/connect-whatsapp`, `/setup-ai`,
`/connect-nuvemshop`, `/invite-team`, `/done`. Estado persistido em
`organizations` (migration `0008`). É o caminho **P0** da doutrina de QA visual — primeira
impressão do usuário que acabou de instalar numa VPS.

---

## 5. Modelo de dados — 96 tabelas

Lista extraída do `supabase/baseline.sql` (o artefato que o self-hoster realmente aplica),
agrupada por domínio [M]:

| Domínio | Tabelas |
|---|---|
| **Tenancy & acesso** (7) | `organizations`, `user_organizations`, `platform_admins`, `api_tokens`, `user_recovery_codes`, `api_audit_log`, `idempotency_keys` |
| **Atendimento** (8) | `conversations`, `messages`, `conversation_notes`, `conversation_assignment_events`, `message_templates`, `attendant_availability`, `send_ledger`, `outbound_copies` |
| **Canais** (7) | `channel_sessions`, `channel_session_health`, `channel_session_warmup`, `channel_knobs`, `meta_templates`, `disclosure_template_versions`, `disclosure_template_pointers` |
| **CRM** (13) | `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities`, `crm_lead_links`, `crm_lead_scores`, `crm_lead_risk_states`, `crm_lead_reactivations`, `lead_state`, `lead_state_transitions`, `lead_checkpoints`, `lead_notes`, `merge_queue` |
| **Contatos & comércio** (3) | `contacts`, `orders`, `nuvemshop_products` |
| **IA — agentes** (8) | `ai_agents`, `ai_agent_versions`, `ai_agent_runs`, `ai_invocations`, `llm_calls`, `ai_budgets`, `ai_models`, `ai_pricing` |
| **IA — conhecimento** (5) | `ai_knowledge_sources`, `ai_knowledge_versions`, `ai_chunks`, `ai_faq_items`, `knowledge_searches` |
| **IA — memória & playbook** (7) | `org_memory_versions`, `org_memory_pointers`, `org_memory_entries`, `playbook_versions`, `playbook_pointers`, `promise_table_versions`, `promise_table_pointers` |
| **IA — skills & routers** (7) | `skill_versions`, `skill_pointers`, `skill_activations`, `ai_routers`, `ai_router_members`, `ai_router_decisions`, `ai_provider_credentials` |
| **IA — follow-up & reentrada** (8) | `followup_flow_versions`, `followup_flow_pointers`, `followup_enrollments`, `followup_enrollment_events`, `reentry_knob_versions`, `reentry_knob_pointers`, `reentry_template_versions`, `reentry_template_pointers` |
| **IA — casos & flywheel** (7) | `agent_cases`, `agent_case_events`, `agent_inbox_items`, `flywheel_distiller_proposals`, `flywheel_judge_verdicts`, `judge_alignment_pool`, `before_send_traces` |
| **Automação & eventos** (8) | `event_log`, `job_queue`, `cron_jobs`, `watchdog_cursors`, `automation_rules`, `automation_rule_runs`, `webhook_sources`, `webhook_events_log` |
| **LGPD & compliance** (2) | `lgpd_requests`, `storage_redaction_queue` |
| **Operação & versão** (6) | `incidents`, `metrics`, `pacing_ledger`, `tenant_integrations`, `system_update_runs`, `system_version` |

Fora do `public`: `private.app_secrets`.

**Convenções aplicadas**: `organization_id uuid not null references organizations(id) on delete cascade`
em toda tabela tenant-aware · policy `tenant_isolation_<tabela>_all` via `fn_user_org_ids()` ·
`unique (organization_id, external_id)` + captura de `23505` para idempotência de mensagem ·
`type` é `text` + CHECK, nunca enum · `tags text[]` + GIN (as tags de conversa são **coluna**,
não tabela — migration `0033`).

### 5.1 ⚠️ Achado: `lib/database.types.ts` está desatualizado — [M]

O arquivo de tipos gerado declara **90** tabelas; o `baseline.sql` cria **96**. Faltam nos tipos:

`crm_lead_scores` · `crm_lead_risk_states` · `crm_lead_reactivations` · `meta_templates` ·
`system_update_runs` · `system_version`

São exatamente as tabelas das migrations `0075`–`0083` (score/risco/reativação), `0088`
(templates da Meta) e `0089`–`0094` (auto-atualização) — ou seja, a regeneração parou por volta
da migration `0074`. O item 7 da Doutrina de Migrations e o DoD pedem regenerar os tipos quando o
contrato muda. Consequência prática: código que toca essas tabelas usa `any`/casts ou o client
não-tipado, e o compilador deixa de proteger esses caminhos. **Não é bug de runtime** — o schema
está correto e o `baseline.sql` entrega as tabelas ao self-hoster; é perda de rede de segurança
em tempo de compilação.

---

## 6. Eventos, workers e crons

### 6.1 Crons — [M] `docker-compose.prod.yml` (serviço `scheduler`, alpine + crond, resolução 1 min)

| Rota | Frequência | Papel |
|---|---|---|
| `/cron/agent-dispatcher` | 1 min | Despacha turnos de agente |
| `/cron/followup-flow-worker` | 1 min | Avança matrículas de follow-up vencidas |
| `/cron/event-log-drain` | 1 min (timeout 45s) | **Drena `event_log` — sem ele nenhuma automação roda** |
| `/cron/routing-worker` | 1 min | Roteamento automático de conversa para atendente |
| `/cron/storage-redaction?limit=50` | 5 min | Apaga mídia de contato anonimizado |
| `/cron/snooze-watcher` | 5 min | Desperta conversa adiada |
| `/cron/attendant-heartbeat` | 5 min | Presença/disponibilidade do atendente |
| `/cron/risk-watcher` | 15 min | Reclassifica risco de lead |
| `/cron/contact-avatars` | 10 min | Sincroniza foto de perfil do WhatsApp |
| `/cron/lgpd-sla-watcher` | 12:00 diário | Alarma SLA de LGPD antes de estourar |
| `/cron/kb-conversations-batch` | 03:30 diário (timeout 120s) | Conversa resolvida → base de conhecimento (elo do flywheel) |

Autenticação: `Authorization: Bearer $INTERNAL_SECRET` na rede interna do compose.

⚠️ **O `recover-stuck-messages` da doutrina (`CLAUDE.md`) não existe como rota** [M] — não há
`app/api/v1/cron/recover-stuck-messages/route.ts`. Mensagem presa em `status='sending'` não tem,
hoje, varredura declarada no `scheduler`. Ou a recuperação acontece por outro caminho
(a confirmar), ou é uma lacuna entre doutrina e código.

### 6.2 Workers `event_log` — [M] `workers/`

`ai-response-worker` · `ai-sentiment-worker` · `ai-handoff-from-sentiment` ·
`ai-budget-checker` · `ai-budget-reset` · `rag-indexer` · `media-persist-worker` ·
`media-derive-worker` · `lgpd-export-worker` · `lgpd-redact-worker` · `storage-cleanup-worker` ·
`agent-worker/main.ts` (processo dedicado, serviço `worker` do compose).

Padrão: cada worker tem par `.ts` (entrypoint) + `.handler.ts` (lógica pura testável).

---

## 7. Requisitos não-funcionais

| Dimensão | Como está atendido | Estado |
|---|---|---|
| **Isolamento multi-tenant** | RLS em toda tabela tenant-aware + 62 arquivos de invariante rodando em CI, incluindo teste de 2 organizações provando zero vazamento | ✅ com gate |
| **Auditabilidade** | `api_audit_log` append-only, retenção 5 anos (hot 90d), sem RLS de UPDATE/DELETE | ✅ |
| **LGPD** | Anonimização > delete, cascade completo, export assinado, SLA com feriados BR | ✅ |
| **Segurança de credencial** | AES no banco para credencial de IA e OAuth; SHA256 para bearer; SHA512 hex para WAHA; HMAC timing-safe em webhook | ✅ |
| **Rate limit HTTP** | `checkRateLimit` chamado em **2 lugares** (webhook público + dispatcher de IA). `/login`, `/signup`, aceite de convite, crons, `/api/mcp` e webhooks WAHA/Nuvemshop **sem proteção** | 🔴 lacuna |
| **Anti-banimento WhatsApp** | Throttle + jitter + janela + warm-up + spinning, com knobs por sessão | ✅ |
| **Acessibilidade** | `@axe-core/playwright` no harness; design system com Atkinson Hyperlegible e densidade aerada | 🟡 parcial |
| **i18n** | README em pt/en/es; `contacts.locale`; UI é pt-BR | 🟡 UI monolíngue |
| **Responsivo** | **Transbordo de layout a 390px em qualquer tela** | 🟠 bug conhecido [R] |
| **Observabilidade** | Sentry sanitizado + logger estruturado + `/health` + incidents | ✅ |
| **Performance** | Prefixo estável de prompt (preserva cache do provider), paginação por cursor, `build-and-size` no CI. **Sem virtualização de lista**: `@tanstack/react-virtual` está no `package.json` com **zero imports** [M] — inbox e listas longas renderizam tudo | 🟡 |

---

## 8. Catálogo completo de opções

### 8.1 Variáveis de ambiente — [M] 40 declaradas em `lib/env.ts`

**Obrigatórias (núcleo)**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `NEXT_PUBLIC_APP_URL`, `NODE_ENV`.

**Segredos internos**: `INTERNAL_SECRET`, `INTERNAL_CRON_SECRET`, `IMPERSONATE_COOKIE_SECRET`,
`LGPD_SIGNING_KEY`, `CPF_ENCRYPTION_KEY`, `AI_CRED_AES_KEY`, `NUVEMSHOP_OAUTH_ENCRYPTION_KEY`,
`WAHA_BYO_ENCRYPTION_KEY`, `WAHA_HMAC_SECRET`.

**WhatsApp**: `WAHA_API_BASE_URL`, `WAHA_API_KEY`, `WAHA_WEBHOOK_BASE_URL`,
`WAHA_WEBHOOK_REQUIRE_SIGNATURE`.

**IA**: `AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL`, `VERCEL_AI_GATEWAY_URL`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `AGENT_DISPATCH_CONSUMER`,
`INTERNAL_AGENT_RUN_STUB`.

**Infra opcional**: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `SENTRY_DSN`,
`EVENT_LOG_WORKER_ENABLED`, `NEXT_PUBLIC_ADMIN_URL`.

**Nuvemshop**: `NUVEMSHOP_ENABLED`, `NUVEMSHOP_APP_ID`, `NUVEMSHOP_CLIENT_ID`,
`NUVEMSHOP_CLIENT_SECRET`.

**LGPD / marca**: `LGPD_DPO_EMAIL`, `LGPD_EXPORT_EXPIRES_HOURS`, `APP_NAME`, `APP_LOGO_URL`.

⚠️ **6 destas não estão em `.env.example`** — incluindo 3 segredos (`IMPERSONATE_COOKIE_SECRET`,
`INTERNAL_CRON_SECRET`, `LGPD_SIGNING_KEY`) [R, `current-state.md` §4.5]. Inversamente,
`FLYWHEEL_*` e `WATCHDOG_*` estão no template mas são lidos direto de `process.env`, sem Zod.

### 8.2 Opções pela tela (não exigem tocar em arquivo)

| Onde | O que se configura |
|---|---|
| Organização | Nome, dados, retenção de dados, encarregado LGPD |
| Equipe | Papel por membro, limite de conversas simultâneas, disponibilidade, convite/revogação |
| Funis | Etapas, ordem, `expected_duration_hours`, vocabulário, motivos de perda, campos customizados, pipeline default |
| Conexões | Número por QR ou canal oficial Meta, reconexão, saúde, warm-up |
| Proteção de envio | `throttle_ms`, `jitter_max_ms`, janela de horário, domingo — por sessão |
| Agentes | 15+ opções (tabela em M6.1), publicação por versão, pausa, duplicação, teste |
| Roteadores | Membros, intenção, exemplos, modelo classificador, 1 ativo por canal |
| Follow-ups | Grafo completo: gatilho, espera fixa/inteligente, condição, classificação por IA, ação, desfecho |
| Conhecimento | Fontes, upload, reindexação, opt-in de conversa para RAG |
| Memória | Doc-mãe versionado + entradas de aprendizado |
| Skills | Import de pacote, ativação por palavra-chave |
| Uso e orçamento | Teto de gasto por org, modelo default |
| Webhooks | Fontes de captação, regras QUANDO/SE/ENTÃO, reenvio de falha |
| Perfil / Segurança | Nome, idioma, fuso, avatar, MFA, códigos de recuperação, sessões |
| Notificações | Canais e assuntos |
| API Tokens | Criação (plaintext uma vez) e revogação |
| Atualização | Versão instalada, o que muda, executar com backup |

---

## 9. Estado atual — entregue, incompleto, quebrado

### 9.1 Entregue [R, README + `current-state.md`; código correspondente localizado — M]

Fundação & plataforma · Atendimento WhatsApp · CRM & pedidos · IA nativa · LGPD · Self-host ·
Webhooks & automação · **Governança de atendimento** (épico G1–G6, 31/31 features com
`passes: true` em `plan/features.json`, fechado em 2026-07-18) · Operação visível ·
Atualização pela tela (v1.1.0).

### 9.2 Incompleto [R]

| Épico | Falta |
|---|---|
| Follow-up inteligente | Onda 8: gatilho `stage_change`, flywheel, fechamento do DoD da 8.3 |
| Evolução do harness | **Uma prova do dono**: mensagem real de WhatsApp fechando o ciclo completo |
| Operação visível | Prova na VPS após publicar (localhost já provado) |
| Casos humanos | Wave 7 (prova E2E) relatada parcial — A CONFIRMAR |
| Inbox multimodal | Ondas 4–6 A CONFIRMAR; multimodal provado só em OpenAI (credencial Anthropic era placeholder, chave Google era de gateway) |
| Fase FG / Vendaval | Não iniciada; README não a lista mais — A CONFIRMAR se saiu de escopo |
| Billing | **Tela é placeholder explícito** ("Em breve — Fase 2") [M] |

### 9.3 Lacunas verificadas 🔴🟠

1. **Rate limit HTTP quase inexistente** 🔴 — 2 pontos de aplicação. `/login`, `/signup` e
   aceite de convite ficam expostos a força bruta e enumeração.
2. **Fallback in-memory do rate limit** 🟠 — sem Upstash (estado normal de primeiro deploy), o
   limite passa a ser por processo, com apenas um `logger.warn`.
3. **98 dos 179 handlers usam `createAdminClient`** 🟠 [M] — service role bypassa RLS, e a regra
   "filtre `organization_id` manualmente, nunca do body" não tem enforcement automático na
   escrita. Os invariantes cobrem isolamento e rodam em CI; o que falta é gate que impeça handler
   novo de nascer errado. (A auditoria de 2026-07-29 contou 89 de 169 — a proporção subiu de
   53% para 55%.)
4. **Cobertura E2E parcial no CI** 🟠 — existem 22 specs em `tests/e2e/` [M]; o `e2e.yml` roda
   **10 nomeadas**. Fica de fora a `vps-fresh-onboarding`, que a própria doutrina classifica como
   P0. E o job `e2e` **não é check obrigatório** (issue #63).
5. **`pnpm gov:verify` não cobre `test:db` nem `test:e2e`** 🟠 — verde local não prova RLS.
6. **`.env.example` desalinhado de `lib/env.ts`** 🟠 — 3 segredos faltando.
7. **Sem gitleaks/trufflehog no CI nem pre-commit** 🟡.
8. **`inbound-turn.ts` com ~1.800 linhas** 🟡 — 2,4× o segundo maior arquivo, e é o hot path.
9. **Transbordo de layout a 390px** 🟠 e **ausência de criação de funil pela UI** 🟡.
10. **Idempotency-Key em 1 rota**, não no padrão prometido 🟡.
11. **`lib/database.types.ts` desatualizado em 6 tabelas** 🟡 [M] — regeneração parou por volta da
    migration `0074`; ver §5.1. Perda de checagem de tipo nos módulos de score/risco/reativação,
    templates da Meta e auto-atualização.
12. **`recover-stuck-messages` está na doutrina e não no código** 🟡 [M] — ver §6.1.
13. **O agent-engine não passa por RLS** 🟠 [M] — 57 arquivos usam `pg.Pool` direto; o isolamento
    depende de o `tenantId` entrar em cada query. Não há segunda camada se alguém esquecer, e é
    justamente o hot path do produto. Os invariantes de banco são a única rede. Ver §3.4.1.
14. **Duas dependências declaradas e não usadas** 🟡 [M] — `@tanstack/react-virtual` (zero
    referências) e `pdf-parse` (zero imports; a extração usa `pdfjs-dist`). Ver §3.4.5.

---

## 10. Opções de evolução — com trade-offs

Não são recomendações fechadas: são as escolhas reais em aberto, com o que cada uma custa.

### Opção A — Endurecer antes de crescer (segurança/qualidade primeiro)
**Faz:** rate limit em todas as rotas públicas; lint rule ou teste de diff que reprova handler
novo com `createAdminClient` sem filtro de `organization_id`; `e2e` como check obrigatório;
`.env.example` reconciliado; gitleaks no CI.
**Custo:** ~1 épico, zero valor visível ao usuário.
**Ganho:** remove o único modo de falha catastrófico do produto (vazamento cross-tenant) e o
vetor mais barato de ataque (força bruta em `/login`). Para um projeto self-host onde cada
instalação é de terceiros, a reputação de uma CVE é assimetricamente cara.
**Quando escolher:** se houver qualquer instalação de terceiro em produção hoje.

### Opção B — MCP público (a aposta da visão)
**Faz:** expõe as 16 tools como contrato público autenticado por token, com escopo por papel e
rate limit por token; publica `docs/specs/14` como contrato estável.
**Custo:** exige a Opção A como pré-requisito (superfície pública sem rate limit é inviável) +
versionamento de contrato + documentação de ecossistema.
**Ganho:** é a única iniciativa que muda a *categoria* do produto — de "CRM com IA" para
"infraestrutura para agentes". É o que o `VISION.md` chama de sistema nervoso.
**Risco:** contrato público é imutável na prática; errar o formato agora custa caro depois.

### Opção C — Fechar o flywheel de auto-aprimoramento
**Faz:** completa conversa resolvida → conhecimento → proposta → juiz → versão nova, com métrica
de "o agente melhorou?" no painel de Evolução.
**Custo:** as peças existem (`flywheel_*`, `judge_alignment_pool`, `/proposals`, `/evolution`);
falta o loop medido e o gate humano provado em operação real.
**Ganho:** é o diferencial defensável — um incumbente copia inbox e kanban em um trimestre, não
copia um loop que melhora com o uso de cada tenant.
**Risco:** sem métrica confiável de melhora, vira teatro de IA.

### Opção D — Multi-nicho de verdade (templates por vertical)
**Faz:** pipelines, vocabulários, playbooks e skills prontos para clínica, imobiliária,
infoproduto e serviços — o e-commerce já tem (Nuvemshop).
**Custo:** baixo tecnicamente (a infraestrutura de `vocabulary` + `settings.fields` já existe);
alto em pesquisa de domínio.
**Ganho:** reduz o tempo do "instalei" ao "está vendendo" — a métrica que mais mata adoção de
self-host. Ataca diretamente a jornada P0.
**Quando escolher:** se o gargalo medido for abandono pós-instalação.

### Opção E — Primeira impressão / mobile
**Faz:** corrige transbordo a 390px, cria caminho de criação de funil pela UI, coloca
`vps-fresh-onboarding` no CI.
**Custo:** pequeno e bem delimitado.
**Ganho:** desproporcional — a doutrina do próprio projeto diz que a experiência de quem instala
numa VPS **é** o produto, e bug de primeira impressão é abandono.

### Opção F — Mais canais / mais e-commerce
**Faz:** VTEX e Shopify via adapter (o padrão de adapter já está provado com Meta Cloud vs WAHA);
identity probabilística entre canais.
**Custo:** médio; cada integração traz um contrato de webhook e um modo de falha novo.
**Ganho:** amplia mercado sem mudar o núcleo.
**Risco:** dilui foco no momento em que o diferencial (agentes) ainda não está fechado.

### Opção G — Billing de verdade
**Faz:** substitui o placeholder por cobrança real.
**Contra-argumento forte:** o `VISION.md` diz explicitamente que **não há assinatura** e que a
monetização é por infraestrutura. Uma tela de Billing num produto sem plano pago é ruído — a
opção honesta pode ser **remover a tela**, não implementá-la.

---

## 11. KPIs sugeridos

Nenhum destes está instrumentado hoje como métrica de produto [I] — a instrumentação existente
(`metrics`, `fn_attendant_metrics`, `/app/ai/usage`) é operacional, por tenant.

| Camada | Indicador |
|---|---|
| **Adoção** | Instalações que completam o onboarding ÷ instalações iniciadas · dias até a primeira conversa real |
| **Atendimento** | Tempo até primeira resposta · conversas resolvidas sem handoff · taxa de handoff por motivo |
| **IA** | % de turnos sem intervenção humana · custo por conversa resolvida · buscas de conhecimento sem resultado (`knowledge_searches` já grava) · propostas de flywheel aprovadas ÷ geradas |
| **Funil** | Conversão por etapa · leads em `critico` no radar · tempo médio por etapa vs `expected_duration_hours` |
| **Confiabilidade** | Mensagens `sending` presas · `event_log` acumulado (proxy de cron morto) · incidentes abertos por severidade |
| **Comunidade** | Instalações ativas · estrelas/forks · issues respondidas |

---

## 12. Anexos

### 12.1 Inventário de telas — 86 [M]

| Área | Telas [M] | Conteúdo |
|---|---|---|
| Público | 6 | `/login`, `/login/mfa`, `/login/forgot`, `/login/recovery`, `/login/reset`, `/signup` |
| Raiz e estado | 6 | `/`, `/403`, `/500`, `/503`, `/account-suspended`, `/design` |
| Onboarding | 7 | wizard completo (`welcome` → `connect-whatsapp` → `setup-ai` → `connect-nuvemshop` → `invite-team` → `done`) |
| `/app` (tenant) | 47 | inclui os 17 de IA e os 12 de settings |
| `/admin` (plataforma) | 19 | dashboard, tenants, users, platform-admins, inbox, audit, incidents, lgpd, usage, forbidden |
| Fora dos grupos | 1 | `/team/accept-invite/[token]` (aceite público de convite) |
| **Total** | **86** | |

Dentro de `/app`: atendimento (`inbox`, `inbox/[id]`, `radar`, `templates`) · CRM (`kanban`,
`contacts`, `contacts/[id]`, `pipelines/[id]`) · IA (17) · canais (`connections`,
`integrations/nuvemshop`, `webhooks`) · análise (`metrics`, `audit`) · organização
(`settings` ×12, `team`, `team/invite`, `lgpd/requests` ×2) · home (`/app`).

### 12.2 Superfície de API por família — 179 handlers [M]

`/api/v1/admin/*` (21) · `/api/v1/ai/*` (50) · `/api/v1/conversations/*` (16) ·
`/api/v1/leads/*` (12) · `/api/v1/cron/*` (11) · `/api/v1/webhooks/*` (8) ·
`/api/v1/pipelines/*` (7) · `/api/v1/team/*` (6) · `/api/v1/lgpd/*` (5) ·
`/api/v1/contacts/*` (5) · `/api/v1/channel-sessions/*` (4) · `/api/v1/automation-rules/*` (5) ·
`/api/v1/settings/*` (3) · `/api/v1/webhook-sources/*` (3) · `/api/v1/system/*` (3) ·
demais avulsas (audit, health, mcp, messages, metrics, attendants, onboarding, integrations,
channels, message-templates, conversation-tags, auth/realtime-token, internal/agents/run).

### 12.3 Portões de CI

**Obrigatórios**: `verify` (typecheck + lint + test:unit) · `invariants` (`pnpm test:db`:
pgvector/pg17, baseline em modo install e update, 62 arquivos de invariante incluindo isolamento
RLS de 2 organizações) · `build-and-size` (build em Node 22).
**Não-obrigatório**: `e2e` (10 das 22 specs).

---

## 13. O que este documento não conseguiu determinar

- Se `typecheck`/`lint`/`test:unit`/`test:db` passam **hoje** — nada foi executado.
- Estado real de banco de dev ou produção — nenhuma conexão aberta.
- Se os épicos arquivados (Casos Humanos Wave 7, Inbox Multimodal ondas 4–6) fecharam de fato.
- Cobertura de teste em porcentagem — `coverage` está configurado, sem relatório gerado.
- Se `docs/architecture/` cumpre o "mapa vivo" exigido pelo item 13 do DoD (contém só o diagrama
  do agent-turn).
- Frequência dos crons `kb-conversations-batch`, `contact-avatars` e `recover-stuck-messages` —
  as rotas existem, mas não aparecem no `scheduler` do `docker-compose.prod.yml`.
