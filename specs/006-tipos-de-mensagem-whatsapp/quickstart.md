# Quickstart — como provar a feature 006

**Feature**: 006-tipos-de-mensagem-whatsapp · **Data**: 2026-08-09

Este é o guia de **validação**, não de implementação. Ele diz o que rodar, em que ambiente, e
qual desfecho conta como prova. Detalhes de contrato estão em
[`contracts/api-mensagens-v1.md`](contracts/api-mensagens-v1.md); de dado, em
[`data-model.md`](data-model.md).

---

## 0. A regra que decide se a prova vale

`curl` **não** prova UX (Princípio IV). Serve como diagnóstico. A prova de toda jornada
visível é o navegador dirigido por Playwright, numa **conta nova**, no **estado vazio**.

E prova de formato de terceiro só existe medindo o terceiro (doutrina de medição, regra 5):
**dublê não prova** que o `quoted_id`, o vCard ou o menu chegam certos no aparelho.

---

## 1. Gates de código — o que roda em qualquer máquina

```bash
pnpm typecheck            # tsc --noEmit estrito
pnpm lint                 # eslint + lint-channels (nome de provedor fora de lib/channels reprova)
pnpm test:unit            # Vitest — NÃO inclui tests/invariants/**
pnpm test:db              # Postgres efêmero + baseline install/update + invariantes
```

**`test:db` é obrigatório antes de abrir PR** nesta feature: ela mexe em schema (M1 e M2) e
em projeção que filtra tenant. `pnpm test:unit` verde aqui é falso-verde — o isolamento RLS
não foi exercitado.

O que precisa ficar verde e é específico desta feature:

- par `messages_type_check` ↔ constante de união (`test:db`)
- projeção não cruza organização (`test:db`)
- reação não vira bolha; tipo desconhecido vira rótulo (`test:unit`)
- tela oferece só o que a capability declara (`test:unit`)
- nenhum envio novo escapa da cadeia `before_send` (`test:unit`, teste já existente estendido)

**Sabotagem obrigatória** (Princípio XI): antes de aceitar cada teste, quebre de propósito o
que ele vigia e confirme o vermelho. Teste que passa com a projeção desligada não é teste.

---

## 2. Ambiente fresco para a prova de tela

Receita não-óbvia — errar qualquer item aqui gasta uma rodada inteira:

- **Banco**: Supabase local **pg17** (`config.toml` `major_version = 17`; o baseline usa
  `GRANT MAINTAIN`, que é pg17+), com `supabase/baseline.sql` aplicado. **Não** a cadeia de
  `migrations/` — ela não sobe do zero.
- **Conta**: `scripts/bootstrap-owner.ts`. Estado vazio: sem canal conectado, sem
  conhecimento, sem lead.
- **App**: `next build` + `next start`. `next dev` compila lento demais e o Turbopack quebra
  `cookies()`.
- **Worktree**: `node_modules` real, **nunca symlink** (Turbopack rejeita "out of filesystem
  root"), e **fora de `/tmp`** (é limpo no meio da sessão — commite cada marco).
- **App de desenvolvimento nesta VPS** é serviço systemd: `systemctl restart crm-dev`.
  `kill` + `pnpm start` faz medir o build velho em silêncio.

```bash
pnpm test:e2e             # Playwright (requer o app servido)
```

**Estado que sobrevive entre execuções** (doutrina, regra 6): o fator de MFA fica no banco e o
segredo TOTP morre com o processo. O `beforeAll` zera o fator. Casos que logam em sequência
caem na mesma janela de 30 s e o segundo código é recusado — logue **uma vez** e compartilhe a
sessão (`mode: serial`).

---

## 3. Prova por User Story

### US1 — Ler a conversa inteira, sem buraco

**Como**: aparelho real do outro lado. O contato executa, em ordem: responde citando uma
mensagem antiga, reage com emoji, troca o emoji, remove a reação, manda localização, manda
cartão de contato, apaga uma mensagem.

**Desfecho que conta**:

- citação visível na bolha, dizendo de quem era o original;
- emoji **preso** à mensagem alvo — e **zero** bolhas com só um emoji na linha do tempo;
- troca refletida, remoção somem o emoji;
- localização com nome e endereço, com link para o mapa;
- contato com nome e telefone copiável;
- mensagem apagada com o conteúdo visível **e** a marca de apagada (FR-005);
- **zero bolhas em branco** na conversa inteira (SC-001).

**Âncora antes da asserção** (doutrina, regra 3): afirme `toHaveURL` da conversa, ou um
elemento que só existe nela, **antes** de qualquer `not.toMatch`. Sem âncora, o caso fica
verde medindo a tela de login.

**Limitação declarada, não escondida** (research R2): o apagamento **não chega** pelo canal
não-oficial hoje — a normalização daquele canal não tem o caso. O caso de apagamento
**afirma a pré-condição de canal** em vez de assumi-la, e o buraco entra no
`user-journey-map.md`. Rodar no canal errado e passar verde é o pior desfecho possível.

### US2 — Responder citando

**Como**: pela tela, escolher uma mensagem recebida, acionar "responder", enviar. Conferir no
aparelho real.

**Desfecho**: a citação chega apontando para a mensagem certa; a bolha do corretor também
mostra o trecho; citar mensagem cuja mídia não baixou identifica o tipo do anexo; alvo sem
identificador do canal **falha com motivo** e a mensagem não sai sem citação.

**Contagem de ações** (SC-003): no máximo 2 do gesto na mensagem até o envio — medido
contando os cliques da spec, não a olho.

### US3 — Localização, contato, figurinha

**Como**: enviar os três pela tela, conta nova, aparelho real do outro lado.

**Desfecho**: o mapa abre no lugar certo; o contato salva na agenda; a figurinha chega **como
figurinha**, sem moldura de imagem. **Zero** recusas do canal por campo obrigatório ausente
(SC-004) — inclusive nos casos que hoje falhariam (`location` e `contact` são os dois tipos
anunciados e inenviáveis que a feature conserta).

### US4 — Menu, botão de link, pedido de localização

**Como**: enviar cada um; do lado do cliente, tocar numa opção do menu.

**Desfecho**: opções clicáveis chegam; o clique volta e aparece **em texto legível** na
conversa (depende de US1 estar pronta — senão vira evento mudo); o botão de link chega com o
rótulo escrito pelo corretor; a localização respondida entra como localização legível.

---

## 4. Medições numéricas

| Critério | Como medir | Erro a não cometer |
|---|---|---|
| SC-005 — apagamento marcado em ≤10 s | diferença entre `created_at` do Postgres do evento e o instante em que a tela mostra a marca | `Date.now()` antes da chamada mistura a espera com a anterior e o primeiro intervalo não tem predecessor |
| SC-004 — zero recusas por campo ausente | contar respostas do canal em N envios cobrindo todos os tipos | contar só os que passaram |
| Projeção não degrada | conversa com **≥500 mensagens**, tempo de carregar uma página | medir em conversa de 10 mensagens não mede índice nenhum |
| SC-007 — nada oferecido sem suporte | percorrer canal a canal e listar as ações visíveis | testar num canal só |

---

## 5. Recurso pago que o teste cria, o teste apaga

Instância de canal custa por unidade. Toda execução que provisiona termina com o `DELETE`, e
a verificação é o **registro vazio** — não a intenção de apagar. É a mesma doutrina de
compensação que a feature de conexão implementa; vale para quem a testa.

---

## 6. Antes de dizer "pronto"

1. `pnpm typecheck` e `pnpm lint` zerados
2. `pnpm test:unit` e **`pnpm test:db`** verdes, com a sabotagem confirmada em cada teste novo
3. Playwright verde no ambiente fresco, com evidência visual em `.superpowers/evidence/`
4. Migrations M1/M2 com os **três** artefatos (migration + apêndice no `baseline.sql` + linha
   no MANIFEST)
5. `docs/testing/user-journey-map.md` atualizado — inclusive com o buraco do apagamento no
   canal não-oficial
6. Mapa vivo em `docs/architecture/` com a peça nova e ≥2 arestas
7. Verde parcial **não** é reportado como verde: diga qual suíte rodou e qual não rodou
