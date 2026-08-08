# Contrato — rotas HTTP

Todas sob `/api/v1/`, JSON snake_case, UUID v4, ISO-8601 UTC, respostas por `ok()`/`fail()` de
`lib/api/wrappers.ts`, Zod em todo input externo, `X-Request-Id` em toda resposta (Princípio VI).
Mutação bem-sucedida emite `api_audit_log`.

Códigos de erro novos vão para `lib/api/errors.ts` — nunca string literal na rota.

**A regra de nome que estas rotas seguem** (research D11, FR-033/FR-041): **schema e contrato de API
são neutros de nicho** — `knowledge-scopes`, `scope_id`, `official_code`. **Tela e rótulo carregam o
vocabulário** — a página é `/app/ai/conhecimento/operadoras` e o usuário lê "Operadora". A linha é
onde ela dói menos: mudar um rótulo é configuração; mudar um contrato publicado é quebra.

---

## Superfície do tenant — `/api/v1/knowledge-scopes`

Papel mínimo: `manager` para escrita, `viewer` para leitura (FR-032, A-07). `organization_id`
resolvido do cookie/JWT, **nunca do body** (Princípio I).

### `GET /api/v1/knowledge-scopes`

Lista as operadoras que aquele tenant enxerga — espelhos do catálogo e as próprias, juntas.

```jsonc
{
  "data": [
    {
      "id": "uuid",
      "display_name": "…",
      "official_code": "…|null",
      "origin": "catalogo|proprio",     // FR-039: a camada é visível desde a lista
      "is_active": true,
      "materials_count": 3,
      "own_materials_count": 1          // quantos são do corretor — o que ele pode corrigir
    }
  ],
  "meta": { "cursor": "…", "has_more": false }
}
```

### `POST /api/v1/knowledge-scopes`

Cria operadora própria do tenant (FR-002). Aceita `Idempotency-Key` (Princípio V).

Body: `{ "display_name": "…", "official_code": "…|null" }`

`201` com a operadora criada. `409 escopo_ja_existe` quando o nome colide com uma que aquele
tenant já enxerga — inclusive espelho do catálogo, para o corretor não criar uma duplicata do que
já veio pronto.

### `PATCH /api/v1/knowledge-scopes/{id}`

Renomear (`display_name`) e ligar/desligar (`is_active`).

Desligar um **espelho do catálogo** é a trava 4: torna o material daquela operadora inerte para
este tenant e não afeta nenhum outro (FR-008). `403 escopo_do_catalogo_nao_editavel` ao tentar
mudar qualquer outro campo de um espelho.

### `POST /api/v1/knowledge-scopes/{id}/materials`

Carrega material próprio (FR-004, FR-007). `multipart/form-data` para arquivo, JSON para texto
colado.

**`{id}` é o UUID do escopo OU a palavra reservada `todas`.** Escrito ao construir a rota, porque
o contrato não dizia como se declara "vale para todas as operadoras" nesta superfície — e o
`data-model.md` recusa, com razão, um escopo fictício "todos" como LINHA em `knowledge_scopes`
(ele apareceria na lista do corretor e no filtro do contato como se fosse uma operadora).

A palavra no segmento da URL resolve sem criar linha nenhuma. E resolve um segundo problema, que
é o ponto de FR-001: **a declaração de escopo mora no PATH, nunca no corpo**. Um corpo sem
`scope_id` e sem `applies_to_all` é indistinguível de um corpo em que a tela esqueceu de mandá-los,
e o CHECK do banco devolveria um erro que ninguém entende. No path, a ausência é impossível: ou há
um segmento, ou não há rota. Qualquer outro valor — incluindo o `undefined` que uma tela monta sem
seleção — é `400 material_sem_escopo` com frase acionável.

O corpo é validado como `strictObject` **sem** `scope_id`, `applies_to_all` nem `organization_id`:
mandá-los é `422`. Declaração em dois lugares é declaração que um dia discorda de si mesma.

Antes de aceitar, a rota **declara e valida** formato e tamanho máximo (FR-007). Recusa com
`422 material_sem_texto_extraivel`, `415 formato_nao_suportado` ou `413 material_muito_grande`,
cada uma com `message` em português dizendo o que fazer em seguida — nunca aceita para falhar
depois em silêncio.

`202` com o material em `status: "building"`. O estado final chega pela tela, não por polling do
cliente.

### `GET /api/v1/knowledge-scopes/{id}/materials`

Estado por material (FR-005): `building | ready | failed | archived`, com `chunks_count` quando
pronto e `last_index_error` em português quando falhou.

### `PATCH /api/v1/contacts/{id}` — o caminho "cadastro" do vínculo

FR-017 dá ao cadastro **precedência** sobre o que veio da conversa, e sem esta rota não haveria como
gravá-lo. Aceita `knowledge_scope_id` (ou `null` para desvincular).

Grava sempre `knowledge_scope_source = 'cadastro'`. O agente, quando pergunta na conversa e recebe
resposta utilizável, grava `'conversa'` — e **nunca sobrescreve** um vínculo de origem `cadastro`.
A precedência é verificável na coluna, não convencionada no código.

---

## Superfície de plataforma — `/api/v1/catalog`

**Só `is_platform_admin`** (FR-036, trava 1). Nenhum papel de tenant alcança, por nenhum caminho —
inclusive `admin` da organização. Toda mutação auditada com autor e data.

### `GET /api/v1/catalog/scopes` · `POST` · `PATCH /{id}`

CRUD da operadora curada. `POST` exige `slug` único — é a chave que a semeadura reconhece.

### `POST /api/v1/catalog/scopes/{id}/materials`

Cria material curado com `origin: "local"`. **Nunca** reescreve material `seed`: editar um material
existente cria uma **versão nova** (`version + 1`), e a anterior permanece (trava 6, FR-037).

### `GET /api/v1/catalog/gaps`

O que os clientes daquela instalação perguntaram e o catálogo não cobria, agrupado por operadora e
assunto (FR-028, lado plataforma).

**Restrito à própria instalação.** Não existe rota, job ou campo que envie isto para fora — é a
trava 7, e A-18 declara por quê.

---

## O que estas rotas não fazem

- **Não expõem busca vetorial ao cliente HTTP.** A recuperação é chamada pelo runtime do agente,
  por conexão de serviço. Expor a busca numa rota autenticada recriaria o problema que
  `retrieve_top_k_chunks` tem hoje: função de leitura ampla alcançável por token de tenant (research
  D2).
- **Não aceitam `organization_id` no body**, em nenhuma delas.
- **Não devolvem `embedding`.** É ruído para o cliente e peso na resposta.
