# Contrato — a semeadura do catálogo

Como o conteúdo curado sai da nossa instalação e chega a todo clone, sem apagar nada de ninguém.
É a trava 6 do Princípio X v2.0.0 e o critério SC-018.

---

## Onde vive

Apêndice no fim de `supabase/baseline.sql`, em bloco rotulado no padrão do arquivo:

```sql
-- ---- catálogo curado de operadoras (migration 0116) ----
```

O kit self-host aplica **só** o `baseline.sql`, tanto no `install.sh` (banco novo, `ON_ERROR_STOP=1`)
quanto no `update.sh` (banco existente, sem a flag). Conteúdo que entra só em `migrations/` não
chega a self-hoster nenhum (Princípio III).

---

## As três regras que a semeadura obedece

### 1. Só acrescenta. Nunca reescreve.

```sql
insert into public.catalog_materials (slug, version, …)
values (…)
on conflict (slug, version) do nothing;
```

`do nothing`, **nunca** `do update`. As duas formas são idempotentes; só uma é não-destrutiva.
Um `do update` reaplicado apagaria a correção que o dono da instalação fez num procedimento errado —
exatamente o que a trava 6 proíbe, e o que SC-018 mede com "zero edições locais sobrescritas".

Conteúdo corrigido por nós chega como `version + 1`. A anterior permanece, e o desempate de FR-035
faz a mais recente valer.

### 2. Embeddings viajam prontos.

`catalog_chunks.embedding` é literal `vector(1536)` no próprio apêndice, com `embedding_model`
registrado ao lado. SQL não chama API de embedding: sem isso, a instalação fresca só responderia
depois que um worker rodasse com chave de IA válida, e SC-017 e FR-030 falhariam no minuto zero
(research D6).

Custo declarado: ~12 KB por trecho, ~1,2 MB para ~100 trechos. É dívida assumida, não detalhe.

Quando o modelo de embedding configurado difere do registrado, um worker re-embeda — só nesse caso,
e com dono declarado na Central quando travar (Princípio V).

### 3. Espelhos alcançam clone antigo.

O bloco termina chamando a função idempotente de materialização para **toda organização existente**:

```sql
select public.fn_sincronizar_operadoras_do_catalogo(o.id) from public.organizations o;
```

É isto que faz operadora curada nova chegar a quem instalou há seis meses e roda `update.sh`. Sem
essa linha, a semeadura só serviria a instalação nova — e a atualização entregaria tabelas vazias.

A mesma função é chamada na criação de organização, para que tenant novo em instalação antiga
também nasça enxergando o catálogo.

---

## Como o conteúdo é produzido

O administrador de plataforma escreve pela tela (`/api/v1/catalogo/…`), na nossa instalação. Quando
o conteúdo está bom, um script de release exporta as linhas `origin = 'seed'` para o bloco do
apêndice, com os embeddings já calculados.

**A consequência, declarada em vez de escondida**: corrigir conteúdo curado **em outras
instalações** exige release e atualização do clone. Foi a decisão do dono do produto na sessão de
clarificação, contra a recomendação do desenvolvedor, e está registrada em SC-010 e em "Perguntas em
aberto" da spec. Na **própria** instalação o efeito continua imediato, sem deploy — que é o que o
Princípio X cobra.

---

## Prova de que a semeadura está correta

Rodar num Postgres descartável (`pgvector/pgvector:pg17`), que é o que o job `invariants` faz:

1. **install** — banco limpo, `psql -v ON_ERROR_STOP=1 -f supabase/baseline.sql`. Tem de passar.
2. **update** — reaplicar no mesmo banco, sem a flag. Tem de passar.
3. **update com edição local** — inserir um `catalog_materials` com `origin='local'` e alterar um
   `origin='seed'`, reaplicar, e provar: zero materiais perdidos, zero edições sobrescritas, zero
   duplicatas visíveis ao usuário.
4. **update duas vezes** — o estado depois de duas reaplicações é idêntico ao de uma.

Os passos 3 e 4 são o teste que falta hoje: o `test:db` atual prova idempotência, e idempotência
sozinha não prova não-destrutividade.
