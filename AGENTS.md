# AGENTS.md — DeskcommCRM

> Contrato para **qualquer** agente de código (Codex, Cursor, Copilot, Amp, Claude Code).
> Este arquivo é o núcleo portável. A **doutrina completa e não-negociável vive em
> [`CLAUDE.md`](CLAUDE.md)** — leia-o antes de tocar em código. Aqui está o mínimo
> para não causar dano.

---

## Objetivo do projeto

Sistema operacional de vendas com agentes de IA nativos; nicho de validação = corretor
de plano de saúde (multi-nicho é capacidade, não prioridade). WhatsApp como canal
primário, com **todo tráfego de entrada chegando pelo `gateway_go`**. Multi-tenant com
RLS desde o dia 1, LGPD nativa. **Entrega: SaaS de instância única, operada por nós** —
ninguém instala nada. **Cobrança é gerenciada no Cotador Simplificado, não aqui.**
Posicionamento: [`VISION.md`](VISION.md). Autoridade: `.specify/memory/constitution.md` (v2.3.0).

**Consequência que muda como você trabalha:** existe **uma** instância e **um** banco.
Bug em produção atinge todos os tenants ao mesmo tempo, e **não há versão de escape** —
mudança destrutiva de schema exige caminho de volta pensado antes (expand/contract).
Isolamento de tenant furado vaza entre clientes distintos, não entre pastas do mesmo dono.

## Stack (CONFIRMADO em `package.json`)

Next.js 16.2 (App Router) · React 19.2 · TypeScript 6.0 estrito · Tailwind 3.4 ·
shadcn/ui · Supabase (Postgres + Auth + Realtime + Storage) · Upstash Redis ·
Vercel AI Gateway (`@ai-sdk/anthropic|openai|google`) · WAHA Plus (engine NOWEB) ·
Zod 4 · Vitest 4 · Playwright 1.62 · Sentry 10.
Runtime: **Node ≥22** (`.nvmrc` = 22; o job `ci` roda 22, mas o `perf` ainda builda em 20 —
divergência com `engines`, registrada como bug). Gerenciador: **pnpm 9.15.9** (`packageManager`).
Versão do produto: **1.0.0** (`CHANGELOG.md`, SemVer — mudança visível ao usuário entra lá).

## Estrutura que importa

| Path | O quê |
|---|---|
| `app/api/v1/` | 166 route handlers REST (versionado por path) — 169 contando `app/api/**` |
| `app/api/internal/`, `app/api/mcp/`, `app/api/v1/cron/` | superfícies não-cookie (secret/bearer próprio) |
| `app/app/` | UI autenticada do tenant · `app/admin/` UI de plataforma |
| `app/actions/` | Server Actions (auth, onboarding, team, settings) |
| `lib/agent-engine/`, `lib/ai/` | runtime do agente, guardrails, RAG, dispatcher |
| `lib/api/wrappers.ts` | `ok()` / `fail()` — **use sempre**, não monte Response na mão |
| `lib/auth/require-role.ts` | `requireRole()` — guard canônico de RBAC |
| `lib/supabase/{browser,server,admin}.ts` | clients canônicos |
| `workers/` | workers de `event_log` + crons |
| `supabase/migrations/` | schema versionado · `supabase/baseline.sql` = o que sobe ambiente do zero e o que o gate `invariants` aplica |
| `proxy.ts` | middleware do Next 16 (auth de borda, `X-Request-Id`) |

## Comandos (CONFIRMADO em `package.json`)

```bash
pnpm install          # deps (frozen-lockfile no CI)
pnpm dev              # dev server
pnpm build            # next build
pnpm lint             # eslint
pnpm typecheck        # tsc --noEmit (estrito)
pnpm test:unit        # vitest — EXCLUI tests/invariants e tests/e2e
pnpm test:db          # invariantes de banco + gate do baseline (PRECISA de Docker)
pnpm test:e2e         # Playwright (PRECISA de app rodando + banco semeado)
pnpm gov:verify       # typecheck + lint + test:unit  ← verificação única atual
```

⚠️ **`pnpm gov:verify` NÃO cobre tudo.** Ele omite `test:db` e `test:e2e`. Se sua
mudança toca schema, RLS ou UI, `gov:verify` verde **não** é prova — rode `pnpm test:db`
(exige Docker) e/ou `pnpm test:e2e` você mesmo. Ver [`docs/harness-audit.md`](docs/harness-audit.md).

**O que o CI cobre.** `.github/workflows/ci.yml`: `verify` = typecheck + lint + test:unit;
`invariants` = `pnpm test:db` (isolamento RLS + invariantes de governança contra Postgres
efêmero pg17). `.github/workflows/perf.yml`: `build-and-size` = `pnpm build`.
**Os três são checks obrigatórios** na branch protection da `main`.

`.github/workflows/e2e.yml` roda **28 das 32 specs** Playwright contra um Supabase local de
verdade com o `baseline.sql` aplicado — o mesmo schema que a instância roda. **Não é
obrigatório ainda** (o conjunto de specs acabou de mudar, então execuções verdes anteriores
eram de outro conjunto e não provam a estabilidade deste). As 4 de fora: `followup-journey` e
`webhooks` (precisam de WAHA), `vps-fresh-onboarding` (WAHA + Redis + Resend + Nuvemshop; é a
P0 da doutrina de QA) e `capacidades-do-agente`, que está fora porque REPROVA de verdade — ver
o summary do job. Se você mexeu em UI fora desse subconjunto, a prova é sua.

## Padrões de código (observados no repo, não inventados)

- **Route handler:** valida input com Zod → guard (`requireRole` / `requirePlatformAdmin` /
  secret) → query com `organization_id` explícito → `audit()` se mutação → `ok()` / `fail()`.
- Erro: `fail(code, message, status)` com código de `lib/api/errors.ts`. Nunca `throw` cru na borda.
- JSON **snake_case** na API. Dinheiro em `_cents` + `currency`. Datas ISO-8601 UTC.
- Log: `lib/logger.ts` (estruturado). **`console.log` é proibido** em código merged.
- Testes ao lado do código (`lib/foo/bar.test.ts`) ou em `tests/{unit,api,invariants,e2e}/`.
- Comentários em PT-BR são a norma neste repo — mantenha o idioma do arquivo que editar.

## Canal e gateway (`gateway_go`) — regras que não se negociam

Todo tráfego de entrada chega pelo `gateway_go`, **repo irmão com deploy separado**
(`/root/PROJETOS/gateway_go`). Constituição v2.3.0, Princípios VII e XIV.

- **Código novo do CRM não lê payload cru de provedor** (WAHA/uazapi/Meta). Só envelope
  normalizado.
- **O gateway nunca toca tabela do CRM.** `insert`/`update`/`select` direto é proibido, sem
  exceção. Ele escreve **só por função `security definer` versionada** — a "quarta superfície" —
  e só sob as seis travas: (1) zero grant de tabela, nem `select`; (2) papel Postgres dedicado,
  **nunca** `service_role` nem o segredo do JWT; (3) `organization_id` resolvida **dentro do
  banco** pela conexão de origem, nunca de parâmetro nem do corpo; (4) assinatura versionada como
  contrato; (5) invariante em CI reprovando se o papel ganhar privilégio de tabela; (6) sem HTTP
  dentro da função. Falhar em qualquer uma torna a superfície proibida, não degradada.
- **A quarta superfície é só do gateway.** Não se estende ao Cotador Simplificado — a ponte com
  ele é contrato HTTP explícito, nada além.
- **Endereço do gateway é configuração.** Sem `localhost`, sem nome de serviço de compose, sem
  "sobe junto". Ele não entra no `docker-compose.prod.yml` do CRM.
- **Sem réplica = ponto único de falha declarado, e a durabilidade tem duas pontas
  obrigatórias.** A do gateway é fila em disco com retentativa; a do CRM é fila de entrada com
  dreno (quando a entrega é HTTP) ou **reconciliação periódica** (quando o gateway escreve por
  função). Divergência vira alerta — reconciliar em silêncio é proibido. Uma ponta só é
  descumprimento.
- **Teto de taxa por conexão**, nunca global nem por IP — todas as entregas vêm do mesmo endereço.
- Queda do gateway vira alerta para a operação **e** aviso na Central para o usuário. Silêncio é
  proibido: o sintoma natural é "as mensagens pararam", sem lugar nenhum para olhar.

Desenho e medições: `specs/004-envio-pelo-gateway/decisao-escrita-direta.md`.

## Diretórios e arquivos SENSÍVEIS

- **`supabase/baseline.sql`** — é o que sobe ambiente do zero e o que `scripts/test-db.sh`
  aplica no job `invariants` (obrigatório), em modo install **e** update. Toda mudança de
  schema tem que aparecer aqui **como apêndice idempotente**, senão o gate reprova e o
  ambiente fresco nasce sem a mudança. Ver doutrina de Migrations em `CLAUDE.md`.
- **`supabase/migrations/*.sql` já aplicadas** — nunca edite. Corrija com migration nova.
- **`lib/supabase/admin.ts`** — service role **bypassa RLS**. 89 rotas o usam; toda
  query precisa filtrar `organization_id` manualmente, resolvido de fonte confiável
  (cookie/JWT/webhook secret/path token), **nunca do body**.
- **`lib/auth/public-paths.ts`** — adicionar path aqui remove a checagem de auth de borda.
  Só com guard próprio dentro da rota.
- **`.env*`** — não abra, não copie valor, não logue. Só `.env.example` é template.
- **`docker-compose.traefik.yml`** — na máquina de produção (proxy reverso próprio),
  é o único lugar que dá ao contêiner `app` as labels
  de roteamento. Todo `up -d` leva os **dois** arquivos de compose:
  `docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env up -d app`.
  Esquecer o segundo `-f` recria o contêiner sem labels: o proxy deixa de enxergá-lo e o
  domínio inteiro responde `404`, com o contêiner `healthy` — o healthcheck é um probe TCP
  interno e não sabe nada de roteamento. Runbook: `docs/runbooks/deploy.md`.

## Arquivos GERADOS — não editar à mão

- `lib/database.types.ts` (6.1k linhas — gerado do schema Supabase)
- `graphify-out/` (grafo de conhecimento; regenerado por `/graphify .`)
- `pnpm-lock.yaml`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `.next/`

## Como validar uma alteração

1. `pnpm typecheck` e `pnpm lint` zerados.
2. `pnpm test:unit` verde.
3. Tocou schema/RLS/tabela tenant-aware → `pnpm test:db` (sobe Postgres efêmero via Docker,
   aplica `baseline.sql` em modo install **e** update, roda os invariantes).
4. Tocou UI ou fluxo de usuário → `pnpm test:e2e` com evidência visual. **`curl` não conta**
   como prova de UX (doutrina de QA Visual em `CLAUDE.md`).
5. Mudou schema → migration versionada em `supabase/migrations/` **+** apêndice idempotente
   em `supabase/baseline.sql` **+** linha em `supabase/migrations/MANIFEST.md`. Os três juntos.
6. Criou função em `public` → `revoke execute on function ... from public, anon;` e depois
   `grant` só a quem precisa. São **duas** origens de `EXECUTE` e revogar uma só deixa a
   função exposta como RPC alcançável pela anon key. Detalhe em `CLAUDE.md`, item 9 da
   doutrina de Migrations.

## Testes existentes (CONFIRMADO)

- **221** arquivos `*.test.ts(x)` unitários (rodam em `test:unit` e no CI)
- **67** arquivos de invariante de banco em `tests/invariants/` — RLS/isolamento cross-tenant,
  RBAC, governança (G1–G6). Excluídos do `test:unit` de propósito; rodam via `pnpm test:db`
  **e no job `invariants` do CI**.
- **32** specs Playwright em `tests/e2e/`. **28 rodam no CI** (via `e2e.yml`,
  não-obrigatório). As 4 de fora dependem de serviço externo (WAHA/Redis/Resend/Nuvemshop) —
  incluindo `vps-fresh-onboarding` — ou reprovam legitimamente (`capacidades-do-agente`).
  Ver issue #63.

## Limitações conhecidas (estado em 2026-07-29, contra `origin/main` @ 789dfa6)

- **4 das 32 specs E2E seguem fora do CI**, e o `e2e` ainda não é check obrigatório: um PR
  que o quebre entra na `main` assim mesmo. Se você mexeu em UI coberta só por essas 4, a
  prova é sua.
- Rate limit HTTP existe em **2** pontos do código (webhook de captação e dispatcher de IA);
  login, signup, aceite de convite, crons e MCP estão sem. Não há lockout por conta no login.
- Fallback do rate limit é **em memória** — sem Upstash configurado o limite é por processo.
- `Idempotency-Key` implementado em **1** rota, apesar de o contrato prometer nos POSTs de criação.
- **6 vars de `lib/env.ts` faltam no `.env.example`**, incluindo 3 secrets. Se você adicionar
  env var, adicione nos dois lugares (item 9 do DoD).
- `lib/auth/invite-token.ts` cai em `"dev-fallback"` como secret HMAC se nenhum secret existir
  (inalcançável em produção, porque `INTERNAL_SECRET` é obrigatório e derruba o boot).
- **89 dos 169 handlers de `app/api/**` usam service role** — sem gate automático para o filtro de
  `organization_id`. Escrevendo handler novo, o filtro é responsabilidade sua.
- Detalhes e prioridade: [`docs/harness-audit.md`](docs/harness-audit.md),
  [`docs/current-state.md`](docs/current-state.md) e [`docs/threat-model.md`](docs/threat-model.md).

## Regras de segurança

- Sempre `getUser()` no backend. **Nunca `getSession()`** (confia no cookie sem revalidar).
- API key/token **nunca** em query string — só header. Plaintext do bearer é mostrado
  **uma vez**; no banco só hash SHA256.
- HMAC de webhook com `crypto.timingSafeEqual`. Fail-closed quando o secret falta.
- Nunca logue segredo, token, CPF, telefone ou e-mail. Sentry tem `beforeSend` que
  higieniza — não confie nele como única camada.
- Não commite screenshot/dump com dado real de cliente.

## Critério de conclusão

Vale a **Definition of Done de 13 itens em [`CLAUDE.md`](CLAUDE.md)**. Não declare pronto
sem: typecheck/lint zerados, testes relevantes verdes, RLS testada se tocou tabela
tenant-aware, migration + baseline + MANIFEST se mudou schema, e prova visual se mudou UI.

## Regra final — não invente

Este repositório tem PRDs, specs, regras de negócio e doutrina escritos
(`docs/prd/`, `docs/specs/`, `docs/business-rules/`, `docs/doctrine/`).
**Nunca invente regra de negócio, número, SLA ou comportamento de produto.**
Se a regra não está escrita, diga que não está e pergunte — não preencha a lacuna com
suposição plausível. Ao documentar, marque o que é `CONFIRMADO` (provado por código) e o
que é `INFERIDO`.

## Planejamento acompanha a execução (constituição v2.4.0)

A cada **5 tasks** avançadas — ou ao fechar uma fase, o que vier primeiro — atualize os artefatos de
planejamento antes de seguir: `tasks.md` da spec com o estado real, `plan.md` se o desenho mudou, e
`docs/current-state.md` se o que está pronto/quebrado mudou.

Planejamento atualizado só no fim mentiu o caminho inteiro. Quem retoma lê o plano, não o histórico
de commits — e um plano atrasado manda a próxima sessão refazer o que já existe.

## Como medir sem produzir verde falso — DOUTRINA (aprendida medindo, 2026-08-08)

Uma sessão inteira de execução da Fase 6 da spec 004 produziu **cinco defeitos de produto** que
3157 asserções unitárias não pegavam — e, no caminho, **quatro verdes falsos meus**. As regras
abaixo são o que separou um do outro. Elas custaram caro; leia antes de escrever teste de tela ou
medição.

### 1. Leia a captura antes de supor

Playwright grava `test-results/**/error-context.md` — a **página no instante da falha**, em YAML.
Medido: cada suposição minha sobre a causa custou **uma rodada inteira** (subir ambiente, build,
rodar); cada leitura da captura resolveu em **um minuto**. Foi ela que revelou "Sua conta exige 2FA"
depois de eu ter errado a causa duas vezes.

### 2. Ausência prova transição; presença prova chegada

Esperar que a tela de desafio **apareça** como sinal de que o código foi aceito passa na hora — ela
já está visível. O sinal certo é ela **sumir** (`toHaveCount(0)`). Trocar os dois dá verde imediato
que não mede nada.

### 3. Asserção negativa exige âncora de lugar

`expect(corpo).not.toMatch(/WAHA/)` passa em **qualquer** página que não contenha o termo —
inclusive numa que o teste nunca quis abrir. Medido: um caso ficou verde medindo a **tela de login**.
Afirme onde está (`toHaveURL`, ou um elemento que só existe ali) **antes** de afirmar o que não vê.

### 4. Cronômetro independente do laço

Medir latência com `Date.now()` antes da chamada mistura a espera com a duração da anterior — e o
primeiro intervalo não tem predecessor. Deu **95,9%** onde a verdade era **100%**. Use carimbo de
quem não participa do laço: `created_at` do Postgres, timestamp do outro processo.

### 5. Dublê responde no formato que VOCÊ escreveu

Teste com dublê não prova formato de campo nem latência de sistema externo. Dois defeitos desta spec
viviam exatamente aí: a reconciliação varrendo até `agora` (o provedor leva ~25 min para indexar) e
o `select` sem a coluna que o próprio ramo novo precisa. **Formato e tempo de terceiro só se sabem
medindo o terceiro.**

### 6. Estado que sobrevive entre execuções é a causa favorita do "piorou sem eu mexer"

Fator de MFA fica no banco; segredo TOTP vive em módulo e morre com o processo. Re-execução começa
no desafio sem ter o segredo — 5 vermelhos depois de 2 verdes, sem nada do produto mudar. Zere o
estado externo no `beforeAll`.

### 7. Código TOTP só vale UMA vez

Casos que logam em sequência caem na mesma janela de 30 s e mandam o mesmo código; o segundo é
recusado. Ou guarde o último enviado e espere a janela virar, ou — melhor — **logue uma vez** e
compartilhe a sessão (`mode: serial`).

### 8. Recurso pago que o teste cria, o teste apaga

Instância de provedor custa por unidade. Toda execução que provisiona termina com o `DELETE`, e a
verificação é o registro vazio — não a intenção. É a mesma doutrina de compensação que a feature
implementa; ela vale para quem a testa.

