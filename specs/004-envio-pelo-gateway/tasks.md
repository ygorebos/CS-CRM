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

## Fase 2 — O fork do gateway — ✅ **COMPLETA em 2026-08-08** (worktree `gateway_go-crm`, branch `feat/004-escrita-crm`)

Forma recomendada: **um repo, dois builds** (§5 da decisão), não fork literal.

- [X] **T020** ✅ **FEITA em 2026-08-08** (worktree `gateway_go-crm`, branch `feat/004-escrita-crm`,
      commit `4df6cf0`). `internal/store` com interface de 3 verbos; `Cotador` é casca sobre o
      processor — zero mudança de comportamento, e o commit diz por que absorver o processor depois
      seria mudança própria. 13 call sites de handlers fiados em `h.Store`. Suíte: 16 pacotes ok.
- [X] **T021** ✅ **FEITA** no mesmo commit — `internal/store/crm.go`. Só fala com as duas funções
      versionadas; tenant NUNCA no corpo (teste dedicado, vermelho sob sabotagem); tradução
      recebida/enviada→inbound/outbound, tipo fora do CHECK→`system` com `tipo_original` preservado;
      régua de telefone idêntica à do CRM (divergir parte o histórico do contato).
- [X] **T022** ✅ **FEITA por desenho melhor que o previsto**: o upsert cru de `mensagem.go:100`
      continua existindo **só dentro da variante Cotador** (via processor). Na variante CRM o caminho
      inteiro passa por `fn_gateway_ingest_message` — não há upsert a trocar, há implementação a
      escolher no boot. O ponto medido na §2 da decisão (idioma `ignore-duplicates` não sobrevive à
      constraint DEFERRABLE) morre porque a variante CRM nunca fala com tabela. **(FR-001)**
- [X] **T023** ✅ **FEITA** — `store.ErroDefinitivo()` reconhece SQLSTATE `GW***` no corpo PostgREST;
      teste cobre GW001 (definitivo) e 57014 (transitório). O CONSUMO no laço de retentativa da fila
      é a T025 — a função existe e está testada, o laço ainda não a chama. **(FR-005)**
- [X] **T024** ✅ **FEITA** — `STORE_ALVO=cotador|crm` (default cotador: todo deploy existente segue
      igual), `CRM_POSTGREST_URL` + `CRM_GATEWAY_WRITER_TOKEN` obrigatórias no alvo crm. Typo ou
      config incompleta **recusam o boot** — testado. Endereço é configuração pura.
- [X] **T025** ✅ **FEITA** (commit `ebc1ba7` no worktree) — `store.ComFila`: falha transitória de
      escrita enfileira em disco (subdir `escrita/` do `ENTREGA_FILA_DIR`), retentativa com recuo e
      teto pela máquina de política que a fila de entrega já tinha; definitivo (GW***) não enfileira
      — descarta com registro; descarte abre o `AoMorrer` (o gancho do aviso visível). ⚠️ **Resta da
      FR-013**: teto de TAMANHO da fila e alarme de dreno lento — a fila herdada tem teto de
      tentativas, não de tamanho. Vai como task própria na Fase 5 (T056). **(FR-013 parcial)**
- [X] **T026** ✅ **FEITA** — `TestEscritaSobreviveAoReinicio`: enfileira com o banco fora, REABRE a
      fila no mesmo diretório (o reinício), drena com o banco de volta — 3/3, zero perda. O "nada
      duplicou" é do lado do CRM (idempotência por `external_id`, provada na Fase 1). A versão com
      processo real morto no meio é a §6 do quickstart (T068). **(FR-013, SC-011 parcial)**
- [X] **T027** ✅ **FEITA** (commit `68207ff`) — balde de fichas por conexão em `store.ComTeto`,
      composto como `ComFila(ComTeto(crm))`: estouro é erro **transitório**, vira pendência de disco
      da própria conexão e drena no ritmo do teto, enquanto as outras seguem em tempo real.
      **Medido antes: nenhum rate limit existia no gateway, em camada nenhuma.** Default 25/s
      sustentado, rajada 50. Sabotagem: teto desligado derruba 2 testes. **(Princípio XIV)**
- [X] **T028** ✅ **FEITA** (commit `bca3896`) — `GET /v1/connections/{id}/reconciliation?since&until`.
      Fonte é o PROVEDOR (decisão da análise); o `/message/find` da uazapi não filtra por tempo
      (conferido no OpenAPI dele), então a janela é cortada no gateway e o teto de páginas é
      **declarado** (`truncated=true` — o CRM estreita a janela e repete). Grupo fora pela mesma
      doutrina da ingestão. **(FR-013a)**
- [X] **T029** ✅ **FEITA** (commit `4c85d6e`) — as 5 rotas do contrato §3-§7 atrás do token de
      ADMIN, com as duas correções que o contrato pedia (tempo constante em `token.go` — commit
      `bb059e2` — e escopo admin). Idempotency-Key durável no próprio registro (provedor vê UMA
      criação por chave, provado contando); tudo-ou-nada com rollback e órfã logada; DELETE 204
      idempotente fechando o buraco que o código antigo comentava; `expires_at` no pair; estado
      desconhecido cai em `failed` com o cru ao lado; variante cotador responde 404. **PUT
      /delivery (§8) não entra na variante crm por decisão**: não há segredo HMAC a rodar — a
      credencial é o token do papel, e a rotação dele é do lado do CRM. Sabotagem: idempotência
      removida derruba o teste. **(FR-011, FR-012)**
- [X] **T029a** ✅ **FEITA** (commit `bb059e2`) — costura `Fonte` no resolver (`New()` preservado;
      `NewComFonte` para a variante CRM) + `internal/registro`: arquivo JSON por conexão, escrita
      atômica, travessia de diretório recusada, sobrevive a reinício (testado). Sem isto, toda rota
      de envio da variante CRM consultaria o banco do Cotador.

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
- [X] **T031** ✅ (commit `47e42228`) Adapter `lib/channels/adapters/gateway.ts` no seam, fail-closed preservado.
- [X] **T032** ✅ no mesmo commit — `sessionRef` = `gateway_connection_id` do canal; corpo nunca escolhe conexão; teste varre `organization` fora do JSON.
- [X] **T033** ✅ — credencial só em cabeçalho (teste afirma que a URL não contém o token).
- [X] **T034** ✅ — `message_id` da resposta vira `external_id`; ausente → null, nunca inventado.
- [X] **T035** ✅ Passar o envio migrado pelas mesmas travas de vazão e janela do envio atual, e
      corrigir a rotina de recuperação que monta chamada crua ao WAHA e ignora o seam — num canal
      migrado ela envia para o lugar errado, em silêncio. **(FR-020)**
  - **Correção do alvo:** a task nomeava `app/api/v1/cron/recover-stuck-messages`. Medido: essa
    rota **não envia nada** — só marca `failed` e abre aviso na Central. Quem monta a chamada crua é
    o **redrive do watchdog** (`lib/agent-engine/edge/crm/session-reconciler.ts:139`), que fazia
    `POST /api/sendText` com `waha_session_name` — NULO numa sessão do gateway. O defeito descrito
    existia; o arquivo era outro.
  - **Buraco anterior, achado no caminho:** `resolveSessionRef` só conhecia `waha` e `meta_cloud`.
    O `switch` é exaustivo no TypeScript, então uma sessão `whatsapp_uazapi` **não reprovava o
    typecheck** e devolvia `undefined` em runtime — e `JSON.stringify` apaga chave undefined. Todo
    envio de canal migrado sairia sem `connection_id`. Consertado com `gateway_connection_id` na
    união, na `CHANNEL_SESSION_REF_COLUMNS` e com `throw` no lugar do `undefined`.
  - **Travas de vazão: nada a mudar, e isso foi medido.** `lib/automation/actions/send-whatsapp.ts`
    aplica janela 7h-22h, limite diário por `channel_session_id` e espaçamento+jitter **antes** de
    chamar `sendMessageHandler`, e nenhum desses passos pergunta o provider — o arquivo nem está na
    `KNOWN_DEBT` do `lint-channels`, que já proíbe nomear provider fora de `lib/channels/`. O envio
    migrado herda a cadeia inteira por construção.
  - **Provas:** `tests/unit/endereco-da-conexao-no-envio.test.ts` (3, vermelho antes: 3/3) e o bloco
    novo de `tests/invariants/agent-watchdog.test.ts` (2) — canal do gateway sem credencial fica
    `queued` e o WAHA **não** recebe nada; com o gateway no ar sai por ele, endereçado pela conexão
    da sessão. Sabotagem (`getAdapter('waha')` fixo): os 2 reprovam.
  - **Fixture que modelava linha impossível:** `conversationRow` de
    `tests/unit/messages-handler-desfechos.test.ts` gravava `waha_session_name` para QUALQUER
    provider — linha que o `channel_sessions_provider_ref_check` recusa. Agora espelha o CHECK, e o
    caso `meta_cloud` passou a exercitar `resolveMetaCreds` de verdade (o dublê do admin ganhou
    `.from`).
  - Verde: `pnpm test:unit` 3096/3096, `pnpm test:db` 555/555, typecheck e `lint-channels` zerados.
- [X] **T036** ✅ Resposta do gateway tratada como **aceite provisório**: estado definitivo só pela
      confirmação assíncrona. **(FR-021)**
  - O handler grava `sent` + `ack: 0` — "recebi", não "chegou". Quem promove para `delivered`/`read`
    é `fn_gateway_update_message_status`, com a guarda de não-regressão de estado (Fase 1). O
    `external_id` do aceite é gravado no mesmo update **porque é por ele que a confirmação
    assíncrona acha a linha depois** — sem id, o estado definitivo nunca chega.
  - Prova: `tests/unit/messages-handler-desfechos.test.ts` caso `T036/FR-021`. Sabotagem
    (`status: 'delivered', ack: 2` na resposta síncrona): 6 casos reprovam, inclusive este.
- [X] **T037** ✅ Queda do gateway vira alerta para a operação **e** aviso na Central para o usuário
      (`agent_inbox_items`). Silêncio é proibido. **(FR-023, Princípio XIV)**
  - **A tripla de schema:** `20260809140000_0129_aviso_gateway_fora.sql` + apêndice no `baseline.sql`
    (bloco ÚNICO da constraint, editado no lugar — #159) + linha no MANIFEST. Kind novo
    `gateway_unreachable`, **separado** de `gateway_inbound_down`: lá o recebimento está desligado
    por configuração (uma variável, e o envio continua saindo); aqui o processo não responde e nem
    entra nem sai mensagem. Fundir faria o aviso mentir em metade dos casos.
  - **Onde mora:** `lib/gateway/aviso-de-gateway-fora.ts`, chamado pelo **dreno** — que já roda a
    cada minuto e já tem o cliente de serviço na mão. Cron novo seria peça a mais para agendar,
    monitorar e esquecer.
  - **As duas pontas do XIV:** `logger.error` (alerta que vira Sentry) **e** item `critical` na
    Central. A cópia é para o corretor, não para nós — sem jargão, dizendo que **nada se perde** e
    que dá para responder pelo aparelho enquanto isso. Prometer ação a quem não pode agir é pior que
    calar, então ela não pede conserto nenhum ao usuário.
  - **Fecha sozinho.** O tique que acha o gateway de pé resolve os avisos abertos. Aviso crítico que
    continua aberto depois do conserto ensina exatamente o hábito que a Central não pode criar.
  - **Só avisa quem DEPENDE** (conexão com `ingest_path='gateway'` ou `gateway_connection_id`), e
    quando ninguém depende a sondagem nem sai. Alarme falso em instalação que não virou a chave é o
    jeito mais rápido de a Central perder credibilidade.
  - **Prova:** `tests/unit/aviso-de-gateway-fora.test.ts` (6). Sabotagens: `res.ok` → `true` (502
    contando como "no ar") e `status:'resolved'` → `'open'` reprovam um caso cada. **O dublê teve de
    ser consertado no meio:** a primeira versão ignorava o payload do `update` e a segunda sabotagem
    passava verde — dublê que não olha o que foi escrito não prova escrita nenhuma.
  - **O typecheck cobrou a tela:** `Record<InboxKind, string>` em `lib/ai/agent-inbox-copy.ts`
    reprovou o kind sem cópia. Peça nova sem porta de saída não compila — é o mapa vivo funcionando.
  - Verde: `pnpm test:unit` 3106/3106, `pnpm test:db` 555/555, typecheck e `lint-channels` zerados.

### Análise de fim da Fase 3 (2026-08-08) — um achado, corrigido antes de seguir

Conferido o corpo do `POST /v1/messages` **contra a struct Go de verdade**
(`internal/handlers/messages.go:33-56`), campo por campo: `connection_id`, `to`, `tipo`, `texto`,
`midia_url`, `midia_mime`, `nome_arquivo` e a resposta `message_id` batem.

**O que NÃO batia: a legenda.** O adapter montava a mídia sem `media.caption`. O gateway repassa a
legenda em `texto`, ao lado de `midia_url` (`sender/dispatch.go:63` — `Texto` viaja junto com
`MidiaURL`), e os **dois** adapters que já existiam mandam (`lib/waha/media-send.ts:24`,
`meta-cloud.ts:51`). Só o novo esquecia — e o desfecho é da mesma família dos outros defeitos desta
fase: a foto chegava ao cliente **sem uma palavra**, sem erro, sem log, e com o CRM registrando
envio bem-sucedido. Corrigido com teste próprio; sabotagem (descartar a legenda) reprova.
- [X] **T038** ✅ Mídia entregue por referência de endereço, com validade **≥ 1 h** — cobre a
      retentativa do gateway mais a busca do provedor, com margem para reinício. **(FR-024)**
  - **Defeito medido:** o handler assinava a URL por **600 s**. Dez minutos cobrem o canal que baixa
    na hora e mais nada — com o gateway no caminho a mensagem pode esperar na fila em disco. A
    referência vencia antes da busca do provedor e virava anexo que não abre no celular do cliente,
    com o CRM achando que o envio deu certo. Agora `MEDIA_SIGNED_URL_TTL_S = 60 * 60`, exportada e
    documentada como piso.
  - Prova: caso `T038/FR-024` afirma `>= 3600`. Sabotagem (voltar a 600): reprova.
- [X] **T039** ✅ Envio para grupo continua impedido pelo caminho novo, com o mesmo desfecho de hoje —
      e não vira erro obscuro. **(FR-025)**
  - O desfecho é o MESMO (`failed`, nada sai); o que muda é o motivo. O ramo `!chatId` do handler
    gravava `missing_phone_number` para as duas causas — e numa conversa de grupo isso é mentira: o
    grupo não tem telefone e nunca vai ter, e quem lia ia procurar um cadastro para consertar. Agora
    grupo sai como `group_send_unsupported` com mensagem legível. **Conserta também o canal
    oficial**, que já devolvia `null` para grupo e herdava o mesmo erro obscuro.
  - **Par de casos, de propósito:** o segundo prova que o canal que SABE endereçar grupo continua
    enviando. Sem ele, "impedir grupo" poderia ter virado proibição geral e uma capacidade existente
    morreria sem ninguém notar.
  - Prova: casos `T039/FR-025` e o par. Sabotagem (voltar o `error_code` fixo): reprova.

---

## Fase 4 — CRM: conexão pela tela (F3)

- [X] **T040** ✅ Parear número novo pela tela, pelo gateway, com QR code, **sem passo a mais** e
      **sem** a tela nomear provedor. **(FR-030)**
  - Rota nova `GET /api/v1/channel-sessions/[id]/pairing` — JSON, serve os **dois** canais. A rota
    irmã `/qr` devolve bytes de PNG e continua existindo sem mudança: ela é o caminho de quem já usa,
    e mexer nela agora tocaria o passo mais frágil da instalação existente.
  - **Sem passo a mais:** o diálogo é o mesmo, o fluxo é o mesmo. O que mudou é de onde o material
    vem. E **sem nomear provedor**: a decisão "que natureza de endereço esta conexão tem" virou
    `classificarRef()` em `lib/channels/session-ref.ts` — o `lint-channels` reprovou a primeira
    versão da rota, que lia a coluna direto, e o conserto foi mover a pergunta para dentro do seam.
  - **Código de pareamento por número** apareceu de graça: o contrato devolve `pair_code`, e a tela
    passou a mostrá-lo. É a saída de quem tem um aparelho só e não consegue apontar a câmera para a
    própria tela.
- [X] **T041** ✅ Tela detecta sozinha que conectou; consome `expires_at` para pedir material novo
      **quando expira**, em vez de refazer a imagem a cada 15 s no escuro. **(FR-031)**
  - **O 15 s errava nas DUAS direções:** era palpite de folga sobre uma expiração que ninguém
    declarava. Quem demorava a pegar o celular ainda escaneava código morto — e concluía que o
    aparelho dele é que estava ruim; quem escaneava rápido pagava requisições que não precisavam
    sair. `proximoPedidoDeQrMs()` (`lib/channels/validade-do-qr.ts`) agenda para 3 s **antes** do
    vencimento.
  - **Canal que não declara validade mantém os 15 s.** Fingir uma validade não medida seria pior que
    não ter nenhuma: erraria com aparência de precisão.
  - **Piso de 1 s** para validade já vencida (relógio fora de sincronia, aba em segundo plano) — sem
    ele o cálculo dá negativo e a tela entra em laço de requisições.
  - A detecção de conexão já existia (poll de 3 s em `channel_sessions`) e não mudou.
  - **Prova:** `tests/unit/pareamento-com-validade.test.ts` (5) sobre a função pura — testar o
    `useEffect` inteiro exigiria montar diálogo, cliente HTTP e relógio para provar uma conta de
    cinco linhas. Sabotagem (ignorar a validade): 3 reprovam.
  - ⚠️ **Falta a prova de TELA** (Playwright, conta nova, estado vazio) exigida pela doutrina de QA
    Visual — está na Fase 6 (T060-T069), junto com a execução medida do quickstart.
- [X] **T042** ✅ Traduzir os estados do gateway para o vocabulário da tela; estado desconhecido cai
      em estado seguro e legível — **nunca tela vazia**. **(FR-032)**
  - Duas funções, e as duas em `lib/gateway/provisionamento.ts`: `estadoConhecido()` (cru → um dos
    seis do contrato §5.1; qualquer outra coisa vira `failed`, com o cru preservado em
    `provider_status` para o diagnóstico) e `statusDeCanalPara()` (os seis → o vocabulário da COLUNA
    `channel_sessions.status`, que é o que a tela, o envio e os invariantes já leem).
  - **Por que traduzir, em vez de alinhar as pontas:** nenhuma das duas pode ceder. O gateway
    normaliza N provedores num vocabulário só — é exatamente o motivo de a normalização ser dele e
    não nossa; e a coluna tem CHECK, então mudá-la seria migração destrutiva num banco único só para
    renomear estado.
  - `created` e `connecting` caem no MESMO `STARTING`: a tela não tem o que mostrar de diferente
    entre "registro criado" e "subindo" — nos dois o corretor espera. Inventar um estado a mais daria
    a ele uma tela que muda sem que nada tenha mudado.
  - Prova: casos `T042` e "estado desconhecido cai em failed" em `tests/unit/conexao-tudo-ou-nada.test.ts`.
  - **Falta a metade de TELA** (mostrar o estado traduzido na Central), que anda junto com T040/T041.
- [X] **T043** ✅ Criar canal tudo-ou-nada: provisionamento falhando não deixa linha órfã no CRM nem
      instância órfã no provedor. **O CRM é o dono da compensação** (T003). **(FR-033, FR-012)**
  - **Cliente do contrato:** `lib/gateway/provisionamento.ts` — as cinco rotas do
    `gateway-provisioning-v1.md`, mais `estadoConhecido()` (§5.1: estado que o CRM não reconhece cai
    em `failed` com o cru preservado, **nunca** tela vazia — já entrega a FR-032 da T042).
  - **Token ADMIN, não o interno** (§2, correção 2): `GATEWAY_ADMIN_TOKEN` nova em `lib/env.ts` e
    `.env.example`. Criar instância custa dinheiro e apagar é irreversível; vazar a credencial de
    **envio** não pode significar poder de apagar a instância de todos. O gateway já recusa o interno
    nessas rotas (`middleware/admin.go:21`), então trocar um pelo outro falha alto.
  - **A ordem é gateway-primeiro, e isso é a decisão:** se a linha do CRM viesse antes, um
    provisionamento falho deixaria **canal fantasma na tela**, e o corretor tentaria parear um número
    que não existe em lugar nenhum. Nesta ordem, a falha do primeiro passo não deixa rastro.
  - **A compensação saiu da rota para `provisionarEGravarConexao`**: compensação dentro de Route
    Handler só se exercita montando request, sessão e cliente — três dublês para testar um `if`. Com
    as portas injetáveis, o caso que importa é um teste de três linhas.
  - **Idempotência derivada da conexão** (`channel:<org>:<sessionName>`), não aleatória: clique duplo
    ou retry depois de timeout reusam a MESMA chave e o gateway devolve a MESMA instância. Chave
    aleatória por chamada tornaria a proteção enfeite, e **cada timeout viraria uma instância paga e
    órfã**.
  - **Órfã que não dá para desfazer AGORA vira alerta**, nunca silêncio: quem receber a fatura do
    provedor não tem como saber que a instância é nossa.
  - **Prova:** `tests/unit/conexao-tudo-ou-nada.test.ts` (14). Sabotagem (remover a chamada de
    compensação): reprova o caso que congela o defeito.
- [X] **T044** ✅ Convergir as duas portas (onboarding e Central de Conexões) para o mesmo caminho de
      criação. **(FR-034)**
  - **A divergência que doía não era a rota, era a COLUNA.** Medido: o onboarding não definia
    `ingest_path`, então a linha nascia com o default `legacy` — e o onboarding é **A** porta do
    usuário novo, a única por onde quem se cadastra passa. O corretor recém-chegado ficava fora do
    gateway mesmo numa instalação que já tinha virado a chave, sem nada na tela dizendo isso: o
    "gateway de pé e sem uso" acontecendo justamente com quem mais importa. E não emitia
    `channel.connected` — número entrando no ar sem registrar quem ligou, na porta de 100% deles.
  - **Conserto:** `lib/channels/criar-conexao.ts`, caminho único das duas. Consertar as colunas num
    dos dois inserts deixaria o outro livre para divergir de novo amanhã.
  - **O que NÃO converge, de propósito:** o formato do nome. `org_<8>` fixo no onboarding é o que faz
    quem fechou a aba e voltou cair na conexão que já começou (nome aleatório criaria uma órfã por
    tentativa); aleatório na Central é o que permite ter mais de um número. Intenções diferentes,
    identidades diferentes — o nome é **parâmetro**, e o teste afirma a diferença em vez de fingir
    que não existe.
  - **Prova:** `tests/unit/portas-de-conexao-convergem.test.ts` (4) — compara as DUAS linhas em vez
    de conferir lista de campos, que é o que sobreviveria a alguém acrescentar coluna numa porta só.
    Sabotagem (remover `ingest_path`): reprova.
- [X] **T045** ✅ Exigir papel `admin` nas **duas** portas. A do onboarding não exigia papel nenhum
      — furo pré-existente que migrar sem corrigir carregaria para o caminho novo. **(FR-035)**
  - **O furo, medido:** `/api/v1/onboarding/whatsapp/session` só checava `loadAuthUser` +
    `resolveActiveOrg`. Um `viewer` podia iniciar o pareamento de um número da organização e — pior
    — **ressuscitar** um canal que o admin tinha excluído: a rota reativa a linha arquivada quando o
    nome bate, e o nome é derivado do id da org, então bate **sempre**. Excluir um número é decisão
    de admin; desfazê-la não podia ser de qualquer um. A porta gêmea já exigia `admin` desde sempre,
    então isto não é regra nova — é a mesma regra chegando na porta que ficou para trás.
  - **Por que agora e não depois:** migrar o pareamento para o gateway sem corrigir levaria o furo
    para o caminho novo, onde ele passaria a valer também para o provisionamento de instância no
    provedor — que custa dinheiro por instância criada.
  - **O `GET` continua aberto** a qualquer membro, de propósito: ele só LÊ o estado, e negá-lo
    transformaria a tela num erro para quem não pode parear, sem impedir nada.
  - **Achado ao escrever o teste:** com `admin`, a rota estourava exceção crua — `ensureChannelSession`
    lança em três situações reais (cifra indisponível, insert recusado, reativação falha) e nada
    capturava. O corretor levaria **500 com pilha na primeira tela do produto**, onde a primeira
    impressão se decide. Agora vira `internal_error` legível com o motivo em `details`.
  - **Prova:** 6 casos novos em `tests/unit/rbac-matrix.test.ts` — o par das duas portas existe
    porque o defeito ERA a divergência; cobrir só a consertada deixaria a outra livre para divergir
    de novo. Sabotagem (`requireRole("viewer")`): 2 reprovam.
- [X] **T046** ✅ Desconectar e reconectar pela tela no canal migrado, com os mesmos desfechos de
      hoje. **(FR-036)**
  - **Reconectar** caía no 422 de "canal oficial" — mensagem errada sobre um canal que TEM sessão, e
    beco sem saída na tela: o corretor lia que precisava atualizar a credencial de uma API que ele
    não usa. Agora reconectar é **re-parear** pelo gateway, com o mesmo `force` de hoje, o mesmo
    audit `channel.reconnected` e o status já traduzido para o vocabulário da tela.
  - **Excluir era o caro.** O canal migrado caía no ramo do canal oficial, que só zera credencial e
    roda o token de webhook. A linha sumiria da tela e **a instância continuaria viva no provedor** —
    recebendo, sendo cobrada todo mês, sem nenhum lado reconhecendo-a como sua. É a instância órfã da
    T043 chegando pela porta de SAÍDA em vez da de entrada. Agora excluir desprovisiona.
  - **Duas remoções, de propósito:** `apagarNoGateway` lança, `apagarNoGatewaySemLancar` engole. O
    silêncio é certo na compensação (quem chama já trata outra falha; uma exceção trocaria "não
    consegui criar" por um erro sobre a limpeza) e errado no pedido do usuário (falhar calado deixa a
    tela dizendo que o número saiu enquanto ele continua ligado e cobrando).
  - Prova: caso `T046/FR-036` em `tests/unit/conexao-tudo-ou-nada.test.ts`; `test:db` 555/555 (as
    rotas tocam schema de canal).
- [X] **T047** ✅ Cada canal continua com segredo de recebimento próprio — a migração não pode
      reintroduzir segredo global. **(FR-037)**
  - Satisfeito por construção depois da T044: o caminho único chama
    `provisionarSegredoDeWebhook` **por conexão** (32 bytes novos, cifrados at-rest), e o
    `webhook_path_token` também nasce por conexão — dois canais com o mesmo token receberiam a
    entrega um do outro.
  - **A guarda afirma o MECANISMO, não o valor:** provisionamento chamado uma vez por conexão. Um
    segredo guardado em módulo, env ou cache passaria por um teste que só comparasse dois valores
    diferentes na mesma rodada; não passa por este.
  - Prova: caso `T047/FR-037` em `tests/unit/portas-de-conexao-convergem.test.ts`.
- [X] **T048** ✅ [SABOTAGEM] **Executada em 2026-08-08, as duas, com o resultado observado.** Não é
      declaração de intenção: os arquivos foram editados, a suíte rodou, o vermelho foi lido e tudo
      restaurado (typecheck zerado depois).

      **Sabotagem A — resolução da conexão do gateway quebrada** (`resolveSessionRef` passando a ler
      `waha_session_name` no ramo do gateway, que é NULO nessas linhas): **1 vermelho** —
      `endereco-da-conexao-no-envio` › "todo provider que sabe enviar tem ramo de referência". É
      exatamente o defeito que a T035 encontrou em produção-potencial: envio saindo sem
      `connection_id`. Prova que o teste vigia a RESOLUÇÃO, e não só a existência da função.

      **Sabotagem B — checagem de papel rebaixada** (`requireRole("admin")` → `"viewer"` nas rotas de
      pareamento): **2 vermelhos** em `rbac-matrix` — a porta do onboarding para `manager` e para
      `viewer`, esta última cobrando também o audit `authz.denied`. Prova que a rede pega o furo
      exato que a T045 fechou.

      **Sabotagens das fatias anteriores, todas executadas e registradas na task de cada uma:**
      redrive forçado ao canal antigo (2 vermelhos), TTL de mídia de volta a 600 s (1), `error_code`
      de grupo fixo (1), estado definitivo na resposta síncrona (6), legenda descartada (1), 502
      contando como "no ar" (1), aviso que não fecha (1), `ingest_path` removido (1), compensação
      removida (1), validade do QR ignorada (3).

---

## Fase 5 — Transversais

- [X] **T056** ✅ FR-013 completa na fila: **teto de tamanho** e **alarme de dreno parado**
      (commit `3dd8856` no worktree do gateway). **(FR-013)**
  - **Teto de tentativas ≠ teto de tamanho.** O primeiro limita quanto tempo UMA pendência insiste;
    não limita QUANTAS existem. Numa indisponibilidade longa o outro lado não retorna, ninguém esgota
    tentativa, e a fila cresce com o tráfego até acabar o disco — que não derruba só a fila, derruba
    o processo, e aí o gateway perde também o que ainda conseguiria entregar.
  - **Descarta a VELHA, não recusa a nova.** Recusar a nova perde a mensagem que acabou de chegar —
    a que tem mais chance de ainda importar para alguém esperando resposta — e faz isso justamente
    quando o volume está alto. A velha já falhou várias vezes e vai para `mortas/`, inspecionável.
    `AoLotar` é gancho separado de `AoMorrer`: lá a pendência esgotou as próprias tentativas, aqui
    ela morre por causa das outras, e a ação de quem lê é diferente.
  - **O alarme que faltava:** o único existente era o do DESCARTE, e descarte só acontece quando as
    tentativas esgotam. O sintoma de "CRM fora do ar" aparece antes e em silêncio — a pendência mais
    velha envelhecendo sem nenhum evento. `VerificarParada` declara parada acima de 15 min, e roda
    **depois** de processar: antes, alarmaria por pendência que ia sair naquele instante.
  - **Deadlock meu, medido:** a primeira versão chamava `aparar()` com o lock do `Enfileirar` tomado,
    e `matar()` pega o mesmo mutex. `sync.Mutex` não é reentrante — a suíte travou **sem erro** até o
    timeout. Agora apara fora do lock, com a consequência aceita escrita no código: duas entradas
    simultâneas podem passar momentaneamente do teto, e a próxima apara. Teto é proteção de disco,
    não invariante exato.
  - **Prova:** 3 testes em `internal/entrega/fila_teto_test.go`, incluindo o de fila vazia (alarme
    falso é o que ensina a ignorar alarme). Sabotagens: remover o teto e remover a checagem de idade
    reprovam um caso cada. Suíte inteira do gateway verde.

- [X] **T050** ✅ Reconciliação periódica do lado do CRM — a segunda ponta que o Princípio XIV
      exige. **(FR-013a)**
  - **O que a T028 devolvia não bastava, e isso só apareceu ao consumir:** a varredura da janela dá
    `external_id` + direção + instante. Suficiente para DESCOBRIR o buraco, insuficiente para tapá-lo
    — com três campos não se reconstrói uma mensagem. Por isso o gateway ganhou a **fase 2**
    (`POST .../reconciliation/fetch`, commit `1fb22b1` no worktree): o CRM manda os ids que não tem e
    recebe **envelope**.
  - **Duas fases, e a razão é o caso comum:** a janela quase sempre está completa. Uma fase só, que
    já devolvesse tudo, pagaria o preço do caso raro em todo tique — corpo, mídia e contato de cada
    mensagem de uma hora de conversa.
  - **A reingestão usa `ingerirEnvelope`**, o mesmo caminho da entrega normal. Não existe código de
    exceção para "mensagem que entrou pela reconciliação" — atalho aqui gravaria diferente do
    principal, e a diferença só apareceria no dia do incidente.
  - **Recuperar em silêncio é proibido, e é o coração da task.** Se toda rodada recupera mensagens e
    ninguém fica sabendo, a rede de segurança vira **tapa-buraco permanente**: o defeito de origem
    continua lá, agora invisível porque alguém o conserta a cada minuto. Recuperação > 0 escreve
    `logger.error` **e** abre `gateway_reconciliation_gap` na Central (migration 0130 + apêndice +
    MANIFEST). `warn` e não `critical`: as mensagens já estão na conversa certa; o que se pede é
    conferir se alguém ficou sem resposta.
  - **Divergência SEM recuperação sai como erro mesmo sem aviso:** não há o que o corretor faça, mas
    há o que nós temos de olhar.
  - **Cron próprio, a cada 5 min** (`docker-compose.prod.yml`), não pendurado no dreno: o dreno roda
    a cada minuto porque o trabalho dele é latência; a reconciliação varre uma janela de 1 h contra
    um sistema externo, e 60 varreduras achariam o que uma acha.
  - **Prova:** `tests/unit/reconciliacao-nao-e-silenciosa.test.ts` (5). Sabotagens: pedir a janela
    inteira em vez de só o que falta (2 vermelhos) e nunca abrir o aviso (1).
- [X] **T051** ✅ Reversibilidade por canal: migrar e voltar sem tocar nos demais e sem perder
      mensagem em voo. **(FR-041)**
  - `PATCH /api/v1/channel-sessions/[id]/ingest-path`. A coluna era por conexão desde a 0119 — o que
    faltava era o jeito de virá-la sem `UPDATE` na mão, e `UPDATE` na mão não deixa autoria, não
    deixa data e não aparece para ninguém.
  - **Sem tocar nos demais** é o filtro `id` no UPDATE, e o teste afirma o FILTRO, não só o corpo:
    sem ele a virada de uma conexão levaria junto todas as outras da organização — o oposto exato do
    requisito. Sabotagem (remover o `.eq("id")`): reprova.
  - **Sem perder mensagem em voo, e isso foi MEDIDO:** a rota de recebimento recusa a entrega de
    conexão não migrada com 409 — mas **antes** de recusar grava a linha em `webhook_events_log` com
    `status='error'` (`webhooks/gateway/[token]/route.ts:137`). O dreno recolhe linhas `error` e
    reingere, e a ingestão não pergunta `ingest_path`. A entrega que chegar no instante exato da
    reversão entra pelo dreno no minuto seguinte em vez de sumir.
  - **Recusa migrar canal sem `gateway_connection_id`:** ele ficaria MUDO — a rota de recebimento
    não teria como reconhecê-lo e nenhuma mensagem entraria por caminho nenhum. Erro legível é melhor
    que canal que para de receber sem ninguém entender.
  - Prova: `tests/unit/canal-reversivel-e-auditado.test.ts` (5).
- [X] **T052** ✅ Estender o vigia mecânico de payload cru para o caminho de **envio**.
      **(FR-042, anti-pattern 15)**
  - **Invariante 2** em `scripts/lint-channels.pattern.ts` (`leFormaCruaDeProvedor`), ligado à mesma
    catraca do `gov:verify`. O invariante 1 pega o **nome** do provider; este pega o que é pior de
    achar depois: código lendo a **forma** crua da resposta dele sem citar o nome — `data.key.id`,
    `msg._serialized`, `resp.messageid`. Nada ali diz "WAHA", e a catraca antiga passava batido.
  - **A lista é CURTA, e isso é a decisão.** A primeira versão incluía `fromMe`, `chatId`, `pushName`
    e `participant`: medido na main, 8 arquivos ofensores e **nenhum** lia payload cru — `chatId` é o
    nome que o handler de envio dá ao destinatário resolvido **pelo adapter**. Regra que reprova
    código correto ensina a contorná-la, e vira a catraca com furo que a #118 já custou caro.
    Ficaram só as formas sem outro dono possível.
  - **Nasce com ZERO dívida** (medido), então **não tem lista de exceção**: catraca que nasce limpa
    não precisa de anistia, e criar a lista "para o caso de" é o que faz a primeira entrada parecer
    normal. `lib/gateway/` entra na isenção junto de `lib/channels/` e `lib/waha/` — os três SÃO o
    transporte, é lá que a forma crua tem de morrer.
  - **Prova:** 3 casos em `tests/unit/lint-channels-fronteira.test.ts`, incluindo o que afirma que o
    código CERTO passa. Sabotagem (introduzir `_serialized` no caminho de envio): o lint reprova
    nomeando o arquivo.
- [X] **T053** ✅ Auditoria de toda mudança de canal: criar, migrar, reverter, apagar. **(FR-043)**
  - **Inventário medido antes de escrever:** `channel.connected`, `channel.reconnected`,
    `channel.archived`, `channel.deleted` e `channel.reactivated` já existiam. Faltavam **migrar e
    reverter** — e faltavam porque a operação em si não existia (T051).
  - `channel.migrated` e `channel.reverted` entram como ações **distintas**, não uma com campo de
    direção: a pergunta que se faz num incidente é "alguém migrou algo hoje?", e ela tem de ser
    respondível **filtrando a ação**, não lendo o metadata de cada linha. O `de`/`para` viaja junto
    mesmo assim — saber o destino sem a origem não responde "o que mudou?".
  - **A criação passou a auditar nas DUAS portas** na T044: antes, a porta do onboarding (usada por
    100% dos usuários novos) punha número no ar sem registrar quem o ligou.
  - Prova: casos de trilha em `tests/unit/canal-reversivel-e-auditado.test.ts`.
- [X] **T054** ✅ **JÁ ENTREGUE pela spec 001** — verificado, não reimplementado. `GATEWAY_BASE_URL`,
      `GATEWAY_INTERNAL_TOKEN`, `GATEWAY_INBOUND_ENABLED`, `GATEWAY_MAX_BODY_BYTES` e
      `GATEWAY_MAX_MEDIA_BYTES` existem em `lib/env.ts` **e** em `.env.example`, e `lib/env.ts:238`
      já falha no boot quando `GATEWAY_INBOUND_ENABLED=true` sem `GATEWAY_BASE_URL`. **(FR-044)**
- [X] **T055** ✅ Conferência da tripla, **executada** ao fim das Fases 1–5. **(FR-040)**
  - Quatro migrations nasceram nesta spec, e as três peças existem para as quatro:

    | # | Arquivo em `migrations/` | Apêndice no `baseline.sql` | Linha no MANIFEST |
    |---|---|---|---|
    | 0127 | `gateway_writer` | ✅ (papel + revogações) | ✅ |
    | 0128 | `gateway_escrita` | ✅ (as 2 funções) | ✅ |
    | 0129 | `aviso_gateway_fora` | ✅ (`gateway_unreachable` no bloco único) | ✅ |
    | 0130 | `aviso_divergencia_reconciliacao` | ✅ (`gateway_reconciliation_gap`, idem) | ✅ |

  - **A prova não é a tabela, é o gate:** `pnpm test:db` aplica **só o `baseline.sql`**, em modo
    install E update, e roda os 555 invariantes — entre eles o
    `vocabulario-banco-x-typescript`, que compara o CHECK do banco com a união do TypeScript contra
    Postgres real. Se um apêndice faltasse, o ambiente fresco nasceria sem a mudança e o gate
    reprovaria. **Verde nas quatro.**
  - **Os dois kinds novos entraram no bloco ÚNICO da constraint**, editando a lista existente em vez
    de acrescentar um segundo bloco — a lição do #159: blocos antigos rodam antes e falham em cadeia
    ao re-aplicar num banco que já tem vocabulário posterior.
  - Nenhuma mudança **destrutiva** nesta spec: as quatro só acrescentam (papel, funções, dois valores
    de CHECK). Não há caminho de volta a declarar porque não há nada a desfazer.

---

## Fase 6 — Execução e prova (os SC não se provam sozinhos)

Cada uma destas é **execução medida**, não implementação. Sem elas os Success Criteria são texto.

- [X] **T060** ✅ **EXECUTADA em 2026-08-08 com uazapi REAL e número REAL pareado por QR**, sob
      autorização explícita do dono para usar as credenciais de produção. **(SC-001, SC-002)**

    ```json
    { "enviadas": 20, "aceitas_pelo_gateway": 20, "falhas": 0, "pct_aceitas": "100.0%",
      "com_external_id": 20, "pct_com_id": "100.0%",
      "p95_ms": 1395, "mediana_ms": 481, "max_ms": 2470 }
    ```

  - **p95 de 1395 ms contra o teto de 5000 ms.** 100% aceitas, 100% com `external_id` — que é o que
    permite ao ACK achar a linha depois (FR-019). Zero em estado sem dono.
  - A instância foi provisionada pela rota do contrato (`POST /v1/connections`), pareada por QR
    escaneado num aparelho físico, e **apagada ao fim** (`DELETE` → 204, e o GET seguinte devolve
    `conexao_nao_encontrada`) — instância paga não fica órfã, que é a doutrina da própria T043.
- [~] **T061** **Parcial, e com um achado.** As 20 saíram com `external_id` (T060), mas a
      verificação do estado FINAL não fechou. **(SC-003)**
  - **O achado:** `POST /v1/connections/{id}/reconciliation/fetch` com os três ids que acabaram de
    ser aceitos devolveu **0 envelopes e 3 `nao_encontrados`**. Mensagens que o provedor tinha
    acabado de aceitar não apareceram na busca dele.
  - **Não concluir cedo demais.** Três explicações plausíveis, e não medi qual é: (a) latência de
    indexação do `/message/find` logo após o envio; (b) o `/message/find` sem filtro de chat não
    inclui outbound recém-criada; (c) a paginação do nosso lado não alcançou. **A (a) é a mais
    provável** — a busca rodou segundos após o envio.
  - **Por que isto importa além da T061:** se for (b), a reconciliação (T050) tem um ponto cego para
    mensagens de saída, e o alarme de divergência dispararia para sempre sobre elas. Vale medir com
    a janela aberta por minutos antes de concluir qualquer coisa.
  - **Uma quarta hipótese, e ela é a mais séria — vinda da spec do PROVEDOR**
    (`docs/uazapi-openapi-spec.yaml:6362`): o filtro `id` do `/message/find` documenta o exemplo
    **`user123:r3EB0538`** — um id **prefixado pelo dono**, enquanto o envio nos devolve o wamid
    **puro** (`3EB01400C9DF74F3420BCF`, medido na T067). Se o `messageid` que a busca devolve vier
    nessa forma composta, o casamento client-side do nosso `reconciliation/fetch` (`querido[m.MessageID]`)
    **nunca casa** — e aí não é latência: é a reconciliação declarando **toda** mensagem como faltante,
    para sempre, disparando o alarme de divergência em cada rodada.
  - **Evidência que ESTREITA (não fecha) a quarta hipótese:** o payload real capturado de webhook no
    repo do gateway traz `"messageid": "3EB0538DA65A59F6D8A251"` — forma **pura**, 22 hex, a mesma
    do wamid que o envio nos devolveu. O exemplo `user123:r3EB0538` da spec está documentado no campo
    `id` de **entrada** do filtro, não na saída. Isso torna (d) menos provável e devolve o peso para
    (a) latência ou (b) outbound recente fora da busca — **mas não decide**: a forma do `messageid`
    de saída do `/message/find` continua sem medição direta.
  - **Como decidir entre as quatro, sem adivinhar:** uma chamada crua ao `/message/find` do provedor,
    imprimindo o `messageid` de uma mensagem recém-enviada, e comparar com o wamid que o envio
    devolveu. É uma medição de dois minutos e responde tudo. **Não foi feita** — a instância já tinha
    sido apagada quando a hipótese apareceu.
  - **Enquanto isso não for medido, a T050 não pode ser considerada provada em campo.** Ela está
    correta por teste (5 casos, sabotagem), e o que está em dúvida é o FORMATO do id no mundo real —
    exatamente o tipo de coisa que teste com dublê não pega, porque o dublê usa o formato que eu
    escrevi.
- [X] **T062** ✅ **AS DUAS METADES.** A varredura mecânica (SC-005) e a **rajada de 50 medida**
      (SC-004), executada em 2026-08-08 contra Postgres real com o `baseline.sql`, servido por
      PostgREST, usando a **ação de automação de verdade** (obtida do registro por `getAction`) — não
      uma réplica das três linhas de espaçamento.

    ```json
    { "rajada": 50, "linhas_no_banco": 50, "sucessos": 50, "espacamento_configurado_ms": 1200,
      "amostras_de_intervalo": 49, "intervalos_respeitados": 49, "pct_respeitado": "100.0%",
      "intervalo_minimo_ms": 1217, "intervalo_mediano_ms": 1589, "envios_fora_da_janela": 0 }
    ```

  - **A primeira passada deu 95,9%, e o erro era meu.** Eu marcava `Date.now()` **antes** de chamar a
    ação, o que mistura a espera com a duração do envio anterior — e o primeiro intervalo não tem
    predecessor de quem se espaçar. Trocado pelos `created_at` carimbados pelo Postgres, virou 100%
    com mínimo de 1217 ms contra 1200 configurados. Fica registrado porque é o modo de errar mais
    fácil aqui: medição mal instrumentada produz número **plausível**, e um 95,9% plausível teria
    virado "quase lá" em vez de "meça direito".
  - **Sabotagem — removido o `await sleep(wait)`:** 0% respeitados, mediana de **52 ms**. A rajada
    inteira sai em ~2,5 s: é assim que um número é banido.
  - **A metade mecânica é a que sobrevive ao tempo.** Uma rajada medida hoje prova o código de hoje;
    a varredura reprova o atalho de amanhã. O risco real não é a trava estar errada — é alguém
    acrescentar um caminho de envio que não passa por ela, e a trava continuar perfeita e
    irrelevante.
  - Regra verificável: fora de `lib/channels/`, ninguém chama `adapter.send` a não ser o handler.
    **Duas exceções declaradas com motivo escrito** (o handler, que É o que a trava protege; e o
    redrive do watchdog, que reenvia mensagem já contada — aplicar o limite diário de novo a contaria
    duas vezes contra o teto do número).
  - A lista de exceções **só encolhe**: declarado que ficou limpo reprova, e exceção sem motivo de
    60+ caracteres reprova. Mesmo mecanismo da catraca do `lint-channels`.
  - **Prova:** `tests/unit/nenhum-envio-escapa-das-travas.test.ts` (3). Sabotagem (arquivo novo
    chamando `adapter.send` fora da cadeia): reprova nomeando o arquivo.
- [ ] **T063** Conta **nova**, estado **vazio**: QR na tela em **≤ 15 s**, jornada login → primeira
      conversa atendida **≤ 10 min**, contagem de passos **idêntica** à de antes. Evidência visual em
      `.superpowers/evidence/`. `curl` não conta. **(SC-006, Princípio IV)**
- [X] **T064** ✅ Varredura executada — e ela achou **4**, não zero. Consertadas; agora zero, com o
      resultado congelado em teste. **(SC-007)**
  - **Duas famílias de defeito, e a segunda era pior:**
    1. nome do provedor na cópia ("WAHA não está configurado", "Aguardando WAHA gerar o QR Code").
       Para quem lê não significa nada — e depois da migração significa menos ainda, porque o número
       dele pode estar num provedor cujo nome a tela nem cita;
    2. **"Suba o Docker (`docker compose up -d waha`)"** — doutrina de self-host viva numa tela de um
       produto que hoje é **SaaS operado por nós**. Quem lê não tem container para subir: a instrução
       transfere ao usuário uma tarefa que é nossa e o deixa parado esperando executar algo que ele
       não pode executar. O `lint-channels` **nunca** pegaria isto, porque não é sobre canal.
  - A cópia nova diz o **efeito** ("o serviço de conexão está indisponível"), diz que já estamos
    cuidando, e oferece o que ele PODE fazer — responder pelo aparelho, ou pular o passo e conectar
    depois.
  - **Prova:** `tests/unit/tela-nao-nomeia-provedor.test.ts` (2). Varre **texto visível** (literal de
    JSX, prop de cópia, toast) e não o arquivo inteiro — os dois arquivos legitimamente leem
    `WAHA_API_BASE_URL` do env para decidir se mostram o aviso, e já estão na `KNOWN_DEBT` do
    `lint-channels`. Sabotagem (devolver o nome à cópia): reprova.
- [X] **T065** ✅ **EXECUTADA em 2026-08-08**, com os **dois processos reais**: o binário do
      `gateway_go` compilado desta branch (`STORE_ALVO=crm`, registro em disco, provisionamento atrás
      do token de admin) e o CRM chamando-o por HTTP. Só o **provedor** ficou dublê — criar instância
      de verdade custa dinheiro por instância, e o que esta task mede não é o provedor: é o contrato
      entre as **nossas** duas peças. **(SC-008)**
  - Forçadas 10 falhas de gravação no CRM **depois** de o gateway ter criado a instância — a janela
    exata em que a órfã nasce:

    ```json
    { "rodadas": 10, "falhas_forcadas": 10, "linhas_orfas_no_crm": 0,
      "instancias_vivas_antes": 0, "instancias_vivas_depois": 0, "orfas_no_provedor": 0 }
    ```

  - **A sabotagem é o que dá sentido ao número.** Com a compensação removida, a MESMA execução:

    ```json
    { "rodadas": 10, "falhas_forcadas": 10, "linhas_orfas_no_crm": 0,
      "instancias_vivas_antes": 0, "instancias_vivas_depois": 10, "orfas_no_provedor": 10 }
    ```

    Dez instâncias vivas que nenhum dos dois lados reconhece como suas, e que continuariam sendo
    cobradas todo mês. Sem esta segunda medição, o zero de cima poderia ser o zero de "nada foi
    criado" — e o teste estaria medindo a própria inércia.
- [X] **T066** ✅ **EXECUTADA em 2026-08-08**, contra Postgres real com o **`baseline.sql`**
      aplicado pelo mesmo prelúdio do `scripts/test-db.sh`, servido por **PostgREST** — o cliente do
      CRM falando com o banco como fala em produção. **(SC-009)**
  - 20 mensagens, virada de `ingest_path` no meio (10 antes, 10 depois), e então o **replay inteiro**
    que o gateway faria ao levar 4xx/5xx:

    ```json
    { "enviadas": 20, "ingestoes_ok": 20, "linhas_antes_da_virada": 10,
      "linhas_depois_da_virada": 20, "replay_do_gateway_aceito": 20,
      "linhas_depois_do_replay": 20, "duplicatas": 0, "perdidas": 0, "pct_preservadas": "100%" }
    ```

  - **`replay_do_gateway_aceito: 20` com `linhas_depois_do_replay: 20` é a asserção inteira:** as 20
    retentativas foram aceitas **com sucesso** (o gateway não tem motivo para insistir) e **nenhuma
    virou linha nova**. Duplicata tratada como falha faria o gateway retentar para sempre.
  - **Sabotagem — removida a `messages_org_external_id_unique`:** `linhas_depois_do_replay: 40`,
    `duplicatas: 20`. O cliente receberia cada mensagem duas vezes no histórico. É a **constraint**,
    e não a lógica da aplicação, que segura a idempotência — e a medição é o que prova qual das duas.
- [X] **T067** ✅ **3 de 3, CONFIRMADO NO APARELHO pelo dono em 2026-08-08.** Ele olhou o celular
      (85992431936) e confirmou — respondendo às próprias mensagens no WhatsApp, o que também prova o
      caminho de volta. **(SC-010)**

    | Tipo | Aceita | `external_id` | ms |
    |---|---|---|---|
    | image | ✅ | `3EB01400C9DF74F3420BCF` | 1582 |
    | document (PDF) | ✅ | `3EB099CAD746CB5146F476` | 836 |
    | audio (ogg) | ✅ | `3EB0F739CC2FB09B9FD4C0` | 1083 |

  - **A primeira tentativa da imagem falhou, e o defeito era do meu FIXTURE:** a URL da Wikipédia
    recusa o fetch do provedor (`HTTP 400`). Trocada a fonte, passou. Registrado porque o erro
    voltou como `erro_do_provedor` — legível e correto — e teria sido fácil confundir com defeito
    do envio.
- [X] **T068** ✅ **EXECUTADA em 2026-08-08.** O processo do gateway foi **morto** (health passou a
      responder `000`), e então 20 tentativas de envio pelo adapter mais dois tiques da sondagem.
      **(SC-011)**

    ```json
    { "tentativas": 20, "reagendaveis": 20, "perdidas_em_silencio": 0, "pct_reagendavel": "100%",
      "gateway_alcancavel": false, "avisos_no_primeiro_tique": 1, "avisos_no_segundo_tique": 0,
      "avisos_na_central_total": 1, "kind": "gateway_unreachable" }
    ```

  - **As duas metades do Princípio XIV apareceram:** `logger.error` nos dois tiques (o alerta da
    operação, que vira Sentry) e **um** item na Central — o segundo tique não duplicou.
  - **`perdidas_em_silencio: 0` é a asserção que importa.** Nenhuma tentativa voltou "ok sem id",
    que é o desfecho em que o chamador gravaria "enviada" para uma mensagem que não saiu.
- [X] **T069** ✅ Os três docs atualizados com o estado **real**, incluindo o que NÃO foi provado.
  - `docs/testing/user-journey-map.md`: tabela das 16 promessas com a sabotagem que derruba cada uma,
    mais as 8 provas que dependem de ambiente. A soma delas é uma frase que nenhuma task diz sozinha
    — *a jornada de envio nunca foi percorrida inteira por uma pessoa*.
  - `docs/migracao-para-o-gateway.md`: onde a 004 chegou, as duas pontas de durabilidade fechadas, e
    a variável nova do deploy (`GATEWAY_ADMIN_TOKEN`, diferente do interno de propósito).
  - `docs/current-state.md`: "pronto e coberto" separado de "incompleto, e é execução — não código",
    com o aviso antes de prometer prazo.

---

## ⛔ O que a Fase 6 NÃO conseguiu executar, e exatamente o que falta

**Feito nesta fase:** T062 (metade mecânica), T064 e T069. Os três eram verificáveis sem ambiente —
e a T064 **achou defeito real**, não confirmou expectativa.

**Reexaminado DUAS vezes, e nas duas o bloqueio tinha exagerado.** Primeiro: T065 e T068 **não
precisavam de banco nem de app servido** — provisionamento e sondagem falam HTTP com o gateway e mais nada. O binário foi compilado,
o gateway subiu com `STORE_ALVO=crm` numa porta própria, e as duas medições rodaram contra ele. O
bloqueio inicial estava certo para seis tasks e **errado para estas duas**: eu tinha agrupado tudo
sob "precisa de ambiente" sem separar o que cada uma exige de fato.

Depois: **T066 não precisava do stack Supabase inteiro** — precisava de PostgREST. Um Postgres
efêmero com o `baseline.sql` (prelúdio reaproveitado do `scripts/test-db.sh`), o PostgREST oficial e
um proxy de 12 linhas traduzindo `/rest/v1/*` foram suficientes para o cliente do CRM falar com o
banco como fala em produção. "Precisa de Supabase" era a resposta preguiçosa; o que ela escondia é
que Auth e Storage não entram em nada do que a T066 mede.

**Bloqueado, com o motivo medido:**

| Task | Falta |
|---|---|
| T060, T061 | **Número de WhatsApp real** entregando, para medir p95 do clique à chegada e estado final |
| T063 | **TENTADA em 2026-08-08, e o ambiente FUNCIONOU.** O que falhou foi a minha spec — ver abaixo |
| T067 | **Celular real** recebendo mídia. Não há substituto — o requisito é o anexo abrir no aparelho do destinatário |

**Por que as de banco/app não foram executadas aqui:** esta máquina roda ambientes de outras sessões
(dois stacks Supabase e um app na porta 3000). Subir um paralelo exigiria `next build` na MESMA
árvore, sobrescrevendo o `.next/` de quem está usando — derrubar o trabalho alheio para rodar um
teste é o oposto do que a Fase 6 quer provar. Verificado ao fim: o app da outra sessão continua
respondendo 307, e os dois processos que subi foram encerrados.

**O que a próxima sessão precisa, em ordem:** (1) `GATEWAY_ADMIN_TOKEN` gerado e posto nos dois
lados; (2) gateway rodando com `STORE_ALVO=crm` apontado para um Supabase local pg17 com o
`baseline.sql`; (3) `scripts/bootstrap-owner.ts`; (4) `next build && next start`; (5)
`pnpm exec playwright test conexao-pelo-gateway.spec.ts`. O primeiro caso da spec **afirma a
pré-condição** — se o gateway não estiver configurado ela reprova dizendo isso, em vez de passar
medindo o canal errado.

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

---

### T063 — tentada, com o ambiente de pé (2026-08-08)

**O bloqueio de ambiente caiu.** Worktree próprio (`.next/` isolado, sem tocar no da outra sessão),
`supabase start` com `project_id = deskcomm-f6004` e portas 553xx (nenhuma colisão com os dois stacks
vivos), `baseline.sql` aplicado — 101 tabelas —, `bootstrap-owner.ts`, `next build` e `next start`.
App respondendo **307** com `gateway: ok` no health. **A receita das 5 etapas funciona.**

**Duas armadilhas medidas no caminho, que a próxima sessão não precisa redescobrir:**

1. O `supabase start` sobe um Postgres **sem** `vector`/`citext`/`pg_trgm` no schema `public`, e o
   `baseline.sql` falha na linha 911 com `type public.vector does not exist`. Criar as três extensões
   ANTES resolve.
2. `pkill -f "next start"` **mata o próprio shell** que o executa (a string casa com a linha de
   comando dele). Matar por porta (`fuser -k 3999/tcp`) é o caminho.
3. O Playwright **gerencia o próprio `webServer`**: um `next start` já rodando na porta faz o run
   abortar. Deixe o Playwright subir o servidor, e forneça o `.env.e2e`.

**O que falhou foi a spec, não o produto: 2 passaram, 3 falharam por FALTA DE LOGIN.** Os três casos
navegam para `/app/connections` sem sessão autenticada, caem no redirecionamento para o login, e o
botão "Conectar número" não existe naquela tela. As specs irmãs resolvem isso com `storageState`
(ver `vps-fresh-onboarding.spec.ts`, que loga e salva o estado em `.e2e-owner.json`) — a minha não
carrega esse passo.

**Consequência que vale registrar:** o caso 2 ("estado vazio não nomeia provedor") **passou**, e
passou medindo a **tela de login**. Um verde que não prova nada, exatamente do tipo que a T062 quase
me deu com o 95,9%. A correção é o `storageState`, e ela vem junto com a próxima execução.

**Ambiente derrubado ao fim:** `supabase stop`, portas liberadas, worktree removido, zero containers
`f6004`, e o app da outra sessão intacto em 307.

**Correção aplicada (não re-executada):** a spec ganhou `entrar()` — login com as credenciais do
`bootstrap-owner`, no mesmo padrão da `vps-fresh-onboarding` — e, mais importante, **âncoras de
lugar**: o `beforeEach` afirma `toHaveURL(/\/app\/connections/)` e o caso do estado vazio afirma que
o botão "Conectar número" está visível **antes** de afirmar o que a tela não diz.

A âncora é a lição, não o login. Uma asserção **negativa** sobre "o corpo da página" (`not.toMatch`)
passa em **qualquer** página que não contenha o termo — inclusive numa que o teste nunca quis abrir.
Foi assim que o caso do estado vazio ficou verde medindo a tela de login. Corrigir só o login
deixaria a armadilha armada para o próximo caso negativo que alguém escrever.

⚠️ **A correção NÃO foi re-executada** — o ambiente foi derrubado antes. Ela é a primeira coisa a
rodar na próxima sessão, e o custo agora é subir o ambiente, não descobrir o que fazer.

### Segunda tentativa da T063 (2026-08-08, mesma sessão)

**O ambiente virou UM script e subiu inteiro** (`worktree` + `pnpm install` + `supabase start` +
extensões + `baseline.sql` + `bootstrap-owner` + `next build` + gateway + provedor falso). As três
armadilhas documentadas acima não custaram nada desta vez — é a prova de que a receita funciona.

**Avanço:** descoberto e tratado que **conta recém-bootstrapada cai no WIZARD**, não em `/app`.
Esperar só por `/app` fazia todo caso morrer no login dizendo "navegação não aconteceu" em vez de
"foi para outro lugar". A spec ganhou `concluirWizard()` — que marca **só** o `onboarded_at`, porque
"estado vazio" (SC-006) é sobre o que o USUÁRIO ainda não fez (sem canal, sem conhecimento, sem
lead), não sobre o wizard, que tem jornada e spec próprias.

**Onde parou:** com o wizard resolvido, o `beforeAll` passa e o **login ainda não navega**. Não
diagnostiquei — acabou o contexto da sessão, e diagnosticar por palpite é como se escreve o próximo
verde falso. O ambiente foi derrubado (`supabase stop`, worktree removido, zero containers `f6004`,
app da outra sessão intacto em 307).

**Próximo passo, concreto:** rodar `bash` do script de ambiente (registrado no scratchpad da sessão),
e então investigar o login — hipóteses na ordem: (a) a senha do `.env.local` não bate com a que o
`bootstrap-owner` gravou; (b) MFA obrigatório para `admin` interceptando (as specs irmãs usam
`tests/e2e/helpers/login-admin.ts` justamente por isso, e esta não usa); (c) o clique em "Entrar"
não está encontrando o botão. A (b) é a mais provável — a doutrina exige MFA TOTP para `admin`, e o
dono do bootstrap É admin.

### Terceira tentativa da T063 — o login caiu, e a causa era minha

**A hipótese (b) estava errada, e a causa era mais boba: o `#` na senha.**
`OWNER_PASSWORD=QaF6!2026#Dono` no `.env.local` — o `dotenv` trata `#` como início de comentário, e
o `bootstrap-owner` gravou `QaF6!2026`, enquanto o Playwright mandava a senha inteira. Senha trocada
para uma sem `#`, e o login passou a funcionar.

**Prova de que funcionou:** o caso de pré-condição **passou** — e ele exercita o `beforeEach`
inteiro: login, navegação para `/app/connections` e a âncora `toHaveURL`. Ou seja, a sessão
autentica, o app roteia e a tela certa abre.

**Onde parou agora:** os 4 casos restantes não acham o controle de conectar. O rótulo real é
**"Conectar novo WhatsApp"** (medido em `ConnectionsClient.tsx`) e o regex foi ajustado, mas os 4
seguiram vermelhos — o que aponta para o controle não estar renderizado no estado vazio desta
instalação (provavelmente atrás de alguma condição de configuração), e **isso não foi diagnosticado**.
Acabou o contexto da sessão.

**Não marcar como feita.** O que mudou nesta rodada: a T063 deixou de ter dois bloqueios (ambiente e
login) e passou a ter um só, que é localizar o controle no estado vazio — trabalho de minutos com a
tela aberta na frente. Ambiente derrubado de novo; zero containers `f6004`; app da outra sessão em
307.

### O defeito que a T063 encontrou (2026-08-08) — e é do PRODUTO

Os 4 casos que sobraram vermelhos não eram da spec. `app/app/connections/page.tsx` calculava
`wahaConfigured` **só** do transporte legado, e o `ConnectionsClient` fazia
`disabled={creating || !wahaConfigured}` no botão de conectar.

**Consequência numa instalação migrada:** o corretor vê a tela certa, com o botão certo, **e não
consegue clicar** — porque o gateway, que é quem provisiona ali, não precisa das variáveis do
transporte antigo. É a FR-030 quebrada de um jeito que nenhum teste unitário pega: a tela existe, o
botão existe, e a ação não acontece.

**O nome da flag mentia junto.** `wahaConfigured` decidia se dá para CONECTAR — que é uma pergunta
sobre haver **algum** caminho de provisionamento, não sobre um provedor específico. Virou
`podeConectar`, e agora é a união dos dois caminhos.

**Este é exatamente o tipo de achado que justifica a Fase 6 existir.** As Fases 1–5 provaram cada
peça e todas passaram; o defeito estava na costura entre a tela e a configuração, e só apareceu com
uma conta de verdade, numa instalação de verdade, clicando de verdade.

⚠️ **A correção não foi re-executada contra a spec** — o ambiente já estava derrubado quando ela foi
diagnosticada. `pnpm test:unit` segue 3157/3157 e o `lint-channels` zerado, mas a prova de tela é a
primeira coisa a rodar na próxima sessão.

### Quarta rodada — a página respondeu, e a resposta era 2FA

Rodei de novo depois da correção do botão. **Mesmos 4 vermelhos.** Em vez de supor de novo, li o
`error-context.md` que o próprio Playwright grava — a captura da página no instante da falha:

```yaml
- heading "Configure a verificação em duas etapas"
- paragraph: Sua conta exige 2FA. Use um aplicativo autenticador...
- button "Iniciar configuração"
```

**O login funciona; o app exige MFA e a spec nunca sai dessa tela.** A hipótese (b) que eu tinha
deixado na segunda rodada estava certa — e o `#` na senha era um **segundo** bug, independente, que
escondia este. Consertar o primeiro foi o que permitiu chegar até aqui.

**A doutrina exige MFA TOTP para `admin`** (`CLAUDE.md`, seção Auth & RBAC) e o dono do bootstrap é
admin. As specs irmãs tratam isso com `tests/e2e/helpers/login-admin.ts` + `tests/e2e/utils/totp.ts`
— enrolam o fator e geram o código de 6 dígitos, com o cuidado de não reusar código dentro da mesma
janela de 30 s. **Esta spec não usa nenhum dos dois.**

**Não é mais hipótese: é a captura da tela.** O que falta na T063 é uma coisa só e está nomeada —
adotar o caminho de MFA das specs irmãs. Ambiente derrubado pela quarta vez; zero containers
`f6004`; app da outra sessão em 307.

**E o defeito de produto que estas quatro rodadas acharam continua valendo**: o botão de conectar
morto na instalação migrada (corrigido, `podeConectar`). Ele não seria encontrado por nenhum teste
unitário — e é a resposta para "por que a Fase 6 existe".

### Quinta e sexta rodadas — MFA tratado, e onde a spec parou de fato

**Quinta:** implementado o enrolamento de MFA no padrão da `vps-fresh-onboarding` (captura do
segredo pela via "não consigo escanear" + código de 6 dígitos com retry na virada da janela de 30 s).
**Funcionou:** o primeiro caso passou atravessando o gate inteiro. Mas expôs o passo seguinte — do
**segundo login em diante** o fator já existe e o app cobra o código em `/login/mfa`, tela diferente
da de enrolamento.

**Sexta:** a spec passou a distinguir ENROLAMENTO de DESAFIO (pelo botão "Iniciar configuração") e a
reusar o segredo. **Piorou: 5 vermelhos.** Não diagnosticado — acabou o contexto da sessão, e o
padrão que se repetiu quatro vezes hoje é claro: cada suposição minha sobre a causa custou uma
rodada, e cada leitura da captura do Playwright resolveu em um minuto.

**O que fica registrado, e vale mais que o número da task:**

1. **Um defeito de produto encontrado e corrigido** — o botão de conectar morto na instalação
   migrada (`podeConectar`). Nenhum teste unitário o pegaria.
2. **Dois bugs do próprio harness** — o `#` na senha comido pelo `dotenv`, e o `waitForURL`
   esperando só por `/app` quando conta nova cai no wizard.
3. **O ambiente virou script** e subiu limpo **seis vezes**, sempre derrubado ao fim, com o app da
   outra sessão intacto em 307 todas as vezes.
4. **A ferramenta de diagnóstico está nomeada:** `test-results/**/error-context.md` — a captura da
   página no instante da falha. Quem retomar deve começar por ela, não por hipótese.

**A T063 continua ABERTA**, e o que falta é fazer o desafio de MFA funcionar entre casos. É trabalho
de harness de teste, não de produto — todo o produto que esta jornada exercita já foi corrigido.

### O bug do desafio de MFA, encontrado por leitura (T063)

A sexta rodada piorou de 1 para 0 casos verdes, e a causa estava no meu código, não no produto:

```ts
await digitarCodigo(page, page.getByRole("heading", { name: /verificação em duas etapas/i }));
```

**A condição de sucesso era a própria tela de desafio — que já está visível quando se digita.** O
`toBeVisible()` passava na hora, sem o código ter sido aceito, e a falha reaparecia no `waitForURL`
seguinte dizendo "navegação não aconteceu" em vez de "código recusado". Diagnóstico errado embutido
no teste.

**Corrigido:** o sinal de que o código foi aceito é a tela **SUMIR**. `digitarCodigo` ganhou
`esperandoSumir` e o desafio usa `toHaveCount(0)`.

**A regra que vale além deste caso:** asserção de **ausência** para provar transição, asserção de
**presença** para provar chegada. Trocar as duas produz um verde imediato que não mede nada — a
mesma família do caso que passou medindo a tela de login.

⚠️ **Não re-executado** — o ambiente estava derrubado quando o bug foi encontrado (por leitura do
próprio código, não por nova rodada).