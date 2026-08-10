/**
 * A anonimização por LGPD manda ACIMA da projeção (spec 006, T015).
 *
 * ## O risco que este arquivo fecha
 *
 * A spec 006 fez a tela passar a exibir coisas que ela não exibia: o trecho da
 * mensagem CITADA, a localização, o cartão de contato. Todas essas leituras
 * atravessam a mensagem-alvo — e a mensagem-alvo pode ter sido **anonimizada**.
 *
 * Uma citação que guardasse uma cópia do texto no momento do envio continuaria
 * mostrando o original depois da anonimização: o dado redigido reaparecendo por
 * uma porta lateral, com a auditoria dizendo que ele foi apagado. É a razão de a
 * projeção ler o alvo **no momento da leitura**, e não copiar nada.
 *
 * ## O que se mede aqui, e por que no banco
 *
 * Que `fn_lgpd_cascade_redact_contact` de fato apaga as fontes de onde a projeção
 * lê: `body` (o trecho citado) e `metadata` (o vínculo da citação, a coordenada e
 * o cartão). Um dublê responderia o que eu escrevesse; aqui roda a função de
 * verdade, no Postgres que nasce do `baseline.sql`.
 *
 * O caso de CONTROLE vem primeiro: sem provar que os dados EXISTIAM, todo "sumiu"
 * abaixo passaria com o banco vazio.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "cccc0001-0000-4000-8000-000000000001";
const CONTATO = "cccc3001-0000-4000-8000-000000000001";
const SESSAO = "cccc2001-0000-4000-8000-000000000001";
const CONV = "cccc4001-0000-4000-8000-000000000001";
const PEDIDO = "cccc5001-0000-4000-8000-000000000001";

const EXT_ALVO = "wamid.LGPD.ALVO";
const EXT_CITANTE = "wamid.LGPD.CITANTE";
const EXT_LOCAL = "wamid.LGPD.LOCAL";

function semear(): void {
  const bloco = (dml: string) =>
    `do $seed$ begin ${dml} exception when others then null; end $seed$;`;

  sql(
    bloco(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-lgpd-proj', 'Org da projecao LGPD', 'Org da projecao LGPD');
  `),
  );
  sql(
    bloco(`
    insert into public.channel_sessions
      (id, organization_id, webhook_secret_encrypted, provider, ingest_path,
       gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO}', '${ORG}', '\\x00'::bytea, 'whatsapp_uazapi', 'gateway', 'conn_lgpd', 'tok_lgpd');
  `),
  );
  sql(
    bloco(`
    insert into public.contacts (id, organization_id, phone_number, source, display_name) values
      ('${CONTATO}', '${ORG}', '+5511900430001', 'whatsapp', 'Cliente a anonimizar');
  `),
  );
  sql(
    bloco(`
    insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
      ('${CONV}', '${ORG}', '${CONTATO}', '${SESSAO}');
  `),
  );
  sql(
    bloco(`
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       external_id, type, direction, status, body, metadata)
    values
      -- o ALVO: é dele que a citação tira o trecho
      ('${ORG}', '${CONV}', '${SESSAO}', '${CONTATO}',
       '${EXT_ALVO}', 'text', 'inbound', 'received',
       'meu CPF é 000.000.000-00', '{}'::jsonb),
      -- quem CITA o alvo
      ('${ORG}', '${CONV}', '${SESSAO}', '${CONTATO}',
       '${EXT_CITANTE}', 'text', 'outbound', 'sent',
       'recebido', jsonb_build_object('reply_to_external_id', '${EXT_ALVO}')),
      -- uma localização, cuja carga vive em metadata
      ('${ORG}', '${CONV}', '${SESSAO}', '${CONTATO}',
       '${EXT_LOCAL}', 'location', 'inbound', 'received', null,
       jsonb_build_object('location', jsonb_build_object('lat', -23.5, 'lng', -46.6, 'nome', 'Casa do cliente')));
  `),
  );
  sql(
    bloco(`
    insert into public.lgpd_requests
      (id, organization_id, contact_id, request_type, source, status, due_at)
    values
      ('${PEDIDO}', '${ORG}', '${CONTATO}', 'redact', 'manual', 'received', now() + interval '15 days');
  `),
  );
}

function umaLinha(filtro: string, coluna: string): string {
  return sql(
    `select coalesce(${coluna}::text, '<null>') from public.messages where ${filtro} limit 1`,
  ).trim();
}

describe("anonimização LGPD × projeção de eventos (spec 006)", () => {
  beforeAll(semear);

  it("controle: antes da anonimização, o alvo tem texto e o vínculo da citação existe", () => {
    // Sem este caso, todos os "sumiu" abaixo passariam com o banco vazio.
    expect(umaLinha(`external_id = '${EXT_ALVO}'`, "body")).toContain("CPF");
    expect(
      umaLinha(`external_id = '${EXT_CITANTE}'`, "metadata->>'reply_to_external_id'"),
    ).toBe(EXT_ALVO);
    expect(umaLinha(`external_id = '${EXT_LOCAL}'`, "metadata->'location'->>'nome'")).toBe(
      "Casa do cliente",
    );
  });

  it("depois da anonimização, o trecho citado NÃO devolve o original", () => {
    sql(
      `select public.fn_lgpd_cascade_redact_contact('${ORG}'::uuid, '${CONTATO}'::uuid, '${PEDIDO}'::uuid)`,
    );

    // A projeção lê `body` do alvo NO MOMENTO DA LEITURA. Como a redação o
    // reescreve, a citação passa a mostrar o texto anonimizado — sem nenhum ramo
    // especial na projeção. Fosse uma cópia gravada no envio, o original
    // reapareceria aqui, com a auditoria afirmando que ele foi apagado.
    const corpo = umaLinha(`external_id = '${EXT_ALVO}'`, "body");
    expect(corpo).not.toContain("CPF");
    expect(corpo).toContain("anonimizada");
  });

  it("o VÍNCULO da citação também some — metadata é zerado", () => {
    // Consequência de `metadata = '{}'` na cascata: sem o vínculo, a projeção não
    // encontra alvo e a citação nem chega a ser montada. É mais forte que
    // anonimizar o texto: não sobra nem o ponteiro.
    expect(umaLinha(`external_id = '${EXT_CITANTE}'`, "metadata->>'reply_to_external_id'")).toBe(
      "<null>",
    );
  });

  it("a carga de localização some junto — coordenada é dado pessoal", () => {
    expect(umaLinha(`external_id = '${EXT_LOCAL}'`, "metadata->'location'->>'nome'")).toBe(
      "<null>",
    );
  });

  it("a linha continua existindo — anonimizar não é apagar histórico", () => {
    const n = Number(
      sql(`select count(*) from public.messages where conversation_id = '${CONV}'`).trim(),
    );
    expect(n).toBe(3);
  });
});
