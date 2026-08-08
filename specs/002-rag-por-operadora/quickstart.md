# Quickstart — como provar que esta feature funciona

Cada fatia do plano tem aqui o cenário que a prova. **Nenhum deles é `curl`**: o Princípio IV diz
que chamada de API não prova UX, e os critérios da spec são todos medidos pela tela.

---

## Ambiente (uma vez, e não é opcional)

O ambiente **é** parte da prova: os piores defeitos de primeira impressão moram nos envs opcionais
ausentes.

```bash
nvm use                                    # node 22
pnpm install

# Banco: Supabase local em pg17 (config.toml major_version = 17 — o baseline usa GRANT MAINTAIN)
supabase start
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/baseline.sql
pnpm tsx scripts/bootstrap-owner.ts        # o que o install.sh faz

# Dependências como na VPS
docker compose up -d                       # WAHA + Redis + serverless-redis-http

# App em modo produção — next dev compila lento demais e o Turbopack quebra cookies()
pnpm build && pnpm start
```

**Regras do ambiente fresco que custam tempo quando ignoradas**: worktree com `node_modules` real
(nunca symlink — o Turbopack rejeita "out of filesystem root") e fora de `/tmp`. Deixe
`RESEND_API_KEY` **ausente**: é o estado real de um primeiro deploy.

**Migrations não sobem do zero.** Aplique o `baseline.sql`, não `supabase db push` — a cadeia de
migrations tem stubs `SELECT 1;` e o push "passa" deixando o banco vazio.

---

## F1 — O agente para de inventar

**Estado inicial**: tenant sem acervo nenhum.

1. Pelo WhatsApp de teste, mande 20 perguntas de assistência que o acervo não cobre ("como tiro a
   segunda via?", "esse hospital está na rede?", …).
2. **Esperado**: 20 recusas com escalação. **Zero** afirmações factuais sobre operadora. Cada recusa
   com frase em linguagem de cliente — sem "base de conhecimento", sem "similaridade", sem nome de
   ferramenta (FR-011).
3. Abra a **Central de avisos**: 20 itens, cada um com a pergunta original, a operadora (ou
   "desconhecida") e o motivo.
4. Mande uma pergunta de **conversão** ("quanto custa um plano para 2 pessoas?"). **Esperado**:
   responde normalmente. O veto não alcança a venda (FR-020, SC-011).
5. **Falha induzida** — derrube a busca de conhecimento de propósito e repita o passo 1.
   **Esperado**: as 20 continuam terminando em recusa. Nenhuma em "respondo com o que eu sei"
   (FR-013, SC-002).

6. **Teste de efeito da configuração** (FR-015, SC-012): desligue "Exigir citação da base" na tela e
   repita uma pergunta de assistência; ligue e repita. **Esperado**: o comportamento muda de forma
   observável nos dois sentidos. Hoje essa opção é salva no banco e **nenhum runtime a avalia** — é
   o defeito que originou o Princípio XI, e provar que o valor foi gravado não fecha nada.

**Sabotagem obrigatória** (Princípio XI): desarme o gate no código e rode o teste da cadeia. Se ele
continuar verde, o teste é hipótese, não prova.

```bash
pnpm test:unit -- before-send
```

---

## F2 — A instalação nasce sabendo

**Estado inicial**: banco recém-aplicado do `baseline.sql`. O corretor **não carregou nada**.

1. Login. Abra **Operadoras** pela navegação — não digitando a URL. A tela tem de estar alcançável
   pelo menu (Princípio II; `tests/unit/navegacao-completude.test.ts` reprova tela sem porta).
2. **Esperado**: as operadoras do catálogo aparecem **desligadas**, marcadas como conteúdo que veio
   com o produto (A-20).
3. **Antes de ligar nada**, como cliente, pergunte algo coberto pelo catálogo. **Esperado**: recusa
   e escalação — **e** o aviso ao corretor diz que existe material no catálogo cobrindo o assunto e
   oferece ligá-lo dali (FR-042). Este passo prova o lado que a decisão de A-20 criou; sem ele a
   instalação parece burra por configuração que ninguém mostrou.
4. Ligue o escopo — **um** clique — e repita a pergunta. **Esperado**: resposta ancorada, com a
   origem abrível na conversa (SC-017). Cronometre: este passo entra no teto de SC-011, não fora
   dele.
5. Como cliente de **outra** operadora, faça a mesma pergunta. **Esperado**: recusa e escalação —
   nunca a resposta da primeira (SC-005).
6. Como cliente **sem operadora conhecida**: o agente pergunta **uma vez**, em linguagem natural.
   Responda; a próxima pergunta já é atendida. Não responda; **esperado**: escala, e não adivinha
   nem quando só existe uma operadora carregada (FR-017).
7. Registre a operadora na **ficha do contato** e confira que ela vence o que veio da conversa
   (FR-017, precedência do cadastro).
8. Pergunta que cruza **duas** operadoras ("meu plano é o X e o da minha mãe é o Y"). **Esperado**:
   resposta por operadora, cada parte com sua âncora; a parte sem lastro recusada **isoladamente**,
   sem derrubar a que tem (FR-018).

**Linha de base de SC-006 — meça ANTES de semear o catálogo**, com **1** escopo carregado à mão:
rode a bateria de perguntas e registre o p95 do tempo até a resposta. Depois da semeadura o catálogo
já traz vários escopos e esse número deixa de existir; medi-lo no fim da fatia seria inventá-lo. É a
referência de F4/F5 — sem ela, "não cresce mais que 25%" não tem contra o que comparar.

```bash
pnpm test:db     # invariantes: travas 1/2/3 + não-vazamento entre escopos (SC-007, SC-020, SC-021)
pnpm test:e2e -- operadoras
```

> **Esta prova não é vigiada por gate nenhum.** O check `e2e` **não é obrigatório** na branch
> protection, e a spec da mesma família (`vps-fresh-onboarding`, a jornada `[P0]` de instalação
> fresca) está entre as 4 que **não rodam no CI** — issue #63. Registre a evidência em
> `.superpowers/evidence/` e anote no `user-journey-map.md`: nenhum job vai reprovar a regressão.

---

## F3 — Nós curamos, e atualizar não destrói

1. Como administrador de plataforma, abra a curadoria, crie um material e salve. **Esperado**: ele
   ancora resposta na hora, sem reinício, build ou migration (SC-010).
2. Como `admin` de uma organização (não de plataforma), tente alcançar a mesma tela e a mesma rota.
   **Esperado**: barrado nos dois caminhos (SC-021).
3. **A prova que hoje não existe** — não-destrutividade da atualização:

```bash
# num Postgres descartável
psql -v ON_ERROR_STOP=1 -f supabase/baseline.sql          # install
# … editar um material 'seed' e criar um 'local' …
psql -f supabase/baseline.sql                              # update
psql -f supabase/baseline.sql                              # update de novo
```

**Esperado**: zero materiais perdidos, zero edições locais sobrescritas, zero duplicatas visíveis, e
o estado após duas reaplicações idêntico ao de uma (SC-018).

**E o que o banco intacto não prova — meça a resposta.** Edite um material `seed` (o clone passa a
tê-lo *adotado localmente*), semeie uma versão mais nova do mesmo `slug`, e pergunte ao agente algo
que aquele material cobre. **Esperado**: a resposta ancora na **versão local**, e a versão semeada
aparece na curadoria como pendente de aceite, inerte. Se ela vencer, SC-018 está passando contando
linhas enquanto FR-037 falha respondendo — que é exatamente o defeito que a revisão cruzada de
2026-08-08 encontrou no desenho anterior.

4. **O install e o update têm de concordar sobre o índice.** Depois do install fresco, confira:

```sql
select indexname from pg_indexes where indexname = 'ai_knowledge_sources_unique_per_agent';
```

**Esperado**: zero linhas, tanto no banco recém-instalado quanto no atualizado. O snapshot recria
esse índice e o apêndice tem de derrubá-lo; se ele sobrevive num dos dois caminhos, a segunda
operadora é impossível só para quem instalou do zero — e ninguém percebe até um self-hoster
reclamar (brecha 10).

---

## F4 — O corretor manda no que vale para ele

1. Suba um **PDF** de uma operadora. **Esperado**: estado `pronto` com **contagem de trechos**.
   Se a contagem não aparecer, o defeito medido nº 5 da spec voltou — o PDF subiu, a tela disse
   sucesso, e nada virou conteúdo buscável.
2. Suba um lote com casos inválidos: PDF só de imagem, formato não suportado, arquivo acima do
   limite. **Esperado**: 100% terminam em estado explícito — pronto com contagem, ou falha com
   motivo em português e o que fazer. **Zero** em "salvo sem conteúdo buscável" (SC-014).
3. Carregue material próprio sobre um assunto que o catálogo já cobre. Pergunte. **Esperado**: a
   âncora é a **sua**, e o catálogo não aparece (SC-019).
4. Carregue uma **segunda** operadora e cronometre: **≤2 minutos**. Durante todo o processo,
   perguntas sobre a primeira continuam sendo respondidas — **zero** janela sem base (SC-004).
5. Cronometre o **primeiro material próprio**, do login ao primeiro trecho buscável: **≤5 minutos**,
   sozinho, sem documentação (SC-003).

---

## F5 — O erro fica corrigível

1. Com o **modo de depuração desligado**, abra uma conversa com resposta de assistência já enviada.
   Chegue ao texto do trecho em **no máximo 3 interações de tela** (SC-008).
2. Confira que a origem diz **de qual camada** o trecho veio (FR-039).
3. Atualize o material e reabra uma resposta **antiga**. **Esperado**: ela continua levando ao
   conteúdo que estava valendo na época (FR-023, SC-008).
4. Provoque 10 recusas e abra a tela de conhecimento. **Esperado**: lacunas agrupadas por operadora
   e assunto, com "não há nada sobre isto" **separado** de "quase acertou" (FR-029). Carregue o
   material que cobre uma delas e confirme que ela some da lista (SC-013).
5. Carregue material com validade **já expirada** e pergunte algo que só ele cobriria.
   **Esperado**: escala como se não houvesse material (SC-009).
6. Ligue e desligue a exigência de lastro na tela. **Esperado**: o comportamento do agente muda de
   forma observável nos dois sentidos (SC-012). É o defeito que originou o Princípio XI — a opção
   existe hoje, é salva no banco, e nenhum runtime a avalia.
7. Faça a **mesma** pergunta na superfície de teste e na conversa real. **Esperado**: mesmo veredito
   de lastro; ou a tela de teste declara, antes do resultado, o que ela não avaliou (SC-015).

---

## Antes de declarar qualquer fatia pronta

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build
pnpm test:db     # obrigatório: a feature toca schema, RLS e isolamento
pnpm test:e2e
```

A lista é completa de propósito. Rodar metade e descobrir o resto como surpresa vermelha depois de
horas é a pior experiência que este repositório sabe entregar.

**Verde parcial não é verde**: declare qual suíte rodou e qual não rodou. `pnpm test:unit` **não**
inclui `tests/invariants/**` — a exclusão em `vitest.config.ts` é deliberada, e o isolamento RLS só
é exercitado pelo `pnpm test:db`.

**Evidência visual** de cada jornada em `.superpowers/evidence/`, e o mapa de jornadas
(`docs/testing/user-journey-map.md`) atualizado — as jornadas de F2 são `[P0]`, porque uma
instalação que já sabe responder é a primeira impressão do produto.
