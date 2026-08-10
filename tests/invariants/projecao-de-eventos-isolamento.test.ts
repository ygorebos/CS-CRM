/**
 * A projeção de eventos não atravessa a fronteira do tenant (spec 006, T011).
 *
 * ## O risco específico desta feature
 *
 * A projeção resolve o alvo de uma citação, de uma reação e de um apagamento
 * **pelo `external_id`** — o identificador que o CANAL escolheu. Esse
 * identificador é único **por organização** (`messages_org_external_id_unique`),
 * não globalmente: duas organizações podem legitimamente ter o mesmo, e o
 * histórico da instância já tem casos assim.
 *
 * Uma consulta de projeção que esquecesse `organization_id` acharia as duas — e o
 * desfecho seria a reação de um cliente aparecendo na conversa de outro cliente,
 * de outra empresa. Não é vazamento hipotético: é o dado do concorrente na tela
 * do corretor.
 *
 * ## Por que este teste vive em `tests/invariants/`
 *
 * Porque a pergunta é sobre o BANCO: o índice existe? A unicidade é por
 * organização mesmo? Um dublê responderia o que eu escrevesse (doutrina de
 * medição, regra 5). Aqui roda Postgres de verdade, nascido do `baseline.sql`.
 *
 * ## O caso de controle não é zelo
 *
 * "A org A não vê a linha da org B" passa trivialmente com o banco vazio. Cada
 * caso abaixo primeiro prova que a linha da B EXISTE.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { indexExists, sql } from "./gov-helpers";

const ORG_A = "aaaa0001-0000-4000-8000-000000000001";
const ORG_B = "aaaa0002-0000-4000-8000-000000000002";
const USER_A = "aaaa1001-0000-4000-8000-000000000001";
const SESSAO_A = "aaaa2001-0000-4000-8000-000000000001";
const SESSAO_B = "aaaa2002-0000-4000-8000-000000000002";
const CONTATO_A = "aaaa3001-0000-4000-8000-000000000001";
const CONTATO_B = "aaaa3002-0000-4000-8000-000000000002";
const CONV_A = "aaaa4001-0000-4000-8000-000000000001";
const CONV_B = "aaaa4002-0000-4000-8000-000000000002";

/** O `external_id` COMPARTILHADO — é a colisão que o teste precisa provocar. */
const ALVO = "wamid.PROJECAO_COMPARTILHADO";

function semear(): void {
  const bloco = (dml: string) =>
    `do $seed$ begin ${dml} exception when others then null; end $seed$;`;

  sql(bloco(`insert into auth.users (id, email) values ('${USER_A}', 'proj-a@invariant.test');`));

  sql(
    bloco(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-proj-a', 'Org A da projecao', 'Org A da projecao'),
      ('${ORG_B}', 'inv-proj-b', 'Org B da projecao', 'Org B da projecao');
  `),
  );

  sql(
    bloco(`
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'admin', now());
  `),
  );

  sql(
    bloco(`
    insert into public.channel_sessions
      (id, organization_id, webhook_secret_encrypted, provider, ingest_path,
       gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO_A}', '${ORG_A}', '\\x00'::bytea, 'whatsapp_uazapi', 'gateway', 'conn_proj_a', 'tok_proj_a'),
      ('${SESSAO_B}', '${ORG_B}', '\\x00'::bytea, 'whatsapp_uazapi', 'gateway', 'conn_proj_b', 'tok_proj_b');
  `),
  );

  sql(
    bloco(`
    insert into public.contacts (id, organization_id, phone_number, source, display_name) values
      ('${CONTATO_A}', '${ORG_A}', '+5511900420001', 'whatsapp', 'Cliente da A'),
      ('${CONTATO_B}', '${ORG_B}', '+5511900420002', 'whatsapp', 'Cliente da B');
  `),
  );

  sql(
    bloco(`
    insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
      ('${CONV_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}'),
      ('${CONV_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}');
  `),
  );

  // As duas organizações têm uma mensagem com o MESMO external_id.
  sql(
    bloco(`
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       external_id, type, direction, status, body)
    values
      ('${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}',
       '${ALVO}', 'text', 'inbound', 'received', 'proposta da A'),
      ('${ORG_B}', '${CONV_B}', '${SESSAO_B}', '${CONTATO_B}',
       '${ALVO}', 'text', 'inbound', 'received', 'proposta da B');
  `),
  );

  // E cada uma tem uma REAÇÃO apontando para o mesmo identificador.
  sql(
    bloco(`
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       external_id, type, direction, status, body, metadata)
    values
      ('${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}',
       'wamid.REACAO_A', 'reaction', 'inbound', 'received', '👍',
       jsonb_build_object('reply_to_external_id', '${ALVO}')),
      ('${ORG_B}', '${CONV_B}', '${SESSAO_B}', '${CONTATO_B}',
       'wamid.REACAO_B', 'reaction', 'inbound', 'received', '😡',
       jsonb_build_object('reply_to_external_id', '${ALVO}'));
  `),
  );
}

function contar(filtro: string): number {
  return Number(sql(`select count(*) from public.messages where ${filtro}`).trim());
}

describe("projeção de eventos × isolamento de tenant (spec 006)", () => {
  beforeAll(semear);

  it("controle: as duas organizações têm o MESMO external_id e reações distintas", () => {
    // Sem este caso, todos os zeros abaixo passariam com o banco vazio.
    expect(contar(`external_id = '${ALVO}'`)).toBe(2);
    expect(contar(`type = 'reaction' and body = '😡' and organization_id = '${ORG_B}'`)).toBe(1);
  });

  it("a consulta de mensagens citadas, FILTRADA pela organização, acha só a sua", () => {
    // É a consulta 1 da projeção: `external_id in (...)` + `organization_id`.
    expect(contar(`organization_id = '${ORG_A}' and external_id = '${ALVO}'`)).toBe(1);
    expect(
      contar(`organization_id = '${ORG_A}' and external_id = '${ALVO}' and body = 'proposta da B'`),
    ).toBe(0);
  });

  it("a consulta de eventos, FILTRADA pela organização, não traz a reação da outra", () => {
    // É a consulta 2 da projeção: `metadata->>'reply_to_external_id' in (...)`.
    const daA = contar(
      `organization_id = '${ORG_A}' and metadata->>'reply_to_external_id' = '${ALVO}'`,
    );
    expect(daA).toBe(1);
    expect(
      contar(
        `organization_id = '${ORG_A}' and metadata->>'reply_to_external_id' = '${ALVO}' and body = '😡'`,
      ),
    ).toBe(0);
  });

  it("SEM o filtro de organização a consulta acharia as duas — é o que o filtro impede", () => {
    // O contraponto que prova que o risco é real, e não teórico: a mesma consulta
    // sem `organization_id` devolve a reação do cliente da outra empresa.
    expect(contar(`metadata->>'reply_to_external_id' = '${ALVO}'`)).toBe(2);
  });

  it("o índice da projeção existe — sem ele, cada página vira varredura", () => {
    // Migration 0132. Não é otimização: sem o índice o defeito só aparece na
    // conversa grande de um cliente real, nunca no teste pequeno.
    expect(indexExists("idx_messages_reply_to_external_id")).toBe(true);
  });

  it("o índice é PARCIAL — não pesa no INSERT do caminho mais quente", () => {
    const def = sql(
      `select indexdef from pg_indexes where indexname = 'idx_messages_reply_to_external_id'`,
    );
    expect(def).toContain("WHERE");
    expect(def).toContain("reply_to_external_id");
  });

  it("o índice lidera por organization_id — o filtro de tenant precisa ser seek", () => {
    const def = sql(
      `select indexdef from pg_indexes where indexname = 'idx_messages_reply_to_external_id'`,
    );
    // A ordem das colunas é o que decide se a organização é seek ou recheck. Com
    // ela atrás, a Lei Zero passaria a depender só do WHERE.
    expect(def).toMatch(/\(organization_id,/);
  });
});
