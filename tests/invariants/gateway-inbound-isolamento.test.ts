/**
 * Duas organizações recebendo ao mesmo tempo pela porta nova, e nenhuma enxerga a
 * outra (T041, US3).
 *
 * ## O buraco que este arquivo existe para não deixar reabrir
 *
 * A versão fail-open da rota antiga permitia que quem soubesse a URL injetasse
 * mensagem em CRM alheio, escolhendo o remetente e fazendo o canal da vítima
 * responder para um número arbitrário. A rota do gateway fecha a porta pela
 * autenticidade — mas autenticidade e isolamento são duas coisas: uma entrega
 * perfeitamente assinada de UMA organização não pode, em hipótese alguma,
 * aparecer para outra.
 *
 * ## Por que o caso de CONTROLE é parte do teste, e não zelo
 *
 * "O usuário da org A vê zero linhas da org B" passa trivialmente quando não há
 * linha nenhuma — um erro de setup, um `insert` que falhou em silêncio, um filtro
 * escrito errado. O teste ficaria verde para sempre provando nada. Por isso cada
 * caso primeiro afirma, pelo service role, que as linhas da org B EXISTEM; só
 * então cobra o zero pela sessão do usuário de A.
 *
 * ## Por que a leitura é feita com claims de JWT, e não com o service role
 *
 * O service role **bypassa RLS**. Ler por ele mediria o que o servidor consegue
 * ver, não o que o usuário vê — e é a visão do usuário que o produto promete. As
 * consultas aqui rodam com `request.jwt.claims`, o mesmo caminho de `auth.uid()`
 * que as policies usam em produção.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { countAs, sql } from "./gov-helpers";

const ORG_A = "eeee0001-0000-4000-8000-000000000001";
const ORG_B = "eeee0002-0000-4000-8000-000000000002";
const USER_A = "eeee1001-0000-4000-8000-000000000001";
const USER_B = "eeee1002-0000-4000-8000-000000000002";
const SESSAO_A = "eeee2001-0000-4000-8000-000000000001";
const SESSAO_B = "eeee2002-0000-4000-8000-000000000002";
const CONTATO_A = "eeee3001-0000-4000-8000-000000000001";
const CONTATO_B = "eeee3002-0000-4000-8000-000000000002";
const CONV_A = "eeee4001-0000-4000-8000-000000000001";
const CONV_B = "eeee4002-0000-4000-8000-000000000002";

/**
 * Duas organizações completas, cada uma com sua conexão de gateway, contato,
 * conversa e mensagem — como se as duas tivessem recebido ao mesmo tempo.
 *
 * O `external_id` é o MESMO nos dois lados de propósito: a unicidade é por
 * organização, e provar que as duas linhas coexistem é o contraponto necessário
 * do isolamento. Global, ela faria a mensagem de um tenant impedir a de outro —
 * vazamento ao contrário, e igualmente fatal.
 */
function semear(): void {
  // Cada insert em bloco PRÓPRIO com `exception when unique_violation`, e não
  // `on conflict`: várias destas tabelas têm unique DEFERRABLE, e o Postgres
  // recusa qualquer arbiter na presença de um — o erro fala de "deferrable
  // unique constraints as arbiters" e não tem nada a ver com o que se semeia.
  // Blocos separados porque um `exception` engole o resto da transação: um só
  // bloco faria a primeira colisão abortar todo o seed em silêncio.
  const bloco = (dml: string) => `do $seed$ begin ${dml} exception when others then null; end $seed$;`;

  sql(bloco(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@invariant.test'), ('${USER_B}', 'b@invariant.test');
  `));

  sql(bloco(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-t041-a', 'Org A do T041', 'Org A do T041'),
      ('${ORG_B}', 'inv-t041-b', 'Org B do T041', 'Org B do T041');
  `));

  sql(bloco(`
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_A}', '${ORG_A}', 'admin', now()),
      ('${USER_B}', '${ORG_B}', 'admin', now());
  `));

  sql(bloco(`
    insert into public.channel_sessions
      (id, organization_id, webhook_secret_encrypted, provider, ingest_path,
       gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO_A}', '${ORG_A}', '\\x00'::bytea, 'whatsapp_uazapi', 'gateway', 'conn_t041_a', 'tok_t041_a'),
      ('${SESSAO_B}', '${ORG_B}', '\\x00'::bytea, 'whatsapp_uazapi', 'gateway', 'conn_t041_b', 'tok_t041_b');
  `));

  sql(bloco(`
    insert into public.contacts (id, organization_id, phone_number, source, display_name) values
      ('${CONTATO_A}', '${ORG_A}', '+5511900410001', 'whatsapp', 'Cliente da A'),
      ('${CONTATO_B}', '${ORG_B}', '+5511900410002', 'whatsapp', 'Cliente da B');
  `));

  sql(bloco(`
    insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
      ('${CONV_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}'),
      ('${CONV_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}');
  `));

  // O `external_id` é o MESMO nos dois lados de propósito: a unicidade é POR
  // organização, e as duas linhas coexistindo é o contraponto necessário do
  // isolamento. Global, ela faria a mensagem de um tenant impedir a de outro —
  // vazamento ao contrário, e igualmente fatal.
  sql(bloco(`
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       external_id, type, direction, status, body)
    values
      ('${ORG_A}', '${CONV_A}', '${SESSAO_A}', '${CONTATO_A}',
       'EVT_T041_COMPARTILHADO', 'text', 'inbound', 'received', 'mensagem da A'),
      ('${ORG_B}', '${CONV_B}', '${SESSAO_B}', '${CONTATO_B}',
       'EVT_T041_COMPARTILHADO', 'text', 'inbound', 'received', 'segredo da B');
  `));

  sql(bloco(`
    insert into public.webhook_events_log
      (organization_id, channel_session_id, provider, webhook_path_token, http_method,
       event_type, external_id, status, valid_signature, attempts)
    values
      ('${ORG_A}', '${SESSAO_A}', 'gateway', 'tok_t041_a', 'POST',
       'new_message', 'EVT_T041_COMPARTILHADO', 'processed', true, 0),
      ('${ORG_B}', '${SESSAO_B}', 'gateway', 'tok_t041_b', 'POST',
       'new_message', 'EVT_T041_COMPARTILHADO', 'processed', true, 0);
  `));
}

/** Contagem pelo service role — o que EXISTE, independente de quem olha. */
function existem(tabela: string, filtro: string): number {
  return Number(sql(`select count(*) from public.${tabela} where ${filtro}`).trim());
}

describe("isolamento entre organizações na entrada do gateway (T041)", () => {
  // Uma vez só. Repetir a semeadura a cada caso esbarraria na unicidade
  // DEFERRABLE de `messages` — que estoura no COMMIT, fora do alcance de
  // qualquer `exception` do bloco, e o erro apareceria como se fosse do teste.
  beforeAll(semear);

  it("as duas organizações realmente receberam — controle antes de qualquer zero", () => {
    // Sem este caso, todos os "vê zero" abaixo passariam com o banco vazio.
    expect(existem("messages", `organization_id = '${ORG_B}' and body = 'segredo da B'`)).toBe(1);
    expect(existem("conversations", `organization_id = '${ORG_B}'`)).toBeGreaterThan(0);
    expect(existem("contacts", `organization_id = '${ORG_B}'`)).toBeGreaterThan(0);

    // E o mesmo identificador externo coexiste nas duas: a unicidade é POR
    // organização. Global, a mensagem de um tenant impediria a de outro.
    expect(existem("messages", `external_id = 'EVT_T041_COMPARTILHADO'`)).toBe(2);
  });

  it("o usuário da org A não enxerga NENHUMA mensagem da org B", () => {
    expect(countAs(USER_A, `select count(*) from public.messages where organization_id = '${ORG_B}'`)).toBe(0);
    // E enxerga as próprias — senão "zero" seria só RLS negando tudo, o que
    // passaria neste teste e quebraria o produto.
    expect(
      countAs(USER_A, `select count(*) from public.messages where organization_id = '${ORG_A}'`),
    ).toBeGreaterThan(0);
  });

  it("nem conversas, nem contatos, nem o log de entregas da org B", () => {
    for (const tabela of ["conversations", "contacts", "channel_sessions", "webhook_events_log"]) {
      expect(
        countAs(USER_A, `select count(*) from public.${tabela} where organization_id = '${ORG_B}'`),
      ).toBe(0);
    }
  });

  it("o vazamento não acontece pelo lado de lá tampouco", () => {
    // Isolamento é simétrico. Testar uma direção só esconderia uma policy
    // escrita com o `organization_id` fixo de um dos dois.
    expect(countAs(USER_B, `select count(*) from public.messages where organization_id = '${ORG_A}'`)).toBe(0);
    expect(
      countAs(USER_B, `select count(*) from public.messages where organization_id = '${ORG_B}'`),
    ).toBeGreaterThan(0);
  });

  it("buscar pelo identificador externo compartilhado devolve só a própria linha", () => {
    // É o caminho que um vazamento real tomaria: a consulta não filtra
    // organização, e é a RLS que tem de segurar. Se ela falhar, o corretor da A
    // lê a mensagem do cliente da B — que é o pior desfecho possível aqui.
    expect(
      countAs(
        USER_A,
        `select count(*) from public.messages where external_id = 'EVT_T041_COMPARTILHADO'`,
      ),
    ).toBe(1);
    expect(
      countAs(
        USER_A,
        `select count(*) from public.messages where external_id = 'EVT_T041_COMPARTILHADO' and body = 'segredo da B'`,
      ),
    ).toBe(0);
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Trocar o `using` de `tenant_isolation_messages_all` por `true`
 *     → "não enxerga NENHUMA mensagem da org B" e a busca por external_id caem.
 *  2. Tornar `uniq` de `messages.external_id` global (sem organization_id)
 *     → o caso de controle cai já no seed (a segunda linha não entra).
 */
