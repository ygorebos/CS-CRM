# T099 — remoção de operadora, provada pela tela

Executado em 2026-08-09, ambiente fresco: Supabase local **pg17** com o
`supabase/baseline.sql` aplicado (install), `scripts/seed-e2e-credentials.ts`,
`next build` + `next start` na porta 3011, Playwright/chromium.

```
pnpm exec playwright test --workers=1 escopo-remocao.spec.ts
  5 passed (15.7s)
```

| Captura | O que ela prova |
|---|---|
| `lista-com-remover-so-no-proprio.png` | o botão "Remover" existe na operadora que o corretor criou e **não existe** no espelho do catálogo, que está na mesma tela — a recusa é dita pela ausência, não por um 403 depois do gesto |
| `pergunta-antes-de-remover.png` | o primeiro clique pergunta, e a pergunta diz o que para, o que fica arquivado e o que continua explicável |
| `depois-de-remover.png` | a linha saiu da lista, e o aviso fala em material **arquivado** (a palavra "apagado" não aparece, porque não é o que acontece) |

## O defeito que esta execução achou

Com o filtro `deleted_at is null` **só na rota**, a operadora removida sumia da lista e
**voltava ao recarregar a página**: a tela é Server Component e lê `knowledge_scopes`
direto do banco. Nenhum teste de unidade pegaria — os dublês de supabase-js não sabem que
existem dois leitores.

Corrigidos os três leitores que faltavam: a tela de escopos, a de materiais (que agrupa por
escopo) e `carregarEscoposDoTenant`/`vinculoDoContato` do agent-engine.

## O que este spec NÃO prova

A inércia na busca. "O material para de ancorar" é afirmação sobre `fn_buscar_lastro`, e
exercitá-la exigiria um turno com modelo — a suíte E2E roda sem chave de IA de propósito.
Essa metade está em `tests/invariants/escopo-removido-fica-inerte.test.ts`, contra Postgres
real, com o caso que prova que o material removido não é promovido ao balde "vale para
todos".
