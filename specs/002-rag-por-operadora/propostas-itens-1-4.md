# Propostas dos itens 1–4 — o que foi acordado antes de executar

> **Por que este arquivo existe.** As quatro propostas foram apresentadas e aprovadas antes da
> execução ("sim, propõe as edições dos itens 1-4, depois /speckit-implement"). O texto original
> ficou na parte compactada da sessão e não sobreviveu ao transcript visível — só ao arquivo bruto
> em `~/.claude/projects/-root-PROJETOS-crm-3-0/dd96cbd4-….jsonl`.
>
> **Isto é reconstrução, e está dito em voz alta**: o conteúdo abaixo é fiel ao que foi proposto e
> ao que foi executado, mas foi escrito em 2026-08-10, depois. Registro que depende de memória de
> sessão não é registro — é lembrança. Este arquivo existe para a próxima pessoa não ter de
> confiar na minha.

Origem: `/speckit-analyze` sobre `specs/002-rag-por-operadora/`, que apontou quatro lacunas entre
o que a spec exigia e o que a branch tinha.

---

## Item 1 — Atualizar a branch com a `main` antes de qualquer código

**Proposto**: `git fetch origin && git merge origin/main` na branch da 002 antes de escrever
qualquer linha. Nunca `reset --hard`.

**Por quê**: doutrina de higiene de branches do `CLAUDE.md` — trabalho iniciado em branch atrasada
gera conflito e retrabalho, e é a causa número um de estrago em ambiente multi-sessão.

**Executado**: feito, e **três vezes**. A faixa de numeração de migration colidiu com a `main` em
cada rodada, e em todas quem chegou depois cedeu. Numeração final: 0132–0136. Na terceira, outra
sessão renomeou os arquivos dentro da minha worktree e deixou o `MANIFEST` desatualizado — completei
e conferi as 7 linhas contra os 7 arquivos.

---

## Item 2 — Os dois invariantes que faltavam

**Proposto**: T075 (precedência de camada) e T102 (rastreabilidade sobrevive à reindexação), contra
Postgres real, não contra dublê.

**Por quê**: as duas afirmações são sobre o que a BUSCA faz. Dublê de supabase-js aceita qualquer
encadeamento e devolve o que o teste mandou devolver — mediria a minha cópia da regra.

**Executado**:
- `tests/invariants/precedencia-de-camada.test.ts` — 11 casos. Tenant vence catálogo **dentro do
  mesmo balde**; "vale para todos" sobrevive.
- `tests/invariants/rastreabilidade-sobrevive-reindex.test.ts` — 8 casos. `message_groundings` não
  tem FK para o trecho de propósito: com cascade a reindexação apagaria o histórico, com restrict
  ela falharia.

---

## Item 3 — A sabotagem de T093

**Proposto**: desarmar o gate no código e rodar a cadeia. Teste que continua verde é hipótese, não
prova (Princípio XI).

**Executado**, e depois repetido em mais dois lugares que a execução revelou:
1. `assistance_grounding` desarmado → `pnpm test:unit -- before-send` fica vermelho;
2. `.neq("status","resolved")` removido da rota da Evolução → `lacunas-acionaveis` reprova com "a
   lacuna coberta continuou na lista";
3. `retry` trocado de volta por `skipped` no debounce do indexador → `rag-indexer.test.ts` reprova
   em "devolve retry com horário, e NÃO skipped".

---

## Item 4 — A rota `DELETE /api/v1/knowledge-scopes/{id}` (T099)

**Proposto**: fechar a outra metade de FR-008 — remover a operadora própria, com o acervo dela
ficando inerte.

**O que a execução mudou no desenho, e é a parte que importa**: `delete from knowledge_scopes` **não
roda** com material no balde. A FK de `ai_knowledge_sources.scope_id` é `on delete set null`, e a
constraint `ai_knowledge_sources_scope_xor_all` (0118) exige balde OU "vale para todos" — apagar
deixaria a fonte sem nenhum dos dois. Medido num Postgres descartável antes de qualquer conclusão.

A remoção virou **lógica** (migration 0135, `deleted_at`), com o acervo **arquivado** em vez de
apagado. A saída "óbvia" para a constraint — soltar o ponteiro com `applies_to_all = true` — faria o
material da operadora removida responder a todo mundo sobre tudo: o oposto exato de FR-008, e
invisível na tela. É por isso que `tests/invariants/escopo-removido-fica-inerte.test.ts` tem o caso
"não é promovido ao balde 'todos'".

E o teste unitário da rota, com dublê, **passava verde** sobre o `delete` impossível. Só o
invariante contra Postgres real pegou.
