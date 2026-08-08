# Quickstart — como provar que o recebimento pelo gateway funciona

**Data**: 2026-08-07 · **Spec**: [spec.md](../001-migracao-waha-uazapi/spec.md) ·
**Contrato**: [contracts/gateway-inbound-v1.md](./contracts/gateway-inbound-v1.md)

Este é o **guia de validação**, não de implementação. Cada bloco abaixo prova um critério de
sucesso da spec. A regra do Princípio XI vale em todos: **um teste só conta como prova depois de
ficar vermelho com a implementação sabotada.**

---

## 0. Ambiente (obrigatório antes de qualquer prova)

O ambiente tem que imitar a instalação fresca de uma VPS, não a sua máquina de desenvolvimento.

- Postgres **pg17** limpo, com `supabase/baseline.sql` aplicado (**não** as `migrations/` — a
  cadeia fresh não sobe, `README.md:105`), mais `scripts/bootstrap-owner.ts` — é o que o
  `install.sh` faz.
- `next build` + `next start`. **Não** use `next dev`: compila lento demais e o Turbopack quebra
  `cookies()`.
- Worktree com `node_modules` real (nunca symlink) e **fora de `/tmp`**.
- **Envs opcionais ausentes de propósito** (ex.: sem `RESEND_API_KEY`) — é o estado de um primeiro
  deploy, e é onde moram os piores defeitos de primeira impressão.

> Receita detalhada: doutrina de QA Visual no `CLAUDE.md`, e `docs/runbooks/supabase-dev-local.md`
> para o Supabase de desenvolvimento desta VPS.

---

## 1. SC-001 e SC-002 — a mensagem chega, e chega uma vez só

**Prova de aceite da US1.** É a costura inteira em um fio.

1. Suba a stack fresca com o gateway em modo relay, conectado a um número de teste.
2. Envie uma mensagem real de um celular para esse número.
3. **Pela tela** (Playwright, não `curl`): abra o inbox e confirme contato, conversa e corpo.
4. Cronometre do envio até a mensagem aparecer. Alvo: **≤5s em 95% de 20 envios**.
5. Force o gateway a reentregar **todos** os eventos da sessão. Confirme que a contagem de
   mensagens no inbox **não muda**.

**Sabotagem que tem de reprovar**: remova a captura de violação de unicidade no ingest — o passo 5
passa a duplicar e o teste tem que ficar vermelho.

---

## 2. SC-003 — nada se perde com o CRM fora do ar

**Prova de aceite da US2.**

1. Derrube o processo do CRM (só o CRM; o gateway continua de pé).
2. Envie 10 mensagens reais ao longo de 5 minutos.
3. Suba o CRM.
4. Confirme pela tela que as **10** aparecem, na ordem, sem duplicata.
5. Repita reiniciando **o gateway** no meio do intervalo — a pendência tem que sobreviver
   (é o que separa fila durável de fila em memória, D5).

> ⚠️ **`ENTREGA_FILA_DIR` tem que apontar para um VOLUME antes do passo 5.** Ela nasce vazia, e
> vazia significa **entrega sem durabilidade** — o comportamento anterior à feature. Apontá-la para
> um caminho dentro da imagem tem o mesmo efeito: o reinício leva a pendência junto. Rodar §2 sem
> isso prova o oposto do que a US2 promete, e a falha passa como legítima.

**Sabotagem que tem de reprovar**: troque a fila em disco por fila em memória — o passo 5 perde
mensagens e o teste tem que ficar vermelho.

---

## 3. SC-004, SC-005 e SC-012 — o que não é autêntico não entra, e não vaza

**Prova de aceite da US3.** Roda no gate de banco real (`pnpm test:db`), não em unitário —
`test:unit` **não** executa `tests/invariants/**`, e isolamento provado só em unitário é falso
verde.

Dispare contra a rota, nesta ordem:

> **Ressalva registrada (2026-08-08).** O roteiro pedia um **emissor HTTP real**. A prova foi
> entregue como invariante de banco (`gateway-inbound-autenticidade.test.ts`), cujo emissor é SQL,
> não HTTP — desvio declarado na nota de T040. O que se ganhou: a prova roda no job `invariants`,
> obrigatório na branch protection, em vez de depender de um processo externo que ninguém sobe no
> CI. O que se perdeu: a rota não é exercitada pela pilha HTTP nesta prova. O caso 7 continua sendo
> coberto ponta a ponta pela spec de Playwright.

| # | Requisição | Esperado |
|---|---|---|
| 1 | sem `X-Gateway-Signature` | `401`, zero linhas gravadas |
| 2 | assinatura inválida | `401`, zero linhas gravadas |
| 3 | assinatura válida, `X-Gateway-Timestamp` de 10 min atrás | `401` (fora da janela) |
| 4 | assinatura válida da organização A, token da organização B | `401`, nada em nenhuma das duas |
| 5 | `organization_id` no corpo apontando outra org | vence o token; a linha nasce na org do token |
| 6 | segredo removido da conexão | **`503` `gateway_secret_not_provisioned`** — fecha, nunca abre |
| 7 | entrega legítima | `202`, linha na org certa |

Depois: com **duas organizações reais** recebendo tráfego ao mesmo tempo, prove que um usuário da
org A enxerga **zero** linhas da org B em `messages`, `conversations` e `contacts` — com o **caso
de controle** provando antes que as linhas da org B existem. Sem o caso de controle, o teste
passaria com a tabela vazia.

Por fim (SC-012): reconstrua as 6 recusas **apenas** a partir de `webhook_events_log`, sem olhar
log de aplicação.

**Sabotagem que tem de reprovar**: substitua a comparação de assinatura por `===`, ou troque a
origem do `organization_id` do token para o corpo. As duas têm de derrubar a suíte.

---

## 4. SC-006 e SC-007 — o corretor não sabe que existe um gateway

**Prova de aceite do Princípio VIII.** Cronometrada, em instalação fresca, sem suporte humano.

1. **Conta nova em banco fresco** (`baseline.sql` + `bootstrap-owner`), não instalação nova — a
   v2.2.0 redefiniu "fresco" como conta, e aposentou o kit self-host.
2. Cronômetro começa no **cadastro** (v2.2.0 moveu o início do relógio; era o login).
3. Conecte o canal e mande uma mensagem real de outro celular.
4. Cronômetro para na **primeira resposta do agente**.
5. Alvo: **≤10 minutos**, e **sem regressão** contra a medição anterior a esta feature.
   ⚠️ **Essa medição de base não existe registrada em lugar nenhum.** Ou ela é levantada antes
   (rodando a jornada com `GATEWAY_INBOUND_ENABLED=false`), ou "sem regressão" não é verificável e
   o critério vira opinião. Ver T065.
6. Conte os passos de tela antes e depois da feature. Diferença esperada: **zero**.

Se aparecer qualquer tela, campo ou instrução mencionando "gateway", a feature **falhou** este
critério, mesmo com tudo o mais verde.

---

## 5. SC-008 — canal novo sem código de ingestão novo

**Prova de aceite da US4.**

1. Entregue um envelope normalizado de um canal diferente de WhatsApp.
2. Confirme pela tela que a conversa aparece identificada com o canal de origem.
3. Meça: **zero** linhas de código de ingestão específicas daquele canal no CRM (só valor novo de
   vocabulário e linha de capacidade).

---

## 6. SC-009 — mídia abre

**Prova de aceite da US5.**

1. Envie imagem, áudio e documento reais.
2. Abra os três pela tela. Confirme que o endereço servido **expira**.
3. Entregue um envelope cujo `media.ref` aponte para um host externo arbitrário. Confirme que o
   CRM **não** o busca e que a mensagem entra sem o anexo, com o motivo registrado.

**Sabotagem que tem de reprovar**: faça o CRM usar o host que veio no payload — o passo 3 passa a
buscar o host externo e o teste tem que ficar vermelho.

---

## 7. SC-010 — rajada

**Ambiente, além do §0**: Upstash configurado (sem ele o teto de taxa degrada para por-processo e a
rajada não prova nada sobre produção — `plan.md`, risco 5); um agente com chave de LLM (senão não
existe "ritmo de resposta do agente" para medir); e um emissor capaz de 200 msg/60s. **O teto de
taxa fica LIGADO** — rajada provada com o limite desligado não prova nada.

1. Dispare 200 mensagens em 60 segundos.
2. Confirme: 200 no inbox, zero duplicatas, e o ritmo de resposta do agente ainda obedecendo os
   limites anti-banimento existentes.

**Sabotagem que tem de reprovar**: remova a captura de `23505` no insert de `messages` — a rajada
passa a produzir duplicatas e o passo 2 tem que ficar vermelho.

---

## 8. SC-011 — a suíte inteira, e a sabotagem de cada teste novo

Ordem exata, e **nenhuma etapa vale sozinha**:

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell
pnpm test:db      # obrigatório: esta feature toca schema e RLS
pnpm build
pnpm test:e2e     # com o ambiente fresco da §0
```

`pnpm gov:verify` **não** cobre `test:db` nem `test:e2e` — tratá-lo como "tudo verde" numa
mudança de schema é o falso verde documentado em `docs/harness-audit.md`.

Depois de verde: para **cada** teste novo, sabote o código que ele vigia e confirme que fica
vermelho. Teste que continua verde com a implementação quebrada não é prova, e não conta.

---

## 9. Rollback — a prova que quase ninguém faz

1. Com uma conexão já migrada e recebendo pelo gateway, volte a chave de corte para o caminho
   legado.
2. Confirme que as mensagens continuam entrando, pelo caminho antigo, **sem perder** o que estava
   em voo.
3. Volte a chave para o gateway. Confirme que não duplicou.

Sem esta prova, FR-029 e FR-030 são promessa, não garantia — e num produto self-host, quem não tem
volta não tem virada.
