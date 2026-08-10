/**
 * A superfície de escrita do gateway: isolamento, idempotência, cadeia viva e o
 * ACK que não regride (T016, T017, T018 — FR-004 a FR-010).
 *
 * ## Por que de banco, e não unitário
 *
 * O que se cobra aqui não é a lógica: é o comportamento **com a constraint
 * DEFERRABLE real no caminho**. `messages_org_external_id_unique` é
 * `DEFERRABLE INITIALLY DEFERRED`, e isso muda o que acontece de verdade:
 *
 *   - `on conflict` é recusado pelo Postgres ("deferrable unique constraints as
 *     arbiters");
 *   - `exception when unique_violation` **não captura** sem
 *     `set constraints ... immediate`, porque o 23505 estoura no COMMIT, fora do
 *     bloco, e mata a transação inteira.
 *
 * Nenhum mock reproduz isso. Um teste unitário sobre a função passaria com a
 * linha do `set constraints` removida; este aqui não passa — e é exatamente por
 * isso que ele existe.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG_A = "aaaa0128-0000-4000-8000-000000000001";
const ORG_B = "bbbb0128-0000-4000-8000-000000000002";
const CONN_A = "gw-conn-org-a";
const CONN_B = "gw-conn-org-b";

function semear(): void {
  for (const [org, slug] of [
    [ORG_A, "inv-0128-a"],
    [ORG_B, "inv-0128-b"],
  ]) {
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
      values ('${org}', '${slug}', 'Org ${slug}', 'Org ${slug}')
      on conflict (id) do nothing;
    `);
  }
  for (const [org, conn] of [
    [ORG_A, CONN_A],
    [ORG_B, CONN_B],
  ]) {
    sql(`
      insert into public.channel_sessions
        (organization_id, waha_session_name, webhook_secret_encrypted,
         webhook_path_token, gateway_connection_id, ingest_path)
      values
        ('${org}', 'sessao-${conn}', '\\x00'::bytea, 'tok-${conn}', '${conn}', 'gateway')
      on conflict do nothing;
    `);
  }
}

type OpcoesIngestao = {
  direction?: string;
  eco?: boolean;
  status?: string;
  phone?: string;
  grupo?: boolean;
  /** `metadata.media_ref` — a referência do anexo, como o gateway a emite. */
  mediaRef?: string;
  /** Anexo já persistido: o caminho no bucket privado. */
  storagePath?: string;
};

function ingerir(conn: string, externalId: string, o: OpcoesIngestao = {}): string {
  const status = o.status ? `, p_status => '${o.status}'` : "";
  const meta = o.mediaRef
    ? `, p_metadata => jsonb_build_object('media_ref', '${o.mediaRef}')`
    : "";
  const storage = o.storagePath ? `, p_media_storage_path => '${o.storagePath}'` : "";
  return sql(`
    select coalesce(message_id::text, 'nulo') || '|' || duplicada::text || '|' || coalesce(motivo, '-')
      from public.fn_gateway_ingest_message(
        p_gateway_connection_id => '${conn}',
        p_external_id           => '${externalId}',
        p_direction             => '${o.direction ?? "inbound"}',
        p_type                  => 'text',
        p_contact_kind          => 'phone',
        p_contact_phone         => '${o.phone ?? "+5585999990000"}',
        p_body                  => 'ola',
        p_eh_grupo              => ${o.grupo ? "true" : "false"},
        p_eh_eco                => ${o.eco ? "true" : "false"}${status}${meta}${storage});
  `);
}

/**
 * Tenta ingerir e devolve o DESFECHO como linha, não como notice.
 *
 * `raise notice` sai em stderr, e o helper `sql()` captura só stdout — um teste
 * escrito com notice passa a comparar contra a string "DO" e nunca reprova de
 * verdade. Tabela temporária é o que faz o desfecho voltar pelo canal que o
 * teste realmente lê.
 */
function tentarIngerir(conn: string): string {
  return sql(`
    create temp table _desfecho (v text);
    do $$
    begin
      perform public.fn_gateway_ingest_message(
        p_gateway_connection_id => '${conn}',
        p_external_id => 'tentativa', p_direction => 'inbound',
        p_type => 'text', p_contact_kind => 'phone', p_contact_phone => '+5585900000099');
      insert into _desfecho values ('ACEITOU');
    exception
      when sqlstate 'GW001' then insert into _desfecho values ('RECUSOU_DEFINITIVO');
      when others then insert into _desfecho values ('OUTRO_ERRO:' || sqlstate);
    end $$;
    select v from _desfecho;
  `);
}

function contar(query: string): number {
  const out = sql(query);
  const m = out.match(/\b(\d+)\b/);
  return m ? Number(m[1]) : -1;
}

beforeAll(() => semear());

describe("trava nº 6 — nenhuma função da superfície faz HTTP (anti-pattern 9)", () => {
  it("nem `http`, nem `pg_net`, nem `net.http_*` no corpo", () => {
    const out = sql(`
      select coalesce(string_agg(p.proname, ', '), 'nenhuma')
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname like 'fn_gateway_%'
         and (p.prosrc ~* '\\mhttp_(get|post|put|delete|head)\\M'
              or p.prosrc ~* '\\mpg_net\\M'
              or p.prosrc ~* '\\mnet\\.http');
    `);
    expect(
      out,
      "Função da superfície do gateway faz HTTP. Trigger e função esperando rede dentro da\n" +
        "transação é o anti-pattern 9 e o Princípio V: efeito colateral sai por event_log,\n" +
        "consumido por worker.",
    ).toContain("nenhuma");
  });
});

describe("isolamento entre organizações — o tenant vem da CONEXÃO, nunca do corpo", () => {
  it("mensagem da conexão da org A cai na org A", () => {
    ingerir(CONN_A, "iso-a-1", { phone: "+5585900000001" });
    expect(
      contar(`select count(*) from public.messages
               where organization_id = '${ORG_A}' and external_id = 'iso-a-1';`),
    ).toBe(1);
    expect(
      contar(`select count(*) from public.messages
               where organization_id = '${ORG_B}' and external_id = 'iso-a-1';`),
    ).toBe(0);
  });

  it("o mesmo external_id em conexões de organizações diferentes gera DUAS mensagens", () => {
    // Não é duplicata: a unicidade é (organization_id, external_id). Se este teste
    // virar 1, a resolução de tenant vazou e uma org está vendo mensagem da outra.
    ingerir(CONN_A, "iso-colisao", { phone: "+5585900000002" });
    ingerir(CONN_B, "iso-colisao", { phone: "+5585900000002" });
    expect(contar(`select count(*) from public.messages where external_id = 'iso-colisao';`)).toBe(2);
    expect(
      contar(`select count(distinct organization_id) from public.messages
               where external_id = 'iso-colisao';`),
    ).toBe(2);
  });

  it("conexão desconhecida é erro DEFINITIVO (SQLSTATE GW001), não falha silenciosa", () => {
    expect(tentarIngerir("nao-existe")).toContain("RECUSOU_DEFINITIVO");
  });

  it("conexão ARQUIVADA também recusa — canal desligado não volta a receber sozinho", () => {
    sql(`
      insert into public.channel_sessions
        (organization_id, waha_session_name, webhook_secret_encrypted,
         webhook_path_token, gateway_connection_id, ingest_path, archived_at)
      values
        ('${ORG_A}', 'sessao-arquivada', '\\x00'::bytea, 'tok-arq', 'gw-conn-arquivada', 'gateway', now())
      on conflict do nothing;
    `);
    expect(tentarIngerir("gw-conn-arquivada")).toContain("RECUSOU_DEFINITIVO");
  });
});

describe("idempotência — com a constraint DEFERRABLE real no caminho", () => {
  it("a mesma external_id duas vezes devolve o MESMO id e sinaliza duplicada", () => {
    const primeira = ingerir(CONN_A, "idem-1", { phone: "+5585900000003" });
    const segunda = ingerir(CONN_A, "idem-1", { phone: "+5585900000003" });
    const idPrimeira = (primeira.split("|")[0] ?? "").trim();
    const idSegunda = (segunda.split("|")[0] ?? "").trim();
    expect(idSegunda).toBe(idPrimeira);
    expect(primeira).toContain("|false|");
    expect(segunda).toContain("|true|");
  });

  it("a redelivery não cria segunda linha em messages", () => {
    ingerir(CONN_A, "idem-2", { phone: "+5585900000004" });
    ingerir(CONN_A, "idem-2", { phone: "+5585900000004" });
    ingerir(CONN_A, "idem-2", { phone: "+5585900000004" });
    expect(
      contar(`select count(*) from public.messages
               where organization_id = '${ORG_A}' and external_id = 'idem-2';`),
    ).toBe(1);
  });

  it("a redelivery NÃO acorda o agente de novo — um dispatch por mensagem", () => {
    // O modo de falha que isto pega: o agente respondendo duas vezes à mesma
    // mensagem do cliente porque o gateway reentregou. É visível para o cliente
    // e não tem desfazer.
    ingerir(CONN_A, "idem-dispatch", { phone: "+5585900000005" });
    ingerir(CONN_A, "idem-dispatch", { phone: "+5585900000005" });
    const msgId = sql(`select id::text from public.messages
                        where organization_id = '${ORG_A}' and external_id = 'idem-dispatch' limit 1;`).trim();
    const id = (msgId.match(/[0-9a-f-]{36}/) ?? [""])[0];
    expect(
      contar(`select count(*) from public.event_log
               where event_type = 'ai_agent.dispatch_requested' and entity_id = '${id}';`),
    ).toBe(1);
  });
});

describe("cadeia viva — insert e dispatch na MESMA transação", () => {
  it("mensagem recebida emite ai_agent.dispatch_requested", () => {
    ingerir(CONN_A, "viva-1", { phone: "+5585900000006" });
    const id = (sql(`select id::text from public.messages
                      where organization_id = '${ORG_A}' and external_id = 'viva-1' limit 1;`)
      .match(/[0-9a-f-]{36}/) ?? [""])[0];
    expect(
      contar(`select count(*) from public.event_log
               where event_type = 'ai_agent.dispatch_requested' and entity_id = '${id}';`),
    ).toBe(1);
  });

  it("o ECO do próprio envio NÃO pede turno de agente", () => {
    // Pedir faria o agente responder a si mesmo — defeito visível para o cliente.
    ingerir(CONN_A, "viva-eco", { direction: "outbound", eco: true });
    const id = (sql(`select id::text from public.messages
                      where organization_id = '${ORG_A}' and external_id = 'viva-eco' limit 1;`)
      .match(/[0-9a-f-]{36}/) ?? [""])[0];
    expect(
      contar(`select count(*) from public.event_log
               where event_type = 'ai_agent.dispatch_requested' and entity_id = '${id}';`),
    ).toBe(0);
  });

  it("GRUPO é ignorado por doutrina, com motivo — não vira contato nem conversa", () => {
    // Sem esta guarda, trocar o escritor mudaria o comportamento EM SILÊNCIO:
    // `lib/gateway/ingest.ts:99-107` descarta grupo, e a função tem de descartar
    // igual. Grupo entrando criaria conversa e o agente responderia em grupo.
    const antes = contar(`select count(*) from public.messages where organization_id = '${ORG_A}';`);
    const out = ingerir(CONN_A, "grupo-1", { grupo: true, phone: "+5585900000007" });
    expect(out).toContain("grupo_nao_vinculado");
    expect(out).toContain("nulo");
    expect(contar(`select count(*) from public.messages where organization_id = '${ORG_A}';`)).toBe(antes);
  });

  it("mensagem RECEBIDA não é marcada como enviada pelo CRM", () => {
    // `sent_via='crm'` numa mensagem do cliente faria a conversa exibi-la como se
    // o sistema a tivesse mandado. Espelha `lib/gateway/ingest.ts:157`.
    ingerir(CONN_A, "sentvia-in", { phone: "+5585900000008" });
    const out = sql(`select sent_via from public.messages
                      where organization_id = '${ORG_A}' and external_id = 'sentvia-in' limit 1;`);
    expect(out).not.toContain("crm");
    expect(out).toContain("external_device");
  });

  it("o eco marca sent_via='external_device' — saiu pelo celular, não pelo CRM", () => {
    const out = sql(`select sent_via from public.messages
                      where organization_id = '${ORG_A}' and external_id = 'viva-eco' limit 1;`);
    expect(out).toContain("external_device");
  });
});

describe("ACK — a guarda de não-regressão que o caminho do WAHA não tem", () => {
  function ack(externalId: string, status: string): string {
    return sql(`
      select efeito || '|' || coalesce(motivo, '-')
        from public.fn_gateway_update_message_status(
          p_gateway_connection_id => '${CONN_A}',
          p_external_id => '${externalId}', p_status => '${status}');
    `);
  }

  it("o estado avança normalmente", () => {
    ingerir(CONN_A, "ack-1", { direction: "outbound", status: "sent" });
    expect(ack("ack-1", "delivered")).toContain("aplicado");
    expect(
      sql(`select status from public.messages
            where organization_id = '${ORG_A}' and external_id = 'ack-1';`),
    ).toContain("delivered");
  });

  it("um ACK ATRASADO não apaga o visto azul", () => {
    ingerir(CONN_A, "ack-2", { direction: "outbound", status: "sent" });
    ack("ack-2", "read");
    expect(ack("ack-2", "sent")).toContain("estado_nao_regride");
    expect(
      sql(`select status from public.messages
            where organization_id = '${ORG_A}' and external_id = 'ack-2';`),
    ).toContain("read");
  });

  it("`failed` entra mesmo depois de `read` — é informação nova", () => {
    ingerir(CONN_A, "ack-3", { direction: "outbound", status: "sent" });
    ack("ack-3", "read");
    expect(ack("ack-3", "failed")).toContain("aplicado");
    expect(
      sql(`select status from public.messages
            where organization_id = '${ORG_A}' and external_id = 'ack-3';`),
    ).toContain("failed");
  });

  it("ACK de mensagem desconhecida é ignorado, e NÃO cria mensagem fantasma", () => {
    const antes = contar(`select count(*) from public.messages where organization_id = '${ORG_A}';`);
    expect(ack("nunca-existiu", "delivered")).toContain("mensagem_desconhecida");
    expect(contar(`select count(*) from public.messages where organization_id = '${ORG_A}';`)).toBe(antes);
  });
});

/**
 * O anexo pede a própria persistência.
 *
 * MEDIDO em 2026-08-10, no gateway de dev: toda imagem recebida entrava como
 * mensagem **sem anexo**. Metade da causa era do gateway (tentava o Storage do
 * Cotador); a outra metade é esta — a função gravava a mensagem com a
 * referência em `metadata.media_ref` e não acordava ninguém. O caminho por HTTP
 * (`lib/gateway/ingest.ts`) emite `media.persist_requested` desde sempre; a
 * escrita direta, não. Quem baixa é `workers/media-persist-worker.ts`.
 *
 * O sintoma que isto evita é o pior tipo: anexo eternamente "carregando" —
 * sinal de progresso para algo que não vai acontecer.
 */
describe("anexo — a mídia que entra pela função pede a própria persistência", () => {
  const eventosDeMidia = (externalId: string): number =>
    contar(`
      select count(*)
        from public.event_log e
        join public.messages m on m.id = e.entity_id
       where e.event_type = 'media.persist_requested'
         and m.organization_id = '${ORG_A}'
         and m.external_id = '${externalId}';
    `);

  it("mensagem com media_ref emite media.persist_requested", () => {
    ingerir(CONN_A, "midia-1", { mediaRef: "media/uazapi/conn-a/3EB0AA" });
    expect(
      eventosDeMidia("midia-1"),
      "sem o evento, o worker nunca é acordado e o anexo nunca chega ao bucket",
    ).toBe(1);
  });

  it("a referência sobrevive em messages.metadata — é de lá que o worker lê", () => {
    expect(
      sql(`select metadata->>'media_ref' from public.messages
            where organization_id = '${ORG_A}' and external_id = 'midia-1';`),
    ).toContain("media/uazapi/conn-a/3EB0AA");
  });

  it("o payload carrega o id da mensagem — o worker busca por ele", () => {
    expect(
      sql(`select e.payload->>'message_id' = m.id::text
             from public.event_log e
             join public.messages m on m.id = e.entity_id
            where e.event_type = 'media.persist_requested'
              and m.organization_id = '${ORG_A}' and m.external_id = 'midia-1';`),
    ).toContain("t");
  });

  // A negativa importa tanto quanto a positiva: emitir para toda mensagem faria
  // o worker acordar em cada texto, buscar anexo que não existe e dead-letrar
  // — ruído que enterra o evento verdadeiro.
  it("mensagem SEM anexo não emite nada", () => {
    ingerir(CONN_A, "sem-midia-1");
    expect(eventosDeMidia("sem-midia-1")).toBe(0);
  });

  it("anexo que JÁ está no bucket não é pedido de novo", () => {
    ingerir(CONN_A, "midia-ja-persistida", {
      mediaRef: "media/uazapi/conn-a/3EB0BB",
      storagePath: "org/conversa/mensagem.jpg",
    });
    expect(eventosDeMidia("midia-ja-persistida")).toBe(0);
  });

  // Mesma razão do dispatch: a redelivery sai cedo, antes de qualquer emissão.
  // Sem isso, uma reentrega baixaria o arquivo de novo e sobrescreveria o que
  // já estava certo.
  it("a redelivery NÃO pede o anexo uma segunda vez", () => {
    ingerir(CONN_A, "midia-redelivery", { mediaRef: "media/uazapi/conn-a/3EB0CC" });
    ingerir(CONN_A, "midia-redelivery", { mediaRef: "media/uazapi/conn-a/3EB0CC" });
    expect(eventosDeMidia("midia-redelivery")).toBe(1);
  });
});
