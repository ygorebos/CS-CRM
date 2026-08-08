/**
 * O contrato de entrada do gateway (T010 da spec 001).
 *
 * O que este arquivo vigia não é "o Zod funciona" — é a decisão de produto que o
 * parser encarna: **compatibilidade para frente é obrigatória, e recusa é
 * exceção**. O gateway e o CRM são dois contêineres que o dono da VPS atualiza
 * quando quer; um parse estrito transformaria "o gateway ganhou um campo" em "o
 * CRM parou de receber mensagem".
 *
 * Cada `it` abaixo corresponde a uma linha do contrato
 * (`contracts/gateway-inbound-v1.md` §3, "Regras de compatibilidade"). Se um
 * deles ficar verde com a regra removida do parser, o teste é decoração —
 * a sabotagem de cada um está anotada no fim do arquivo.
 */
import { describe, expect, it } from "vitest";

import { ENVELOPE_VERSION_SUPORTADA, parseEnvelope } from "@/lib/gateway/envelope";

/** Envelope mínimo válido: mensagem de texto recebida. */
function envelopeValido(over: Record<string, unknown> = {}) {
  return {
    envelope_version: 1,
    event_id: "9f1c0a2e-0000-4000-8000-000000000001",
    event_kind: "new_message",
    occurred_at: "2026-08-07T21:14:03Z",
    platform: "whatsapp_uazapi",
    gateway_connection_id: "conn_7f",
    message: {
      external_id: "3EB0ABCDEF",
      direction: "inbound",
      type: "text",
      body: "Boa tarde, queria um plano",
    },
    participant: { external_id: "5511999999999", display_name: "Maria" },
    delivery: { status: "received" },
    media: null,
    metadata: {},
    ...over,
  };
}

describe("envelope do gateway — o que entra e o que é recusado", () => {
  it("envelope válido é aceito e normalizado para o vocabulário do CRM", () => {
    const r = parseEnvelope(envelopeValido());
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.envelope.eventKind).toBe("new_message");
    expect(r.envelope.message?.externalId).toBe("3EB0ABCDEF");
    expect(r.envelope.message?.type).toBe("text");
    expect(r.envelope.message?.direction).toBe("inbound");
    expect(r.envelope.participant?.externalId).toBe("5511999999999");
    expect(r.avisos).toEqual([]);
  });

  it("campo desconhecido no topo é PRESERVADO, não descartado nem fatal", () => {
    const r = parseEnvelope(
      envelopeValido({ campo_que_o_crm_nao_conhece: { algo: 1 } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Preservado: um dia alguém vai precisar saber o que chegou.
    expect(r.envelope.metadata.extra_campo_que_o_crm_nao_conhece).toEqual({ algo: 1 });
    expect(r.avisos.join(" ")).toContain("campo desconhecido preservado");
  });

  it("envelope_version mais nova que a suportada é ACEITA, com aviso", () => {
    const futura = ENVELOPE_VERSION_SUPORTADA + 7;
    const r = parseEnvelope(envelopeValido({ envelope_version: futura }));

    // Recusar aqui pararia a ingestão da instalação inteira só porque o gateway
    // subiu primeiro. É o desfecho que este teste existe para impedir.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.envelopeVersion).toBe(futura);
    expect(r.avisos.join(" ")).toContain("mais nova que a suportada");
  });

  it("tipo desconhecido vira system e guarda o original — nunca é descartado", () => {
    const r = parseEnvelope(
      envelopeValido({
        message: {
          external_id: "MID_POSTBACK_1",
          direction: "inbound",
          type: "postback",
          body: "Quero falar com atendente",
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // O `postback` do Messenger é uma pessoa clicando num botão. Perder a
    // mensagem por causa do rótulo é perder o cliente.
    expect(r.envelope.message?.type).toBe("system");
    expect(r.envelope.message?.body).toBe("Quero falar com atendente");
    expect(r.envelope.metadata.original_type).toBe("postback");
  });

  it("event_kind desconhecido é recusado com motivo, não com exceção", () => {
    const r = parseEnvelope(envelopeValido({ event_kind: "typing_indicator" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;

    // Recusa nomeada: o gateway não deve retentar um evento que este CRM não
    // trata. Retentar seria ruído infinito.
    expect(r.motivo).toBe("event_kind_desconhecido");
    expect(r.detalhe).toBe("typing_indicator");
  });

  it("read_watermark é aceito mesmo sem bloco de mensagem", () => {
    const r = parseEnvelope(
      envelopeValido({ event_kind: "read_watermark", message: undefined }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.eventKind).toBe("read_watermark");
    expect(r.envelope.message).toBeNull();
  });

  it("evento de mensagem SEM external_id é recusado — sem ele não há idempotência", () => {
    const r = parseEnvelope(
      envelopeValido({
        message: { external_id: "", direction: "inbound", type: "text", body: "oi" },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("envelope_invalido");
  });

  it("new_message sem bloco de mensagem é recusado", () => {
    const r = parseEnvelope(envelopeValido({ message: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toBe("evento_sem_mensagem");
  });

  it("corpo que não é objeto é recusado sem lançar", () => {
    for (const lixo of [null, "texto solto", 42, []]) {
      const r = parseEnvelope(lixo);
      expect(r.ok).toBe(false);
    }
  });

  it("mídia é referência, e o host que vier junto não vira confiança", () => {
    const r = parseEnvelope(
      envelopeValido({
        media: { ref: "media/abc123", mime: "image/jpeg", size_bytes: 184320 },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // O parser guarda a referência como veio; quem descarta host é o
    // MediaSource, sobre GATEWAY_BASE_URL. Aqui só se garante que a referência
    // atravessa inteira.
    expect(r.envelope.media?.ref).toBe("media/abc123");
    expect(r.envelope.media?.sizeBytes).toBe(184320);
  });

  it("o código de erro do provedor atravessa sem tradução", () => {
    const r = parseEnvelope(
      envelopeValido({
        event_kind: "status_update",
        delivery: { status: "failed", error_code: "131047", error_detail: "Re-engagement" },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 131047 é o código da Meta para janela fechada. Traduzir aqui apagaria a
    // única pista que o operador tem para saber por que a mensagem não saiu.
    expect(r.envelope.delivery.errorCode).toBe("131047");
    expect(r.envelope.delivery.status).toBe("failed");
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO (T031/T045 exigem confirmar):
 *
 *  1. Trocar `envelope_version > SUPORTADA` por uma recusa
 *     → "envelope_version mais nova que a suportada é ACEITA" cai.
 *  2. Remover o fallback de tipo desconhecido para `system`
 *     → "tipo desconhecido vira system" cai.
 *  3. Trocar `.passthrough()` por `.strict()` no schema de topo
 *     → "campo desconhecido é PRESERVADO" cai.
 *  4. Afrouxar `external_id` para `z.string()` (sem `.min(1)`)
 *     → "evento de mensagem SEM external_id é recusado" cai, e a idempotência
 *       inteira do caminho novo vai junto.
 */
