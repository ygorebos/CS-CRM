# Fatia F1 — "o agente para de inventar"

**Spec** `specs/002-rag-por-operadora/` · **Branch** `feat/002-rag-por-operadora` · **2026-08-08**

Este arquivo registra **o que foi medido** e, com o mesmo destaque, **o que não foi**. Um
relatório que só lista o verde é o tipo de evidência que engana quem lê depois.

---

## O que foi medido

Todos os portões abaixo rodaram nesta árvore, nesta ordem, depois da última linha de código.

| Portão | Resultado |
|---|---|
| `pnpm typecheck` | limpo |
| `pnpm lint` | **0 erros** (185 avisos, todos pré-existentes) |
| `pnpm lint:channels` | ok — 61 arquivos de dívida conhecida, **nenhum novo** |
| `pnpm test:unit` | **292 arquivos, 2981 testes, todos verdes** |
| `pnpm test:shell` | todas as provas passaram |
| `pnpm test:db` | **71 arquivos, 477 testes**, 1 pulado — verde, com Postgres descartável nascido do `baseline.sql` |
| `pnpm build` | build de produção completo |

`pnpm test:db` é o portão que importa nesta fatia mesmo ela mexendo pouco em schema: ele é
o único caminho que aplica o `baseline.sql` que o self-hoster de fato roda.

### O teste confirmado por sabotagem (Princípio XI)

Teste que passa com a implementação sabotada é hipótese, não teste. Duas sabotagens, cada
uma revertida em seguida:

**Sabotagem 1 — o gate nunca arma.** Trocado o `if (ctx.assistanceGroundingEnforced !== true)`
por `if (true)`:

```
Test Files  3 failed | 1 passed (4)
     Tests  12 failed | 20 passed (32)
```

As 12 vermelhas são exatamente as que afirmam o veto. `search-knowledge.test.ts` continuou
verde — correto: ele não testa o gate, e uma sabotagem que derruba *tudo* não prova nada
sobre o que cada teste vigia.

**Sabotagem 2 — a classificação nunca reconhece afirmação.** `isAssistanceClaim` fixado em
`false`:

```
Tests  14 failed
```

Caíram os 5 casos de classificação (segunda via, carência/cobertura, pergunta+afirmação,
frase sem pontuação, acento/caixa) **e** os do gate que dependem dela. Depois de reverter,
28 testes verdes.

### O par que prova FR-015 (a configuração não mente)

`tests/unit/rag-must-hit-efeito.test.ts` é teste de **efeito**, não de gravação:

- **desligado**: `"A carência para internação é de 180 dias."` sem âncora → **enviada**
- **ligado**: o mesmo texto, a mesma ausência de âncora → **vetada**, `assistencia_sem_lastro`

O único delta entre os dois casos é o guardrail. Um teste de gravação (escreve, lê,
compara) passaria com folga sobre o defeito original, que era `rag_must_hit` salvar na tela
e **nenhum runtime ler**.

---

## O que NÃO foi medido

**Nada disto foi provado pela tela.** A doutrina de QA Visual é explícita: `curl` e teste
unitário validam o backend, não a experiência de quem instala. Esta fatia está provada por
unidade e por sabotagem — não pela tela.

| Item | Estado |
|---|---|
| Ambiente fresco estilo VPS (Supabase local pg17 + `baseline.sql` + `bootstrap-owner.ts` + WAHA + Redis, `RESEND_API_KEY` ausente) | **não montado** |
| `tests/e2e/assistencia-sem-lastro.spec.ts` (T015) | **não escrito** — depende do ambiente acima |
| SC-001 e SC-002 medidos numa bateria real de 20 perguntas (T131) | **não medidos** — o que existe é a prova unitária do veto, não a contagem em conversa real |
| J9.1 a J9.5 do `user-journey-map.md` | **pendentes**, registradas lá como pendentes |

E a advertência que precisa sobreviver a esta sessão: **a regressão dessas jornadas não é
vigiada por job nenhum.** O check `e2e` não é obrigatório na branch protection, e a spec da
mesma família (`vps-fresh-onboarding`) está entre as 4 que não rodam no CI (issue #63).

---

## Duas coisas que a análise cruzada achou e o código consertou

**1. A instalação fresca não recusaria nada.** O gate nasce desarmado na cadeia — decisão
correta, porque no caminho determinístico um veto seria drop silencioso. Só que nada armava
o agente do onboarding: `createDefaultAgent.ts` não gravava guardrail algum. As duas peças,
isoladas, estavam certas; a costura não existia. FR-030, SC-001, SC-011 e SC-017 seriam
falsos **com a suíte inteira verde**. Vigiado agora por
`tests/unit/agente-padrao-nasce-com-lastro.test.ts`.

**2. A citação era carimbada depois do envio.** O `update` pós-envio tinha um `catch` cujo
comentário dizia *"citação é enriquecimento, não invariante — falha só loga"*. Quando ele
falhava, a mensagem já estava no telefone do cliente. Agora a âncora viaja no `metadata` do
próprio insert (FR-024).

## Uma decisão de desenho que vale registrar

Quando o veto acontece, **quem fala com o cliente é o sistema**, não o modelo
(`FRASE_DE_RECUSA_SEM_LASTRO`). Se dependesse de o modelo reescrever, o turno em que ele
insistisse acabaria sem mensagem nenhuma — o cliente ficaria no vácuo por causa do
guardrail que veio melhorar o atendimento. É o "morre sem sintoma" que o invariante 4 do
sistema vivo proíbe.

E a recusa **não** chama `performHumanHandoff`: aquele caminho grava `force_human`
irrevogável, e puniria o corretor por uma lacuna do acervo dele. Carregado o material, o
agente tem de voltar a atender sozinho.
