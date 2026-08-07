# Specification Quality Checklist: Recebimento unificado pelo gateway

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

**Nota**: os nomes `gateway` e `CRM` aparecem porque são as **duas partes do acordo de negócio**
que esta feature estabelece, não escolha de implementação — a decisão de usar o gateway veio do
dono do produto. Nenhuma linguagem, biblioteca, nome de tabela, rota ou algoritmo de assinatura
aparece nos requisitos; tudo isso é decidido no `plan.md`.

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Conformidade com a constituição v1.1.0

- [x] **Princípio I** — isolamento: FR-009, FR-010, FR-011, FR-018; SC-005 mede
- [x] **Princípio II** — sistema vivo: FR-022 (cadeia viva), FR-027 (falta de gateway visível na
      tela), FR-015 (fila de descarte inspecionável)
- [x] **Princípio IV** — prova pela tela: US1/US2/US5 têm teste independente pela tela; SC-006
      cronometrado em instalação fresca
- [x] **Princípio V** — evento na fila e idempotência: FR-012 (ACK primeiro), FR-016
- [x] **Princípio VII** — interoperável por contrato: FR-001..FR-004; o gateway entrega envelope,
      não escreve no banco do CRM
- [x] **Princípio VIII** — 10 minutos: declarado no cabeçalho; FR-028, SC-006, SC-007
- [x] **Princípio IX** — missão declarada no cabeçalho (serve às duas)
- [x] **Princípio XI** — teste que prova e vigia: FR-031, FR-032, FR-033; SC-011 exige confirmação
      por sabotagem

## Notes

- Zero marcadores de clarificação: as três decisões que a análise deixara em aberto foram fechadas
  como **suposições declaradas** (gateway por instalação; "demais webhooks" = tráfego de canal;
  ciclo de vida da conexão fora do escopo), conforme a regra de "recomendação única, não catálogo
  de opções". Qualquer uma pode ser revertida pelo dono do produto — o que muda é escopo, não
  arquitetura.
- Validação executada em uma iteração; todos os itens passaram.
