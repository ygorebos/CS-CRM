# Specification Quality Checklist: Envio e conexão pelo gateway

**Purpose**: Validar completude e qualidade da especificação antes do planejamento
**Created**: 2026-08-08
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Sem detalhe de implementação (linguagem, framework, API)
- [x] Focada em valor de usuário e necessidade de negócio
- [x] Escrita para quem decide produto, não só para quem codifica
- [x] Todas as seções obrigatórias preenchidas

> Ressalva declarada: a seção "As três frentes" cita caminhos de arquivo e nomes de rota do
> `gateway_go` e do CRM. Isso é **medição**, não desenho — o bloqueio da F1 é a descoberta central
> desta spec e afirmá-lo sem a evidência o tornaria opinião. As frentes, os requisitos e os
> critérios de sucesso seguem agnósticos.

## Requirement Completeness

- [x] Nenhum marcador [NEEDS CLARIFICATION] restante
- [x] Requisitos testáveis e sem ambiguidade
- [x] Critérios de sucesso mensuráveis
- [x] Critérios de sucesso agnósticos de tecnologia
- [x] Todos os cenários de aceite definidos
- [x] Casos de borda identificados
- [x] Escopo delimitado (há seção "Fora de escopo" explícita)
- [x] Dependências e premissas identificadas

## Feature Readiness

- [x] Todo requisito funcional tem critério de aceite claro
- [x] As histórias cobrem os fluxos principais das três frentes
- [x] A feature atende aos resultados mensuráveis definidos
- [x] Nenhum detalhe de implementação vazou para os requisitos

## Conformidade com a constituição v2.2.0

| Princípio | Como esta spec responde |
|---|---|
| **I** — isolamento de tenant | FR-017: conexão de destino resolvida do próprio canal, **nunca** do corpo. O pior caso da feature está nomeado nos Edge Cases: `connection_id` errado manda a mensagem pelo número de outra organização |
| **II** — nada é ilha | FR-023 (queda vira alerta **e** aviso na Central), FR-043 (auditoria de toda mudança de canal). O Living System Checklist completo é do `plan.md` |
| **III** — schema muda por migration | FR-040. Reversibilidade por canal em FR-041 é o caminho de volta declarado |
| **IV** — prova pela tela | US4 e SC-006 exigem conta nova, estado vazio, cronometrado; SC-010 exige o anexo abrindo **no aparelho** |
| **V** — evento na fila | FR-022: estado com dono declarado, nunca órfão. FR-010: função MUST NOT fazer HTTP — efeito colateral sai por `event_log`. FR-008 põe o pedido de turno do agente na **mesma transação** do insert, fechando a janela em que a mensagem existe e ninguém a atende |
| **VI** — contrato de API | FR-018: credencial em cabeçalho, nunca em query string |
| **VII** — interoperável por contrato | ⚠️ **NÃO-CONFORMIDADE ABERTA.** VII não proíbe "acoplamento" em geral: **enumera** as superfícies permitidas — API REST `/api/v1/`, MCP, webhooks. RPC PostgREST **não é nenhuma das três**, então nem o desenho mais cuidadoso declara conformidade por argumento. FR-001 a FR-004 preservam a *intenção* (função versionada, papel sem grant de tabela, tenant resolvido no banco), e é isso que torna a emenda defensável — mas a emenda tem de **nomear e delimitar a quarta superfície**, não só afrouxar a palavra "banco". T001 do `tasks.md`. Até lá, esta linha é não-conformidade declarada |
| **VIII** — corretor em 10 minutos | US4 é o passo 2 do onboarding. SC-006 exige contagem de passos **idêntica** |
| **IX** — vender ou assistir | Declarado no cabeçalho: serve às duas |
| **X** — operadora é dado curado | N/A — feature de transporte |
| **XI** — teste que prova e vigia | SC-012 exige sabotagem confirmada em **cada** teste novo. SC-005 exige varredura mecânica, não inspeção |
| **XII** — contexto antes de ação | Esta sessão leu a constituição (v2.2.0), o `CLAUDE.md` e os artefatos da spec 001 antes de escrever, e releu depois da compactação de contexto |
| **XIII** — cobrança mora no Cotador | Assumption explícita e item em "Fora de escopo" |
| **XIV** — gateway único e sem réplica | FR-018 (endereço é configuração), FR-023 (queda visível), FR-042 (só envelope). **A frente 1 existe justamente porque XIV proíbe o atalho** de o CRM escrever no banco do outro produto — e isso **continua valendo** na direção CRM→Cotador; o que a decisão de 2026-08-08 mudou foi a direção oposta. O que XIV cobra a mais agora são **as duas pontas de durabilidade**, que ele exige por escrito: FR-013 (fila em disco do gateway, com prova de reinício, teto e alarme) **e** FR-013a (reconciliação periódica do lado do CRM). A versão anterior desta spec deixava só a primeira e **derrubava um MUST** — corrigido em 2026-08-08 |

## Notas

- **A F1 é dependência externa.** A spec declara o contrato e trata a implementação no `gateway_go`
  como fora deste repo. Isso não é escopo escondido: está na tabela das três frentes, nas
  Assumptions e em "Fora de escopo".
- **FR-035 corrige um furo pré-existente** (as rotas de conexão do onboarding não exigem papel
  nenhum). Entrou como requisito em vez de ser deixado para depois porque a migração passa
  exatamente por ali, e carregar o furo para o caminho novo o tornaria mais caro de fechar.
- **US3 cenário 4 nomeia dívida que não nasce aqui.** Está na spec para que a migração não a
  agrave; fechá-la é escopo adicional, declarado em "Fora de escopo".
- Pendente para o `/speckit-plan`: o contrato de envio (`contracts/`) e o mapa de arquitetura.
