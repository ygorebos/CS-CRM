/**
 * O envelope normalizado — o ÚNICO formato de entrada de tráfego de canal.
 *
 * O gateway (`gateway_go`) recebe de todos os canais que ele suporta, converte
 * tudo para este formato e entrega ao CRM. Aqui não existe payload de
 * provedor: quem fala o dialeto de cada canal é o gateway, e é lá que fica. Do
 * lado do CRM há UM parser e UM ingest.
 *
 * ## Por que o parse é tolerante, e onde ele deixa de ser
 *
 * O gateway e o CRM sobem em ritmos diferentes — são dois contêineres, e numa
 * instalação self-host quem atualiza é o dono, quando quiser. Um parse estrito
 * transformaria "o gateway ganhou um campo" em "o CRM parou de receber
 * mensagem", que é o pior desfecho possível para um bug de compatibilidade.
 *
 * Então: **campo desconhecido nunca derruba a ingestão** — é preservado em
 * `metadata`, para não se perder o que ainda não sabemos ler. `envelope_version`
 * maior que a suportada é ACEITA, processando o subconjunto que entendemos.
 *
 * O que continua fechado é o que decide **para quem** a mensagem vai e **se ela
 * é única**: sem `external_id`, sem `platform` ou sem `event_kind` reconhecível,
 * não há idempotência nem roteamento, e aceitar seria gravar lixo com aparência
 * de mensagem. Aí recusa.
 *
 * Contrato completo: `contracts/gateway-inbound-v1.md`, na spec 001.
 */
import { z } from "zod";

/** Versão que este parser entende. Envelope mais novo é aceito, não recusado. */
export const ENVELOPE_VERSION_SUPORTADA = 1;

/**
 * Tipos que `messages.type` aceita (CHECK do banco). Tipo fora desta lista NÃO é
 * descartado: vira `system` com o valor original em `metadata.original_type`.
 * Descartar perderia a mensagem inteira por causa de um rótulo — e o cliente que
 * mandou um "postback" — um clique de botão — continua sendo um cliente
 * esperando resposta.
 */
const TIPOS_CONHECIDOS = [
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "reaction",
  "system",
] as const;

/** O que o envelope pode carregar. `read_watermark` é aceito e ignorado. */
const EVENT_KINDS = ["new_message", "status_update", "read_watermark"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

const midiaSchema = z
  .object({
    /**
     * Caminho RELATIVO. Se vier host aqui, ele é DESCARTADO na hora de baixar —
     * a URL é reconstruída sobre `GATEWAY_BASE_URL`. A garantia anti-SSRF vem da
     * construção, não da confiança no que chegou.
     */
    ref: z.string().min(1),
    mime: z.string().optional().nullable(),
    size_bytes: z.number().int().nonnegative().optional().nullable(),
    filename: z.string().optional().nullable(),
  })
  .passthrough();

const mensagemSchema = z
  .object({
    /** Chave de idempotência. Sem ela não há como não duplicar — por isso é dura. */
    external_id: z.string().min(1),
    direction: z.enum(["inbound", "outbound"]),
    type: z.string().min(1),
    body: z.string().optional().nullable(),
    reply_to_external_id: z.string().optional().nullable(),
    is_group: z.boolean().optional().default(false),
    /** true = eco de envio nosso; false = digitado no aparelho do corretor. */
    sent_by_api: z.boolean().optional().default(false),
  })
  .passthrough();

const participanteSchema = z
  .object({
    external_id: z.string().min(1),
    /** Nome vindo do CANAL. Nunca sobrescreve nome definido por humano. */
    display_name: z.string().optional().nullable(),
    group_sender_id: z.string().optional().nullable(),
  })
  .passthrough();

const entregaSchema = z
  .object({
    status: z.enum(["received", "sent", "delivered", "read", "failed"]).optional(),
    /** Código do provedor, preservado como veio (ex.: "131047"). */
    error_code: z.string().optional().nullable(),
    error_detail: z.string().optional().nullable(),
    window_expires_at: z.string().optional().nullable(),
  })
  .passthrough();

/**
 * `passthrough()` em toda parte não é preguiça: é o mecanismo de compatibilidade
 * para frente. O que não conhecemos sobrevive à validação e é recolhido em
 * `metadata` por `parseEnvelope`.
 */
export const envelopeSchema = z
  .object({
    envelope_version: z.number().int().positive(),
    event_id: z.string().min(1),
    event_kind: z.string().min(1),
    occurred_at: z.string().min(1),
    platform: z.string().min(1),
    gateway_connection_id: z.string().optional().nullable(),
    message: mensagemSchema.optional(),
    participant: participanteSchema.optional(),
    delivery: entregaSchema.optional(),
    media: midiaSchema.optional().nullable(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

export type EnvelopeBruto = z.infer<typeof envelopeSchema>;

/** Chaves que o parser conhece no topo — o resto vira `metadata.extra_*`. */
const CHAVES_CONHECIDAS = new Set([
  "envelope_version",
  "event_id",
  "event_kind",
  "occurred_at",
  "platform",
  "gateway_connection_id",
  "message",
  "participant",
  "delivery",
  "media",
  "metadata",
]);

export interface EnvelopeNormalizado {
  envelopeVersion: number;
  eventId: string;
  eventKind: EventKind;
  occurredAt: string;
  platform: string;
  gatewayConnectionId: string | null;
  message: {
    externalId: string;
    direction: "inbound" | "outbound";
    /** Já mapeado para o vocabulário de `messages.type`. */
    type: (typeof TIPOS_CONHECIDOS)[number];
    body: string | null;
    replyToExternalId: string | null;
    isGroup: boolean;
    sentByApi: boolean;
  } | null;
  participant: {
    externalId: string;
    displayName: string | null;
    groupSenderId: string | null;
  } | null;
  delivery: {
    status: "received" | "sent" | "delivered" | "read" | "failed" | null;
    errorCode: string | null;
    errorDetail: string | null;
    windowExpiresAt: string | null;
  };
  media: {
    ref: string;
    mime: string | null;
    sizeBytes: number | null;
    filename: string | null;
  } | null;
  /** Inclui o que não conhecíamos — nada do que chegou se perde. */
  metadata: Record<string, unknown>;
}

export type ResultadoParse =
  | {
      ok: true;
      envelope: EnvelopeNormalizado;
      avisos: string[];
      /**
       * Chaves do corpo que TENTARAM decidir a organização (FR-017a / T042).
       *
       * O corpo nunca decide tenant — quem decide é a linha de
       * `channel_sessions` achada pelo token do caminho. Estas chaves são
       * ignoradas para todo efeito, e o valor sobrevive apenas como
       * `metadata.extra_*`, que é dado inerte.
       *
       * Ignorar em SILÊNCIO, porém, seria perder o único sinal de que alguém
       * está tentando escrever no CRM de outra pessoa. Quem chama registra.
       */
      tenantForcado: string[];
    }
  | { ok: false; motivo: string; detalhe?: string };

/**
 * Chaves que só existiriam num corpo tentando escolher o dono da mensagem.
 *
 * O gateway legítimo não emite nenhuma delas: a organização do CRM não é
 * conceito que ele conheça.
 */
const CHAVES_QUE_DECIDIRIAM_TENANT = new Set([
  "organization_id",
  "organizationId",
  "org_id",
  "tenant_id",
  "channel_session_id",
  "webhook_path_token",
]);

/**
 * Motivos de recusa. São poucos de propósito: cada um significa "não dá para
 * rotear nem deduplicar isto", nunca "não gostei do formato".
 */
export type MotivoRecusa =
  | "corpo_invalido"
  | "envelope_invalido"
  | "evento_sem_mensagem"
  | "event_kind_desconhecido";

export function parseEnvelope(bruto: unknown): ResultadoParse {
  const r = envelopeSchema.safeParse(bruto);
  if (!r.success) {
    return {
      ok: false,
      motivo: "envelope_invalido",
      detalhe: r.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
        .join("; "),
    };
  }

  const e = r.data;
  const avisos: string[] = [];

  // Versão maior que a nossa NÃO é erro. O gateway pode ter subido primeiro
  // numa VPS; recusar aqui pararia a ingestão da instalação inteira por causa de
  // um número.
  if (e.envelope_version > ENVELOPE_VERSION_SUPORTADA) {
    avisos.push(
      `envelope_version ${e.envelope_version} é mais nova que a suportada ` +
        `(${ENVELOPE_VERSION_SUPORTADA}); processando o subconjunto conhecido`,
    );
  }

  if (!(EVENT_KINDS as readonly string[]).includes(e.event_kind)) {
    // Recusa registrável, não exceção: o gateway não deve retentar um evento que
    // este CRM simplesmente não trata.
    return {
      ok: false,
      motivo: "event_kind_desconhecido",
      detalhe: e.event_kind,
    };
  }
  const eventKind = e.event_kind as EventKind;

  if (eventKind !== "read_watermark" && !e.message) {
    return { ok: false, motivo: "evento_sem_mensagem" };
  }

  // Tudo que veio no topo e não conhecemos é recolhido, com prefixo para não
  // colidir com chave que o próprio gateway já pôs em `metadata`.
  const metadata: Record<string, unknown> = { ...(e.metadata ?? {}) };
  const tenantForcado: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (!CHAVES_CONHECIDAS.has(k)) {
      metadata[`extra_${k}`] = v;
      avisos.push(`campo desconhecido preservado: ${k}`);
      if (CHAVES_QUE_DECIDIRIAM_TENANT.has(k)) {
        // Preservado como dado inerte, como qualquer campo desconhecido — e
        // NUNCA lido para decidir dono. O que muda é que este caso vira sinal:
        // é a assinatura de uma tentativa de escrever no CRM de outra pessoa.
        tenantForcado.push(k);
      }
    }
  }

  let message: EnvelopeNormalizado["message"] = null;
  if (e.message) {
    const tipoBruto = e.message.type;
    const conhecido = (TIPOS_CONHECIDOS as readonly string[]).includes(tipoBruto);
    if (!conhecido) {
      // Mensagem preservada, rótulo sinalizado. Descartar por causa do tipo
      // perderia a conversa; um `postback` é uma pessoa clicando num botão.
      metadata.original_type = tipoBruto;
      avisos.push(`tipo desconhecido "${tipoBruto}" ingerido como system`);
    }
    message = {
      externalId: e.message.external_id,
      direction: e.message.direction,
      type: conhecido ? (tipoBruto as (typeof TIPOS_CONHECIDOS)[number]) : "system",
      body: e.message.body ?? null,
      replyToExternalId: e.message.reply_to_external_id ?? null,
      isGroup: e.message.is_group ?? false,
      sentByApi: e.message.sent_by_api ?? false,
    };
  }

  return {
    ok: true,
    avisos,
    tenantForcado,
    envelope: {
      envelopeVersion: e.envelope_version,
      eventId: e.event_id,
      eventKind,
      occurredAt: e.occurred_at,
      platform: e.platform,
      gatewayConnectionId: e.gateway_connection_id ?? null,
      message,
      participant: e.participant
        ? {
            externalId: e.participant.external_id,
            displayName: e.participant.display_name ?? null,
            groupSenderId: e.participant.group_sender_id ?? null,
          }
        : null,
      delivery: {
        status: e.delivery?.status ?? null,
        errorCode: e.delivery?.error_code ?? null,
        errorDetail: e.delivery?.error_detail ?? null,
        windowExpiresAt: e.delivery?.window_expires_at ?? null,
      },
      media: e.media
        ? {
            ref: e.media.ref,
            mime: e.media.mime ?? null,
            sizeBytes: e.media.size_bytes ?? null,
            filename: e.media.filename ?? null,
          }
        : null,
      metadata,
    },
  };
}
