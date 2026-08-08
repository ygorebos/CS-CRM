/**
 * T050 — anexo quebrado não pode custar a conversa (FR-025).
 *
 * ## A inversão de gravidade que este arquivo impede
 *
 * O jeito ingênuo de tratar mídia é baixar o arquivo durante a ingestão e só
 * então gravar a mensagem. Parece mais simples, e transforma dois problemas
 * pequenos em um grande: anexo lento vira mensagem atrasada, anexo quebrado vira
 * **mensagem perdida**. Do lado de lá existe uma pessoa que escreveu e ficou sem
 * resposta — e o motivo teria sido um JPEG.
 *
 * A ordem certa é a que está no código: a mensagem entra primeiro, e o anexo é
 * pedido depois, por evento separado. Estes testes vigiam essa ordem nos dois
 * pontos em que ela pode ser desfeita — o ingest e o worker.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseEnvelope } from "@/lib/gateway/envelope";
import { ingerirEnvelope } from "@/lib/gateway/ingest";

const SESSAO = { id: "11111111-1111-4111-8111-111111111111", organization_id: "22222222-2222-4222-8222-222222222222" };
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

function envelopeComMidia(extra: Record<string, unknown> = {}) {
  const parse = parseEnvelope({
    envelope_version: 1,
    event_id: "01H0000000000000000000MIDIA",
    event_kind: "new_message",
    occurred_at: "2026-08-08T12:00:00Z",
    platform: "whatsapp_uazapi",
    message: {
      external_id: "EVT_MIDIA_1",
      direction: "inbound",
      type: "image",
      body: null,
    },
    participant: { external_id: "5511966660000" },
    media: { ref: "media/abc123", mime: "image/jpeg", size_bytes: 4096, filename: "foto.jpg" },
    ...extra,
  });
  if (!parse.ok) throw new Error(`envelope de teste inválido: ${parse.motivo}`);
  return parse.envelope;
}

/**
 * Admin dublê mínimo: as RPCs de contato/conversa respondem sucesso, o insert
 * devolve id, e `emit_event` é observável. O objetivo não é exercer o banco —
 * isso é dos invariantes — e sim ver QUAIS eventos saem e em que condição.
 */
function adminDuplo(opts: { falharEmit?: string } = {}) {
  const emitidos: Array<{ tipo: string; payload: unknown }> = [];
  const atualizacoes: Array<Record<string, unknown>> = [];

  const admin = {
    rpc: vi.fn(async (nome: string, params: Record<string, unknown>) => {
      if (nome === "emit_event") {
        const tipo = String(params.p_event_type);
        emitidos.push({ tipo, payload: params.p_payload });
        if (opts.falharEmit === tipo) {
          return { data: null, error: { message: "emit falhou de propósito" } };
        }
        return { data: null, error: null };
      }
      if (nome === "fn_upsert_wa_contact") {
        return { data: { contact_id: "44444444-4444-4444-8444-444444444444" }, error: null };
      }
      if (nome === "fn_upsert_wa_conversation") {
        return { data: { conversation_id: "55555555-5555-4555-8555-555555555555" }, error: null };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((tabela: string) => {
      const cadeia = {
        insert: () => cadeia,
        update: (dados: Record<string, unknown>) => {
          atualizacoes.push({ tabela, ...dados });
          return cadeia;
        },
        select: () => cadeia,
        eq: () => cadeia,
        in: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => ({ data: { id: MESSAGE_ID }, error: null }),
        then: <T,>(onOk: (v: { data: unknown; error: null }) => T) =>
          Promise.resolve({ data: null, error: null }).then(onOk),
      };
      return cadeia;
    }),
  } as unknown as SupabaseClient;

  return { admin, emitidos, atualizacoes };
}

describe("mídia no ingest do gateway (T050)", () => {
  it("a mensagem entra e o anexo é pedido em evento SEPARADO", async () => {
    const { admin, emitidos } = adminDuplo();

    const r = await ingerirEnvelope(admin, SESSAO, envelopeComMidia(), "req-1");

    expect(r).toEqual({ ok: true, efeito: "ingerida", messageId: MESSAGE_ID });

    const tipos = emitidos.map((e) => e.tipo);
    expect(tipos).toContain("media.persist_requested");
    // E o turno do agente também sai: mensagem com anexo não deixa de ser
    // mensagem, e o agente responde a ela como a qualquer outra.
    expect(tipos).toContain("ai_agent.dispatch_requested");
  });

  it("falha ao PEDIR o anexo não derruba a ingestão", async () => {
    const { admin, emitidos } = adminDuplo({ falharEmit: "media.persist_requested" });

    const r = await ingerirEnvelope(admin, SESSAO, envelopeComMidia(), "req-2");

    // A mensagem já está no banco quando o evento é emitido. Devolver erro aqui
    // faria a rota tratar como falha de ingestão e o dreno retentar — e a
    // retentativa não traria nada de novo, só ruído.
    expect(r.ok).toBe(true);
    expect(emitidos.map((e) => e.tipo)).toContain("ai_agent.dispatch_requested");
  });

  it("mensagem SEM anexo não pede persistência de mídia", async () => {
    const { admin, emitidos } = adminDuplo();
    const parse = parseEnvelope({
      envelope_version: 1,
      event_id: "01H0000000000000000000SEMIDIA",
      event_kind: "new_message",
      occurred_at: "2026-08-08T12:00:00Z",
      platform: "whatsapp_uazapi",
      message: { external_id: "EVT_SEM_MIDIA", direction: "inbound", type: "text", body: "oi" },
      participant: { external_id: "5511966660000" },
    });
    if (!parse.ok) throw new Error("envelope inválido");

    await ingerirEnvelope(admin, SESSAO, parse.envelope, "req-3");

    // Evento sem trabalho para fazer é evento que o worker acorda para
    // descobrir que não tem nada — e some do log como "skipped", escondendo os
    // que importam.
    expect(emitidos.map((e) => e.tipo)).not.toContain("media.persist_requested");
  });

  it("o anexo do envelope NÃO vira media_url — a coluna não guarda endereço do payload", async () => {
    const { admin } = adminDuplo();
    const capturado: Array<Record<string, unknown>> = [];
    vi.mocked(admin.from).mockImplementation((() => {
      const cadeia = {
        insert: (dados: Record<string, unknown>) => {
          capturado.push(dados);
          return cadeia;
        },
        update: () => cadeia,
        select: () => cadeia,
        eq: () => cadeia,
        in: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => ({ data: { id: MESSAGE_ID }, error: null }),
        then: <T,>(onOk: (v: { data: unknown; error: null }) => T) =>
          Promise.resolve({ data: null, error: null }).then(onOk),
      };
      return cadeia;
    }) as never);

    await ingerirEnvelope(admin, SESSAO, envelopeComMidia(), "req-4");

    const msg = capturado.find((d) => "external_id" in d);
    expect(msg).toBeDefined();
    // Gravar ali o endereço vindo do envelope plantaria, na coluna, a URL não
    // confiável que a construção anti-SSRF existe justamente para não usar — e
    // o worker legado a consumiria sem reconstruir host nenhum.
    expect(msg?.media_url).toBeNull();
    expect((msg?.metadata as Record<string, unknown>)?.media_ref).toBe("media/abc123");
  });
});

/**
 * T014a — o edge case "corpo gigante ou mídia enorme", que até aqui só existia
 * como variável de ambiente.
 *
 * O teto do CORPO é da rota (413 antes de tocar o banco) e já tem teste próprio.
 * O da MÍDIA é aqui, e a regra é diferente de propósito: corpo grande demais é
 * recusa; anexo grande demais é **mensagem que entra sem o anexo**. A assimetria
 * é a resposta a "o que dói mais": um corpo absurdo é entrega malformada; um
 * anexo absurdo é uma pessoa mandando um vídeo.
 */
describe("teto de mídia declarado no envelope (T014a)", () => {
  it("anexo declarado acima do teto entra como indisponível, sem baixar nada", async () => {
    const { admin, emitidos } = adminDuplo();
    const capturado: Array<Record<string, unknown>> = [];
    vi.mocked(admin.from).mockImplementation((() => {
      const cadeia = {
        insert: (dados: Record<string, unknown>) => {
          capturado.push(dados);
          return cadeia;
        },
        update: () => cadeia,
        select: () => cadeia,
        eq: () => cadeia,
        in: () => cadeia,
        limit: () => cadeia,
        maybeSingle: async () => ({ data: { id: MESSAGE_ID }, error: null }),
        then: <T,>(onOk: (v: { data: unknown; error: null }) => T) =>
          Promise.resolve({ data: null, error: null }).then(onOk),
      };
      return cadeia;
    }) as never);

    const gigante = envelopeComMidia({
      message: {
        external_id: "EVT_MIDIA_GIGANTE",
        direction: "inbound",
        type: "video",
        body: "olha esse vídeo",
      },
      media: {
        ref: "media/gigante.mp4",
        mime: "video/mp4",
        // Acima do teto padrão de 100 MiB.
        size_bytes: 500 * 1024 * 1024,
      },
    });

    const r = await ingerirEnvelope(admin, SESSAO, gigante, "req-teto");

    // A mensagem ENTRA. Recusar aqui perderia a conversa por causa de um arquivo.
    expect(r.ok).toBe(true);
    const msg = capturado.find((d) => "external_id" in d);
    const meta = msg?.metadata as Record<string, unknown>;
    expect(meta.media_status).toBe("failed");
    expect(meta.media_unavailable_reason).toBe("declared_size_above_limit");

    // E o download NÃO é pedido: baixar para descobrir o que já está escrito no
    // envelope gasta rede e memória justamente no caso do arquivo enorme.
    expect(emitidos.map((e) => e.tipo)).not.toContain("media.persist_requested");
    expect(emitidos.map((e) => e.tipo)).toContain("ai_agent.dispatch_requested");
  });

  it("anexo dentro do teto continua sendo pedido normalmente", async () => {
    const { admin, emitidos } = adminDuplo();
    await ingerirEnvelope(admin, SESSAO, envelopeComMidia(), "req-teto-ok");
    // Caso de controle: sem ele, um bug que nunca emitisse o pedido faria o
    // teste acima passar por construção.
    expect(emitidos.map((e) => e.tipo)).toContain("media.persist_requested");
  });
});
