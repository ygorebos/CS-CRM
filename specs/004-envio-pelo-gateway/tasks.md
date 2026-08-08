# Tasks — Envio e conexão pelo gateway (spec 004)

**Escrito em**: 2026-08-08, já sob a [decisão de escrita direta](decisao-escrita-direta.md).

**Numeração de migrations**: começa em **0127**. 0119–0122 foram gastas pela spec 001; 0123–0126
estão **reservadas** pela spec 002 (`002-rag-por-operadora/tasks.md`). Conferir `ls
supabase/migrations/` antes de criar arquivo — colisão de número já mordeu uma vez.

**Doutrina que vale em toda task de schema**: migration versionada **+** apêndice idempotente no
`baseline.sql` **+** linha no `MANIFEST.md`. Os três, sempre. `pnpm test:db` local antes do PR.

---

## Fase 0 — Emenda de doutrina (BLOQUEIA tudo abaixo)

Não é zelo: as tasks da Fase 1 contrariam texto vigente com autoridade acima do `CLAUDE.md`.
Implementar antes de emendar deixa o repo inconsistente consigo mesmo e o próximo agente reverte.

- [ ] **T001** Emendar o Princípio VII da constituição (`/speckit-constitution`, versão própria):
      trocar "o gateway NUNCA escreve no banco do CRM" pela redação que sobrevive — *o gateway nunca
      toca tabela do CRM; escreve só por função versionada, com papel próprio, e nunca decide tenant
      pelo corpo*. Ver §7 da decisão para o argumento.
- [ ] **T002** Refletir a emenda em `CLAUDE.md` (seção Gateway + anti-pattern 15) e em `AGENTS.md`.

---

## Fase 1 — Superfície de escrita no banco do CRM

- [ ] **T010** Criar papel `gateway_writer` na migration `<ts>_0127_gateway_writer.sql`: `nologin`
      não serve (o gateway autentica), zero grant de tabela, `EXECUTE` concedido só nas funções das
      tasks abaixo. Apêndice no baseline + MANIFEST.
- [ ] **T011** Invariante em `tests/invariants/` que **reprova** se `gateway_writer` tiver qualquer
      privilégio em `information_schema.role_table_grants`. É a trava que impede o acoplamento
      voltar por acidente (FR-002).
- [ ] **T012** `fn_gateway_ingest_message` na migration `<ts>_0128_gateway_escrita.sql`. Esqueleto em
      §4 da decisão. Obrigatórios, e cada um tem um motivo medido:
      - resolve `organization_id` de `channel_sessions.gateway_connection_id` (FR-004);
      - `set constraints public.messages_org_external_id_unique immediate` **antes** do insert
        (FR-007 — sem isso o handler nunca dispara);
      - `exception when unique_violation` devolve o id existente + `duplicada = true` (FR-006);
      - emite `ai_agent.dispatch_requested` na mesma transação, só para inbound e só se não for eco
        (FR-008, FR-009);
      - `revoke execute ... from public, anon` + `grant ... to gateway_writer` (FR-003).
- [ ] **T013** `fn_gateway_update_message_status` — o ACK. Portar a guarda de não-regressão de
      `lib/gateway/ingest.ts:278-340` (`ORDEM_DO_ESTADO`): estado que não avança é ignorado com
      sucesso, `failed` sempre passa. Sem a guarda, um ACK atrasado apaga um `read` com um `sent`.
- [ ] **T014** `fn_gateway_provision_connection` — nasce a `channel_sessions` com
      `gateway_connection_id`, `organization_id` e `ingest_path` (FR-011). Tudo-ou-nada com a
      instância do provedor é responsabilidade do chamador (T031).
- [ ] **T015** Teste de isolamento entre 2 organizações para as três funções novas: conexão da org A
      **não** consegue escrever mensagem na org B, nem lendo id de fora. Sabotar a resolução de
      tenant e ver o teste ficar vermelho — sem isso o teste não é prova (Princípio XI).
- [ ] **T016** Teste que prova a idempotência ponta a ponta: mesma `external_id` duas vezes devolve o
      mesmo id, `duplicada = true` na segunda, **uma** linha em `messages` e **um** dispatch em
      `event_log`. Sabotar removendo o `set constraints` e ver a transação morrer no commit.

---

## Fase 2 — O fork do gateway (`/root/PROJETOS/gateway_go`)

Recomendação de forma: **um repo, dois builds** (§5 da decisão), não fork literal.

- [ ] **T020** Extrair a camada de dados para interface (`internal/store`), com a implementação atual
      (Cotador) como primeira instância. Sem mudança de comportamento — commit próprio, verde antes
      de seguir.
- [ ] **T021** Segunda implementação, alvo CRM. Tradução de vocabulário na §3c da decisão
      (`escritorio_id`→`organization_id`, `inbox_mensagens`→`messages`, `wamid`→`external_id`…).
- [ ] **T022** Trocar o único upsert cru (`internal/processor/mensagem.go:100`) por chamada a
      `fn_gateway_ingest_message`. **É o ponto que não sobrevive à mudança de alvo sem reescrita** —
      ver §2 da decisão.
- [ ] **T023** Seleção da implementação por configuração no start, com falha explícita se ambígua.
      Endereço do banco é configuração — sem `localhost`, sem nome de serviço de compose (XIV).
- [ ] **T024** Fila em disco: prova de sobrevivência a reinício, teto de tamanho, alarme quando para
      de drenar (FR-013). **Não é polimento** — virou a única rede contra perda.
- [ ] **T025** Rotas de provisionamento do `gateway-provisioning-v1.md` §3–§8, com as duas correções
      que o contrato pede: comparação de token em tempo constante (`internal/middleware/token.go:25`
      usa `!=`) e escopo de admin para provisionar/desprovisionar.

---

## Fase 3 — CRM: envio pelo gateway (F2)

- [ ] **T030** Adapter de envio atrás do seam `getAdapter(provider)`, fail-closed. Nenhuma feature do
      CRM passa a nomear provedor (FR-011 da F2).
- [ ] **T031** Criação de canal chama o provisionamento em vez de `waha.startSession`; grava
      `gateway_connection_id`; desfaz a instância se o registro falhar (FR-012).
- [ ] **T032** `lib/channels/session-ref.ts`: união ganha o membro do gateway (hoje `waha`,
      `meta_cloud`).
- [ ] **T033** Recusar criação de canal de gateway com erro legível enquanto a Fase 2 não estiver de
      pé (FR-014). Entra **antes** do resto da Fase 3.
- [ ] **T034** Tela de QR consome `qr_code` + `expires_at` em vez de proxiar bytes do WAHA — para o
      corretor parar de olhar QR morto achando que o celular dele é que está ruim.

---

## Fase 4 — Prova pela tela (DoD item 12)

- [ ] **T040** Spec Playwright: conta **nova**, estado **vazio**, conectar canal pelo gateway,
      receber e responder. Evidência visual em `.superpowers/evidence/`. `curl` não conta.
- [ ] **T041** Atualizar `docs/testing/user-journey-map.md` com os casos e achados.
- [ ] **T042** Atualizar `docs/migracao-para-o-gateway.md` e `docs/current-state.md` com o estado
      real ao fim.

---

## Ordem e o que trava o quê

```
T001-T002  emenda            ──▶ libera Fase 1
T010-T011  papel + trava     ──▶ T012-T014
T012-T014  funções           ──▶ T015-T016 (provas)  e  ──▶ T022
T020-T021  costura           ──▶ T022-T023
T022+T024  escrita + fila    ──▶ Fase 3
T033       recusa legível    ──▶ antes de T030-T032
Fase 3     ────────────────────▶ Fase 4
```

**Dívidas herdadas da spec 001 que continuam abertas** (contexto em
`001-migracao-waha-uazapi/tasks.md`): T069 script de cura sem chamador, T070 prova de segredo
placeholder no nível do banco, T071 cron de retenção nunca agendado (LGPD). Não bloqueiam esta spec,
mas seguem contando.
