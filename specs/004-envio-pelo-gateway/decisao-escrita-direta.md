# Decisão — o fork do gateway escreve no banco do CRM

**Status**: decidido pelo dono do produto em 2026-08-08. Este documento **registra e desenha** a
decisão; não a discute. O que ele discute é o *como*, e o preço.

**Decisão literal**: existirão **duas versões** do `gateway_go` — uma apontada para o banco do
**Cotador Simplificado** (a de hoje) e outra apontada para o banco do **CRM**. Na versão do CRM, o
gateway grava **conexão, instância, mensagem, conversa e contato** direto no banco do CRM, para
WhatsApp e para os demais canais. Na pergunta "onde o gateway grava mensagem", a escolha foi
**direto em `public.messages` do CRM**.

**Motivo declarado**: facilitar o desenvolvimento e a migração para o gateway aqui no CRM.

---

## 1. A notícia boa, medida antes de desenhar

A decisão parecia cara porque parecia trocar "gateway fala HTTP com o CRM" por "gateway conhece o
schema do CRM". **Ela não troca isso**, e a razão está no código que já existe:

> **O gateway já não escreve em tabela. Ele escreve em RPC.**

Medido em `/root/PROJETOS/gateway_go`, caminho de recebimento:

| Chamada | Onde |
|---|---|
| `resolver_conexao_uazapi_por_token` | `internal/handlers/uazapi.go:93` |
| `resolver_conexao_por_externo_id` | `internal/handlers/messenger.go:69`, `instagram.go:69` |
| `upsert_contato_multicanal_v1` | `internal/processor/mensagem.go:40`, `handlers/uazapi.go:180` |
| `upsert_conversa_multicanal` | `internal/processor/mensagem.go:75,350` |
| `atualizar_status_mensagem_multicanal` | `internal/processor/mensagem.go:147` |
| `atualizar_nome_conversa_grupo` | `internal/handlers/uazapi.go:194` |

Só **um** ponto do caminho quente escreve tabela crua, e é justamente a mensagem:

```go
// internal/processor/mensagem.go:100
db.Upsert(ctx, "inbox_mensagens", mensagem, "ignore-duplicates", "escritorio_id,wamid")
```

Consequência que mudou o desenho: **a superfície de acoplamento do fork é um conjunto de assinaturas
de função, não o schema do CRM.** O trabalho não é ensinar Go a conhecer `public.messages`; é
implementar, no CRM, funções com o mesmo papel — e trocar aquele único `Upsert` por uma delas.

E o CRM **já tem três** dessas funções, criadas para o caminho do WAHA, com o grant certo
(`baseline.sql:4187-4234`, `revoke ... from public` + `grant execute ... to service_role`):

```sql
public.fn_upsert_wa_contact(uuid, text, text, text, text, text)      -- security definer
public.fn_upsert_wa_conversation(uuid, uuid, uuid)                    -- security definer
public.fn_mark_conversation_message(uuid, text, text, timestamptz)    -- security definer
```

---

## 2. A notícia ruim, também medida — e ela é bloqueante

O idioma de idempotência do gateway (`Upsert` com `ignore-duplicates`) vira, no PostgREST,
`INSERT ... ON CONFLICT (org, external_id) DO NOTHING`. **Isso não funciona contra `public.messages`
do CRM**, e não é opinião:

```
messages_org_external_id_unique UNIQUE (organization_id, external_id) DEFERRABLE INITIALLY DEFERRED
                                                            -- supabase/baseline.sql:2116
```

Provado em Postgres 17 descartável nesta sessão:

```
ERROR:  ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters
```

Pior, e este é o detalhe que mata implementação tarde: **criar um índice único adicional,
não-deferrable, sobre as mesmas colunas NÃO resolve.** Testado — o Postgres continua recusando,
porque a inferência do árbitro esbarra na constraint deferrable antes de considerar o índice novo.

E a captura ingênua do erro dentro de uma função também **não** funciona:

```sql
do $$ begin
  begin
    insert into m (org, external_id) values (...);   -- duplicata
  exception when unique_violation then
    raise notice 'peguei';                            -- NUNCA imprime
  end;
  raise notice 'bloco terminou sem erro';             -- imprime
end $$;
-- ...e o 23505 estoura depois, no COMMIT, fora do alcance do handler.
```

O adiamento é o ponto: a violação só existe no `COMMIT`, e a essa altura o bloco `exception` já
passou. A transação inteira morre.

### 2.1 A saída, provada

```sql
set constraints public.messages_org_external_id_unique immediate;
```

Com essa linha aberta na função, o `exception when unique_violation` **captura**, a função termina
limpa e a transação sobrevive. Foi o único dos três caminhos testados que funcionou:

| Tentativa | Resultado medido |
|---|---|
| `on conflict (org, external_id) do nothing` | **ERRO** — árbitro deferrable |
| índice único imediato extra + `on conflict` | **ERRO** — mesmo erro, o índice não é escolhido |
| `set constraints ... immediate` + `exception when unique_violation` | **funciona** |
| pré-checagem por `select` antes do `insert` | funciona, mas corre — dois webhooks simultâneos passam os dois |

O repo já conhecia isto por outro caminho (`app/api/v1/channels/official/route.ts:177`,
`tests/invariants/gateway-inbound-isolamento.test.ts:134`); a medição acima é confirmação
independente e, sobretudo, **a prova de que o idioma atual do gateway não sobrevive à mudança de
alvo sem reescrever o ponto de escrita da mensagem**.

> **Alternativa possível, não recomendada agora:** tirar o `DEFERRABLE` da constraint. Há precedente
> declarado no próprio baseline (`:9124`, "Perde o DEFERRABLE: medido, nenhum caminho escreve
> ... com violação transitória"), então é legítimo — mas exige a mesma medição para `messages`, é
> mudança de schema em instância única, e não é pré-requisito: a linha `set constraints` resolve sem
> tocar em constraint alguma.

---

## 3. Os quatro problemas da decisão, e onde cada um para

A escolha "direto em `public.messages`" veio com quatro pendências declaradas. Todas medidas:

### (a) Quem dispara a cadeia viva

O trigger `trg_messages_emit_event` (`baseline.sql:2746`) já roda `AFTER INSERT ON public.messages` e
emite `message.received` via `fn_emit_message_event` (`:260-290`). Isso **continua funcionando** com
qualquer escritor — é do banco, não da aplicação.

Mas o evento que **acorda o agente** não é esse. É `ai_agent.dispatch_requested`, e ele é emitido
**só por código de aplicação**, em dois lugares, sob a guarda `if (!ehEco)`:

- `lib/gateway/ingest.ts:253`
- `lib/waha/ingest.ts:467`

**Um gateway que insere direto deixa o agente dormindo.** A correção é a sancionada pela doutrina —
trigger escreve `event_log`, nunca faz HTTP (anti-pattern 9): a emissão do dispatch desce para
dentro da mesma função que insere a mensagem.

**Isso é melhor do que hoje, não pior.** Hoje o `INSERT` e a emissão do dispatch são duas viagens
separadas: se o processo morre entre elas, a mensagem existe e ninguém a atende — e nada no sistema
percebe. Dentro de uma função, insert e dispatch caem na mesma transação: ou os dois, ou nenhum.

### (b) Quem é dono da idempotência

**O banco, e ele não muda de dono.** `messages_org_external_id_unique` fica onde está. O que muda de
lado é só o *tratamento* do 23505 — sai de `lib/gateway/ingest.ts:180` (TypeScript) e entra na função
SQL, com a linha `set constraints` da §2.1. Ver §2 para por que não dá para simplesmente usar o
idioma que o gateway já tem.

### (c) Como o gateway resolve o tenant

Já resolvido, e pelo desenho certo. `channel_sessions.gateway_connection_id` existe desde a migration
0119 (`baseline.sql:8424`) e a linha carrega `organization_id`. O gateway resolve a organização a
partir da **conexão pela qual a mensagem chegou** — nunca do corpo. É a mesma garantia que o
`webhook_path_token` dá hoje, e a mesma que o gateway já usa no Cotador via
`resolver_conexao_uazapi_por_token`.

A tradução de vocabulário é 1-para-1 e vale registrar, porque é ela que o fork realmente muda:

| Cotador | CRM |
|---|---|
| `escritorio_id` | `organization_id` |
| `wa_connections` | `channel_sessions` |
| `inbox_contatos` | `contacts` |
| `inbox_conversas` | `conversations` |
| `inbox_mensagens` | `messages` |
| `wa_webhook_logs` | `webhook_events_log` |
| `wamid` | `external_id` |
| `wa_template_envios` | *(não existe no CRM)* |

### (d) O schema do CRM virar dependência de build do gateway

**Não vira**, se a superfície ficar nas funções. O contrato do fork é um conjunto de assinaturas
versionadas; a tabela por baixo pode mudar sem recompilar Go, exatamente como hoje no Cotador.

A trava que garante isso é operacional, não moral: o fork **não recebe a `service_role` key do CRM**.
Recebe um papel Postgres dedicado com `EXECUTE` só nas funções do §4 e **zero** grant de tabela. Se
alguém tentar escrever tabela crua do Go, falha na hora, em desenvolvimento — não seis meses depois,
em produção.

---

## 4. A superfície de escrita do fork

Proposta: **quatro funções**, três já existem.

| Função | Estado |
|---|---|
| `fn_upsert_wa_contact(...)` | **existe** — `baseline.sql:4187` |
| `fn_upsert_wa_conversation(...)` | **existe** — `baseline.sql:4203` |
| `fn_mark_conversation_message(...)` | **existe** — `baseline.sql:4216` |
| `fn_gateway_ingest_message(...)` | **a criar** — insere a mensagem, trata o 23505, emite o dispatch |
| `fn_gateway_provision_connection(...)` | **a criar** — nasce a `channel_sessions` (a F1 da spec) |
| `fn_gateway_update_message_status(...)` | **a criar** — o ACK, com a guarda de não-regressão |

`fn_gateway_ingest_message` é a peça nova de verdade, e o esqueleto sai direto do que foi medido:

```sql
create or replace function public.fn_gateway_ingest_message(
  p_gateway_connection_id text,   -- FONTE DA VERDADE do tenant. Nunca vem no corpo.
  p_external_id           text,
  ...
) returns table (message_id uuid, duplicada boolean)
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_id uuid;
begin
  -- tenant resolvido da CONEXÃO, não do payload
  select organization_id into strict v_org
    from public.channel_sessions
   where gateway_connection_id = p_gateway_connection_id and archived_at is null;

  -- SEM esta linha o handler abaixo NUNCA dispara e o 23505 mata a transação no COMMIT
  set constraints public.messages_org_external_id_unique immediate;

  begin
    insert into public.messages (organization_id, external_id, ...)
    values (v_org, p_external_id, ...)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id from public.messages
     where organization_id = v_org and external_id = p_external_id;
    return query select v_id, true;
    return;
  end;

  -- a cadeia viva, na MESMA transação do insert (ver §3a)
  if p_direction = 'inbound' and not p_eh_eco then
    perform public.fn_log_event(v_org, 'ai_agent.dispatch_requested', jsonb_build_object(...));
  end if;

  return query select v_id, false;
end $$;

revoke execute on function public.fn_gateway_ingest_message(...) from public, anon;
grant  execute on function public.fn_gateway_ingest_message(...) to gateway_writer;
```

> **As duas origens de `EXECUTE`.** O `revoke ... from public, anon` acima não é redundância: o
> baseline tem `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon`, que alcança toda função
> criada depois dele, e `revoke from public` não o remove. Tratar só uma das origens deixa a função
> exposta como RPC pela anon key — que vai para o browser. Ver `CLAUDE.md`, doutrina de migrations,
> item 9, e o invariante `tests/invariants/hardening-definer-varredura.test.ts`.

---

## 5. Um repo, dois builds — não dois repos

O pedido foi "duas versões, dois serviços". Isso se entrega com um `git fork` **ou** com uma costura
de armazenamento e dois binários. Recomendação: **a costura**, e a razão é aritmética — num fork de
verdade, todo conserto de gateway (normalizador, anti-banimento, retentativa, mídia) tem de ser
aplicado duas vezes, para sempre, e a segunda aplicação é a que alguém esquece.

O corte natural já está desenhado pelo próprio código: o gateway fala com o banco por
`internal/supabase` e por um punhado de nomes de RPC. Vira interface; duas implementações; escolha
por configuração no start. Entrega exatamente o que foi pedido — **dois serviços rodando, um por
produto** — sem duplicar o resto.

Isto é escolha de *como*, não de *o quê*. Se a preferência for o fork literal, o resto deste
documento vale igual.

---

## 6. O que morre da spec 001

Ser honesto sobre o custo é parte do registro. Com o gateway escrevendo direto, o caminho de entrada
construído pela spec 001 fica **sem uso no caminho do gateway**:

| Peça | O que acontece |
|---|---|
| `POST /api/v1/webhooks/gateway/[token]` | deixa de ser o caminho de entrada |
| ACK-primeiro (202 antes de ingerir) | some — não há HTTP para responder |
| `webhook_events_log` como fila durável | some **do caminho do gateway**; a durabilidade passa a ser inteira da fila em disco do gateway |
| HMAC-SHA512 do `envelope_v1` na entrada | substituído por autenticação de papel Postgres |
| `lib/gateway/ingest.ts` | vira SQL |

**Nenhuma dessas peças era decorativa**, e a que dói é a fila. Hoje há duas guardas independentes
contra perda: a fila em disco do gateway **e** o `webhook_events_log` do CRM. Depois, há **uma**. Com
o gateway sendo SPOF declarado (Princípio XIV, sem réplica), isso concentra risco num único ponto —
e é exatamente o ponto que a constituição já declara como o mais frágil da arquitetura.

Não é motivo para não fazer. É motivo para a fila em disco do gateway virar item de primeira
classe da spec — com prova de sobrevivência a reinício, teto de tamanho e alarme quando drena
devagar. Sem isso, a decisão troca duas redes por nenhuma.

**O que NÃO morre:** o `envelope_v1` continua valendo na direção de **saída** e para qualquer
consumidor externo; os normalizadores por provedor (a parte cara do gateway) são intocados; o
vocabulário de estado e a guarda de não-regressão do ACK (`lib/gateway/ingest.ts:278-340`) migram
para SQL sem mudar de regra.

---

## 7. A doutrina que esta decisão contraria

Registro explícito, porque emendar doutrina é **ato separado e deliberado** — não efeito colateral de
um commit de implementação.

| Onde | Texto que passa a conflitar |
|---|---|
| `CLAUDE.md`, seção Gateway | "**O gateway NUNCA escreve no banco do CRM.** Quem persiste é o CRM" |
| `CLAUDE.md`, anti-pattern 15 | "Código novo do CRM lendo payload cru de provedor em vez do envelope" — muda de sentido, já que não haverá envelope na entrada |
| Constituição v2.2.0, Princípio VII | mesma regra, com autoridade acima do `CLAUDE.md` |
| `specs/004.../contracts/gateway-provisioning-v1.md` §1 | escrito para um gateway dono do próprio armazenamento |

**Leitura honesta do conflito, e ela não é toda contra:** a intenção do Princípio VII é impedir
**duas** coisas — que o tenant seja decidido pelo corpo da requisição, e que o schema do CRM vaze
para dentro do gateway. O desenho das §3c e §4 preserva as duas. Chamar uma função `security definer`
versionada, com papel dedicado e sem grant de tabela, é mais próximo de "chamar uma API que por acaso
é implementada em SQL" do que de "escrever no banco alheio".

O que **de fato** se perde é a fronteira de rede — a §6, e a fila que ela levava junto.

Portanto: o que a constituição precisa é de **emenda com redação nova**, não de revogação. A regra
que sobrevive é "o gateway nunca toca tabela do CRM; escreve só por função versionada, com papel
próprio, e nunca decide tenant pelo corpo". Redigir isso é `/speckit-constitution`, com número de
versão próprio — e **não** foi feito aqui.

---

## 8. O que fica em aberto

1. **A fila em disco do gateway vira crítica** (§6). Prova de sobrevivência a reinício, teto, alarme.
2. **Papel `gateway_writer`**: criar, com `EXECUTE` só nas funções do §4 e zero grant de tabela.
   Precisa de invariante que reprove se ele ganhar tabela.
3. **Alcance de rede**: o gateway passa a precisar chegar ao Postgres/PostgREST do CRM. Endereço é
   configuração (Princípio XIV) — sem `localhost`, sem nome de serviço de compose.
4. **`wa_template_envios` não tem equivalente no CRM.** Ou nasce tabela, ou o registro de envio de
   template se perde na migração dos "demais registros".
5. **A F1 da spec 004 e o `gateway-provisioning-v1.md` precisam de reescrita** — foram escritos para
   um gateway dono do próprio armazenamento. O contrato HTTP de provisionamento pode até sobreviver
   como fachada, mas o §1 dele está agora errado.
6. **Emenda da constituição** (§7), como ato próprio.
7. **`DEFERRABLE` de `messages`**: decidir se fica (com `set constraints` em toda função de escrita) ou
   se sai (com a medição que o precedente do `baseline.sql:9124` exige). Não bloqueia; escolher cedo
   evita meia dúzia de funções carregando a linha por herança.
