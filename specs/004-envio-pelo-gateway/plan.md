# Implementation Plan: Envio e conexão pelo gateway — o CRM para de falar WAHA

**Branch**: `feat/004-envio-pelo-gateway` | **Date**: 2026-08-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-envio-pelo-gateway/spec.md`

**Decisão que governa este plano**: [decisao-escrita-direta.md](./decisao-escrita-direta.md) — o fork
do gateway grava **direto no banco do CRM**, por função versionada. Ela reescreveu a F1 e é
pré-requisito de leitura.

---

## Summary

Três frentes, uma ordem forçada. **F1** dá ao gateway uma superfície de escrita no banco do CRM —
funções `security definer`, papel Postgres dedicado sem grant de tabela, tenant resolvido dentro do
banco. **F2** faz o CRM enviar pelo gateway, atrás do seam de canal que já existe. **F3** move o
pareamento de número para o gateway sem que a tela mude de vocabulário nem ganhe passo.

A abordagem técnica saiu de três medições, não de preferência:

1. **O gateway já escreve por RPC, não por tabela** — 6 chamadas mapeadas; só a mensagem é upsert
   cru (`internal/processor/mensagem.go:100`). Logo o acoplamento do fork é um conjunto de
   assinaturas, não o schema. Três das funções necessárias **já existem** no CRM.
2. **O idioma de idempotência do gateway não sobrevive à troca de alvo.**
   `messages_org_external_id_unique` é `DEFERRABLE INITIALLY DEFERRED`; `on conflict` erra contra
   ela, índice único adicional não resolve, e `exception when unique_violation` não captura sem
   `set constraints ... immediate`. Provado em pg17 descartável.
3. **A cadeia viva não é do trigger.** `trg_messages_emit_event` sobrevive a qualquer escritor, mas
   `ai_agent.dispatch_requested` só é emitido por código de aplicação. Desce para dentro da função —
   o que fecha uma janela que hoje existe.

**Forma de entrega**: um repo, dois builds (costura em `internal/store`), não fork literal — em fork
literal todo conserto de gateway é aplicado duas vezes, e a segunda é a que alguém esquece.

---

## Technical Context

**Language/Version**: TypeScript 6 estrito (CRM, Next.js 16 App Router / React 19) · Go (gateway,
repo irmão `/root/PROJETOS/gateway_go`) · PL/pgSQL (a superfície de escrita da F1)

**Primary Dependencies**: Supabase (Postgres 17 + PostgREST + Auth + Storage) · Upstash Redis
(rate limit, idempotência) · Vercel AI Gateway · Playwright · Vitest

**Storage**: Postgres do CRM. **Novidade desta feature**: um segundo escritor (o gateway) alcança o
banco por RPC PostgREST, com papel `gateway_writer`. Nenhuma tabela nova — a F1 acrescenta funções e
um papel, não entidades.

**Testing**: `pnpm typecheck` · `pnpm lint` · `pnpm test:unit` · **`pnpm test:db`** (obrigatório:
esta feature mexe em schema, RLS e papel) · `pnpm test:e2e` (Playwright, F3 e Fase 6)

**Target Platform**: SaaS de instância única, operada por nós. O gateway **não** entra neste deploy
(Princípio XIV) — endereço é configuração, ciclo próprio, sem réplica.

**Project Type**: web-service multi-tenant + serviço externo em Go, versionados separado.

**Performance Goals**: p95 do clique à chegada **≤ 5 s** (SC-001) · QR na tela **≤ 15 s** (SC-006) ·
jornada login → primeira conversa atendida **≤ 10 min** (Princípio VIII).

**Constraints**:
- Idempotência **tem** de tolerar a constraint `DEFERRABLE` (medido — ver Summary).
- Anti-banimento: espaçamento e janela de horário valem igual no caminho novo (FR-020).
- Referência de mídia com validade **≥ 1 h** (FR-024).
- Instância única: mudança destrutiva exige expand/contract; não há versão de escape.

**Scale/Scope**: 39 requisitos funcionais, 12 critérios de sucesso, 58 tasks em 7 fases. Toca 2
repositórios. **Não** cria tabela; cria 4 funções, 1 papel, 2 migrations (0127, 0128).

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Fonte: `.specify/memory/constitution.md` **v2.3.0** (a emenda que este plano exigia — ver Complexity Tracking).

| # | Gate | Resposta | Status |
|---|---|---|---|
| I | Isolamento de tenant | Nenhuma tabela nova. `organization_id` **resolvido dentro do banco** a partir de `channel_sessions.gateway_connection_id` (FR-004) — o corpo da chamada nunca decide tenant. As 4 funções novas revogam `execute` de `public` **e** `anon` (FR-003), as duas origens. `gateway_writer` tem `EXECUTE` e **zero** grant de tabela, vigiado por invariante (T011). | **PASS** |
| II | Nada é ilha | Living System Checklist na seção própria abaixo. Peça nova (`gateway_writer` + funções) entra em `docs/architecture/` com as arestas gateway→função→`messages`→`event_log`→agente. | **PASS** |
| III | Schema muda por migration | Migrations 0127 (papel) e 0128 (funções), cada uma com apêndice idempotente no `baseline.sql` e linha no MANIFEST (T055). **Nada destrutivo**: só `create ... if not exists` e `create or replace`. A questão do `DEFERRABLE` é **decidida como não-mudança** (research D2) justamente para não abrir mudança destrutiva sem necessidade. | **PASS** |
| IV | Prova pela tela | T063 exige conta **nova**, estado **vazio**, cronometrado, com evidência visual. T060/T067/T068 usam gateway e provedor reais. `curl` só como diagnóstico. | **PASS** |
| V | Evento na fila | Nenhum trigger faz HTTP; invariante mecânico varre as funções novas por `http`/`pg_net` (T016, FR-010). Idempotência por `unique (organization_id, external_id)` com captura de `23505` — **dentro** da função, com `set constraints ... immediate`. A fila tem dono declarado nas **duas** pontas (FR-013 gateway, FR-013a CRM). | **PASS** |
| VI | Contrato de API | As rotas do CRM que a feature toca seguem `/api/v1/` com `ok()`/`fail()`, Zod e audit (T053). Credencial do gateway em cabeçalho, nunca em query string (FR-018/T033). | **PASS** |
| VII | Interoperável por contrato | A **v2.3.0 nomeou a quarta superfície** (função `security definer` versionada) e este plano a usa dentro das seis travas: zero grant de tabela e invariante que reprova (T010/T011) · papel dedicado, nunca `service_role` nem segredo do JWT (research D1) · tenant resolvido dentro do banco (FR-004/T012) · assinatura versionada como contrato (`data-model.md` §2) · sem HTTP na função, com varredura mecânica (T016). Ela **não** se estende ao Cotador. ⚠️ **PASS por desenho, não por prova**: as travas 1, 5 e 6 só ficam provadas quando T011 e T016 estiverem verdes. | **PASS (a provar em T011/T016)** |
| VIII | Corretor em 10 minutos | A F3 É o passo 2 do onboarding. A feature **não pode acrescentar passo**: SC-006 exige contagem de passos **idêntica** e cronometragem em conta nova (T063). Nada de configuração nova exposta ao usuário — o endereço do gateway é nosso, não dele. | **PASS** |
| IX | Vender ou assistir | As duas. Recebimento sem envio é caixa de correio; esta feature é o que faz o agente **falar**. Declarado no cabeçalho da spec. | **PASS** |
| X | Operadora é dado curado | **N/A** — feature de transporte. Nada de operadora entra em código, prompt ou tabela aqui. | **N/A** |
| XI | Teste que prova e vigia | Gate certo por tipo: `test:db` para as funções e o papel (T017/T018), Playwright para F3 (T063), receptor real para o efeito externo (T060/T067). **Sabotagem é task explícita por fase** (T019, T048) — SC-012 exige em cada teste novo. | **PASS** |
| XII | Contexto antes de ação | Esta sessão leu a constituição (v2.2.0 na leitura inicial; ela mesma a emendou para v2.3.0 na T001), `CLAUDE.md`, `AGENTS.md` e os artefatos da spec 001; releu após duas compactações de contexto. **Divergências foram reportadas, não resolvidas em silêncio**: a inversão de doutrina da spec 001, a colisão de numeração com a spec 002, e os dois CRITICAL que o `/speckit-analyze` achou contra o meu próprio texto. | **PASS** |
| XIII | Cobrança mora no Cotador | Nenhuma coluna, rota ou tela de assinatura, plano, preço ou pagamento. A feature não consulta estado de assinatura. | **PASS** |
| XIV | Gateway único e sem réplica | A v2.3.0 tornou explícito que a ponta de durabilidade do CRM **muda de forma** conforme o caminho, e este plano usa a forma certa: reconciliação periódica com alerta na divergência. Endereço é configuração (T024/T033) — sem `localhost`, sem nome de serviço de compose. Teto de taxa **por conexão** (T027). Queda vira alerta **e** aviso na Central (T037). **As duas pontas de durabilidade**: fila em disco no gateway (FR-013/T025) **e** reconciliação periódica no CRM (FR-013a/T050). ⚠️ Código novo passa a ler **função**, não envelope, na direção de entrada — o envelope segue valendo na saída. Isso é parte do FAIL de VII, não um segundo desvio. | **PASS (com a ressalva de VII)** |

**Portão**: **0 FAIL**, depois da emenda v2.3.0 (T001, feita em 2026-08-08).

⚠️ **O que mudou e o que não mudou.** A emenda não "resolveu" o conflito por decreto: ela **nomeou
a superfície e a cercou com seis travas**. Este plano passa em VII porque satisfaz as seis **no
desenho** — e três delas (zero grant de tabela, invariante em CI, sem HTTP na função) só ficam
**provadas** quando T011 e T016 estiverem verdes. Até lá o PASS é uma promessa auditável, não um
fato. Se T011 ou T016 não existirem, VII volta a FAIL e não há emenda que conserte.

### Living System Checklist (Princípio II, item 13 do DoD)

| Pergunta | Resposta |
|---|---|
| **Quem alimenta?** | O gateway, chamando `fn_gateway_ingest_message`. E a reconciliação (T050), que alimenta o mesmo caminho com o que o gateway não conseguiu empurrar. |
| **Quem é alimentado?** | `messages` → trigger `trg_messages_emit_event` → `event_log`; e `ai_agent.dispatch_requested` na mesma transação → agent-engine → resposta do agente → envio pelo gateway (F2). O ciclo **fecha**. |
| **Que log emite?** | `message.received`/`message.sent`/`message.failed` (trigger, já existe); `ai_agent.dispatch_requested` (função nova); auditoria de toda mudança de canal (T053). |
| **Onde aparece na tela?** | Inbox (a mensagem), Central de Conexões (estado do canal, e o aviso de queda do gateway — T037), onboarding (o QR — T040/T041). |
| **Por qual porta se chega?** | Central de Conexões e onboarding, que a T044 faz convergir. Ambas passam a exigir `admin` (T045). |
| **Mecanismo anti-morte?** | Três: fila em disco do gateway (T025), reconciliação periódica do CRM (T050) e o alarme de divergência dentro dela. Sem o terceiro, os dois primeiros falham em silêncio. |
| **Onde se configura?** | `lib/env.ts` + `.env.example` (T054), falhando de forma legível na ausência. Nada exposto ao usuário final — é infraestrutura nossa. |
| **Continuidade IA↔humano?** | Inalterada. A feature muda o transporte, não o handoff: a mensagem chega no mesmo lugar, com o mesmo dispatch, e o humano assume pela mesma tela. |
| **≥2 arestas em `docs/architecture/`?** | Sim — `gateway_writer` liga gateway↔funções e funções↔`messages`/`event_log`. T069 registra. |

---

## Project Structure

### Documentation (this feature)

```text
specs/004-envio-pelo-gateway/
├── spec.md                          # requisitos (39 FR, 12 SC)
├── plan.md                          # este arquivo
├── decisao-escrita-direta.md        # a decisão que governa tudo
├── research.md                      # Fase 0 — as 6 decisões técnicas
├── data-model.md                    # Fase 1 — funções, papel, vocabulário
├── quickstart.md                    # Fase 1 — roteiros de validação
├── contracts/
│   └── gateway-provisioning-v1.md   # §1 superado pela decisão; §2-12 válidos
├── checklists/
│   └── requirements.md              # conformidade, com o FAIL de VII declarado
└── tasks.md                         # 58 tasks, 7 fases
```

### Source Code (repository root)

```text
# CRM — /root/PROJETOS/crm_3_0
supabase/
├── migrations/
│   ├── <ts>_0127_gateway_writer.sql       # NOVO — papel, zero grant de tabela
│   └── <ts>_0128_gateway_escrita.sql      # NOVO — as 4 funções
├── baseline.sql                            # apêndice idempotente das duas
└── migrations/MANIFEST.md                  # duas linhas novas

lib/
├── channels/
│   ├── index.ts                            # getAdapter — ganha o membro do gateway
│   ├── session-ref.ts                      # união ganha 'gateway'
│   └── gateway/                            # NOVO — adapter de envio (F2)
├── gateway/
│   ├── ingest.ts                           # entrada fica sem uso no caminho novo
│   └── reconciliacao.ts                    # NOVO — a ponta que puxa (FR-013a)
└── env.ts                                  # endereço + credencial do gateway

app/api/v1/
├── cron/
│   ├── recover-stuck-messages/route.ts     # CORRIGIR — fala WAHA cru (FR-020)
│   └── gateway-reconciliacao/route.ts      # NOVO — agenda T050
└── channel-sessions/route.ts               # criação converge (T044) + admin (T045)

app/(app)/conexoes/  e  app/onboarding/     # QR, expires_at, vocabulário de estado

tests/
├── invariants/                             # papel sem grant, funções sem HTTP, isolamento
├── unit/
└── e2e/                                    # F3 em conta nova, estado vazio

# Gateway — /root/PROJETOS/gateway_go (repo irmão, deploy separado)
internal/
├── store/                                  # NOVO — costura; duas implementações
│   ├── cotador.go                          # a de hoje
│   └── crm.go                              # NOVA — alvo CRM, por RPC
├── processor/mensagem.go                   # :100 troca o upsert cru pela função
├── entrega/                                # fila em disco vira item de 1ª classe
└── handlers/                               # rotas de provisionamento (T029, se T003 escolher)
```

**Structure Decision**: dois repositórios, versionados e implantados separado (Princípio XIV). No
CRM a feature **não cria diretório novo de domínio** — entra nas costuras que já existem
(`lib/channels/`, `supabase/migrations/`, `app/api/v1/cron/`). No gateway, o único diretório novo é
`internal/store/`, que é a costura que permite dois builds em vez de dois repos.

---

## Complexity Tracking

| Violação | Por que é necessária | Alternativa mais simples, e por que foi rejeitada |
|---|---|---|
| **Princípio VII — RESOLVIDO pela emenda v2.3.0.** Linha mantida como registro do que foi decidido e por quem | Decisão explícita do dono do produto em 2026-08-08, reafirmada após eu levantar a objeção doutrinária. O objetivo declarado é facilitar desenvolvimento e migração mantendo duas versões do gateway, uma por produto. | **Rejeitada: gateway dono do próprio armazenamento, entregando ao CRM por HTTP** (o desenho da spec 001 e do `gateway-provisioning-v1.md` original). É o que a constituição manda e foi a minha recomendação. O dono decidiu contra, com o trade-off medido e registrado. **A mitigação não é retórica**: a superfície fica em 4 funções versionadas, o papel não recebe grant de tabela nenhum (com invariante que reprova), o tenant é resolvido dentro do banco, e a emenda que nomeia a quarta superfície **foi feita** (v2.3.0, 2026-08-08) — com as seis travas como condição de existência da superfície, não como recomendação. |
| **Perda da fronteira de rede na direção de entrada** | Consequência inseparável da anterior: sem HTTP não há ACK-primeiro nem `webhook_events_log` como fila. | **Rejeitada: manter a rota assinada em paralelo.** Dois escritores para a mesma tabela, com duas idempotências e dois donos — é o defeito que o próprio `gateway-provisioning-v1.md` §1 nomeia. Em vez disso, a durabilidade fica nas duas pontas que XIV exige: fila em disco (FR-013) e reconciliação (FR-013a). |
| **Duas implementações do mesmo gateway** | O pedido é explícito: duas versões, uma por produto. | **Rejeitada: fork literal do repositório.** Todo conserto (normalizador, anti-banimento, retentativa, mídia) passaria a ser aplicado duas vezes, para sempre. A costura em `internal/store` entrega os dois serviços rodando sem duplicar o resto. |

---

## Riscos

| Risco | Probabilidade | Mitigação |
|---|---|---|
| **As travas de VII virarem letra morta** — a emenda saiu, e alguém implementa a função sem o invariante que a vigia | **alta**, e é o risco novo que a emenda criou | T011 e T016 são as travas 1, 5 e 6. Enquanto não estiverem verdes, o PASS de VII é promessa. Revisor de PR: se a função existe e o invariante não, **reprove** — a emenda permitiu a superfície *sob condição*, e sem a condição ela é proibida. |
| **`set constraints` esquecido numa função nova futura** | alta ao longo do tempo | T018 sabota exatamente isso. Vale escrever no cabeçalho de `0128` por quê, não só o quê — quem copiar a função copia o motivo. |
| **A reconciliação (T050) virar item de fim de fila** | alta — é o que costuma acontecer com rede de segurança | Está na Fase 5, antes da Fase 6, e o T068 (gateway derrubado) não passa sem ela. |
| **`recover-stuck-messages` esquecido** | média | É o defeito nomeado nos Edge Cases e virou T035 com o caminho de arquivo. Envia para o lugar errado **em silêncio** — o pior tipo. |
| **T003 não ser decidido e T014/T029 serem implementadas as duas** | média | T003 é Fase 0 e declara que a perdedora morre. |
| **Sessão concorrente mexer nos mesmos arquivos** | alta — árvore compartilhada | Commit por caminho explícito, nunca `git add .`; `git status` antes de qualquer merge. |

---

## Reavaliação pós-Fase 1

Refeita depois de `research.md`, `data-model.md` e `quickstart.md`:

- **Nenhum gate mudou de status.** VII segue o único FAIL, pelo mesmo motivo e com a mesma mitigação.
- **A Fase 0 fechou os 6 desconhecidos** — nenhum `NEEDS CLARIFICATION` sobreviveu ao research; o
  que restou aberto (T003) é **decisão de produto**, não desconhecido técnico, e está isolada numa
  task de Fase 0.
- **A decisão D2 do research reduziu o risco de III**: manter o `DEFERRABLE` e conviver com ele por
  `set constraints` evita uma mudança destrutiva de constraint num banco de instância única. O gate
  III passa mais folgado do que passaria com a alternativa.
- **D1 do research fechou o buraco de autenticação** que o plano não tinha respondido: o gateway
  **não** recebe a `service_role` key nem o segredo do JWT — recebe um token pré-assinado de papel
  único, rotacionável. Sem isso, o "papel sem grant de tabela" do gate I seria letra morta.
