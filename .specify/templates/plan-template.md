# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]

**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]

**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]

**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]

**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]

**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]

**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]

**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]

**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Fonte: `.specify/memory/constitution.md` v1.0.0. Marque PASS/FAIL/N/A por gate; todo FAIL
precisa de linha na Complexity Tracking com a alternativa mais simples que foi rejeitada.

| # | Gate | Pergunta que o plano responde | Status |
|---|---|---|---|
| I | Isolamento de tenant | Toda tabela nova tem `organization_id` + RLS? Handler com service role filtra a org de fonte confiável (nunca do body)? `getUser()` em vez de `getSession()`? Função nova em `public` revoga `execute` de `public` **e** `anon`? | |
| II | Nada é ilha | Living System Checklist respondido: quem alimenta, quem é alimentado, que log emite, onde aparece na tela, por qual porta se chega, mecanismo anti-morte, onde se configura, continuidade IA↔humano? Peça nova entra em `docs/architecture/` com ≥2 arestas? | |
| III | Schema viaja com o clone | Mudança de schema sai como migration versionada **+** apêndice idempotente no `baseline.sql` **+** linha no MANIFEST? Constraint nova corrige os dados antes de ser criada? | |
| IV | Prova pela tela | Fluxo visível será provado por Playwright em ambiente fresco (baseline + bootstrap-owner, envs opcionais ausentes), não por `curl`? Efeito externo tem receiver real? | |
| V | Evento na fila | Nenhum trigger faz HTTP? Evento externo tem `unique (organization_id, external_id)` + captura de `23505`? POST de criação aceita `Idempotency-Key`? A fila tem dono declarado? | |
| VI | Contrato de API | Rota sob `/api/v1/` com `ok()`/`fail()`, Zod em todo input externo, audit log na mutação, rate limit se pública, credencial em header, token como hash SHA256? | |
| VII | Interoperável por contrato | Integração externa consome API v1 / MCP / webhooks — sem acesso direto ao banco do outro sistema nem FK cruzando fronteira de produto? Entidade trocada carrega `organization_id` e é rastreável até o lead? | |

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
