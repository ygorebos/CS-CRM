# Phase 0 — Research: recebimento unificado pelo gateway

**Data**: 2026-08-07 · **Spec**: [spec.md](./spec.md) · **Plano**: [plan.md](./plan.md)

Este documento fecha as incógnitas técnicas antes do desenho. Cada decisão traz o que foi
**medido** no código (não presumido), a razão, e o que foi rejeitado.

Fontes medidas: `/root/PROJETOS/crm_3_0` (`chore/spec-kit-constituicao`, `9ef4a740`) e
`/root/PROJETOS/gateway_go` (`7777ba1`).

---

## D1 — Formato e transporte do envelope

**Decisão**: HTTP `POST` JSON, um envelope **versionado** (`envelope_version: 1`), derivado de
`MensagemNormalizada` do gateway mas traduzido para o vocabulário do CRM: `snake_case`, campos em
inglês, UUID v4, ISO-8601 UTC — a mesma convenção de `/api/v1/`. Um evento por requisição.

**Razão**: o gateway já converte todos os canais para `MensagemNormalizada` antes de persistir
(`internal/normalizer/types.go`), e são 1.323 linhas de parsing já testadas. Traduzir uma vez, na
borda de saída do gateway, é mais barato que ensinar o CRM a falar quatro dialetos. Manter o
vocabulário do CRM em vez de importar `direcao`/`recebida` em português evita que o padrão de API
do repositório se parta em dois.

**Rejeitado**: (a) encaminhar o corpo cru — é o que `webhook_forward.go` faz hoje, e obrigaria o
CRM a reescrever os parsers, perdendo exatamente o ganho; (b) lote de eventos por requisição —
complica idempotência parcial (metade do lote aceito) sem ganho real no volume esperado;
(c) reaproveitar o português do gateway — cria dois vocabulários dentro do CRM.

---

## D2 — Autenticidade da entrega

**Decisão**: HMAC-SHA512 sobre `"{timestamp}.{corpo_cru}"`, enviado em `X-Gateway-Signature`
(hex) com `X-Gateway-Timestamp` (epoch em segundos). Comparação com `crypto.timingSafeEqual`.
Janela de validade **±5 minutos**. **Fail-closed sem exceção**: sem segredo configurado, a rota
recusa tudo.

**Razão**: `lib/waha/webhook-auth.ts` já implementa HMAC-SHA512 com `timingSafeEqual` e documenta
por que o fail-open anterior era fatal — *"qualquer pessoa que soubesse a URL injetava mensagem
falsa no CRM alheio (...) provado nesta VPS, com `curl` sem header nenhum"*. Reusar o algoritmo e
o utilitário é reuso antes de escrita.

O detalhe que **muda** em relação ao caminho WAHA: lá existe a válvula
`WAHA_WEBHOOK_REQUIRE_SIGNATURE`, desligada por padrão, porque **o WAHA Core não assina** e ligá-la
derrubaria a ingestão de todo mundo. Aqui essa desculpa não existe: o emissor é o nosso gateway e
ele vai assinar sempre. Portanto a rota nova **não** herda a válvula — regra 3 do `webhook-auth.ts`
("sem assinatura e sem exigência ⇒ aceita") **não se aplica** ao gateway.

Assinar o timestamp junto do corpo é o que impede reenviar uma entrega legítima capturada, algo
que a assinatura só-do-corpo do caminho WAHA não cobre.

**Rejeitado**: (a) mTLS — mais forte, mas exige gestão de certificado na instalação do corretor e
quebra o Princípio VIII; (b) bearer estático em header — sem cobertura de integridade do corpo,
e reenvio livre; (c) reusar `X-Webhook-Hmac` do WAHA — nome igual para contrato diferente
confunde diagnóstico e impediria rodar os dois caminhos lado a lado.

---

## D3 — Rota e resolução do tenant

**Decisão**: `POST /api/v1/webhooks/gateway/[token]`, com `token` = `channel_sessions.webhook_path_token`
(coluna que **já existe** e já é única e url-safe). A organização e a sessão vêm da linha
encontrada por esse token. O corpo **nunca** decide organização.

**Razão**: é literalmente o desenho já em produção em `app/api/v1/webhooks/waha/[token]/route.ts`,
e satisfaz o Princípio I (fonte confiável: token do path). Nenhuma tabela nova de mapeamento é
necessária — o mapeamento conexão→organização que a análise apontou como faltante **já existe**,
só precisa ser conhecido pelo gateway.

**Rejeitado**: (a) tabela nova de mapeamento no gateway — duplicaria a fonte da verdade;
(b) `organization_id` no corpo — proibido pelo Princípio I; (c) rota única sem token com o tenant
vindo do segredo — funcionaria, mas perde a capacidade de revogar uma conexão sozinha.

---

## D4 — ACK primeiro, sem perder o evento

**Decisão**: a rota faz **apenas** verificação de assinatura + gravação em `webhook_events_log`
(`status='received'`) e **responde 200**. A ingestão roda fora do ciclo de resposta: disparo
imediato em segundo plano **mais** um dreno periódico que recolhe qualquer linha `received` parada
há mais que um limite curto.

**Razão medida**: `webhook_events_log` **já é uma fila** — tem `status` com
`('received','processed','error','dead')`, `attempts`, `error_message` e `processed_at`
(`supabase/baseline.sql:1887-1908`). Não é preciso criar tabela: o esqueleto do padrão "evento na
fila, worker consome" (Princípio V) já está no schema e nunca foi usado como fila. O repositório
já tem o local do dreno (`app/api/v1/cron/event-log-drain`) e o hábito de worker por cron.

Isto conserta de graça a dívida apontada na análise: a rota WAHA atual espera
`dispatchWahaEvent` **inteiro** antes de responder — invisível com WAHA, mas duplicata garantida
com emissores que retentam.

O disparo imediato é o que sustenta o **SC-001 (≤5s)**; o dreno é o que sustenta o **SC-003 (zero
perdidas)**. Um só dos dois não fecha os dois critérios.

**Rejeitado**: (a) só o dreno por cron — latência de minutos, mata o SC-001 e a sensação de tempo
real do inbox; (b) só o disparo em segundo plano — perde tudo que estiver em voo num restart;
(c) fila externa (Redis/Inngest) — o `CLAUDE.md` proíbe Inngest/Trigger no MVP, e Redis aqui é
para rate limit, não para durabilidade.

---

## D5 — Durabilidade no lado do gateway

**Decisão**: fila local **durável em disco** no gateway (arquivo em volume do contêiner), com
tentativas espaçadas por espera crescente e estado final `dead` inspecionável. A pendência é
gravada **antes** da primeira tentativa.

**Razão**: `internal/handlers/webhook_forward.go` hoje é `go func()` com cliente de 5 segundos, e
todo erro vira `log.Warn` (medido: linhas 44-60). Não há registro nenhum do encaminhamento — o
`wa_webhook_logs` só cobre o que o gateway **persiste**, não o que ele encaminha. E em modo relay
(D10) não existe Supabase para servir de ledger. Sem estado em disco, a garantia da US2 seria
falsa: bastaria reiniciar o contêiner para perder o que estava em voo.

**Rejeitado**: (a) manter em memória — a US2 exige sobreviver a reinício; (b) usar o banco do CRM
como ledger — viola a fronteira declarada na constituição (o gateway não escreve no banco do CRM);
(c) exigir Postgres próprio no relay — reintroduz a dependência que o modo relay existe para
remover, e infla a instalação do corretor.

---

## D6 — Idempotência ponta a ponta

**Decisão**: a chave é o identificador externo da mensagem, contra a unicidade
`(organization_id, external_id)` que o CRM já usa, com captura da violação como caminho normal.
Reentrega de algo já ingerido responde **sucesso** ao gateway, não erro.

**Razão**: os dois lados já convergiram nesse desenho sem combinar — o gateway usa
`unique(escritorio_id, wamid)` com `ignore-duplicates`, o CRM usa `unique(organization_id,
external_id)` com captura de `23505`. Responder sucesso na reentrega é o que faz o gateway parar
de retentar; responder erro criaria retentativa infinita sobre um evento já processado.

É também o que torna seguro rodar os dois caminhos ao mesmo tempo durante a transição (FR-029) —
se legado e gateway entregarem a mesma mensagem, a segunda cai na unicidade.

**Rejeitado**: chave de deduplicação própria da entrega (hash do corpo) — deduplicaria a
*entrega*, não a *mensagem*, e não protegeria contra o mesmo evento chegando pelos dois caminhos.

---

## D7 — Mídia

**Decisão**: o envelope carrega **referência**, não bytes. O CRM baixa a mídia **exclusivamente**
do endereço base do gateway configurado localmente, descartando qualquer host que venha no
envelope, e persiste no armazenamento do CRM com endereço temporário assinado. Falha de download
não impede a mensagem de entrar.

**Razão**: é a técnica que `lib/messaging/media/waha-source.ts` já usa — anti-SSRF **por
construção**, descartando o host do payload e reconstruindo a URL sobre a base confiável. A
análise apontou que a garantia atual "depende de o WAHA estar na rede interna"; a mesma construção
aplicada à base do gateway preserva a garantia sem depender de topologia. O gateway já tem
`media_uazapi.go` e `media_whatsapp_cloud.go`, e o CRM já tem `media-persist-worker`.

**Rejeitado**: (a) base64 embutido no envelope — o `CLAUDE.md` já proíbe isso no envio, e no
recebimento estoura memória em rajada; (b) confiar na URL do provedor que veio no payload — é
exatamente o SSRF que a construção atual evita; (c) o gateway subir direto para o armazenamento do
CRM — daria ao gateway credencial de escrita no nosso lado, contra a fronteira declarada.

---

## D8 — Provider novo no schema

**Decisão**: estender os dois `CHECK` existentes — `channel_sessions_provider_check` (hoje
`waha`, `meta_cloud`, em `baseline.sql:8425`) e `webhook_events_log_provider_check` (hoje `waha`,
`nuvemshop`, `generic`, em `baseline.sql:1907`) — e acrescentar linha na matriz de capacidades
para cada canal novo. Sai como **tripla**: migration versionada + apêndice idempotente no
`baseline.sql` + linha no `MANIFEST.md` (Princípio III).

**Razão**: os valores são vocabulário fechado com `CHECK`, e o `CLAUDE.md` mantém `text + CHECK`
justamente para permitir estender. O invariante
`tests/invariants/vocabulario-banco-x-typescript.test.ts` cobre colunas que já têm `CHECK` — então
esquecer o lado TypeScript reprova no portão, que é o comportamento desejado.

**Rejeitado**: remover o `CHECK` para "não precisar migrar" — perderia a vigilância do invariante
e abriria a coluna a valor digitado errado.

---

## D9 — Coexistência e reversão

**Decisão**: chave de corte **por conexão** — uma coluna em `channel_sessions` que declara por qual
caminho aquela conexão ingere (legado ou gateway), com legado como padrão. Migrar é mudar uma
linha; voltar atrás também.

**Razão**: virar tudo de uma vez num produto self-host significa que uma instalação quebrada não
tem caminho de volta sem release. Por conexão, a primeira instalação real migra um número, prova, e
só então o resto anda. A idempotência de D6 é o que torna a dupla entrega inofensiva na janela de
virada.

**Rejeitado**: (a) chave global por variável de ambiente — sem granularidade e sem reversão por
tenant; (b) virar direto sem chave — impede o desligamento condicionado a evidência que a própria
spec exige (FR-030).

---

## D10 — Modo relay no gateway

**Decisão**: um modo de operação em que o gateway **normaliza e entrega, sem persistir** em banco
próprio, tornando opcionais as credenciais de banco hoje obrigatórias.

**Razão medida**: `internal/config/config.go` chama `mustGetEnv("SUPABASE_URL")` e
`mustGetEnv("SUPABASE_SERVICE_ROLE_KEY")` — o processo **entra em pânico** sem elas. Hoje o gateway
literalmente não sobe sem um banco para persistir. Sem o modo relay, embarcar o gateway na
instalação do corretor exigiria dar a ele um banco que ninguém vai ler: custo e superfície de
ataque sem função.

**Rejeitado**: (a) apontar o gateway para o banco do CRM — viola a fronteira; (b) subir um banco
descartável só para satisfazer a exigência — desperdício e mais uma peça para o corretor manter;
(c) manter o gateway fora da instalação, como serviço nosso — mata a independência do self-host e
cria dado pessoal trafegando por infraestrutura de terceiro (LGPD).

---

## D11 — Estratégia de prova (Princípio XI)

**Decisão**: quatro camadas, cada uma com o gate certo, e **cada teste novo confirmado por
sabotagem** antes de contar como prova.

| Camada | Prova | Gate |
|---|---|---|
| Contrato do envelope | envelope válido/inválido/versão futura → aceito, recusado, tolerado | `test:unit` |
| Autenticidade e isolamento | sem assinatura, assinatura errada, timestamp velho, tenant trocado | `test:db` (invariante, banco real, 2 organizações) |
| Ingestão e idempotência | mesma entrega 2× → 1 mensagem; nome humano preservado | `test:db` |
| Ponta a ponta | emissor HTTP real assinando → mensagem visível **na tela** do inbox | Playwright, ambiente fresco |

**Razão**: o Princípio XI exige o gate certo por tipo de mudança, e o `CLAUDE.md` avisa que
`test:unit` **não** roda `tests/invariants/**`. Isolamento entre tenants provado só em unitário é
falso verde. Efeito externo provado com mock não estressa a assinatura real nem o egress.

**Rejeitado**: cobrir tudo em unitário com o cliente de banco simulado — é o padrão que deixou
passar os três defeitos citados no Princípio XI.

---

## Incógnitas remanescentes (não bloqueiam o desenho)

1. **Formato do ledger em disco do gateway** (D5) — arquivo próprio ou biblioteca embarcada. É
   decisão de implementação dentro do gateway; não muda contrato nem schema do CRM. Resolvida na
   primeira tarefa que a toca.
2. **Limite de tamanho de corpo e de mídia** — precisa de número. Proposta: adotar o limite que o
   maior canal suportado já impõe, medido na implementação, em vez de inventar um.
3. **Retenção de `webhook_events_log`** — a tabela vira fila e passa a crescer com todo o tráfego.
   Precisa de política de arquivamento; a coluna `archived_at` já existe para isso. Fica como item
   da fatia de polimento, não da costura.
