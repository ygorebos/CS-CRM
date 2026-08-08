# Specification Quality Checklist: Estruturas de agente pré-prontas (templates de partida)

**Purpose**: Validar completude e qualidade da especificação antes de seguir para o planejamento
**Created**: 2026-08-07
**Feature**: [spec.md](../spec.md)
**Iterações executadas**: 2 de 3

## Content Quality

- [x] Sem detalhes de implementação (linguagens, frameworks, APIs)
- [x] Focada em valor de usuário e necessidade de negócio
- [x] Escrita para quem não é técnico
- [x] Todas as seções obrigatórias preenchidas

## Requirement Completeness

- [ ] Nenhum marcador [NEEDS CLARIFICATION] restante — **3 restantes, dentro do teto de 3** (Q1 catálogo v1, Q2 conhecimento em "assistir", Q3 alcance de permissão para PME). Todos são decisão de escopo do dono do produto, cada um com recomendação do desenvolvedor já formada (princípio I). Não bloqueiam `/speckit-plan` das histórias P1.
- [x] Requisitos testáveis e sem ambiguidade
- [x] Critérios de sucesso mensuráveis
- [x] Critérios de sucesso agnósticos de tecnologia
- [x] Todos os cenários de aceite definidos
- [x] Edge cases identificados
- [x] Escopo claramente delimitado
- [x] Dependências e suposições identificadas

## Feature Readiness

- [x] Todo requisito funcional tem critério de aceite claro
- [x] Cenários de usuário cobrem os fluxos primários
- [x] A feature atende os resultados mensuráveis definidos em Success Criteria
- [x] Nenhum detalhe de implementação vaza para a especificação

## Conformidade com a constituição v1.1.0

- [x] Cabeçalho declara **qual missão do princípio IX** cada template serve (`constitution.md:236-237`) — e prova, por medição, que uma estrutura não pode servir as duas
- [x] Cabeçalho declara **onde a feature cai no teto de 10 minutos** do princípio VIII
- [x] Princípio VI (reusar antes de escrever) respondido: Assumptions 5, 6 e 11 apontam o que já existe e é reusado
- [x] Princípio I respeitado: suposição declarada por escrito; pergunta aberta vem com recomendação, nunca como catálogo de opções
- [x] Afirmação medida cita `arquivo:linha`; suposição está declarada como suposição
- [x] Living System Checklist respondido (DoD item 13)

## Registro das iterações de validação

### Iteração 1 — falhas encontradas e corrigidas

1. **"Success criteria mensuráveis"** falhava em dois itens redigidos como qualidade ("o corretor entende o que o agente faz"). Corrigido: SC-012 passou a ter unidade (≤30 segundos, por observação de uso) e os demais ganharam contagem explícita (0 vazamentos, 0 instalações parciais, ≤2 ações, 100% do conteúdo preservado).
2. **"Requisitos testáveis"** falhava em FR-013/FR-014, redigidos como intenção ("o template deve ser editável"). Corrigido: quebrados em obrigações verificáveis separadas — visibilidade item a item (FR-013), edição com o mesmo papel e sem desinstalar (FR-014), distinção origem × customização (FR-015), não-interferência entre itens (FR-016).
3. **"Edge cases identificados"** não cobria o caso derivado da medição do teto: template curado deixa jornada em estado "parcial" na tela. Adicionado como edge case e como FR-018.

### Iteração 2 — falhas encontradas e corrigidas

4. **"Sem detalhes de implementação"** falhava: três requisitos citavam nomes de tabela e coluna do banco. Corrigido — os nomes ficaram restritos às seções "Estado medido hoje", "Assumptions" e "Dependências", que são registro de medição, e saíram dos Functional Requirements e dos Success Criteria.
5. **"Escopo claramente delimitado"** falhava por ausência de fronteira explícita. Adicionada a seção "Fora de escopo", com seis exclusões, incluindo permissão por conexão (que é a Q3) e editor de templates pelo corretor.
6. **Premissa recebida do orquestrador estava errada e foi corrigida na spec, não repetida**: o teto de 20 não vive em `lib/agent-engine/agent/agent-config.ts` (lá o único 20 é o teto de `rag_top_k`, linha 122) e não é limite de usuários. Vive em `lib/mcp/tools/selecao-por-pacote.ts:24` e é teto de capacidades por agente. Registrado em Assumptions 1.

## Notes

- Os 3 [NEEDS CLARIFICATION] são deliberados e estão no teto permitido. As histórias P1 (corretor sozinho, autonomia de edição, voltar atrás) podem ir a `/speckit-plan` sem eles; Q1 afeta o conteúdo do catálogo, Q2 afeta uma parte da missão "assistir", Q3 afeta apenas a história P2 da PME.
- **Aviso de dado desatualizado no repositório** (fora do escopo desta spec, registrado em Dependências): `CLAUDE.md:217`, `AGENTS.md:74`, `AGENTS.md:136` e `docs/current-state.md:128` afirmam que a spec e2e `capacidades-do-agente` reprova pelo teto de 20 capacidades. Ela foi corrigida em `bf20db49` e roda no CI (`.github/workflows/e2e.yml:240`). Quem planejar esta feature partindo daqueles documentos parte de premissa falsa.
