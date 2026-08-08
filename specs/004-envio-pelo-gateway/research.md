# Research — Fase 0

**Spec**: [spec.md](./spec.md) · **Plano**: [plan.md](./plan.md) · **Decisão que governa**:
[decisao-escrita-direta.md](./decisao-escrita-direta.md)

Seis desconhecidos entraram nesta fase. Cinco fecharam com decisão; o sexto é decisão de **produto**,
não técnica, e está isolado numa task de Fase 0 (T003).

---

## D1 — Como o gateway se autentica como `gateway_writer`

**Decisão**: **token JWT pré-assinado, de papel único, emitido por nós e rotacionável.** O gateway
recebe o token; **nunca** a `service_role` key do CRM e **nunca** o segredo do JWT.

**Contexto medido**: hoje o gateway fala com o PostgREST do Cotador mandando a `service_role` key
nos dois cabeçalhos (`internal/supabase/client.go:33-34`):

```go
"apikey":        c.serviceRoleKey,
"Authorization": "Bearer " + c.serviceRoleKey,
```

Repetir isso contra o CRM entregaria ao gateway uma chave que **bypassa RLS em todas as tabelas** —
e tornaria o "papel sem grant de tabela" do gate I letra morta, porque o papel nem seria usado.

**Rationale**: o token carrega `{"role": "gateway_writer"}` e o PostgREST troca de papel ao
processá-lo. Isso mantém a camada de dados do gateway como está (HTTP + PostgREST), o que é o que
faz T020/T021 serem costura barata em vez de reescrita. O gateway não consegue emitir outro token
porque não tem o segredo — ele só apresenta o que recebeu.

**Alternativas consideradas**:

| Alternativa | Por que não |
|---|---|
| `service_role` key, como hoje no Cotador | Bypassa RLS em tudo. É o oposto do que a decisão prometeu como mitigação. |
| Dar o **segredo do JWT** ao gateway, para ele assinar | Pior que a anterior: quem tem o segredo emite qualquer papel, inclusive `service_role`. |
| Conexão Postgres direta (`pgx`) com senha do papel | Autenticação de papel de verdade e sem superfície PostgREST — **tecnicamente a mais limpa**. Rejeitada por custo: troca a camada de dados inteira do gateway de HTTP para driver SQL, o que transforma T020/T021 de costura em reescrita, e some com o `Prefer`/`on_conflict` que o resto do código do gateway usa. **Reavaliar** se o fork acabar divergindo muito. |

### D1.1 — A armadilha do `authenticator` (medida, e ela quebra o gate obrigatório)

Para o PostgREST trocar de papel, `authenticator` precisa ser membro de `gateway_writer`:

```sql
grant gateway_writer to authenticator;
```

**`authenticator` não existe no Postgres efêmero do `pnpm test:db`.** Medido: `scripts/test-db.sh`
cria `anon`, `authenticated` e `service_role` (`:53-60`) e **não** cria `authenticator`; e
`grep -c authenticator supabase/baseline.sql` devolve **0** — os papéis de cluster do Supabase não
entram no dump de schema.

Consequência prática: um `grant ... to authenticator` solto na migration **reprova o job
`invariants`**, que é obrigatório na branch protection. A migration 0127 tem de:

1. criar `gateway_writer` com guarda (`if not exists`, como o próprio harness faz);
2. condicionar o `grant ... to authenticator` à existência do papel;
3. permanecer idempotente na re-aplicação (modo update do baseline).

```sql
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'gateway_writer') then
    create role gateway_writer nologin;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant gateway_writer to authenticator';
  end if;
end $$;
```

Sem o passo 2 a migration passa na nossa instância e reprova no CI — o pior padrão de falha, porque
parece funcionar onde você testou.

---

## D2 — Manter o `DEFERRABLE` de `messages_org_external_id_unique`

**Decisão**: **manter**. Conviver com ele por `set constraints ... immediate` dentro de cada função
de escrita.

**Contexto medido** (pg17 descartável, nesta sessão):

| Tentativa | Resultado |
|---|---|
| `on conflict (organization_id, external_id) do nothing` | `ERROR: ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters` |
| índice único **imediato** adicional + `on conflict` | **mesmo erro** — o índice novo não é escolhido como árbitro |
| `exception when unique_violation` sem preparar nada | **não captura** — o 23505 estoura no `COMMIT`, fora do bloco, e mata a transação |
| `set constraints ... immediate` + `exception when unique_violation` | **funciona** |
| pré-checagem por `select` antes do `insert` | funciona, mas corre — dois webhooks simultâneos passam os dois |

**Rationale**: tirar o `DEFERRABLE` é mudança de constraint num banco de **instância única**, sem
versão de escape, e exigiria a mesma medição que o precedente do repo cobra (`baseline.sql:9124`:
*"Perde o DEFERRABLE: medido, nenhum caminho escreve ... com violação transitória"*). O ganho seria
poder usar `on conflict` — conveniência de idioma. O custo é uma janela em produção por conveniência.
`set constraints` custa uma linha e resolve.

**Alternativas consideradas**: dropar o `DEFERRABLE` com expand/contract (adiado, não descartado —
se um dia várias funções carregarem a linha por herança, reavaliar, com a medição que o precedente
exige); índice único adicional (**não funciona**, medido acima).

**Consequência para quem escrever código**: toda função nova que insira em `messages` precisa da
linha. O cabeçalho da migration 0128 deve dizer **por quê**, não só o quê — quem copiar a função
copia o motivo junto, e é assim que a regra sobrevive à próxima sessão.

---

## D3 — Uma função gorda ou várias finas

**Decisão**: **uma função por operação de negócio**, não uma por tabela. Quatro no total:
`fn_gateway_ingest_message`, `fn_gateway_update_message_status`, `fn_gateway_provision_connection` e
o reaproveitamento das três de contato/conversa que **já existem** (`fn_upsert_wa_contact`,
`fn_upsert_wa_conversation`, `fn_mark_conversation_message`, `baseline.sql:4187-4234`).

**Rationale**: três razões, e a primeira é a que decide.

1. **Atomicidade é o ganho principal da decisão.** Hoje `lib/gateway/ingest.ts` faz insert e emissão
   de `ai_agent.dispatch_requested` em viagens separadas — morrer no meio deixa mensagem sem
   atendimento, sem ninguém perceber. Uma função por operação põe as duas na mesma transação. Funções
   finas por tabela devolveriam o problema, com mais viagens.
2. **Menos superfície é menos acoplamento.** O contrato do fork é o conjunto de assinaturas; quanto
   menor, mais barato versionar.
3. **Menos viagens é menos latência**, e SC-001 tem p95 de 5 s ponta a ponta.

**Alternativas consideradas**: uma função por tabela (mais viagens, perde atomicidade, superfície
maior); uma única função para tudo (perde a distinção entre ingestão e ACK, que têm regras de
idempotência diferentes — o ACK tem guarda de não-regressão, a ingestão tem `unique_violation`).

---

## D4 — Janela e cadência da reconciliação (FR-013a)

**Decisão**: janela de **6 horas**, varrida a cada **15 minutos**, com sobreposição deliberada.

**Rationale**: a janela tem de cobrir com margem o maior tempo tolerado de indisponibilidade do CRM.
Seis horas cobre uma madrugada inteira de incidente — que é o cenário realista numa operação sem
plantão 24h. A cadeia de 15 minutos é curta o bastante para o corretor não perder a conversa e longa
o bastante para a varredura não competir com o tráfego normal.

**A sobreposição é de propósito**: cada varredura reprocessa o que a anterior já viu. Isso só é
seguro — e é seguro — porque a gravação é idempotente por FR-006. Janela sem sobreposição perde
exatamente o que estava na fronteira quando o processo caiu.

**Alarme, não silêncio**: divergência encontrada é **alerta**, não conserto silencioso. Reconciliar
em silêncio esconde o defeito que a reconciliação existe para medir — e transforma a rede de
segurança em anestésico.

**Alternativas consideradas**: janela curta com cadência alta (perde incidente longo, que é o caso
que importa); reconciliação sob demanda, disparada por suspeita (não existe quem suspeite — a falha
é justamente a mensagem que nunca chegou a existir).

**Aberto para medição**: os números são ponto de partida defensável, não medição. Revisar depois do
primeiro incidente real, com o tempo observado no lugar do estimado.

---

## D5 — Um repo com dois builds, não fork literal

**Decisão**: costura em `internal/store` com duas implementações, escolhidas por configuração no
start. Entrega os **dois serviços rodando, um por produto**, que foi o pedido.

**Rationale**: aritmética. Num fork literal, todo conserto de gateway — normalizador,
anti-banimento, retentativa, mídia — passa a ser aplicado duas vezes, para sempre. A segunda
aplicação é a que alguém esquece, e o esquecimento aparece como bug só num dos produtos, meses
depois. A parte que realmente difere entre os dois é a camada de dados; o resto é idêntico e caro de
duplicar.

**Alternativas consideradas**: fork literal do repositório (o pedido original — atende igual em
comportamento e custa mais em manutenção; se a preferência for essa, nada mais neste plano muda);
um único binário com as duas implementações ativas (rejeitado: um bug de configuração escreveria no
banco errado, e o banco errado é de outro produto).

---

## D6 — Onde a conexão nasce (ABERTO — é decisão de produto)

**Status**: **NEEDS DECISION**, isolado na task T003 da Fase 0. Não é desconhecido técnico — os dois
caminhos funcionam e estão desenhados. É escolha de dono.

| Opção | A favor | Contra |
|---|---|---|
| **(a)** rota HTTP no gateway (`gateway-provisioning-v1.md` §3-§8) | contrato já escrito; o gateway continua dono da instância do provedor; funciona igual para os dois produtos | mais uma superfície de rede para manter e autenticar |
| **(b)** função no CRM (`fn_gateway_provision_connection`) | coerente com a decisão de escrita direta; uma superfície só; transação única | o gateway precisaria chamar o provedor **e** o CRM, e o tudo-ou-nada (FR-012) fica com dois donos |
| **(c)** as duas, com dono declarado por etapa | separa "criar instância no provedor" (gateway) de "criar registro" (CRM) | é a que mais parece certa no papel e a que mais tem chance de virar duas verdades divergentes |

**Enquanto não decidir**: T014 (função) e T029 (rotas) estão ambas no `tasks.md`, marcadas como
condicionadas a T003, e a perdedora morre. Implementar as duas é o desfecho ruim que T003 existe para
evitar.

**Recomendação para quando for decidir**: **(a)**. O contrato já está escrito e revisado, o gateway
já é dono da instância do provedor, e o tudo-ou-nada fica com um dono só. A (b) só ganha se o
provisionamento passar a ser raro o bastante para a viagem extra não importar — e ele acontece
exatamente no passo 2 do onboarding, que é onde o teto de 10 minutos aperta mais.

---

## O que **não** precisou de research

Registrado para a próxima sessão não repetir o levantamento:

- **Como o gateway escreve hoje** — medido: por RPC, 6 chamadas; só a mensagem é upsert cru
  (`internal/processor/mensagem.go:100`). Está na §1 da decisão.
- **Quem dispara a cadeia viva** — medido: `trg_messages_emit_event` (`baseline.sql:2746`) sobrevive
  a qualquer escritor, mas `ai_agent.dispatch_requested` é só de aplicação
  (`lib/gateway/ingest.ts:253`, `lib/waha/ingest.ts:467`). Está na §3a.
- **Como resolver tenant** — `channel_sessions.gateway_connection_id` já existe (migration 0119,
  `baseline.sql:8424`). Está na §3c.
- **Tradução de vocabulário Cotador↔CRM** — tabela completa na §3c da decisão.
