# Contrato — a busca que fundamenta a resposta

A superfície mais crítica da feature. É onde SC-005 (não-vazamento entre escopos), SC-007
(isolamento entre corretores) e SC-019 (precedência de camada) são ganhos ou perdidos.

"Escopo de conhecimento" é o nome estrutural; "operadora" é o rótulo que o nicho de validação exibe
(research D11).

---

## `fn_buscar_lastro`

```sql
fn_buscar_lastro(
  p_agent_id   uuid,          -- resolvido server-side a partir da conversa
  p_scope_id   uuid,          -- o escopo do contato; NULL = desconhecido
  p_embedding  vector(1536),
  p_k          integer default 5,
  p_threshold  real    default 0.40
) returns table (
  chunk_id     uuid,
  layer        text,          -- 'tenant' | 'catalog'
  material_id  uuid,
  content      text,
  similarity   real,
  source_ref   jsonb          -- título, escopo, data de atualização: o que a tela mostra
)
```

`LANGUAGE sql STABLE SECURITY DEFINER`, `SET search_path TO 'public', 'pg_temp'`.

### De onde vem o tenant

**De `p_agent_id`, nunca do chamador.** A função resolve internamente:

```sql
organization_id       := (select organization_id       from ai_agents where id = p_agent_id)
active_kb_version_id  := (select active_kb_version_id  from ai_agents where id = p_agent_id)
```

Isto é o que FR-019 exige: o isolamento **não depende** de o chamador informar corretamente o
próprio tenant. Ele aponta um agente — que o runtime resolve a partir da conversa, não do input do
usuário — e a organização é *consultada*, não *afirmada*.

**Por que não `auth.uid()`** (brecha 7, corrigida em 2026-08-08): o chamador real é o agent-engine,
que fala com o banco por Pool `pg` com credencial de serviço (`search-knowledge.ts:65`). Não há
sessão de usuário, `auth.uid()` é NULL, e uma função que derivasse o tenant dali devolveria conjunto
vazio em toda chamada de produção.

### A regra que ela implementa

1. **Tenant e acervo derivados de `p_agent_id`** — acima.
2. **Escopo.** Só entram trechos cujo escopo é `p_scope_id` **ou** que estão marcados como "vale
   para todos". Trecho de outro escopo não sai daqui, em nenhuma circunstância (FR-016).
3. **`p_scope_id IS NULL` devolve apenas material "vale para todos"** — nunca busca ampla. Escopo
   desconhecido não faz o sistema escolher por ser o único cadastrado nem por semelhança (FR-017).
4. **Escopo desativado para o tenant não devolve nada** (`knowledge_scopes.is_active = false`) —
   trava 4, FR-008.
5. **Material vencido não devolve nada** (`valid_until < current_date`) — FR-026. Sem validade
   declarada, ancora normalmente (FR-025).
6. **Precedência de camada, dentro do mesmo balde.** Se algum trecho `tenant` do balde passa o
   limiar, os trechos `catalog` **daquele balde** saem do conjunto. Balde = ou o escopo específico,
   ou "vale para todos" — nunca os dois juntos (research D7). Sem essa separação, um texto do
   corretor sobre o horário de atendimento dele apagaria o procedimento de boleto da operadora.
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
a escalação para humano, e o item na Central com pergunta original, escopo e motivo (FR-012). Um
veto que produza só uma delas é defeito — é o que o teste de sabotagem tem de pegar.

**`rag_must_hit` passa a ter efeito** (FR-015). O guardrail existe em `lib/ai/guardrails-schema.ts`,
é editável na tela, é validado por Zod, é salvo no banco — e nenhum runtime o avalia. Ele arma este
gate, e `min_citations` vira o piso de `groundings.length`. É o defeito que originou o Princípio XI,
e fechá-lo exige **teste de efeito**, não de gravação: prova de que ligar a opção muda o
comportamento, não de que o valor foi persistido.

**Entrada no trace** desde a fatia F1, inclusive quando desarmado (`verdict: 'skipped'`), para que o
ajuste do léxico da classificação seja feito sobre medição, e não sobre impressão.

---

## Pergunta que cruza dois escopos (FR-018)

O veto é **por afirmação**, não por mensagem. Quando o cliente pergunta sobre dois escopos ("meu
plano é o X e o da minha mãe é o Y"), cada parte é buscada com seu próprio `p_scope_id` e ancorada
separadamente. A parte sem lastro é recusada **isoladamente**, sem derrubar a que tem.

Fundir material de escopos diferentes numa afirmação única é proibido — e é o modo de falha que uma
implementação ingênua produz sozinha, chamando a busca uma vez com os dois escopos.

---

## O que este contrato proíbe

- **Instrução de prompt como substituto.** FR-010: a verificação é do sistema. A mensagem que hoje
  manda o agente "responder com o que já sabe" quando a base cai
  (`lib/agent-engine/agent/search-knowledge.ts:108`) some.
- **Busca ampla quando o escopo é desconhecido.** `p_scope_id IS NULL` não vira "procure em tudo".
- **Citação como enriquecimento.** Falha ao registrar a âncora impede o envio, não vira warning
  (FR-024). O `catch` que hoje "só loga" (`inbound-turn.ts:1494`) desaparece junto com o `update`.
