/**
 * A costura do gateway, cobrada NO BANCO que o clone recebe (T020/T021 da spec 001).
 *
 * Este arquivo lê o Postgres descartável que nasce de `supabase/baseline.sql`
 * (via `scripts/test-db.sh`), nunca o banco de dev — e a escolha É o teste. A
 * migration é o caminho de quem já tem banco; o baseline é o destino de quem
 * clona. Garantia que existe só na migration não chega ao self-hoster.
 *
 * As duas promessas cobradas aqui são as que sustentam a fatia 1 inteira:
 *
 *  1. **Idempotência.** Reentregar o mesmo evento não produz segunda mensagem.
 *     Sem isso, a coexistência dos dois caminhos durante a virada (a chave
 *     `ingest_path`) duplicaria a conversa do cliente, e a retentativa do
 *     gateway viraria spam no inbox.
 *
 *  2. **Posse do nome.** O nome vindo do canal nunca sobrescreve o que um humano
 *     escreveu. A regra existe hoje dentro do `coalesce` de
 *     `fn_upsert_wa_contact` e **não tinha teste nenhum** — a análise do gateway
 *     apontou o risco como "estruturalmente possível", e a medição mostrou que a
 *     RPC já protegia. O que faltava era a vigia: sem ela, um `insert` próprio
 *     num ingest futuro reintroduz o defeito em silêncio, e o sintoma é a
 *     qualificação do atendente sumindo sozinha.
 *
 * As asserções são de COMPORTAMENTO. Conferir que "existe uma constraint chamada
 * X" prova que alguém escreveu o nome; o produto precisa que a linha errada seja
 * RECUSADA e que a certa sobreviva.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

function novaOrg(slug: string): string {
  sql(`
    insert into public.organizations (slug, legal_name, display_name)
    values ('${slug}', 'inv 0116', 'inv 0116');
  `);
  return sql(`select id from public.organizations where slug = '${slug}'`).trim();
}

function novaSessaoDeGateway(org: string, sufixo: string): string {
  sql(`
    insert into public.channel_sessions
      (organization_id, webhook_secret_encrypted, provider, ingest_path,
       gateway_connection_id, webhook_path_token, waha_session_name)
    values
      ('${org}', '\\x00'::bytea, 'whatsapp_uazapi', 'gateway',
       'conn_${sufixo}', 'tok_${sufixo}', null);
  `);
  return sql(
    `select id from public.channel_sessions where gateway_connection_id = 'conn_${sufixo}'`,
  ).trim();
}

function erroDe(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return String(err.stderr ?? "") + String(err.message ?? "");
  }
  throw new Error("o comando passou — a trava não existe neste banco");
}

describe("0116 · a costura do gateway chega ao clone", () => {
  it("uma conexão de canal do gateway pode existir sem sessão do caminho legado", () => {
    const org = novaOrg(`inv116-sessao-${Date.now()}`);
    const id = novaSessaoDeGateway(org, `a${Date.now()}`);
    // Se o `provider_ref_check` não tivesse ganhado o ramo do gateway, este
    // INSERT falharia — e o erro apontaria para a coluna errada.
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("conexão do gateway SEM identificador do lado de lá é recusada", () => {
    const org = novaOrg(`inv116-orfa-${Date.now()}`);
    const msg = erroDe(() =>
      sql(`
        insert into public.channel_sessions
          (organization_id, webhook_secret_encrypted, provider, ingest_path,
           gateway_connection_id, webhook_path_token, waha_session_name)
        values ('${org}', '\\x00'::bytea, 'instagram', 'gateway', null,
                'tok_orfa_${Date.now()}', null);
      `),
    );
    // Linha órfã não daria para rotear de volta — e o erro tem de dizer QUAL
    // trava barrou, senão "rejeitou" não distingue o CHECK certo de um NOT NULL.
    expect(msg).toMatch(/channel_sessions_provider_ref_check/);
  });

  it("ingest_path fora do vocabulário é recusado", () => {
    const org = novaOrg(`inv116-path-${Date.now()}`);
    const msg = erroDe(() =>
      sql(`
        insert into public.channel_sessions
          (organization_id, webhook_secret_encrypted, provider, ingest_path,
           webhook_path_token, waha_session_name)
        values ('${org}', '\\x00'::bytea, 'waha', 'talvez',
                'tok_path_${Date.now()}', 'sess_x');
      `),
    );
    expect(msg).toMatch(/channel_sessions_ingest_path_check/);
  });

  it("o default de ingest_path preserva a instalação existente", () => {
    const org = novaOrg(`inv116-default-${Date.now()}`);
    const tok = `tok_def_${Date.now()}`;
    sql(`
      insert into public.channel_sessions
        (organization_id, webhook_secret_encrypted, webhook_path_token, waha_session_name)
      values ('${org}', '\\x00'::bytea, '${tok}', 'sess_legado');
    `);
    // Conexão criada sem dizer nada continua no caminho legado. É o que impede
    // uma atualização de virar a chave de todo mundo de uma vez.
    expect(
      sql(`select ingest_path from public.channel_sessions where webhook_path_token = '${tok}'`),
    ).toBe("legacy");
  });

  it("o mesmo external_id não entra duas vezes na MESMA organização", () => {
    const marca = Date.now();
    const org = novaOrg(`inv116-idem-${marca}`);
    const sessao = novaSessaoDeGateway(org, `b${marca}`);

    // INSERT e SELECT em chamadas SEPARADAS: o psql imprime a etiqueta
    // `INSERT 0 1` no stdout mesmo com `-tA`, e ela colaria no uuid.
    const fone = `+5511900${String(marca).slice(-6)}`;
    sql(`insert into public.contacts (organization_id, phone_number, source)
         values ('${org}', '${fone}', 'whatsapp');`);
    const contato = sql(
      `select id from public.contacts where organization_id = '${org}' limit 1`,
    ).trim();

    sql(`insert into public.conversations (organization_id, contact_id, channel_session_id)
         values ('${org}', '${contato}', '${sessao}');`);
    const conversa = sql(
      `select id from public.conversations where organization_id = '${org}' limit 1`,
    ).trim();

    const inserir = (corpo: string) => `
      insert into public.messages
        (organization_id, conversation_id, channel_session_id, contact_id,
         external_id, type, direction, status, body)
      values ('${org}', '${conversa}', '${sessao}', '${contato}',
              'EVT_REENTREGA_${marca}', 'text', 'inbound', 'received', '${corpo}');
    `;

    sql(inserir("primeira"));
    const msg = erroDe(() => sql(inserir("reentrega")));

    // É esta trava que torna seguro (a) o gateway reentregar e (b) os dois
    // caminhos coexistirem durante a virada por conexão.
    expect(msg).toMatch(/unique|duplicate key/i);
    expect(
      sql(`select count(*) from public.messages
            where organization_id = '${org}' and external_id = 'EVT_REENTREGA_${marca}'`),
    ).toBe("1");
  });

  it("organizações diferentes PODEM ter o mesmo external_id", () => {
    const marca = Date.now();
    const orgA = novaOrg(`inv116-a-${marca}`);
    const orgB = novaOrg(`inv116-b-${marca}`);

    for (const [i, org] of [orgA, orgB].entries()) {
      const s = novaSessaoDeGateway(org, `c${marca}${i}`);
      sql(`insert into public.contacts (organization_id, phone_number, source)
           values ('${org}', '+5511${String(marca).slice(-7)}${i}', 'whatsapp');`);
      const c = sql(
        `select id from public.contacts where organization_id = '${org}' limit 1`,
      ).trim();
      sql(`insert into public.conversations (organization_id, contact_id, channel_session_id)
           values ('${org}', '${c}', '${s}');`);
      const cv = sql(
        `select id from public.conversations where organization_id = '${org}' limit 1`,
      ).trim();
      sql(`
        insert into public.messages
          (organization_id, conversation_id, channel_session_id, contact_id,
           external_id, type, direction, status, body)
        values ('${org}', '${cv}', '${s}', '${c}',
                'EVT_COMPARTILHADO_${marca}', 'text', 'inbound', 'received', 'oi');
      `);
    }

    // A unicidade é POR organização. Global, ela faria a mensagem de um tenant
    // impedir a de outro — vazamento ao contrário, e igualmente fatal.
    expect(
      sql(`select count(*) from public.messages
            where external_id = 'EVT_COMPARTILHADO_${marca}'`),
    ).toBe("2");
  });

  it("o nome definido por um humano NÃO é sobrescrito pelo nome vindo do canal", () => {
    const marca = Date.now();
    const org = novaOrg(`inv116-nome-${marca}`);
    const fone = `+5511911${String(marca).slice(-6)}`;

    // Primeira mensagem: o canal informa o nome do perfil.
    const id1 = sql(
      `select public.fn_upsert_wa_contact('${org}', 'phone', '${fone}', null, '${fone}@c.us', 'Maria do WhatsApp');`,
    ).trim();

    // O atendente corrige para o nome real do cliente.
    sql(`update public.contacts set display_name = 'Maria Silva (titular)' where id = '${id1}';`);

    // Chega outra mensagem, e o canal manda o nome do perfil de novo.
    const id2 = sql(
      `select public.fn_upsert_wa_contact('${org}', 'phone', '${fone}', null, '${fone}@c.us', 'Maria do WhatsApp');`,
    ).trim();

    expect(id2).toBe(id1);
    // Este é o defeito que a vigia impede: a qualificação do atendente sumindo
    // sozinha na próxima mensagem do cliente.
    expect(sql(`select display_name from public.contacts where id = '${id1}'`)).toBe(
      "Maria Silva (titular)",
    );
  });

  it("o nome do canal PREENCHE quando ninguém escreveu nada", () => {
    const marca = Date.now();
    const org = novaOrg(`inv116-nome2-${marca}`);
    const fone = `+5511922${String(marca).slice(-6)}`;

    const id = sql(
      `select public.fn_upsert_wa_contact('${org}', 'phone', '${fone}', null, '${fone}@c.us', 'João do Perfil');`,
    ).trim();

    // A regra não é "ignorar o canal" — é "não sobrescrever humano". Contato sem
    // nome nenhum é pior para o atendente que um nome de perfil.
    expect(sql(`select display_name from public.contacts where id = '${id}'`)).toBe(
      "João do Perfil",
    );
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Tirar o ramo do gateway de `channel_sessions_provider_ref_check`
 *     → "uma conexão de canal do gateway pode existir" cai.
 *  2. Trocar `coalesce(contacts.display_name, excluded.display_name)` por
 *     `excluded.display_name` em `fn_upsert_wa_contact`
 *     → "o nome definido por um humano NÃO é sobrescrito" cai.
 *  3. Tornar a unicidade de `messages.external_id` global (sem organization_id)
 *     → "organizações diferentes PODEM ter o mesmo external_id" cai.
 */
