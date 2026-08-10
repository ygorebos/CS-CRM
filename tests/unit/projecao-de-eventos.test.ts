/**
 * A projeção de eventos sobre mensagens (spec 006, US1).
 *
 * O que estes casos vigiam é o defeito que a feature conserta: reação virando
 * bolha solta, apagamento virando bolha em branco, citação invisível. Cada um
 * falharia se a projeção fosse desligada — provado por sabotagem antes de ser
 * aceito.
 */
import { describe, expect, it } from "vitest";

import { previewDaListagem } from "@/lib/gateway/ingest";
import {
  ehEventoSobreMensagem,
  projetarEventos,
} from "@/lib/messaging/projection/project-events";
import type { Message } from "@/lib/types/messaging";

const ORG = "11111111-1111-1111-1111-111111111111";

function msg(over: Partial<Message> & { id: string }): Message {
  return {
    id: over.id,
    organization_id: ORG,
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: over.external_id ?? null,
    type: over.type ?? "text",
    direction: over.direction ?? "inbound",
    status: "received",
    ack: null,
    error_code: null,
    error_message: null,
    body: over.body ?? null,
    media_url: over.media_url ?? null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: over.media_storage_path ?? null,
    sent_via: "system",
    sent_by_user_id: null,
    sent_at: over.sent_at ?? "2026-08-09T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: over.metadata ?? {},
    created_at: "2026-08-09T12:00:00.000Z",
  };
}

/**
 * Dublê do cliente do Supabase que responde às DUAS consultas da projeção.
 *
 * Ele não prova formato de banco — isso é papel do invariante em `test:db`. O que
 * ele prova é a LÓGICA: quem vira estado, quem vence, o que some. Registra também
 * os filtros aplicados, para que o caso de tenant possa afirmar que
 * `organization_id` foi filtrado, e não apenas torcer.
 */
function fakeSupabase(linhas: Message[]) {
  const filtrosOrg: string[] = [];

  interface Estado {
    org?: string;
    campo?: string;
    valores?: string[];
  }

  function filtrar(e: Estado): Message[] {
    return linhas.filter((l) => {
      // O filtro de organização é aplicado de VERDADE aqui, e não ignorado: é o
      // que faz o caso de tenant medir alguma coisa em vez de só contar chamadas.
      if (e.org && l.organization_id !== e.org) return false;
      if (e.campo === "external_id") {
        return l.external_id !== null && (e.valores ?? []).includes(l.external_id);
      }
      if (e.campo === "metadata->>reply_to_external_id") {
        const alvoId = (l.metadata as Record<string, unknown>).reply_to_external_id;
        return typeof alvoId === "string" && (e.valores ?? []).includes(alvoId);
      }
      return false;
    });
  }

  function novaQuery() {
    const estado: Estado = {};
    // `then` é método PRÓPRIO, e cada elo devolve o MESMO objeto — foi assim que
    // o dublê passou a ser aguardável. A primeira versão devolvia um Proxy só no
    // fim da cadeia, então `await` caía num objeto sem `then` e resolvia para ele
    // mesmo: `{data}` vinha `undefined` e seis casos falhavam por defeito do
    // instrumento, não do código medido.
    const q = {
      select: () => q,
      eq: (col: string, val: string) => {
        if (col === "organization_id") {
          estado.org = val;
          filtrosOrg.push(val);
        }
        return q;
      },
      in: (col: string, vals: string[]) => {
        estado.campo = col;
        estado.valores = vals;
        return q;
      },
      order: () => q,
      then: (res: (v: { data: Message[]; error: null }) => void) =>
        res({ data: filtrar(estado), error: null }),
    };
    return q;
  }

  const client = { from: () => novaQuery() } as never;
  return { client, filtrosOrg };
}

describe("ehEventoSobreMensagem", () => {
  it("reação é evento, não item da conversa", () => {
    expect(ehEventoSobreMensagem({ type: "reaction", metadata: {} })).toBe(true);
  });

  it("apagamento é evento — chega como system com o rótulo cru preservado", () => {
    expect(ehEventoSobreMensagem({ type: "system", metadata: { original_type: "revoke" } })).toBe(
      true,
    );
  });

  it("system de outro tipo NÃO é evento — clique de botão continua sendo conversa", () => {
    // `interactive` traz o texto do botão que o cliente tocou. Tratá-lo como
    // evento sumiria com a resposta do cliente da linha do tempo.
    expect(
      ehEventoSobreMensagem({ type: "system", metadata: { original_type: "interactive" } }),
    ).toBe(false);
  });

  it("mensagem comum não é evento", () => {
    expect(ehEventoSobreMensagem({ type: "text", metadata: {} })).toBe(false);
  });
});

describe("projetarEventos", () => {
  it("prende a reação à mensagem alvo, e não à linha do tempo", async () => {
    const alvo = msg({ id: "m1", external_id: "wamid.A", body: "Proposta enviada" });
    const reacao = msg({
      id: "r1",
      type: "reaction",
      body: "👍",
      direction: "inbound",
      metadata: { reply_to_external_id: "wamid.A", reaction_emoji: "👍" },
      sent_at: "2026-08-09T12:01:00.000Z",
    });
    const { client } = fakeSupabase([alvo, reacao]);

    const p = await projetarEventos(client, ORG, [alvo]);
    expect(p.get("m1")!.reactions).toEqual([
      { emoji: "👍", actorKind: "inbound", reactedAt: "2026-08-09T12:01:00.000Z" },
    ]);
  });

  it("reação é ESTADO: a última do mesmo autor vence, não soma", async () => {
    const alvo = msg({ id: "m1", external_id: "wamid.A", body: "Proposta" });
    const eventos = [
      msg({
        id: "r1",
        type: "reaction",
        body: "👍",
        metadata: { reply_to_external_id: "wamid.A" },
        sent_at: "2026-08-09T12:01:00.000Z",
      }),
      msg({
        id: "r2",
        type: "reaction",
        body: "❤️",
        metadata: { reply_to_external_id: "wamid.A" },
        sent_at: "2026-08-09T12:02:00.000Z",
      }),
    ];
    const { client } = fakeSupabase([alvo, ...eventos]);

    const p = await projetarEventos(client, ORG, [alvo]);
    expect(p.get("m1")!.reactions.map((r) => r.emoji)).toEqual(["❤️"]);
  });

  it("emoji vazio REMOVE a reação em vez de virar entrada vazia", async () => {
    const alvo = msg({ id: "m1", external_id: "wamid.A", body: "Proposta" });
    const eventos = [
      msg({
        id: "r1",
        type: "reaction",
        body: "👍",
        metadata: { reply_to_external_id: "wamid.A" },
        sent_at: "2026-08-09T12:01:00.000Z",
      }),
      msg({
        id: "r2",
        type: "reaction",
        body: "",
        metadata: { reply_to_external_id: "wamid.A" },
        sent_at: "2026-08-09T12:02:00.000Z",
      }),
    ];
    const { client } = fakeSupabase([alvo, ...eventos]);

    const p = await projetarEventos(client, ORG, [alvo]);
    expect(p.get("m1")!.reactions).toEqual([]);
  });

  it("as reações do contato e da equipe convivem — uma por autor", async () => {
    const alvo = msg({ id: "m1", external_id: "wamid.A", body: "Proposta" });
    const eventos = [
      msg({
        id: "r1",
        type: "reaction",
        body: "👍",
        direction: "inbound",
        metadata: { reply_to_external_id: "wamid.A" },
        sent_at: "2026-08-09T12:01:00.000Z",
      }),
      msg({
        id: "r2",
        type: "reaction",
        body: "🎉",
        direction: "outbound",
        metadata: { reply_to_external_id: "wamid.A" },
        sent_at: "2026-08-09T12:02:00.000Z",
      }),
    ];
    const { client } = fakeSupabase([alvo, ...eventos]);

    const p = await projetarEventos(client, ORG, [alvo]);
    expect(p.get("m1")!.reactions.map((r) => `${r.actorKind}:${r.emoji}`).sort()).toEqual([
      "inbound:👍",
      "outbound:🎉",
    ]);
  });

  it("marca a mensagem apagada SEM esconder o corpo (FR-005)", async () => {
    const alvo = msg({ id: "m1", external_id: "wamid.A", body: "A mensalidade é 480" });
    const apagamento = msg({
      id: "d1",
      type: "system",
      direction: "inbound",
      metadata: { reply_to_external_id: "wamid.A", original_type: "revoke" },
      sent_at: "2026-08-09T12:05:00.000Z",
    });
    const { client } = fakeSupabase([alvo, apagamento]);

    const p = await projetarEventos(client, ORG, [alvo]);
    expect(p.get("m1")!.deletion).toEqual({
      deletedAt: "2026-08-09T12:05:00.000Z",
      deletedByKind: "inbound",
    });
    // O corpo continua na mensagem — a decisão do dono foi preservar a evidência.
    expect(alvo.body).toBe("A mensalidade é 480");
  });

  it("resolve a citação de uma mensagem que está fora da página", async () => {
    const citada = msg({
      id: "m0",
      external_id: "wamid.OLD",
      body: "Qual o valor da coparticipação?",
      direction: "inbound",
    });
    const resposta = msg({
      id: "m1",
      external_id: "wamid.NEW",
      body: "É 30%",
      direction: "outbound",
      metadata: { reply_to_external_id: "wamid.OLD" },
    });
    const { client } = fakeSupabase([citada, resposta]);

    const p = await projetarEventos(client, ORG, [resposta]);
    expect(p.get("m1")!.quote).toMatchObject({
      messageId: "m0",
      authorKind: "inbound",
      preview: "Qual o valor da coparticipação?",
      isUnavailable: false,
    });
  });

  it("citação de alvo que o CRM nunca ingeriu aparece como indisponível, não some", async () => {
    const resposta = msg({
      id: "m1",
      external_id: "wamid.NEW",
      body: "pode ser",
      metadata: { reply_to_external_id: "wamid.QUE_NAO_EXISTE" },
    });
    const { client } = fakeSupabase([resposta]);

    const p = await projetarEventos(client, ORG, [resposta]);
    expect(p.get("m1")!.quote?.isUnavailable).toBe(true);
  });

  it("citação de anexo sem legenda não fica vazia — o tipo do alvo viaja", async () => {
    const citada = msg({ id: "m0", external_id: "wamid.IMG", type: "image", body: null });
    const resposta = msg({
      id: "m1",
      external_id: "wamid.NEW",
      body: "essa mesma",
      metadata: { reply_to_external_id: "wamid.IMG" },
    });
    const { client } = fakeSupabase([citada, resposta]);

    const p = await projetarEventos(client, ORG, [resposta]);
    expect(p.get("m1")!.quote?.type).toBe("image");
  });

  it("mensagem sem NADA a exibir vira rótulo, nunca bolha vazia (FR-009)", async () => {
    const nada = msg({
      id: "m1",
      external_id: "wamid.X",
      type: "system",
      body: null,
      metadata: { original_type: "postback" },
    });
    const { client } = fakeSupabase([nada]);

    const p = await projetarEventos(client, ORG, [nada]);
    expect(p.get("m1")!.unsupported).not.toBeNull();
    expect(p.get("m1")!.unsupported!.originalType).toBe("postback");
  });

  it("mensagem com corpo NÃO recebe rótulo de não-suportada", async () => {
    // O clique num botão chega como `system` com o título do botão no corpo.
    // Rotulá-lo de "não sabemos exibir" seria esconder a resposta do cliente.
    const clique = msg({
      id: "m1",
      external_id: "wamid.X",
      type: "system",
      body: "Plano Familiar",
      metadata: { original_type: "interactive" },
    });
    const { client } = fakeSupabase([clique]);

    const p = await projetarEventos(client, ORG, [clique]);
    expect(p.get("m1")!.unsupported).toBeNull();
  });

  it("localização conta como conteúdo — não vira rótulo de não-suportada", async () => {
    const loc = msg({
      id: "m1",
      external_id: "wamid.L",
      type: "location",
      body: null,
      metadata: { location: { lat: -23.5613, lng: -46.6565, nome: "Clínica X" } },
    });
    const { client } = fakeSupabase([loc]);

    const p = await projetarEventos(client, ORG, [loc]);
    expect(p.get("m1")!.unsupported).toBeNull();
  });

  it("TODA consulta da projeção filtra a organização", async () => {
    // `external_id` é único POR ORGANIZAÇÃO. Sem este filtro, dois tenants com o
    // mesmo id do canal projetariam a reação de um cliente na conversa de outro.
    const alvo = msg({ id: "m1", external_id: "wamid.A", body: "oi" });
    const citada = msg({ id: "m0", external_id: "wamid.OLD", body: "anterior" });
    alvo.metadata = { reply_to_external_id: "wamid.OLD" };
    const { client, filtrosOrg } = fakeSupabase([alvo, citada]);

    await projetarEventos(client, ORG, [alvo]);
    expect(filtrosOrg.length).toBeGreaterThanOrEqual(2);
    expect(new Set(filtrosOrg)).toEqual(new Set([ORG]));
  });

  it("página vazia não consulta nada", async () => {
    const { client, filtrosOrg } = fakeSupabase([]);
    const p = await projetarEventos(client, ORG, []);
    expect(p.size).toBe(0);
    expect(filtrosOrg).toEqual([]);
  });
});

describe("prévia da listagem de conversas", () => {
  it("reação não vira emoji solto na lista", () => {
    expect(previewDaListagem("reaction", "👍", {})).toBe("Reagiu 👍");
  });

  it("reação removida se anuncia", () => {
    expect(previewDaListagem("reaction", "", {})).toBe("Reação removida");
  });

  it("apagamento não vira [system]", () => {
    expect(previewDaListagem("system", null, { original_type: "revoke" })).toBe(
      "Mensagem apagada",
    );
  });

  it("forma sem corpo mostra o nome em português, não o rótulo interno", () => {
    expect(previewDaListagem("location", null, {})).toBe("Localização");
    expect(previewDaListagem("contact", null, {})).toBe("Contato");
    expect(previewDaListagem("image", null, {})).toBe("Foto");
  });

  it("texto continua sendo o texto", () => {
    expect(previewDaListagem("text", "bom dia", {})).toBe("bom dia");
  });

  it("tipo desconhecido não vaza colchete nem nome interno", () => {
    expect(previewDaListagem("carousel", null, {})).toBe("Nova mensagem");
  });
});
