# Quickstart — roteiros de validação

**Spec**: [spec.md](./spec.md) · **Plano**: [plan.md](./plan.md) · **Tasks**: [tasks.md](./tasks.md)

Cada seção prova um bloco de Success Criteria e tem uma task correspondente na Fase 6. **Roteiro
executado sem número anotado não conta** — "passou" não é medição.

> **Declaração de ambiente é obrigatória em toda execução.** Anote: SHA do CRM, SHA do gateway,
> se o banco é fresco ou reaproveitado, e se o provedor é real ou simulado. Roteiro sem isso não é
> reproduzível, e resultado não reproduzível não é prova.

---

## 0. Pré-requisitos

```bash
nvm use                        # node 22
pnpm install
```

**Banco fresco** — do `baseline.sql`, **nunca** da cadeia de `migrations/` (a cadeia fresh não sobe):

```bash
# Supabase local em pg17 (o baseline usa GRANT MAINTAIN, privilégio pg17+)
# config.toml: major_version = 17
supabase start
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql
pnpm tsx scripts/bootstrap-owner.ts
```

**Gateway** apontado para este banco, com `gateway_writer` e o token de papel (research D1):

```bash
cd /root/PROJETOS/gateway_go
# store=crm, endereço do CRM como CONFIGURAÇÃO — nunca localhost em prod
go run ./cmd/gateway
```

⚠️ **`ENTREGA_FILA_DIR` precisa apontar para diretório persistente**, senão a §6 (reinício) prova o
oposto do que se quer: uma fila que some no restart passa no teste errado.

**Antes de qualquer coisa**, o gate que a doutrina exige para mudança de schema/RLS/papel:

```bash
pnpm test:db     # baseline em modo install E update + invariantes
```

Se a 0127 quebrar aqui e passar na sua máquina, leia **research D1.1** — é o `authenticator`.

---

## 1. Envio ponta a ponta — 20 mensagens reais

**Prova**: SC-001, SC-002 · **Task**: T060

1. Provisionar uma conexão e parear um número real.
2. Confirmar `channel_sessions`: `ingest_path='gateway'` e `gateway_connection_id` preenchido.
3. Enviar 20 mensagens de texto para um celular de teste, cronometrando **do clique à chegada**.

**Esperado**:

| Medida | Alvo |
|---|---|
| Chegaram no aparelho | **20/20** |
| p95 clique→chegada | **≤ 5 s** |
| Com `external_id` preenchido | **20/20** |
| Em estado sem dono | **0** |

**Anote o p95, não "passou".** Sem o número não há como comparar na próxima execução.

---

## 2. Idempotência e não-regressão de estado

**Prova**: SC-003 · **Tasks**: T018, T061

1. Reentregar **todo** o lote da §1 ao gateway (mesmo `external_id`).
2. Contar linhas em `messages` antes e depois.
3. Mandar um ACK **atrasado** (`sent`) para uma mensagem que já está `read`.
4. Mandar um `failed` para uma mensagem que já está `read`.

**Esperado**:

- Contagem de `messages` **idêntica**; um `ai_agent.dispatch_requested` por mensagem, não dois.
- O ACK atrasado é **ignorado com sucesso** (`estado_nao_regride`) — a tela não regride.
- O `failed` **entra**, mesmo depois de `read`. É a exceção deliberada da máquina de estado.

> Se o passo 1 estourar `duplicate key ... messages_org_external_id_unique` em vez de devolver
> `duplicada = true`, falta o `set constraints ... immediate`. Research D2.

---

## 3. Vazão, janela e o caminho que escapa

**Prova**: SC-004, SC-005 · **Task**: T062

1. Rajada de 50 mensagens por canal migrado; registrar o intervalo entre saídas consecutivas.
2. Tentar enviar fora da janela de horário configurada.
3. **Varredura mecânica** (não inspeção visual) por caminhos de envio que não passam pelo seam.

**Esperado**: espaçamento respeitado em **100%** das amostras · **0** envios fora da janela · **0**
caminhos que escapam.

> O caminho que escapa hoje tem nome e endereço: `app/api/v1/cron/recover-stuck-messages/route.ts`
> monta chamada crua ao WAHA. Num canal migrado ela envia para o lugar errado **em silêncio** — o
> pior tipo de defeito. É a T035, e esta seção é o que a vigia.

---

## 4. Conta nova, estado vazio, cronômetro

**Prova**: SC-006, SC-007 · **Task**: T063 · **Princípios IV e VIII**

**Não é `curl`.** É Playwright dirigindo o browser, numa conta **recém-criada**, com **estado vazio**:
sem canal, sem base de conhecimento, sem lead, sem convite aceito.

1. Cadastro novo. **Cronômetro começa no cadastro**, não depois do login.
2. Conectar canal pelo gateway. Medir do clique até o QR aparecer.
3. Parear com celular real.
4. Receber uma mensagem, deixar o agente responder, conferir no aparelho.

**Esperado**:

| Medida | Alvo |
|---|---|
| Clique → QR na tela | **≤ 15 s** |
| Cadastro → primeira conversa atendida | **≤ 10 min** |
| Contagem de passos de tela | **idêntica** à de antes da feature |
| Nome de provedor em texto visível | **0** ocorrências |

**A contagem de passos exige linha de base.** Meça o fluxo **atual** antes de tocar no código — sem
o "antes", "idêntica" não é verificável. Evidência visual em `.superpowers/evidence/`.

---

## 5. Provisionamento que falha — tudo-ou-nada

**Prova**: SC-008 · **Task**: T065

Forçar falha **10 vezes**, alternando o ponto: (a) provedor recusa criar instância; (b) instância
criada e o registro falha depois.

**Esperado**: **0** canais órfãos no CRM e **0** instâncias órfãs no provedor, nas 10.

> O caso (b) é o que importa. Hoje `DELETE /v1/uazapi/instance` do gateway apaga a instância e
> **deixa a linha órfã** — comentado no próprio código (`uazapi_ops.go:243-246`).

---

## 6. Gateway fora do ar — as duas pontas de durabilidade

**Prova**: SC-011 · **Tasks**: T026, T068 · **Princípio XIV**

**Ponta que empurra** (fila do gateway):

1. Derrubar o CRM (não o gateway).
2. Mandar 30 mensagens ao gateway.
3. **Matar o processo do gateway** com a fila cheia.
4. Subir gateway e CRM.

**Esperado**: **30/30** no inbox, **0** duplicatas.

**Ponta que puxa** (reconciliação, FR-013a):

5. Com tudo no ar, apagar à mão 3 mensagens que o gateway entregou (simula escrita aceita e perdida).
6. Esperar a varredura de reconciliação.

**Esperado**: as 3 voltam, **e** a divergência **alarma**. Reconciliação silenciosa reprova este
roteiro mesmo tendo recuperado tudo — silêncio é o defeito, não só a perda.

**Ponta do usuário**:

7. Com o gateway derrubado, tentar enviar.

**Esperado**: **100%** em estado reagendável · **1** aviso na Central · **0** mensagens perdidas em
silêncio.

---

## 7. Reversão por canal

**Prova**: SC-009 · **Task**: T066

1. Com tráfego correndo, virar um canal de `gateway` para `legacy`.
2. Contar mensagens em voo antes e depois.
3. Virar de volta.

**Esperado**: **100%** preservadas, **0** duplicatas, nas duas viradas. Os demais canais **intocados**
— é a prova de que a chave de corte é por canal e não global.

---

## 8. Mídia

**Prova**: SC-010 · **Task**: T067

Enviar imagem, documento e áudio; **abrir no aparelho** do destinatário.

**Esperado**: **3/3** abrem. A referência de endereço vale **≥ 1 h** (FR-024) — validar expirando uma
de propósito e confirmando que o gateway falha de forma legível, em vez de entregar anexo morto.

---

## 9. Isolamento entre organizações

**Prova**: Princípio I · **Tasks**: T017, T019

Roda em `pnpm test:db`, não à mão:

1. Duas organizações, uma conexão cada.
2. Chamar `fn_gateway_ingest_message` com o `gateway_connection_id` da org A e ids da org B no corpo.

**Esperado**: a mensagem cai **sempre** na org da conexão. O corpo **não** decide tenant.

**Sabotagem obrigatória** (SC-012, Princípio XI): trocar a resolução de tenant por leitura do
parâmetro e confirmar que o teste fica **vermelho**. Teste que não fica vermelho sob sabotagem não é
prova — é decoração.

---

## Desvios declarados

Coisas que este roteiro **não** cobre, ditas em voz alta para ninguém confundir com aprovação:

- **Carga real de produção.** A rajada de 50 (§3) prova espaçamento, não capacidade.
- **Múltiplos canais simultâneos** no mesmo tenant. A §7 prova isolamento entre canais na virada,
  não sob concorrência.
- **Reconciliação com janela cheia.** A §6 apaga 3 mensagens; não prova 6 horas de fila.
- **`wa_template_envios`.** Sem equivalente no CRM — lacuna declarada na §6 do `data-model.md`.
