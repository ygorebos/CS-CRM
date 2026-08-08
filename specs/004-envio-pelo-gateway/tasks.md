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

- [ ] **T040** Parear número novo pela tela, pelo gateway, com QR code, **sem passo a mais** e
      **sem** a tela nomear provedor. **(FR-030)**
- [ ] **T041** Tela detecta sozinha que conectou — sem recarregar, sem confirmar à mão. Consome
      `expires_at` para pedir material novo **quando expira**, em vez de refazer a imagem a cada
      15 s no escuro. **(FR-031)**
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
- [ ] **T046** Desconectar e reconectar pela tela no canal migrado, com os mesmos desfechos de hoje.
      **(FR-036)**
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
- [ ] **T048** [SABOTAGEM] Provar que os testes das Fases 3 e 4 vigiam: quebrar a resolução de
      conexão e ver T032 vermelho; remover a checagem de papel e ver T045 vermelho. **(SC-012)**

---

## Fase 5 — Transversais

- [ ] **T056** Completar a FR-013 na fila: **teto de tamanho** (hoje só há teto de tentativas — fila
      sem teto de tamanho enche o disco na indisponibilidade longa) e **alarme quando parar de
      drenar** (pendência mais velha que N minutos = alerta; hoje só o descarte alarma, e o
      empilhamento silencioso é justamente o sintoma de CRM fora do ar). **(FR-013)**

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
