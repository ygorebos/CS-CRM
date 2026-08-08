# Tasks — Envio e conexão pelo gateway (spec 004)

**Escrito em**: 2026-08-08, já sob a [decisão de escrita direta](decisao-escrita-direta.md).
**Revisado** no mesmo dia pela análise cruzada, que achou 18 requisitos sem executor — as Fases 3 a
6 saíram dessa revisão.

**Numeração de migrations**: começa em **0127**. 0119–0122 foram gastas pela spec 001; 0123–0126
estão **reservadas** pela spec 002 (`002-rag-por-operadora/tasks.md`). Conferir `ls
supabase/migrations/` antes de criar arquivo — colisão de número já mordeu uma vez.

**Doutrina que vale em toda task de schema**: migration versionada **+** apêndice idempotente no
`baseline.sql` **+** linha no `MANIFEST.md`. Os três, sempre. `pnpm test:db` local antes do PR.

**Doutrina que vale em toda task de teste**: o teste só conta depois de ficar **vermelho sob
sabotagem** (Princípio XI, SC-012). Cada fase termina com sua task de sabotagem — elas não são
opcionais nem agrupáveis no fim.

---

## Fase 0 — Decisões que bloqueiam (nenhuma é código) — ✅ **COMPLETA em 2026-08-08**

- [X] **T001** ✅ **FEITA em 2026-08-08 — constituição v2.3.0.** Emendados VII (quarta superfície
      nomeada e cercada por seis travas) e XIV (a ponta de durabilidade do CRM muda de forma:
      reconciliação periódica quando o gateway escreve por função). Três inconsistências internas
      corrigidas junto e declaradas no Sync Impact Report. **O que a emenda NÃO fez**: ela permitiu
      a superfície **sob condição**. As travas 1, 5 e 6 só ficam cumpridas com T011 e T016 verdes —
      sem elas, VII volta a ser violado e não há emenda que conserte. O pedido original era:
      - **VII**: não basta afrouxar "acesso direto ao banco". VII **enumera** as superfícies
        permitidas (API REST `/api/v1/`, MCP, webhooks) e RPC PostgREST não é nenhuma. A emenda tem
        de **nomear e delimitar a quarta superfície**: função `security definer` versionada, papel
        dedicado sem grant de tabela, tenant resolvido dentro do banco, e quem pode usá-la.
      - **XIV**: reler antes de concluir que só VII muda. A spec passou a cumpri-lo (FR-013 +
        FR-013a), mas a emenda tem de deixar claro que as **duas** pontas de durabilidade seguem
        obrigatórias quando o gateway escreve direto.
- [X] **T002** ✅ **FEITA em 2026-08-08.** `CLAUDE.md`: seção Gateway reescrita ("nunca toca
      **tabela**" + as seis travas + a quarta superfície não alcança o Cotador + as duas pontas de
      durabilidade); anti-patterns **15a/15b/15c** novos (tocar tabela ou segurar `service_role`/
      segredo do JWT · tenant vindo de parâmetro · durabilidade com uma ponta só). `AGENTS.md`
      **ganhou a seção de canal e gateway, que não existia** — ele mencionava o gateway uma única
      vez e nenhum agente externo tinha como saber destas regras. `.specify/templates/plan-template.md`:
      gates VII e XIV atualizados (era o `TODO(PLAN_TEMPLATE_VII)` do Sync Impact Report).
- [X] **T003** ✅ **DECIDIDA em 2026-08-08 pelo dono: (a) rota HTTP no gateway.** O provisionamento
      é o `gateway-provisioning-v1.md` §3-§8. **T014 morre** (`fn_gateway_provision_connection` não
      nasce) e **T029 deixa de ser condicional**.
      **Consequência que melhora a mitigação de VII**: quem grava `channel_sessions` volta a ser o
      **CRM**, pelo caminho que ele já usa (service role com `organization_id` de fonte confiável).
      O gateway devolve o `connection_id` e **nunca toca essa tabela** — a superfície de escrita dele
      cai de quatro funções para **duas**. Superfície menor é acoplamento menor.
      **E o tudo-ou-nada passa a ter um dono só, o CRM**: ele chama o gateway, recebe o id, grava sua
      linha; se a gravação falhar, chama `DELETE` no gateway para desfazer a instância (T043).

---

## Fase 1 — Superfície de escrita no banco do CRM (F1) — ✅ **COMPLETA em 2026-08-08**

- [X] **T010** ✅ `20260809120000_0127_gateway_writer.sql` + apêndice no baseline + MANIFEST. Papel `gateway_writer` na migration `<ts>_0127_gateway_writer.sql`: zero grant de
      tabela, `EXECUTE` só nas funções desta fase. Apêndice no baseline + MANIFEST. **(FR-002)**
- [X] **T011** ✅ `tests/invariants/gateway-writer-sem-tabela.test.ts` (6 asserções, verdes). Invariante que **reprova** se `gateway_writer` tiver qualquer privilégio em
      `information_schema.role_table_grants`. É a trava que impede o acoplamento voltar por
      acidente. **(FR-002)**
- [X] **T012** ✅ `20260809130000_0128_gateway_escrita.sql` + apêndice + MANIFEST. `fn_gateway_ingest_message` na migration `<ts>_0128_gateway_escrita.sql`. Esqueleto na
      §4 da decisão. Cada item tem motivo medido:
      - resolve `organization_id` de `channel_sessions.gateway_connection_id` **(FR-004)**;
      - `set constraints public.messages_org_external_id_unique immediate` **antes** do insert
        **(FR-007)** — sem isso o handler nunca dispara;
      - `exception when unique_violation` devolve o id existente + `duplicada = true` **(FR-006)**;
      - emite `ai_agent.dispatch_requested` na mesma transação, só inbound e só se não for eco
        **(FR-008, FR-009)**;
      - `revoke execute ... from public, anon` + `grant ... to gateway_writer` **(FR-003)**.
- [X] **T013** ✅ SQLSTATE `GW001` (conexão desconhecida/arquivada) e `GW003` (argumento inválido) — o gateway distingue por classe, sem parsear string. Taxonomia de erro das funções: **definitivo** (conexão desconhecida, arquivada, de
      outro dono, corpo inválido) vs **transitório** (banco fora, tempo esgotado, conflito de
      serialização), com erro sem classe caindo em transitório. É o que decide se o gateway retenta
      para sempre ou descarta cedo demais. **(FR-005)**
- [~] **T014** ❌ **MORTA pela T003.** Era `fn_gateway_provision_connection`. Com o provisionamento
      na rota HTTP do gateway, quem grava `channel_sessions` é o CRM pelo caminho dele (T043) — não
      há função de provisionamento a criar. Mantida riscada, não apagada, para a próxima sessão não
      reabrir a discussão achando que foi esquecimento. **(FR-011 agora é servida por T029 + T043)**
- [X] **T015** ✅ na 0128, com 4 testes de ACK verdes. `fn_gateway_update_message_status` — o ACK. Portar a guarda de não-regressão de
      `lib/gateway/ingest.ts:278-340` (`ORDEM_DO_ESTADO`): estado que não avança é ignorado com
      sucesso, `failed` sempre passa. Sem a guarda, um ACK atrasado apaga um `read` com um `sent`.
      **(FR-021, FR-022)**
- [X] **T016** ✅ em `gateway-escrita-direta.test.ts`. Invariante que varre as funções desta fase e reprova qualquer chamada HTTP
      (`http`, `pg_net`, `net.http_*`) — anti-pattern 9. **(FR-010)**
- [X] **T017** ✅ 4 testes verdes, e **vermelhos sob sabotagem** (ver T019). [TEST] Isolamento entre 2 organizações nas funções novas: conexão da org A **não**
      escreve na org B, nem passando id de fora. **(FR-004)**
- [X] **T018** ✅ 3 testes verdes, e **vermelhos sob sabotagem** (ver T019). [TEST] Idempotência ponta a ponta: mesma `external_id` duas vezes devolve o mesmo id,
      `duplicada = true` na segunda, **uma** linha em `messages`, **um** dispatch em `event_log`.
      **(FR-006, FR-007, FR-008)**
- [X] **T019** ✅ [SABOTAGEM] **Executada em 2026-08-08, as duas, com o resultado observado.**
      Não é declaração de intenção: o `baseline.sql` foi editado, o gate rodou, o vermelho foi lido
      e o arquivo restaurado.

      **Sabotagem A — removido o `set constraints ... immediate`:** 3 testes vermelhos, todos com
      `ERROR: duplicate key value violates unique constraint "messages_org_external_id_unique"`.
      É exatamente a falha prevista — sem a linha, o `exception when unique_violation` **nunca
      dispara** e o 23505 escapa. Prova que T018 vigia a linha, e não apenas o caminho feliz.

      **Sabotagem B — removido o filtro `where cs.gateway_connection_id = ...`:** 3 testes de
      isolamento vermelhos, **incluindo os dois de `GW001`** — sem o filtro, conexão desconhecida
      resolve para uma organização qualquer e a escrita é **aceita** em vez de recusada. Prova que
      T017 pega o vazamento de tenant, que é o pior modo de falha da feature.

      Gate completo depois de restaurar: **82 arquivos, 551 passed, 1 skipped**. **(SC-012)**

- [X] **T019a** ✅ **Análise pós-Fase 1 (2026-08-08): dois desvios contra o caminho de referência,
      achados comparando a função com `lib/gateway/ingest.ts` linha a linha, e corrigidos.**
      Nenhum dos dois teria sido pego pelos testes que eu mesmo escrevi — foram achados por leitura
      do comportamento que já existe, que é o que "não regredir" quer dizer aqui:

      **(1) Grupo entrava.** `ingest.ts:99-107` descarta conversa de grupo por doutrina
      (`CLAUDE.md`, seção WAHA). A função não tinha a guarda: trocar o escritor faria grupos
      criarem contato e conversa, e o agente responderia em grupo. Mudança de comportamento **em
      silêncio**, que é a pior classe de regressão numa migração. Entrou `p_eh_grupo` e o retorno
      ganhou `motivo` — ignorar vira decisão declarada, não descarte mudo.

      **(2) Mensagem recebida era marcada `sent_via='crm'`.** Bug meu. `ingest.ts:157` marca
      recebida como `external_device`; só o envio que passou pela nossa API é `crm`. Do jeito que
      estava, a conversa exibiria mensagem do cliente como se o sistema a tivesse mandado.

      Os dois ganharam teste próprio. Gate: **82 arquivos, 553 passed, 1 skipped**.

---

## Fase 2 — O fork do gateway (`/root/PROJETOS/gateway_go`)

Forma recomendada: **um repo, dois builds** (§5 da decisão), não fork literal.

- [ ] **T020** Extrair a camada de dados para interface (`internal/store`), com a implementação atual
      (Cotador) como primeira instância. Sem mudança de comportamento — commit próprio, verde antes
      de seguir.
- [ ] **T021** Segunda implementação, alvo CRM. Tradução de vocabulário na §3c da decisão
      (`escritorio_id`→`organization_id`, `inbox_mensagens`→`messages`, `wamid`→`external_id`…).
- [ ] **T022** Trocar o único upsert cru (`internal/processor/mensagem.go:100`) por chamada a
      `fn_gateway_ingest_message`. **É o ponto que não sobrevive à mudança de alvo sem reescrita** —
      §2 da decisão. **(FR-001)**
- [ ] **T023** Consumir a taxonomia da T013: definitivo descarta e registra, transitório retenta com
      recuo. Erro sem classe = transitório. **(FR-005)**
- [ ] **T024** Seleção da implementação por configuração no start, com falha explícita se ambígua.
      Endereço do banco é configuração — sem `localhost`, sem nome de serviço de compose (XIV).
- [ ] **T025** Fila em disco: sobrevive a reinício, teto de tamanho declarado, alarme quando para de
      drenar. **Não é polimento** — é metade do que XIV exige. **(FR-013)**
- [ ] **T026** [TEST] Matar o gateway com a fila cheia, subir de novo, provar que **nada** se perdeu
      e nada duplicou. **(FR-013, SC-011)**
- [ ] **T027** Teto de taxa **por conexão** (não global, não por IP — todas as entregas vêm do mesmo
      endereço). Um tenant não pode degradar outro. **(Princípio XIV)**
- [ ] **T028** Endpoint de reconciliação: dado uma janela, devolver o que foi entregue naquela
      conexão. É o que a T050 do lado do CRM consome. **(FR-013a)**
- [ ] **T029** Rotas de provisionamento do `gateway-provisioning-v1.md` §3–§8 — **o caminho
      escolhido na T003**, não mais condicional. Com as duas correções que o contrato pede:
      comparação de token em **tempo constante** (`internal/middleware/token.go:25` usa `!=`,
      enquanto `admin.go:44` já usa `subtle.ConstantTimeCompare`) e **escopo de admin** para
      provisionar/desprovisionar — hoje um token único deixa quem envia mensagem apagar instância.
      `DELETE` idempotente: apagar o que já não existe é `204`, senão o CRM trava com linha que não
      consegue limpar. **(FR-011, FR-012)**

---

## Fase 3 — CRM: envio pelo gateway (F2)

- [X] **T030** ✅ **FEITA em 2026-08-08** — `providerPodeEnviar()` / `providersQuePodemEnviar()` em
      `lib/channels/index.ts` + `tests/unit/canal-nasce-com-envio.test.ts` (4 testes, **vermelhos sob
      sabotagem**: `waha: null` derruba 2).
      **Medição que mudou a forma da task:** nenhuma rota de criação produz hoje canal sem envio — as
      duas gravam `waha` (default da coluna) e `meta_cloud`, ambos com adapter. Então isto é **guarda
      preventiva**, e está escrito como tal no código. O `getAdapter()` já era fail-closed, mas falha
      **no envio**, fundo na pilha, com erro técnico — para o corretor o desfecho é um canal que
      conecta, recebe e nunca responde. A guarda existe para o instante em que a Fase 3 acrescentar
      provider do gateway, que é exatamente o instante em que ninguém vai lembrar disto. **(FR-014)**
- [ ] **T031** Adapter de envio atrás do seam `getAdapter(provider)`, fail-closed. Nenhuma feature do
      CRM passa a nomear provedor. **(FR-015, FR-016)**
- [ ] **T032** Resolver a conexão de destino do próprio canal, nunca de corpo de requisição. É o
      pior caso da feature (Edge Cases: mensagem sai pelo número de outra organização).
      **(FR-017)**
- [ ] **T033** Credencial em cabeçalho, nunca em query string; endereço do gateway como
      configuração. **(FR-018)**
- [ ] **T034** Gravar como `external_id` o identificador que o gateway devolve, e provar que ele
      **casa** com o que volta na confirmação de entrega — se não casar, o visto nunca chega.
      **(FR-019)**
- [ ] **T035** Passar o envio migrado pelas mesmas travas de vazão e janela do envio atual, e
      **corrigir `app/api/v1/cron/recover-stuck-messages`**, que hoje monta chamada crua ao WAHA e
      ignora o seam — num canal migrado ela envia para o lugar errado, em silêncio. **(FR-020)**
- [ ] **T036** Tratar a resposta do gateway como **aceite provisório**: estado definitivo só pela
      confirmação assíncrona. **(FR-021)**
- [ ] **T037** Queda do gateway vira alerta para a operação **e** aviso na Central para o usuário
      (`agent_inbox_items`). Silêncio é proibido. **(FR-023, Princípio XIV)**
- [ ] **T038** Mídia entregue por referência de endereço, com validade **≥ 1 h** — cobre a
      retentativa do gateway mais a busca do provedor, com margem para reinício. **(FR-024)**
- [ ] **T039** Envio para grupo continua impedido pelo caminho novo, com o mesmo desfecho de hoje —
      e não vira erro obscuro. **(FR-025)**

---

## Fase 4 — CRM: conexão pela tela (F3)

- [ ] **T040** Parear número novo pela tela, pelo gateway, com QR code, **sem passo a mais** e
      **sem** a tela nomear provedor. **(FR-030)**
- [ ] **T041** Tela detecta sozinha que conectou — sem recarregar, sem confirmar à mão. Consome
      `expires_at` para pedir material novo **quando expira**, em vez de refazer a imagem a cada
      15 s no escuro. **(FR-031)**
- [ ] **T042** Traduzir os estados do gateway para o vocabulário da tela; estado desconhecido cai em
      estado seguro e legível — **nunca tela vazia**. **(FR-032)**
- [ ] **T043** Criar canal tudo-ou-nada: provisionamento falhando não deixa linha órfã no CRM nem
      instância órfã no provedor. **O CRM é o dono da compensação** (T003): recebe o `connection_id` do gateway, grava sua linha, e se a gravação falhar chama `DELETE` no gateway. Prova compartilhada com T029. **(FR-033, FR-012)**
- [ ] **T044** Convergir as duas portas (onboarding e Central de Conexões) para o mesmo caminho de
      criação — hoje divergem em rota e em formato de nome de sessão. **(FR-034)**
- [ ] **T045** Exigir papel `admin` nas **duas** portas. Hoje a do onboarding não exige papel nenhum
      — furo pré-existente que migrar sem corrigir carregaria para o caminho novo. **(FR-035)**
- [ ] **T046** Desconectar e reconectar pela tela no canal migrado, com os mesmos desfechos de hoje.
      **(FR-036)**
- [ ] **T047** Cada canal continua com segredo de recebimento próprio — a migração não pode
      reintroduzir segredo global. **(FR-037)**
- [ ] **T048** [SABOTAGEM] Provar que os testes das Fases 3 e 4 vigiam: quebrar a resolução de
      conexão e ver T032 vermelho; remover a checagem de papel e ver T045 vermelho. **(SC-012)**

---

## Fase 5 — Transversais

- [ ] **T050** Reconciliação periódica do lado do CRM: pergunta ao gateway (T028) o que ele entregou
      numa janela, grava o que faltar pelo caminho idempotente, e **alarma** na divergência —
      reconciliar em silêncio esconde o defeito que se queria medir. É a segunda ponta que o
      Princípio XIV exige. **(FR-013a)**
- [ ] **T051** Reversibilidade por canal: migrar e voltar sem tocar nos demais e sem perder mensagem
      em voo. **(FR-041)**
- [ ] **T052** Estender o vigia mecânico de payload cru — hoje cobre só o caminho de **recebimento**
      — para o caminho de **envio**. **(FR-042, anti-pattern 15)**
- [ ] **T053** Auditoria de toda mudança de canal: criar, migrar, reverter, apagar. **(FR-043)**
- [X] **T054** ✅ **JÁ ENTREGUE pela spec 001** — verificado, não reimplementado. `GATEWAY_BASE_URL`,
      `GATEWAY_INTERNAL_TOKEN`, `GATEWAY_INBOUND_ENABLED`, `GATEWAY_MAX_BODY_BYTES` e
      `GATEWAY_MAX_MEDIA_BYTES` existem em `lib/env.ts` **e** em `.env.example`, e `lib/env.ts:238`
      já falha no boot quando `GATEWAY_INBOUND_ENABLED=true` sem `GATEWAY_BASE_URL`. **(FR-044)**
- [ ] **T055** Toda mudança de estado de canal/mensagem sai como migration versionada + apêndice no
      baseline + linha no MANIFEST. Conferir ao fim de cada fase, não no fim de tudo. **(FR-040)**

---

## Fase 6 — Execução e prova (os SC não se provam sozinhos)

Cada uma destas é **execução medida**, não implementação. Sem elas os Success Criteria são texto.

- [ ] **T060** 20 envios reais por canal migrado: **100%** chegam, p95 do clique à chegada **≤ 5 s**;
      **100%** terminam com `external_id` e estado final coerente, zero em estado sem dono.
      **(SC-001, SC-002)**
- [ ] **T061** Estado de entrega alcança o valor final em **≥ 99%** de 20 mensagens, com **zero**
      regressões observadas na tela. **(SC-003)**
- [ ] **T062** Rajada de 50: espaçamento configurado respeitado em **100%** das amostras, **zero**
      envios fora da janela de horário. E varredura **mecânica** provando **zero** envios por
      caminho que escapa das travas. **(SC-004, SC-005)**
- [ ] **T063** Conta **nova**, estado **vazio**: QR na tela em **≤ 15 s**, jornada login → primeira
      conversa atendida **≤ 10 min**, contagem de passos **idêntica** à de antes. Evidência visual em
      `.superpowers/evidence/`. `curl` não conta. **(SC-006, Princípio IV)**
- [ ] **T064** Varredura por nome de provedor em texto visível nas telas de conexão e onboarding:
      **zero** ocorrências. **(SC-007)**
- [ ] **T065** Falha de provisionamento forçada **10 de 10**: nenhum canal órfão no CRM, nenhuma
      instância órfã no provedor. **(SC-008)**
- [ ] **T066** Reverter canal no meio de tráfego: **100%** das mensagens em voo preservadas, **zero**
      duplicatas, provado por contagem antes/depois. **(SC-009)**
- [ ] **T067** Imagem, documento e áudio abrindo **no aparelho** do destinatário, **3 de 3**.
      **(SC-010)**
- [ ] **T068** Gateway derrubado: **100%** das tentativas terminam em estado reagendável e **um**
      aviso aparece na Central — nenhuma mensagem perdida em silêncio. **(SC-011)**
- [ ] **T069** Atualizar `docs/testing/user-journey-map.md`, `docs/migracao-para-o-gateway.md` e
      `docs/current-state.md` com o estado real ao fim.

---

## Ordem e o que trava o quê

```
T001 ✅ T002 ✅ T003 ✅  Fase 0 COMPLETA — Fase 1 liberada
                        (T003 escolheu a rota HTTP: T014 morta, T029 firme)
T010-T011  papel + trava       ──▶ T012-T016
T012-T016  funções             ──▶ T017-T019 (provas)  e  ──▶ T022
T020-T021  costura             ──▶ T022-T025
T022+T025  escrita + fila      ──▶ Fase 3
T028       reconciliação (gw)  ──▶ T050 (reconciliação CRM)
T030       recusa legível      ──▶ antes de T031-T039
Fase 3 + Fase 4                ──▶ Fase 5 ──▶ Fase 6
```

**Paralelizável [P]**: T011 com T012 · T027 com T028 · T051 a T054 entre si · T064 com T067.

## Cobertura declarada

| Bloco | Requisitos | Onde |
|---|---|---|
| F1 | FR-001 a FR-014 (+FR-013a) | T010–T019, T050 |
| F2 | FR-015 a FR-025 | T030–T039 |
| F3 | FR-030 a FR-037 | T040–T047 |
| Transversais | FR-040 a FR-044 | T050–T055 |
| Success Criteria | SC-001 a SC-012 | T060–T068, e as tasks `[SABOTAGEM]` para SC-012 |

**Dívidas herdadas da spec 001 que continuam abertas** (contexto em
`001-migracao-waha-uazapi/tasks.md`): T069 script de cura sem chamador, T070 prova de segredo
placeholder no nível do banco, T071 cron de retenção nunca agendado (LGPD). Não bloqueiam esta spec,
mas seguem contando — e T071 **não** é dispensada pela decisão: `webhook_events_log` continua em uso
pelos demais provedores.
