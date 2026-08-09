# Tasks — A virada de chave (spec 005)

**Escrito em**: 2026-08-09, a partir dos achados **C1** e **C3** da análise cruzada da spec 004.

**Numeração de migrations**: **nenhuma prevista** (ver `plan.md` — as três colunas já existem com as
constraints certas). Se aparecer necessidade, começa em **0131**: 0123–0126 estão reservadas pela
spec 002, 0127–0130 foram gastas pela 004. Conferir `ls supabase/migrations/` antes de criar
arquivo — colisão de número já mordeu uma vez.

**Doutrina que vale em toda task de teste**: o teste só conta depois de ficar **vermelho sob
sabotagem** (Princípio XI). Cada fase termina com sua task de sabotagem, e elas não são opcionais
nem agrupáveis no fim.

**Doutrina que vale em toda task de tela**: leia `CLAUDE.md` § "Como medir sem produzir verde
falso" **antes** de escrever asserção. As regras 2 (ausência prova transição), 3 (asserção negativa
exige âncora de lugar) e 5 (dublê responde no formato que você escreveu) já custaram quatro verdes
falsos nesta migração.

---

## Fase 1 — C1: o onboarding pelo gateway

> **Alvo**: FR-001 a FR-006. **Bloqueia**: a Fase 2 (que reusa a resolução de transporte) e
> qualquer virada de chave em produção — hoje ligar o gateway quebra o cadastro de quem chegar
> depois.

- [ ] **T001** Uma resposta só para "que transporte esta instalação tem?" — `lib/channels/transporte.ts`.
      **(FR-002, FR-006)**
  - Hoje a mesma pergunta tem três formas: `getWahaClient() !== null`
    (`app/onboarding/connect-whatsapp/page.tsx:13`), `provisionamentoConfigurado()`
    (`app/api/v1/channel-sessions/route.ts:74`) e `transporteLegadoPronto ||
    provisionamentoConfigurado()` (`app/app/connections/page.tsx:32`). **Foi assim que o onboarding
    ficou para trás sem ninguém notar** — quem acrescentou o ramo do gateway acrescentou em dois dos
    três lugares.
  - Função pura, injetável, devolvendo `"gateway" | "legacy" | null`. `null` é "nenhum transporte", e
    é um estado legítimo — não um erro.
  - **Precedência declarada no código, não no comentário**: com os dois configurados, o gateway
    ganha. É o destino da migração; nascer no legado seria criar dívida com o serviço novo de pé.
  - Trocar os três chamadores. O da Central muda de forma sem mudar de comportamento — se mudar,
    é regressão, e a prova é o teste que já existe.

- [ ] **T002** A tela do onboarding para de depender do WAHA. **(FR-002)**
  - `app/onboarding/connect-whatsapp/page.tsx:13` passa a consultar T001; `_client.tsx` recebe o
    transporte, não o booleano `wahaConfigured`.
  - **O sintoma que isto conserta**: instalação com gateway ligado e WAHA ausente mostra ao usuário
    recém-cadastrado o aviso de "WAHA não configurado" em vez do QR. Ele não conecta, e o produto
    morre no primeiro minuto.

- [ ] **T003** `POST /api/v1/onboarding/whatsapp/session` provisiona no gateway quando for o caso.
      **(FR-001, FR-003)**
  - `criarConexaoDeCanal` **já aceita** `gateway?: { provider, connectionId }` e já desfaz a
    instância quando a gravação falha (`lib/channels/criar-conexao.ts`). O que falta é o ramo que
    chama `criarConexaoNoGateway` antes — o mesmo que a Central faz.
  - **Preservar o nome fixo `org_<8>`.** Ele é o que faz o corretor que fechou a aba e voltou cair
    na conexão que já começou, em vez de criar órfã. Nome aleatório aqui produziria uma instância
    paga por tentativa de pareamento.
  - **Preservar o que a T044/T045 da 004 já convergiu**: `ingest_path` pelo interruptor, auditoria
    `channel.connected` com `origem='onboarding'`, papel `admin` exigido. Esta task acrescenta
    transporte; não desfaz nada.

- [ ] **T004** O onboarding passa a consumir `/pairing` em vez de montar endereço do WAHA. **(FR-004)**
  - `app/api/v1/onboarding/whatsapp/qr/route.ts:24` monta
    `${baseUrl}/api/${session}/auth/qr?format=image` à mão. A rota `/channel-sessions/[id]/pairing`
    **já serve os dois canais**: para conexão que não é do gateway ela devolve `image_url` apontando
    para a rota irmã `/qr`, em vez de erro.
  - Com isso o onboarding herda de graça o `expires_at` e o `pair_code` — o agendamento por validade
    da T041 da 004 passa a valer também aqui, e quem tem um aparelho só ganha o código por número.
  - A rota `/onboarding/whatsapp/qr` **continua existindo** enquanto houver instalação no legado.
    Removê-la é contract, e contract vem depois da escrita nova estar em produção.

- [ ] **T005** Sem transporte nenhum, a tela recusa dizendo o que falta. **(FR-005)**
  - `null` da T001 vira texto que nomeia a variável ausente para quem opera, sem nomear provedor
    para quem usa. Nunca tela vazia; nunca QR que não vai funcionar.

- [ ] **T006** Nenhuma palavra da jornada nomeia provedor. **(FR-001, SC-003)**
  - Varrer o texto visível de `app/onboarding/connect-whatsapp/**` por "WAHA", "uazapi", "gateway".
  - Se `lint-channels` já cobre parte disso, estender em vez de duplicar — ele foi o que reprovou a
    primeira versão da rota `/pairing` na 004.

- [ ] **T007** Provas de unidade da Fase 1.
  - T001: precedência com os dois configurados, `null` com nenhum, e as três formas antigas
    devolvendo o mesmo que a nova para cada combinação.
  - T003: gravação falha desfaz a instância; nome `org_<8>` estável entre duas chamadas.
  - **Não** testar `useEffect` de tela aqui — a prova de tela é a Fase 3.

- [ ] **T008** **[SABOTAGEM]** Quebrar de propósito e exigir vermelho.
  - Inverter a precedência da T001 (legado ganhando do gateway) → os testes da T007 reprovam.
  - Devolver `wahaConfigured=true` fixo na T002 → o caso de "gateway sem WAHA" reprova.
  - Registrar quantos vermelhos cada sabotagem produziu. Sabotagem que não fica vermelha significa
    que o teste mede outra coisa.

---

## Fase 2 — C3: a conexão que já está no ar

> **Alvo**: FR-010 a FR-017. **Depende de**: Fase 1 (T001).
>
> **O fato desconfortável, e ele manda no desenho todo**: sessão pareada **não se transfere** entre
> provedores. As credenciais vivem no WAHA; o gateway pareia contra a uazapi. Migrar é parear de
> novo. O que se preserva é a linha, o histórico e as conversas — não a sessão.

- [ ] **T010** A chave de envio, que não existe. **(FR-010)**
  - Medido: `PATCH /api/v1/channel-sessions/[id]/ingest-path` troca o **recebimento** e recusa com
    `channel_without_gateway_connection` quando a linha não tem endereço no gateway. O **envio**
    segue `provider` (`lib/channels/index.ts`), e não há rota, tela nem script que troque `provider`
    numa linha existente.
  - Consequência hoje: uma linha `provider='waha'` com `ingest_path='gateway'` **recebe pelo novo e
    envia pelo velho**. Meio migrada é um estado que ninguém escolheu e que dá para alcançar.
  - Decidir **antes de escrever**: rota nova, ou a `/ingest-path` passa a virar as duas colunas
    juntas? A segunda tem a vantagem de tornar o estado meio-migrado inalcançável — e essa é a razão
    pela qual eu a recomendaria. Registrar a decisão aqui.

- [ ] **T011** O aviso e a confirmação, **antes** de qualquer escrita. **(FR-014)**
  - A tela diz, em português de gente: o número vai precisar ser pareado de novo, o histórico
    continua, e dá para voltar atrás.
  - Confirmação explícita. Sem ela, nenhuma coluna muda e nenhuma instância paga nasce.

- [ ] **T012** Passo 1 e 2 da sequência: provisionar e gravar o endereço **sem** trocar `provider`.
      **(FR-011, FR-016)**
  - A linha ganha `gateway_connection_id` e continua `provider='waha'`. Nada muda para o usuário;
    o envio segue pelo WAHA. É o que torna o passo 3 reversível a custo zero.
  - `channel_sessions_provider_ref_check` permite as duas referências na mesma linha — ele exige a
    do provider corrente, não a ausência das outras. É o que faz o expand/contract caber sem coluna
    de sombra.

- [ ] **T013** Passo 4: a virada, `provider` e `ingest_path` **juntos**. **(FR-010, FR-015)**
  - Atômica. Meio virada é o estado da T010, e ele deixa de ser alcançável aqui.
  - `waha_session_name` **permanece** — é o caminho de volta (FR-012), não resíduo. Quem "limpar"
    essa coluna tira a reversão do ar.
  - Auditoria que distingue a troca de transporte da troca de `ingest_path` sozinha.

- [ ] **T014** A reversão, pela mesma tela, sem release. **(FR-012)**
  - Volta `provider='waha'` e `ingest_path='legacy'`, **preservando** `gateway_connection_id` — se
    o operador migrar de novo, não nasce segunda instância paga.
  - **A tela diz o que a reversão não desfaz**: se a sessão WAHA já foi deslogada, voltar deixa o
    número desconectado. É reversível, não é indolor, e prometer o contrário é mentir.

- [ ] **T015** A janela do passo 3: provar que não duplica. **(FR-016)**
  - Entre "instância provisionada" e "número pareado" os dois transportes estão vivos. A defesa
    existente é `unique (organization_id, external_id)`.
  - **O que a task tem de medir, e é o ponto**: a mesma mensagem chegando pelos dois caminhos traz
    `external_id` **diferente** (id do WAHA vs id da uazapi — os formatos divergem, e o da uazapi
    ainda difere entre conversa individual e grupo). Se a unicidade não cobre esse caso, a defesa
    tem de ser dedup por conteúdo + janela, e ela **é escopo desta task**.
  - Medir com os dois formatos reais, não com dublê: dublê responde no formato que você escreveu.

- [ ] **T016** Migração concorrente não paga duas vezes. **(FR-017)**
  - Duas requisições na mesma conexão produzem uma instância. `Idempotency-Key` já é o padrão dos
    POSTs de criação; usar o mesmo mecanismo, não inventar outro.
  - Recurso pago que o teste cria, o teste apaga — e a verificação é o registro vazio, não a
    intenção.

- [ ] **T017** Provas de unidade da Fase 2.
  - T013: virada atômica; falha no meio não deixa linha meio virada.
  - T014: reversão preserva `gateway_connection_id`.
  - T015: as duas ingestões com `external_id` diferente produzem **uma** mensagem.

- [ ] **T018** **[SABOTAGEM]** Quebrar de propósito e exigir vermelho.
  - Trocar só `ingest_path` na T013 (deixando `provider`) → o teste de virada atômica reprova.
  - Apagar `waha_session_name` na virada → o teste de reversão reprova.
  - Remover a dedup da T015 → o teste da janela reprova com mensagem em dobro.

---

## Fase 3 — A prova pela tela (e o que ela exige antes)

> **Pré-condições — nenhuma é código, e sem elas a fase não roda.** Estão aqui nomeadas porque a
> Fase 6 da 004 as descobriu no meio da execução, e isso custou a fase inteira:
>
> 1. fork do gateway publicado — `feat/004-escrita-crm` em `/root/PROJETOS/gateway_go-crm` **nunca
>    foi enviado** (sem upstream); o gateway de produção ainda roda a variante relay;
> 2. gateway de pé com `STORE_ALVO=crm` apontado para um Supabase pg17 com o `baseline.sql`;
> 3. `GATEWAY_BASE_URL`, `GATEWAY_ADMIN_TOKEN`, `GATEWAY_INTERNAL_TOKEN`, `GATEWAY_INBOUND_ENABLED`;
> 4. `SECRET_ENCRYPTION_KEY` — sem ela toda criação de conexão devolve 422 (pendência do PR #14);
> 5. `scripts/bootstrap-owner.ts`, `next build && next start`;
> 6. **número de WhatsApp real** para T023 e T024.
>
> **Worktree próprio, `node_modules` real (nunca symlink), fora de `/tmp`.** Esta máquina roda
> ambientes de outras sessões; `next build` na árvore compartilhada derruba o trabalho alheio.

- [ ] **T020** Onboarding pelo gateway, conta nova, estado vazio, **sem WAHA no ambiente**.
      **(SC-001)**
  - É o caso que mede o que C1 conserta. Com o WAHA presente ele passaria pelo motivo errado.
  - Da tela do cadastro ao número pareado, dirigindo o browser. `curl` não conta.
  - **Regra 2 da doutrina de medição**: o sinal de que pareou é o material de pareamento **sumir**
    (`toHaveCount(0)`), não a tela de QR aparecer — ela já está visível.

- [ ] **T021** Instalação sem transporte nenhum: a tela recusa dizendo o que falta. **(FR-005)**

- [ ] **T022** A jornada não nomeia provedor. **(SC-003)**
  - **Regra 3**: `expect(corpo).not.toMatch(/WAHA/)` passa em qualquer página que não contenha o
    termo — inclusive numa que o teste nunca quis abrir. Afirmar **onde está** (`toHaveURL`, ou um
    elemento que só existe ali) **antes** de afirmar o que não vê. Um caso da 004 ficou verde
    medindo a tela de login.

- [ ] **T023** A conexão viva migra, com número real. **(SC-004, SC-006)**
  - Migrar, parear, **enviar e receber**, e abrir a conversa para conferir que o histórico anterior
    continua lá, na mesma conversa.

- [ ] **T024** E volta. **(SC-004)**
  - Reverter, enviar e receber de novo pelo legado. Reversão que não foi exercitada não é caminho de
    volta — é intenção de caminho de volta.

- [ ] **T025** **[SABOTAGEM]** das provas de tela. **(SC-007)**
  - Devolver `image_url` nulo na `/pairing` → T020 reprova.
  - Escrever "conectado via WAHA" numa tela do fluxo → T022 reprova.
  - Se alguma sabotagem ficar **verde**, o caso mede outra coisa — conserte o caso, não a sabotagem.

- [ ] **T026** Atualizar o planejamento e o mapa vivo (constituição v2.4.0).
  - `docs/migracao-para-o-gateway.md` está com `last_updated: 2026-08-08` e diz **F1 ⛔ não existe** —
    a Fase 1 e a Fase 2 da 004 fecharam. É o achado **C4** da análise, e ele mente para quem
    retomar.
  - `docs/current-state.md`: separar "pronto e coberto" de "pronto e nunca exercitado com tráfego".
  - `specs/004-envio-pelo-gateway/tasks.md`: apontar para esta spec no lugar onde a T044 diz que as
    duas portas convergiram — ela convergiu a linha do banco, não o transporte.

---

## Ordem e o que trava o quê

```
T001  transporte único   ──▶ T002-T005 (onboarding)  e  ──▶ Fase 2
T002-T006 onboarding     ──▶ T007 ──▶ T008 [SABOTAGEM]
T010  decisão da chave   ──▶ T011-T014
T012  endereço sem virar ──▶ T013 virada ──▶ T014 reversão
T015+T016 janela         ──▶ T017 ──▶ T018 [SABOTAGEM]
Fase 1 + Fase 2          ──▶ Fase 3 (com as 6 pré-condições)
```

**Paralelizável [P]**: T005 com T006 · T015 com T016 · T021 com T022.

**A T010 é decisão antes de código.** Escrever a rota antes de decidir se ela troca uma coluna ou
duas produz exatamente o estado meio-migrado que ela existe para impedir.

## Cobertura declarada

| Bloco | Requisitos | Onde |
|---|---|---|
| C1 — onboarding | FR-001 a FR-006 | T001–T008 |
| C3 — conexão viva | FR-010 a FR-017 | T010–T018 |
| Provas | SC-001 a SC-007 | T020–T025 |
| Planejamento vivo | — | T026 |

**Fora daqui, e continua contando**: T060/T061/T067 da spec 004 (p95 do envio, estado final, mídia
no aparelho) seguem esperando número real; T069/T070/T071 seguem abertas desde a spec 001 — T071
(cron de retenção do `webhook_events_log`, LGPD) **não** foi dispensada pela escrita direta.
