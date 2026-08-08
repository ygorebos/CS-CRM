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

## A prova pela tela — feita em 2026-08-08

Ambiente fresco montado do zero, pelo caminho do `install.sh`, e **isolado**: o Supabase de
dev da máquina ocupa 54321/54322 e o WAHA de pé pertence a outro worktree, então o stack
desta prova subiu em 544xx. Nada de ninguém foi derrubado.

| Passo | Resultado |
|---|---|
| Supabase local pg17 pela CLI, portas próprias | 9 contêineres |
| Cadeia de migrations do zero | **não sobe** — 0 tabelas, exatamente o que a doutrina afirma |
| `baseline.sql` em modo install (`ON_ERROR_STOP=1`) | **97 tabelas** |
| `bootstrap-owner.ts` | dono + org + super-admin |
| `pnpm e2e:build` + `next start` | produção, com `RESEND_API_KEY` e chave de IA **ausentes** |

`tests/e2e/assistencia-sem-lastro.spec.ts` — **4 casos, 4 verdes**, dirigindo o browser:

1. o aviso chega pela porta que o corretor já usa, **com contador**
2. o aviso carrega os três campos de FR-012 — pergunta original, operadora, motivo e o que fazer
3. o aviso **não fala a língua do sistema**: zero ocorrências de `guardrail`, `gate`, `grounding`, `chunk`, `embedding`, `rag_must_hit`
4. a conversa saiu do automático e está esperando uma pessoa

Capturas em `alertas-com-aviso-de-falta-de-material.png`,
`aviso-com-pergunta-operadora-e-motivo.png` e `conversa-de-volta-para-a-fila-humana.png`.

### O que a tela ensinou, e o teste não sabia

A porta da Central **não é** o item "Alertas" da barra lateral: o grupo `ia` do
`lib/navigation/registry.ts` não renderiza para o papel `agent` — quem atende no dia a dia
não veria o item nenhum. A porta real é o **sino do cabeçalho**, presente em toda tela e já
com a contagem. A primeira versão do spec falhou por assumir a porta errada, e é por isso
que a prova pela tela não é substituível por asserção de banco: ela mede o caminho que a
pessoa percorre, não o que o desenho supôs.

### Sabotagem da prova visual

`escalarAssistenciaSemLastro` alterada para não criar o aviso: **3 das 4 vermelhas**. A
quarta (a conversa volta à fila) permaneceu verde — e está correto, porque a sabotagem
atingiu só o aviso. Uma sabotagem que derrubasse as quatro esconderia que cada caso vigia
uma coisa diferente. Revertida, 4 verdes de novo.

### O seed chama a função real

`scripts/seed-e2e-assistencia-sem-lastro.ts` chama `escalarAssistenciaSemLastro`, não um
`INSERT` equivalente — mesmo princípio do `seed-e2e-escalacao.ts`. Um seed que montasse o
estado na mão provaria o teste contra uma cópia da regra, e no dia em que a função mudasse
o teste seguiria verde.

---

## O que ainda NÃO foi medido

| Item | Estado |
|---|---|
| **O veto em si, pela tela** | a suíte roda **sem chave de IA** (é o estado de um primeiro deploy). Para o gate decidir é preciso um turno com modelo. O veto está provado por unidade e por sabotagem; o que a tela prova é o que o corretor vê **depois** dele |
| **SC-001 e SC-002** numa bateria real de 20 perguntas (T131) | **não medidos** — depende da mesma chave |
| J9.1 a J9.3 do `user-journey-map.md` | pendentes; J9.4 e J9.5 passaram a estar cobertas |

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
