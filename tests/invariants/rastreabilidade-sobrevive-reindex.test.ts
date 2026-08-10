import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { registrarGroundings } from "@/lib/agent-engine/agent/grounding-registry";
import { descreverOrigem } from "@/lib/ai/citations/types";

/**
 * A resposta já dada continua explicável depois de o acervo ser reconstruído — T102, FR-023.
 *
 * ═══ O QUE QUEBRA SE ISTO NÃO FOR VIGIADO ═══
 *
 * Reindexar apaga `ai_chunks` e recria com ids novos; recurar o catálogo publica versão
 * nova e pode remover a antiga. Uma resposta enviada semana passada aponta para linhas que
 * deixaram de existir. Há exatamente duas formas de "consertar" isso, e as duas destroem a
 * feature:
 *
 *   1. **FK com `on delete cascade`** — a reindexação apaga o histórico junto. O corretor
 *      pergunta "de onde saiu essa resposta?" e o sistema responde que nunca houve âncora.
 *   2. **FK com `restrict`** — a reindexação passa a falhar, e o acervo congela.
 *
 * Por isso `message_groundings.chunk_id` e `.material_id` **não têm FK**, e `source_ref`
 * carrega a cópia congelada. Isso não é omissão: é a decisão. Este arquivo existe para que
 * ela não seja "corrigida" por alguém que veja um id sem referência e conclua que faltou
 * constraint — a leitura óbvia, e errada.
 *
 * ═══ A METADE OPOSTA, QUE TAMBÉM É REQUISITO ═══
 *
 * `message_id` **tem** FK com `cascade`, e tem de continuar tendo: âncora órfã de mensagem
 * anonimizada seria dado sobrevivente de uma conversa que o titular pediu para apagar
 * (LGPD). Um teste que só provasse a ausência de FK passaria verde com a tabela inteira
 * solta — e trocaria um defeito de rastreabilidade por um de privacidade.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const DIM = 1536;
const Q = `[${Array.from({ length: DIM }, (_, k) => (k === 1 ? 1 : 0)).join(",")}]`;

const ORG = "5a570000-0000-4000-8000-000000000001";
const ORG_VIZINHA = "5a570000-0000-4000-8000-000000000002";
const USER = "5a571111-0000-4000-8000-000000000001";
const CONTACT = "5a572222-0000-4000-8000-000000000001";
const CONV = "5a573333-0000-4000-8000-000000000001";
const SESSION = "5a574444-0000-4000-8000-000000000001";
const MSG = "5a575555-0000-4000-8000-000000000001";
/** A mensagem que existe só para ser apagada — prova o cascade da LGPD. */
const MSG_EFEMERA = "5a575555-0000-4000-8000-000000000002";

let agente = "";
let kbV1 = "";
let kbV2 = "";
let fonteV1 = "";
let trechoV1 = "";
let materialCurado = "";
let trechoCurado = "";

interface Grounding {
  layer: "tenant" | "catalog";
  chunk_id: string | null;
  material_id: string | null;
  source_ref: Record<string, unknown>;
  similarity: number | null;
}

async function groundingsDa(messageId: string): Promise<Grounding[]> {
  const { rows } = await pool.query<Grounding>(
    `select layer, chunk_id, material_id, source_ref, similarity
       from public.message_groundings
      where message_id = $1
      order by layer`,
    [messageId],
  );
  return rows;
}

/** As FKs declaradas numa coluna, pelo catálogo do Postgres. */
async function fksDe(tabela: string, coluna: string): Promise<Array<{ tipo: string }>> {
  const { rows } = await pool.query<{ tipo: string }>(
    `select c.confdeltype as tipo
       from pg_constraint c
       join pg_class t      on t.oid = c.conrelid
       join pg_namespace ns on ns.oid = t.relnamespace
       join pg_attribute a  on a.attrelid = t.oid and a.attnum = any(c.conkey)
      where ns.nspname = 'public'
        and t.relname  = $1
        and c.contype  = 'f'
        and a.attname  = $2`,
    [tabela, coluna],
  );
  return rows;
}

beforeAll(async () => {
  for (const [org, slug] of [
    [ORG, "rastro-a"],
    [ORG_VIZINHA, "rastro-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Rastro LTDA', 'Rastro') on conflict (id) do nothing`,
      [org, slug],
    );
  }
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'rastro@exemplo.test')
     on conflict (id) do nothing`,
    [USER],
  );
  // `fn_user_org_ids()` — a helper de toda policy de tenant — lê `user_organizations` e
  // exige `revoked_at is null`. Vínculo sem `accepted_at` continua valendo; convite
  // revogado, não.
  await pool.query(
    `insert into user_organizations (organization_id, user_id, role, accepted_at)
     values ($1, $2, 'admin', now()) on conflict do nothing`,
    [ORG, USER],
  );

  agente = (
    await pool.query<{ id: string }>(
      "insert into ai_agents (organization_id, name, system_prompt) values ($1, 'agente-rastro', 'p') returning id",
      [ORG],
    )
  ).rows[0]!.id;
  kbV1 = (
    await pool.query<{ id: string }>(
      "insert into ai_knowledge_versions (organization_id, agent_id, version_number) values ($1, $2, 1) returning id",
      [ORG, agente],
    )
  ).rows[0]!.id;
  await pool.query("update ai_agents set active_kb_version_id = $1 where id = $2", [kbV1, agente]);

  fonteV1 = (
    await pool.query<{ id: string }>(
      `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, applies_to_all)
       values ($1, $2, 'policy', 'Manual de rede credenciada v1', true) returning id`,
      [ORG, agente],
    )
  ).rows[0]!.id;
  trechoV1 = (
    await pool.query<{ id: string }>(
      `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
       values ($1, $2, $3, 0, $4, md5($4), 10, $5::vector) returning id`,
      [ORG, fonteV1, kbV1, "a rede credenciada da regiao esta no portal", Q],
    )
  ).rows[0]!.id;

  materialCurado = (
    await pool.query<{ id: string }>(
      `insert into catalog_materials (catalog_scope_id, applies_to_all, slug, version, title, body)
       values (null, true, 'rastro-mat', 1, 'Regra geral curada', 'corpo') returning id`,
    )
  ).rows[0]!.id;
  trechoCurado = (
    await pool.query<{ id: string }>(
      `insert into catalog_chunks (catalog_material_id, position, content, content_hash, token_count, embedding, embedding_model)
       values ($1, 0, $2, md5($2), 10, $3::vector, 'teste') returning id`,
      [materialCurado, "o plano cobre consulta eletiva apos a carencia", Q],
    )
  ).rows[0]!.id;

  // ── a conversa e as duas mensagens ────────────────────────────────────────
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $2, 'Cliente do Rastro', '+5585999990001') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'sessao-rastro', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, $4, 'open', false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  for (const id of [MSG, MSG_EFEMERA]) {
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
                             type, direction, status, body, sent_via, sent_at)
       values ($1, $2, $3, $4, $5, 'text', 'outbound', 'delivered', 'resposta do agente', 'ai', now())
       on conflict (id) do nothing`,
      [id, ORG, CONV, SESSION, CONTACT],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from organizations where id = any($1)", [[ORG, ORG_VIZINHA]]);
  await pool.query("delete from catalog_materials where slug like 'rastro-%'");
  await pool.query("delete from auth.users where id = $1", [USER]);
  await pool.end();
});

describe("a âncora é registro, não ponteiro", () => {
  it("o caminho de produção grava as duas camadas com a cópia congelada", async () => {
    await registrarGroundings(pool, {
      organizationId: ORG,
      messageId: MSG,
      citations: [
        {
          chunk_id: trechoV1,
          score: 0.91,
          metadata: {
            layer: "tenant",
            title: "Manual de rede credenciada v1",
            scope: "Operadora X",
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        },
        {
          chunk_id: trechoCurado,
          score: 0.77,
          metadata: {
            layer: "catalog",
            material_id: materialCurado,
            title: "Regra geral curada",
            scope: null,
            updated_at: "2026-07-01T00:00:00.000Z",
          },
        },
      ],
    });

    const linhas = await groundingsDa(MSG);
    expect(linhas).toHaveLength(2);
    expect(linhas.map((l) => l.layer)).toEqual(["catalog", "tenant"]);
    expect(linhas.find((l) => l.layer === "tenant")!.chunk_id).toBe(trechoV1);
    expect(linhas.find((l) => l.layer === "catalog")!.material_id).toBe(materialCurado);
  });

  it("sobrevive à reindexação — trecho e fonte apagados, âncora intacta", async () => {
    // Reindexação de verdade: versão nova do acervo, trechos novos, e os antigos apagados
    // junto com a própria fonte. É o pior caso, e é o caso comum: material re-subido.
    kbV2 = (
      await pool.query<{ id: string }>(
        "insert into ai_knowledge_versions (organization_id, agent_id, version_number) values ($1, $2, 2) returning id",
        [ORG, agente],
      )
    ).rows[0]!.id;
    const fonteV2 = (
      await pool.query<{ id: string }>(
        `insert into ai_knowledge_sources (organization_id, agent_id, source_type, name, applies_to_all)
         values ($1, $2, 'policy', 'Manual de rede credenciada v2', true) returning id`,
        [ORG, agente],
      )
    ).rows[0]!.id;
    await pool.query(
      `insert into ai_chunks (organization_id, knowledge_source_id, kb_version_id, position, content, content_hash, token_count, embedding)
       values ($1, $2, $3, 0, $4, md5($4), 10, $5::vector)`,
      [ORG, fonteV2, kbV2, "a rede credenciada mudou e agora sai pelo aplicativo", Q],
    );
    await pool.query("update ai_agents set active_kb_version_id = $1 where id = $2", [
      kbV2,
      agente,
    ]);
    // `ai_chunks` cai por cascade da fonte — é assim que a reindexação limpa a versão velha.
    await pool.query("delete from ai_knowledge_sources where id = $1", [fonteV1]);

    // CONTROLE: o trecho REALMENTE sumiu. Sem isto o caso passaria com o acervo intacto,
    // medindo uma reindexação que não aconteceu.
    const sumiu = await pool.query("select 1 from ai_chunks where id = $1", [trechoV1]);
    expect(sumiu.rowCount).toBe(0);

    const linhas = await groundingsDa(MSG);
    expect(linhas).toHaveLength(2);
    const doTenant = linhas.find((l) => l.layer === "tenant")!;
    // O id continua ali como PISTA, apontando para nada — e isso é o desenho.
    expect(doTenant.chunk_id).toBe(trechoV1);
    expect(doTenant.source_ref.title).toBe("Manual de rede credenciada v1");
    expect(doTenant.similarity).toBeCloseTo(0.91, 2);
  });

  it("sobrevive à recuração — material do catálogo apagado, âncora intacta", async () => {
    await pool.query("delete from catalog_materials where id = $1", [materialCurado]);
    const sumiu = await pool.query("select 1 from catalog_chunks where id = $1", [trechoCurado]);
    expect(sumiu.rowCount).toBe(0);

    const doCatalogo = (await groundingsDa(MSG)).find((l) => l.layer === "catalog")!;
    expect(doCatalogo.material_id).toBe(materialCurado);
    expect(doCatalogo.source_ref.title).toBe("Regra geral curada");
  });

  it("a tela ainda explica a resposta a partir da cópia congelada (FR-022)", async () => {
    // `descreverOrigem` é a MESMA função que o `MessageBubble` usa. Um teste que lesse
    // `source_ref` na mão provaria que o jsonb guarda texto, não que o corretor consegue
    // ler a origem de uma resposta cujo material não existe mais.
    const doTenant = (await groundingsDa(MSG)).find((l) => l.layer === "tenant")!;
    const origem = descreverOrigem({ metadata: doTenant.source_ref });
    expect(origem.camada).toBe("tenant");
    expect(origem.titulo).toBe("Manual de rede credenciada v1");
    expect(origem.escopo).toBe("Operadora X");
    expect(origem.atualizadoEm).not.toBeNull();
  });

  it("`chunk_id` e `material_id` NÃO podem ganhar FK — é a decisão, não um esquecimento", async () => {
    expect(await fksDe("message_groundings", "chunk_id")).toHaveLength(0);
    expect(await fksDe("message_groundings", "material_id")).toHaveLength(0);
  });

  it("`message_id` PRECISA continuar com FK em cascade — é a LGPD", async () => {
    const fks = await fksDe("message_groundings", "message_id");
    expect(fks).toHaveLength(1);
    // `c` = ON DELETE CASCADE no catálogo do Postgres.
    expect(fks[0]!.tipo).toBe("c");
  });

  it("apagada a mensagem, a âncora vai junto — sem órfã de conversa redigida", async () => {
    await registrarGroundings(pool, {
      organizationId: ORG,
      messageId: MSG_EFEMERA,
      citations: [
        { chunk_id: trechoV1, score: 0.5, metadata: { layer: "tenant", title: "qualquer" } },
      ],
    });
    expect(await groundingsDa(MSG_EFEMERA)).toHaveLength(1);

    await pool.query("delete from messages where id = $1", [MSG_EFEMERA]);
    expect(await groundingsDa(MSG_EFEMERA)).toHaveLength(0);
    // E a da outra mensagem continua de pé — o cascade é por mensagem, não por conversa.
    expect(await groundingsDa(MSG)).toHaveLength(2);
  });

  it("a âncora é do tenant: a organização vizinha não lê nenhuma linha (RLS)", async () => {
    const client = await pool.connect();
    try {
      await client.query("set role authenticated");
      // `is_local = false` (escopo de SESSÃO), e não `true`. Com `true` o valor morre no
      // fim da transação implícita do próprio `set_config`, e a consulta seguinte já roda
      // com a GUC de volta a `''` — que `auth.uid()` tenta ler como jsonb e ergue
      // "invalid input syntax for type json". O erro parece de sintaxe e é de escopo.
      await client.query(
        `select set_config('request.jwt.claims', '{"sub":"${USER}"}', false)`,
      );
      const minhas = await client.query(
        "select count(*)::int n from message_groundings where organization_id = $1",
        [ORG],
      );
      const dela = await client.query(
        "select count(*)::int n from message_groundings where organization_id = $1",
        [ORG_VIZINHA],
      );
      // CONTROLE de um lado, isolamento do outro: sem o primeiro, RLS negando TUDO
      // passaria como isolamento perfeito.
      expect(minhas.rows[0]!.n).toBe(2);
      expect(dela.rows[0]!.n).toBe(0);
    } finally {
      // A conexão volta ao pool: deixar papel e claim pendurados contaminaria o próximo
      // teste que a pegasse, e o sintoma apareceria em outro arquivo.
      await client.query(`select set_config('request.jwt.claims', '', false)`);
      await client.query("reset role");
      client.release();
    }
  });
});
