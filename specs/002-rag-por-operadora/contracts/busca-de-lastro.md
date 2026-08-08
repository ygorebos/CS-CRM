# Contrato — a busca que fundamenta a resposta

A superfície mais crítica da feature. É onde SC-005 (não-vazamento entre operadoras), SC-007
(isolamento entre corretores) e SC-019 (precedência de camada) são ganhos ou perdidos.

---

## `fn_buscar_lastro`

```sql
fn_buscar_lastro(
  p_agent_id     uuid,
  p_operadora_id uuid,        -- a operadora do contato; NULL = desconhecida
  p_embedding    vector(1536),
  p_k            integer default 5,
  p_threshold    real    default 0.40
) returns table (
  chunk_id     uuid,
  layer        text,          -- 'tenant' | 'catalog'
  material_id  uuid,
  content      text,
  similarity   real,
  source_ref   jsonb          -- título, operadora, data de atualização: o que a tela mostra
)
```

`LANGUAGE sql STABLE SECURITY DEFINER`, `SET search_path TO 'public', 'pg_temp'`.

### A regra que ela implementa

1. **Tenant derivado, nunca recebido.** A organização sai de `fn_user_org_ids()`/`auth.uid()`, não
   de parâmetro. É a diferença que separa esta função da `retrieve_top_k_chunks`, cujo próprio
   comentário delega a validação ao chamador (`baseline.sql:917`) — e é o que FR-019 exige.
2. **Escopo por operadora.** Só entram trechos cuja operadora é `p_operadora_id` **ou** que estão
   marcados como "vale para todas". Trecho de outra operadora não sai daqui, em nenhuma
   circunstância (FR-016).
3. **`p_operadora_id IS NULL` devolve conjunto vazio** — exceto material "vale para todas". Operadora
   desconhecida **não** vira busca ampla: o sistema não escolhe operadora por ser a única cadastrada
   nem por semelhança (FR-017).
4. **Operadora desativada para o tenant não devolve nada** (`operadoras.is_active = false`) — trava
   4, FR-008.
5. **Material vencido não devolve nada** (`valid_until < current_date`) — FR-026. Sem validade
   declarada, ancora normalmente (FR-025).
6. **Precedência de camada**: se **qualquer** trecho `tenant` da operadora passa o limiar, os
   trechos `catalog` da mesma operadora saem do conjunto daquela resposta (research D7, FR-035).
7. **Ordenação final** por similaridade decrescente, `limit greatest(p_k, 0)`.

### Grants

```sql
revoke execute on function public.fn_buscar_lastro(...) from public, anon, authenticated;
grant  execute on function public.fn_buscar_lastro(...) to service_role;
```

As **duas** origens revogadas (Princípio I / `CLAUDE.md` item 9): o `revoke from public` não tira o
grant direto que `ALTER DEFAULT PRIVILEGES … TO anon` do baseline dá a toda função nova, e o
`revoke from anon` não tira o grant que o Postgres dá a `PUBLIC` na criação. `authenticated` entra
na lista porque nenhum caminho autenticado precisa dela — medido em research D2.

### Forward-fix na função antiga

No mesmo apêndice, `retrieve_top_k_chunks` perde `authenticated`. Ela permanece existindo para os
caminhos vivos (worker e MCP, ambos com admin client), mas deixa de ser alcançável por token de
tenant. É correção de um defeito que o Princípio XI nomeia, e vai junto porque a feature que mais
depende de isolamento não pode conviver com a porta aberta ao lado.

---

## Contrato do gate `assistance_grounding`

Entra em `BEFORE_SEND_GATES` na posição (2.5), entre `lgpd` e `pacing`.
`BEFORE_SEND_CHAIN_VERSION`: 6 → 7.

```ts
interface GroundingGateContext {
  /** Desarmado por default. Só o caminho do agente arma — igual ao internal_vocabulary da v6. */
  assistanceGroundingEnforced: boolean;
  /** Trechos que fundamentaram este texto. Vazio = sem lastro. */
  groundings: readonly Grounding[];
  /** Resultado da classificação determinística — nunca do modelo (research D4). */
  isAssistanceClaim: boolean;
}
```

**Veredito**:

| Situação | Resultado |
|---|---|
| `isAssistanceClaim = false` | `pass` — saudação, qualificação e discurso de conversão não exigem âncora (A-02, FR-020) |
| `isAssistanceClaim = true` e `groundings.length > 0` | `pass`, e as âncoras são gravadas **no insert da mensagem** (research D5) |
| `isAssistanceClaim = true` e `groundings` vazio | `veto` com `code: 'assistencia_sem_lastro'` |
| Busca indisponível | tratado como `groundings` vazio → `veto`. **Nunca** "responda com o que já sabe" (FR-013) |
| Tenant sem acervo nenhum | idem. A ausência de acervo não suprime a verificação (FR-014) |

**O veto produz três coisas, sempre as três**: a frase ao cliente sem vocabulário interno (FR-011),
a escalação para humano, e o item na Central com pergunta original, operadora e motivo (FR-012).
Um veto que produza só uma delas é defeito — é o que o teste de sabotagem tem de pegar.

**Entrada no trace** desde a fatia F1, inclusive quando desarmado (`verdict: 'skipped'`), para que
o ajuste do léxico da classificação seja feito sobre medição, e não sobre impressão.

---

## O que este contrato proíbe

- **Instrução de prompt como substituto.** FR-010: a verificação é do sistema. A mensagem que hoje
  manda o agente "responder com o que já sabe" quando a base cai
  (`lib/agent-engine/agent/search-knowledge.ts:108`) some.
- **Fundir operadoras numa afirmação.** Pergunta que cruza duas operadoras é respondida por
  operadora, cada parte com sua âncora, e a parte sem lastro é recusada isoladamente (FR-018).
- **Citação como enriquecimento.** Falha ao registrar a âncora impede o envio, não vira warning
  (FR-024). O `catch` que hoje "só loga" (`inbound-turn.ts:1494`) desaparece junto com o `update`.
