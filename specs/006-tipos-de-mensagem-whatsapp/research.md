# Phase 0 — Pesquisa medida

**Feature**: 006-tipos-de-mensagem-whatsapp · **Data**: 2026-08-09

Tudo aqui foi medido lendo o código dos dois repositórios, com o arquivo e a linha. Nada
foi acreditado. As decisões abaixo são o que o plano executa.

---

## R1 — O alvo da reação e o alvo do apagamento já chegam ao CRM?

**Pergunta**: sem mudar a porta de tráfego, dá para prender a reação à mensagem certa e
saber qual mensagem foi apagada?

**Medição**:

| Canal | Onde | O que foi medido |
|---|---|---|
| uazapi (não-oficial) | `internal/normalizer/uazapi.go:257` | `ReplyToMsgID = p.Data.Quoted`; o teste `uazapi_test.go:455` prova que numa `ReactionMessage` o `quoted` é **o wamid da mensagem reagida** |
| WhatsApp Cloud (oficial) | `internal/normalizer/whatsapp_cloud.go:307-309` | para `revoke`, `ReplyToMsgID` recebe `revoke.original_message_id` — com comentário dizendo que o campo é reusado de propósito |
| WhatsApp Cloud | `whatsapp_cloud.go:493-497` | reação devolve o emoji; o alvo é escrito no `ReplyToMsgID` pelo chamador |
| Messenger | `internal/normalizer/messenger.go:66` | `msg.ReplyToMsgID = r.Mid` na reação |
| Envelope | `internal/envelope/envelope.go:100-103` | `ReplyToMsgID` vira `message.reply_to_external_id` |
| CRM | `lib/gateway/ingest.ts:171` | grava em `metadata.reply_to_external_id` |
| CRM | `lib/gateway/envelope.ts:236-246` | emoji vira `body`; `metadata.reaction_emoji` também chega, vindo do gateway |

**Decisão**: **sim, o vínculo já existe no banco hoje.** Reação, citação e apagamento usam o
**mesmo campo** — `metadata.reply_to_external_id` — e o CRM já o grava em toda mensagem.
Nada precisa mudar na porta de tráfego para a User Story 1.

**Alternativa rejeitada**: pedir um campo novo ao gateway (`reacted_to`, `revoked_id`).
Rejeitada porque duplicaria um vínculo que já viaja, e porque exigiria release acoplado dos
dois lados — que é justamente o escopo que o usuário cortou.

---

## R2 — Mensagem apagada chega pelo canal que a Central oferece?

**Pergunta**: a User Story 1, cenário 4 é provável no canal que os usuários realmente usam?

**Medição**: `internal/normalizer/uazapi.go:305-330` — `mapUazapiType` reconhece
`conversation`, `extendedtextmessage`, `imagemessage`, `audiomessage`, `pttmessage`,
`videomessage`, `documentmessage`, `stickermessage`, `locationmessage`, `reactionmessage`.
**Não há caso de apagamento.** Qualquer outro `messageType` cai em `"unsupported"`.
`whatsapp_cloud.go:548-552` **tem** o caso `revoke`.

O canal que a Central de Conexões cria hoje é `whatsapp_uazapi`
(`lib/channels/capabilities.ts`, `CHANNEL_PROVIDER_GATEWAY_WHATSAPP`).

**Decisão**: o CRM implementa a leitura do apagamento **por evento, não por canal** — quem
manda o sinal é o envelope, e o código funciona em qualquer canal que o entregue. No canal
oficial isso é observável hoje. **No canal não-oficial, não é** — e isso NÃO é resolvido
nesta entrega, porque a correção mora na porta de tráfego, que está fora de escopo (FR-022).

**A limitação DEVE ser registrada, não silenciada**: entra no `user-journey-map.md` como
buraco de cobertura nomeado, e a spec de tela que prova o apagamento declara a
pré-condição de canal em vez de assumi-la — senão passa verde medindo outra coisa
(a regra 3 da doutrina de medição do `CLAUDE.md`).

**Alternativa rejeitada**: inferir apagamento comparando o histórico do provedor com o
nosso. Rejeitada: é o cron de reconciliação com outro nome, custa uma varredura por
conversa, e inferir "sumiu, logo foi apagada" confunde apagamento com falha de entrega.

---

## R3 — Onde mora a reação: linha própria, coluna, ou tabela nova?

**Estado medido**: hoje a reação **já entra como linha em `messages`**, com `type='reaction'`
(`supabase/baseline.sql:1685`, CHECK aceita `reaction`) e `body` = emoji. É por isso que ela
aparece como bolha solta.

**Opções**:

| Opção | Custo | Risco |
|---|---|---|
| **A. Projeção na leitura** — a linha da reação continua sendo a fonte; a API a tira da linha do tempo e a devolve pendurada na mensagem-alvo | 1 índice de expressão; 1 consulta extra por página | consulta a mais por página |
| B. Coluna `reactions jsonb` em `messages`, escrita no ingest | escrita no caminho quente + backfill de histórico | duplica um dado que já existe (anti-pattern 2); ingest passa a ter efeito colateral sobre outra linha |
| C. Tabela `message_reactions` | tabela nova + RLS + backfill | mesma duplicação da B, com mais superfície de tenancy |

**Decisão: A — projeção na leitura.** A doutrina DIRC responde sozinha: o dado **já existe**
(não Duplicar), o vínculo **já é uma referência** (`external_id`), e o formato final é
**Calculável** on-demand. É também a única opção que não toca o caminho que recebe mensagem
— o mais caro de quebrar neste sistema.

**A mesma projeção resolve os três casos**, porque os três são a mesma forma: *um evento que
aponta para uma mensagem*. Reação (`type='reaction'`), apagamento (`original_type='revoke'`) e
citação (`reply_to_external_id` numa mensagem comum) saem de **uma consulta só** por página.

**Custo aceito**: uma consulta adicional por página de conversa. Sem índice, ela é varredura —
por isso o índice de expressão é obrigatório, e não otimização prematura.

---

## R4 — Paginação: e quando a reação está numa página e o alvo em outra?

**Problema**: a listagem é por cursor, 50 por página (`listMessagesQuerySchema`). Uma reação
de hoje pode apontar para uma mensagem de três páginas atrás.

**Decisão**: a projeção parte **do alvo, não do evento**. Para a página carregada, colhem-se
os `external_id` das mensagens e busca-se quem aponta para eles — nunca o contrário. Assim a
reação sempre encontra o alvo que está na tela, e reação a mensagem fora da página
simplesmente não é buscada, o que é o comportamento certo: não há onde exibi-la.

**Órfão**: evento cujo alvo o CRM nunca ingeriu não aparece — mas **não some sem rastro**: a
linha continua no banco e o contador de eventos não projetados é registrado no log. Sumir em
silêncio é o que a doutrina chama de evento sem consumer.

---

## R5 — `location` e `contact` são aceitos pela API e não podem ser enviados. Confirmado?

**Medição**: `lib/schemas/messaging.ts` — `messageTypeSchema` inclui `location` e `contact`;
`sendMessageSchema` tem apenas `body`, `media_url`, `media_storage_path`, `media_mime`,
`media_size_bytes`, `metadata` e os três campos de template. Não há latitude, longitude nem
lista de contatos. `lib/channels/adapters/gateway.ts:63-83` monta o corpo com
`connection_id`, `to`, `tipo`, `texto`, `midia_url`, `midia_mime`, `nome_arquivo` — e nada
mais. Do outro lado, `internal/handlers/messages.go:301-307` recusa com
`"campos obrigatórios ausentes: latitude e longitude"` e `"campo obrigatório ausente:
contatos"`.

**Decisão**: confirmado — os dois tipos são **anunciados e inenviáveis**. A correção é dupla:
dar a eles a carga que falta (FR-013/FR-014) **e** fazer o sistema deixar de aceitar tipo que
não consegue entregar (FR-017). Aceitar e falhar lá na frente é o defeito, não o sintoma.

---

## R6 — Onde guardar a carga de localização, contato e menu?

**Opções**: colunas dedicadas vs `metadata` jsonb.

**Decisão**: `metadata`, com **schema Zod central compartilhado** entre quem escreve e quem
lê. É o que o `CLAUDE.md` exige para não cair no anti-pattern 6 (`jsonb` lock-in: UI lendo
path direto sem schema central). Colunas dedicadas para lat/lng/vCard/opções seriam 8+
colunas nulas em 99% das linhas, contra a doutrina DIRC.

**Consequência de projeto**: existe **um** módulo que define a carga de cada tipo de
mensagem, e tanto o envio quanto a tela o consomem. Nenhum componente lê
`metadata.location.lat` na mão.

---

## R7 — Vocabulário de tipos: quem precisa de migration?

**Medição**: `messages_type_check` (baseline linha 1685, reescrito pelo apêndice da migration
0091 na linha 8544) aceita hoje: `text, image, video, audio, document, sticker, location,
contact, reaction, system, template`.

| Tipo do plano | Precisa de migration? |
|---|---|
| citação (não é tipo — é campo da mensagem) | não |
| `sticker`, `location`, `contact` | **não** — já estão no CHECK |
| `menu`, `cta_url`, `location_request` (User Story 4) | **sim** — CHECK novo, no molde exato da 0091 |

**Decisão**: a User Story 4 carrega a única migration de vocabulário, e ela é aditiva
(conjunto antigo ⊂ conjunto novo, backfill nenhum) — expand puro, sem contract.

**Achado adjacente, registrado**: `messages_type_check` **não** tem par em
`tests/invariants/vocabulario-banco-x-typescript.test.ts`. É exatamente a classe de
divergência que aquele invariante existe para pegar, e ela está descoberta na coluna de
mensagem. O plano acrescenta o par — com uma constante TypeScript que seja a **união**
(entrada + saída), da qual a lista do envelope e o enum de envio derivam como subconjuntos.
Sem isso, o par compararia listas que legitimamente divergem e reprovaria certo.

---

## R8 — Quem decide se a tela oferece "responder", "localização", "menu"?

**Medição**: `lib/channels/capabilities.ts` é declarado como "o ÚNICO lugar do sistema que
pode conhecer a diferença entre os canais", e `scripts/lint-channels.ts` reprova nome de
provedor fora de `lib/channels/`. A matriz de capacidade do gateway
(`internal/sender/capability.go`) já responde por operação e plataforma.

**Decisão**: cada ação nova vira **capability** em `ChannelCapabilities`, e a tela pergunta
capacidade — nunca provider. Capacidade que ninguém consome é código morto e o teste de
matriz reprova, então cada uma nasce com consumidor.

**Alternativa rejeitada**: perguntar ao gateway em tempo real que operações a conexão
suporta. Rejeitada por acoplamento de latência: a tela ficaria esperando a rede para saber se
desenha um botão, e a queda do gateway apagaria a interface inteira em vez de apagar o envio.

---

## R9 — Como provar sem falso-verde

Da doutrina de medição do `CLAUDE.md`, aplicada a esta feature:

- **Presença não prova chegada.** Para citação e reação, a asserção é a **âncora de lugar**
  (`toHaveURL` + elemento que só existe na conversa) **antes** de qualquer asserção sobre o
  conteúdo — senão o caso passa medindo a tela de login.
- **Dublê responde no formato que eu escrevi.** O formato de `quoted_id`, do vCard e do menu
  só se conhece medindo o canal real. Um caso com aparelho real é obrigatório para cada tipo
  novo enviado; teste com dublê prova a montagem do pedido, não a chegada.
- **Cronômetro fora do laço.** SC-005 usa `created_at` do Postgres ou o carimbo do outro
  processo, nunca `Date.now()` antes da chamada.
- **Sabotagem.** Cada teste novo é confirmado quebrando de propósito o que ele vigia
  (Princípio XI). Um teste de projeção que passa com a projeção desligada não é teste.
- **Estado que sobrevive entre execuções.** A conta de teste tem MFA no banco; o `beforeAll`
  zera o fator, e os casos que precisam de sessão logam **uma vez** (`mode: serial`) — código
  TOTP vale uma vez só.

---

## Riscos assumidos

| Risco | Efeito se acontecer | O que o plano faz |
|---|---|---|
| Apagamento não chega no canal não-oficial (R2) | US1-4 não é provável no canal de produção | limitação declarada na spec de tela e no mapa de jornadas; **não** se finge cobertura |
| `quoted_id` do gateway não casa com o `external_id` que gravamos | citação sai apontando para o vazio, sem erro | caso com aparelho real antes de liberar a US2; FR-012 manda falhar em vez de sair sem citação |
| Consulta de projeção sem índice | conversa grande fica lenta e ninguém percebe em teste pequeno | o índice entra na **mesma** migration da projeção, e a medição usa conversa com ≥500 mensagens |
| Menu/`cta_url` recusados por limite do canal (contagem de opções, tamanho de rótulo) | envio falha na cara do corretor | limite vem da capability e é imposto **antes** do envio, com motivo legível (FR-019) |
