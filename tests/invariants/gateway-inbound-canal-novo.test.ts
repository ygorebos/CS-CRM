/**
 * Canal novo entra sem código de ingestão novo (T056, US4).
 *
 * ## Esta é a história que paga a feature
 *
 * Antes, cada provedor trazia o seu ingest inteiro. Um canal a mais significava
 * um arquivo a mais, com o mesmo bug de identidade e de idempotência reescrito
 * de novo. A promessa da US4 é que isso acabou: o gateway aprende o canal, o CRM
 * recebe o MESMO envelope, e aqui não se escreve nada.
 *
 * Um teste que só rodasse WhatsApp não provaria isso — provaria que o caminho
 * feliz do canal já suportado funciona. Por isso os casos aqui são de
 * **Instagram**, com identificador que não é telefone, e de **tipo que o CRM não
 * conhece**.
 *
 * ## Por que o tipo desconhecido não pode ser descartado
 *
 * `messages.type` tem CHECK. Um tipo novo do provedor (enquete, evento, o que
 * vier) violaria a constraint, e a saída preguiçosa é jogar a mensagem fora.
 * Isso apaga da conversa uma coisa que o cliente mandou — e ninguém do lado de
 * cá fica sabendo. A saída certa é `system` + `metadata.original_type`: a
 * mensagem entra, o atendente vê que houve algo, e o valor original fica
 * gravado para quando o CRM aprender o tipo.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "./gov-helpers";
import { adminPorSql, rpcReal } from "./supabase-por-sql";

const ORG = "dddd0056-0000-4000-8000-000000000001";
const SESSAO_IG = "dddd1056-0000-4000-8000-000000000001";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseEnvelope } from "@/lib/gateway/envelope";
import { ingerirEnvelope } from "@/lib/gateway/ingest";

/**
 * As RPCs de contato e conversa são chamadas DE VERDADE: são elas que carregam
 * a regra de posse de nome e a unificação de conversa. Dublá-las aqui esconderia
 * exatamente a parte que um canal novo estressa — identificador que não é
 * telefone.
 */
function admin(): SupabaseClient {
  return adminPorSql((nome, params) => {
    if (nome === "fn_upsert_wa_contact" || nome === "fn_upsert_wa_conversation") {
      return rpcReal(nome, params);
    }
    return { data: null, error: null };
  }) as unknown as SupabaseClient;
}

const SESSAO_REF = { id: SESSAO_IG, organization_id: ORG };

function semear(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'inv-t056', 'Org do T056', 'Org do T056')
    on conflict (id) do nothing;
  `);
  // A conexão nasce com `provider = 'instagram'`: é o vocabulário que a 0116
  // acrescentou espelhando o `platform` do envelope. Sem ele, o canal novo
  // entraria como se fosse WhatsApp e a tela mentiria sobre a origem.
  sql(`
    insert into public.channel_sessions
      (id, organization_id, waha_session_name, webhook_secret_encrypted,
       provider, ingest_path, gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO_IG}', '${ORG}', 'sessao-t056-ig', '\\x00'::bytea,
       'instagram', 'gateway', 'conn_t056_ig', 'tok_t056_ig')
    on conflict (id) do nothing;
  `);
}

let seq = 0;
function envelopeDeInstagram(over: Record<string, unknown> = {}) {
  seq += 1;
  const base = {
    envelope_version: 1,
    event_id: `01H0000000000000000000T056${seq}`,
    event_kind: "new_message",
    occurred_at: "2026-08-08T12:00:00Z",
    platform: "instagram",
    message: {
      external_id: `EVT_T056_${seq}`,
      direction: "inbound",
      type: "text",
      body: "oi, vi o anúncio",
    },
    // IGSID: identificador interno do canal, não telefone. É o caso que o
    // caminho legado nunca precisou tratar.
    participant: { external_id: "17841400000000001", display_name: "Maria do Insta" },
  };
  const parse = parseEnvelope({ ...base, ...over });
  if (!parse.ok) throw new Error(`envelope inválido: ${parse.motivo}`);
  return parse.envelope;
}

function linhaDaMensagem(externalId: string): Record<string, string> | null {
  const out = sql(`
    select coalesce(json_agg(t), '[]') from (
      select m.type, m.direction, m.body, m.metadata->>'platform' as platform,
             m.metadata->>'original_type' as original_type,
             cs.provider, c.channel
        from public.messages m
        join public.channel_sessions cs on cs.id = m.channel_session_id
        join public.conversations c on c.id = m.conversation_id
       where m.organization_id = '${ORG}' and m.external_id = '${externalId}'
       limit 1
    ) t;
  `);
  const linhas = JSON.parse(out || "[]") as Array<Record<string, string>>;
  return linhas[0] ?? null;
}

describe("canal novo pelo gateway (T056)", () => {
  beforeAll(() => {
    semear();
  });

  it("envelope de Instagram entra e a origem fica identificável", async () => {
    const env = envelopeDeInstagram();
    const externalId = env.message!.externalId;

    const r = await ingerirEnvelope(admin(), SESSAO_REF, env, "req");
    expect(r.ok).toBe(true);
    expect((r as { efeito: string }).efeito).toBe("ingerida");

    const linha = linhaDaMensagem(externalId);
    expect(linha).not.toBeNull();
    expect(linha!.body).toBe("oi, vi o anúncio");
    // A origem é identificável por DOIS lados independentes: a conexão sabe o
    // que ela é, e a mensagem carrega a plataforma do evento. Um só bastaria
    // até o dia em que uma conexão for reaproveitada.
    expect(linha!.provider).toBe("instagram");
    expect(linha!.platform).toBe("instagram");
    // `conversations.channel` continua 'whatsapp' porque o CHECK do banco só
    // aceita esse valor — dívida declarada, e é por isso que a tela lê o
    // `provider` da conexão, não esta coluna. Vigiado aqui para a dívida não
    // virar surpresa quando alguém for mostrar o canal na conversa.
    expect(linha!.channel).toBe("whatsapp");
  });

  it("participante que NÃO é telefone vira contato sem inventar número", async () => {
    const env = envelopeDeInstagram();
    await ingerirEnvelope(admin(), SESSAO_REF, env, "req");

    const contato = sql(`
      select coalesce(json_agg(t), '[]') from (
        select phone_number, wa_identity, display_name
          from public.contacts
         where organization_id = '${ORG}' and wa_identity = 'lid:17841400000000001'
         limit 1
      ) t;
    `);
    const linhas = JSON.parse(contato || "[]") as Array<Record<string, string | null>>;
    expect(linhas.length).toBe(1);
    // Gravar o IGSID em `phone_number` violaria o formato E.164 do CHECK — e,
    // antes disso, criaria um "telefone" para o qual ninguém consegue ligar.
    expect(linhas[0]!.phone_number).toBeNull();
    expect(linhas[0]!.display_name).toBe("Maria do Insta");
  });

  it("tipo desconhecido é PRESERVADO como system, nunca descartado", async () => {
    seq += 1;
    const externalId = `EVT_T056_TIPO_${seq}`;
    const env = envelopeDeInstagram({
      message: {
        external_id: externalId,
        direction: "inbound",
        type: "poll", // o CRM não conhece enquete
        body: "Qual plano você prefere?",
      },
    });

    const r = await ingerirEnvelope(admin(), SESSAO_REF, env, "req");
    expect(r.ok).toBe(true);

    const linha = linhaDaMensagem(externalId);
    expect(linha).not.toBeNull();
    // Descartar apagaria da conversa algo que o cliente mandou, sem ninguém do
    // lado de cá ficar sabendo. É a sabotagem do T060a.
    expect(linha!.type).toBe("system");
    expect(linha!.original_type).toBe("poll");
    expect(linha!.body).toBe("Qual plano você prefere?");
  });

  it("segunda entrega do mesmo evento não duplica — a idempotência vale para qualquer canal", async () => {
    const env = envelopeDeInstagram();
    const externalId = env.message!.externalId;

    await ingerirEnvelope(admin(), SESSAO_REF, env, "req");
    const r2 = await ingerirEnvelope(admin(), SESSAO_REF, env, "req");

    expect(r2).toEqual({ ok: true, efeito: "duplicada" });
    const n = Number(
      sql(
        `select count(*) from public.messages where organization_id = '${ORG}' and external_id = '${externalId}';`,
      ).trim(),
    );
    expect(n).toBe(1);
  });

  it("plataforma desconhecida também entra — o CRM não bloqueia canal que ainda não conhece", async () => {
    seq += 1;
    const externalId = `EVT_T056_PLAT_${seq}`;
    const env = envelopeDeInstagram({
      platform: "telegram", // ainda não existe aqui
      message: { external_id: externalId, direction: "inbound", type: "text", body: "olá" },
    });

    const r = await ingerirEnvelope(admin(), SESSAO_REF, env, "req");

    // Recusar plataforma nova exigiria release do CRM a cada canal que o
    // gateway aprendesse — que é exatamente o acoplamento que esta história
    // existe para desfazer.
    expect(r.ok).toBe(true);
    expect(linhaDaMensagem(externalId)?.platform).toBe("telegram");
  });
});
