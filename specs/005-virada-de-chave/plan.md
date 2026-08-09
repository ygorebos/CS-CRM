# Plan — A virada de chave (spec 005)

**Escrito em**: 2026-08-09, a partir da análise cruzada da spec 004.

**Princípio que manda aqui**: VIII (teto de 10 minutos) para o bloco C1; XIV (duas pontas de
durabilidade) e a doutrina de expand/contract para o bloco C3.

---

## Technical Context

| | |
|---|---|
| **Linguagem** | TypeScript 6 estrito, Next.js 16 App Router, React 19 |
| **Banco** | Supabase (Postgres 17). **Nenhuma coluna nova** — ver abaixo |
| **Transporte** | `gateway_go` (repo irmão, deploy separado), variante `STORE_ALVO=crm` |
| **Provas** | Vitest (unidade), Playwright (tela, conta nova, estado vazio) |
| **Migrations** | Se alguma for necessária, começa em **0131** (0123–0126 reservadas pela spec 002; 0127–0130 gastas pela 004) |

### Não há mudança de schema — e isso é uma conclusão, não um palpite

As três colunas de que os dois blocos precisam já existem, com as constraints certas:

```sql
channel_sessions.provider              -- CHECK: waha | meta_cloud | whatsapp_uazapi | …
channel_sessions.gateway_connection_id -- TEXT, sem FK (Princípio VII)
channel_sessions.ingest_path           -- CHECK: legacy | gateway, default legacy
```

E `channel_sessions_provider_ref_check` **permite** `waha_session_name` e `gateway_connection_id`
não-nulos na mesma linha: ele exige a referência do provider corrente, não a ausência das outras.
É exatamente o que faz o expand/contract da FR-012 caber numa linha só, sem coluna de sombra.

Se durante a execução aparecer necessidade de coluna, ela sai como migration versionada +
apêndice idempotente no `baseline.sql` + linha no MANIFEST. Os três, sempre.

---

## O desenho, por bloco

### C1 — onboarding pelo gateway

O trabalho é **de fiação, não de invenção**. As três peças que faltam já existem para a Central:

```
hoje                                          depois
────                                          ──────
page.tsx                                      page.tsx
  wahaConfigured = getWahaClient()!==null       transporte = transporteDisponivel()
      │                                             │
      ▼                                             ▼
POST /onboarding/whatsapp/session             POST /onboarding/whatsapp/session
  criarConexaoDeCanal({…})                      provisiona no gateway quando for o caso,
  getWahaClient().start()                       e chama criarConexaoDeCanal({…, gateway})
      │                                             │
      ▼                                             ▼
GET /onboarding/whatsapp/qr                   GET /channel-sessions/[id]/pairing
  `${baseUrl}/api/${s}/auth/qr`  (WAHA)         contrato único, com expires_at
```

`criarConexaoDeCanal` **já aceita** o parâmetro `gateway?: { provider, connectionId }`
(`lib/channels/criar-conexao.ts`) e já faz o desfazer da instância quando a gravação falha. A rota
`/pairing` **já serve os dois canais**: para conexão que não é do gateway ela devolve
`image_url` apontando para a rota irmã `/qr`, em vez de erro. Nada disso precisa nascer.

O que nasce: **um só lugar que responde "que transporte esta instalação tem?"**. Hoje a pergunta
está espalhada em três formas diferentes — `getWahaClient() !== null` (onboarding),
`provisionamentoConfigurado()` (Central, `channel-sessions/route.ts:74`) e
`transporteLegadoPronto || provisionamentoConfigurado()` (`app/app/connections/page.tsx:32`). Três
respostas para a mesma pergunta é como o onboarding ficou para trás sem ninguém notar.

**Decisão de precedência**: com os dois transportes configurados, conexão **nova** nasce pelo
gateway. É o destino da migração, e nascer no legado seria criar dívida com o serviço novo de pé.

### C3 — a conexão viva

Duas chaves, e só uma existe:

| O que muda | Coluna | Chave hoje |
|---|---|---|
| Recebimento | `ingest_path` | ✅ `PATCH /api/v1/channel-sessions/[id]/ingest-path` |
| Envio | `provider` | ⛔ não existe |

A sequência, e a ordem **não é escolha** — cada passo só é reversível porque o anterior deixou a
linha íntegra:

```
1. provisiona instância no gateway            (linha intacta; nada muda para o usuário)
2. grava gateway_connection_id na linha        (provider ainda 'waha' — envio segue pelo WAHA)
3. usuário pareia o número no gateway (QR)     (janela: dois transportes vivos)
4. troca provider + ingest_path juntos         (a virada; atômica)
5. waha_session_name PERMANECE                 (é o caminho de volta)
```

**O passo 3 é o que ninguém pode contornar.** Sessão pareada não se transfere entre provedores. A
tela precisa dizer isso antes da confirmação (FR-014) — prometer migração sem QR seria prometer o
que o WhatsApp não permite.

**A janela do passo 3** é onde mora o risco da FR-016: WAHA ainda pareado e uazapi já provisionado.
Recebimento em dobro é o desfecho a evitar, e a defesa já existe — a idempotência por
`unique (organization_id, external_id)`. O que a task tem de **provar** é que ela cobre o caso em
que o mesmo conteúdo chega pelos dois caminhos com `external_id` **diferente** (id do WAHA vs id da
uazapi). Se não cobrir, a defesa é a dedup por conteúdo+janela, e ela é escopo desta spec.

---

## Constitution Check

| Princípio | Como esta spec se posiciona |
|---|---|
| **VII** — gateway não toca tabela | Inalterado. O CRM continua sendo quem escreve; o gateway provisiona por HTTP (decisão T003 da 004) |
| **VIII** — teto de 10 minutos | É o alvo do bloco C1. SC-001 mede |
| **XI** — sabotagem | SC-007: toda prova de tela vermelha sob sabotagem |
| **XIV** — duas pontas / sem réplica | Inalterado. Dreno e reconciliação da 004 continuam sendo as pontas |
| **Migrations** | Sem mudança de schema prevista; se houver, a tripla obrigatória |
| **Expand/contract** | FR-012: `waha_session_name` preservado é o contract adiado. Não há `drop column` nesta spec |

Nenhum gate violado. Nenhuma justificativa de exceção necessária.

---

## Fases

| Fase | O quê | Depende de |
|---|---|---|
| **1** | C1 — onboarding pelo gateway | nada (só código do CRM) |
| **2** | C3 — migração da conexão viva | Fase 1 (reusa a resolução de transporte) |
| **3** | Prova pela tela, conta nova, estado vazio | gateway de pé + número real |

A Fase 3 é a que a 004 não conseguiu executar por falta de recurso, e o motivo continua o mesmo. A
diferença é que agora ele está **nomeado como pré-condição da fase**, não descoberto no meio dela.
