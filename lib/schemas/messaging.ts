/**
 * Schemas Zod do EPIC-03 Inbox + Messaging.
 *
 * Cobre boundary de validação das rotas /api/v1/conversations e
 * /api/v1/messages. Validações compartilhadas entre rota REST e webhooks
 * (quando o payload entra na pipeline pós-verificação HMAC).
 */
import { z } from "zod";

import {
  OUTBOUND_MESSAGE_TYPES,
  type OutboundMessageType,
} from "@/lib/messaging/message-types";
import {
  EXIGENCIA_POR_TIPO,
  contactsPayloadSchema,
  ctaUrlPayloadSchema,
  locationPayloadSchema,
  menuPayloadSchema,
} from "@/lib/messaging/payloads";

export const conversationStatusSchema = z.enum([
  "open",
  "claimed",
  "ai_handling",
  "closed",
  "archived",
]);

export const messageDirectionSchema = z.enum(["inbound", "outbound"]);

/**
 * O que o CRM pode enviar — DERIVADO de `lib/messaging/message-types.ts`, nunca
 * transcrito.
 *
 * A lista literal que morava aqui era a segunda de três (envelope, este arquivo e
 * o CHECK do banco), e nada obrigava as três a concordarem. `template` continua
 * dentro pelo mesmo motivo de sempre: o tipo é o que carrega custo, conformidade
 * de janela e o que o contato de fato viu (cabeçalho, rodapé, botões) — não é
 * "texto com outro nome". `reaction` e `system` continuam fora porque não são
 * mensagem que alguém compõe.
 */
export const messageTypeSchema = z.enum(
  OUTBOUND_MESSAGE_TYPES as [OutboundMessageType, ...OutboundMessageType[]],
);

export const messageStatusSchema = z.enum([
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
]);

export const sendMessageSchema = z
  .object({
    conversation_id: z.string().uuid(),
    type: messageTypeSchema.default("text"),
    body: z.string().min(1).max(4096).optional(),
    media_url: z.string().url().optional(),
    media_storage_path: z.string().min(1).max(500).optional(),
    media_mime: z.string().optional(),
    media_size_bytes: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    /**
     * A mensagem que esta responde (spec 006, FR-011).
     *
     * É o **UUID da linha do CRM**, nunca o identificador do canal. O servidor
     * resolve o identificador externo a partir da linha, conferindo que ela é da
     * mesma conversa e da mesma organização. Aceitar o id do canal pelo corpo
     * deixaria o cliente apontar para mensagem de outro tenant — a mesma classe de
     * defeito que o Princípio I chama de Lei Zero.
     *
     * Vale para QUALQUER tipo, não só texto: cita-se ao mandar uma foto também.
     */
    reply_to_message_id: z.string().uuid().optional(),
    /** Só em `type: "location"`. Carga em `lib/messaging/payloads.ts`. */
    location: locationPayloadSchema.optional(),
    /** Só em `type: "contact"`. */
    contacts: contactsPayloadSchema.optional(),
    /** Só em `type: "menu"`. O teto de opções é do CANAL, imposto no handler. */
    menu: menuPayloadSchema.optional(),
    /** Só em `type: "cta_url"`. */
    cta_url: ctaUrlPayloadSchema.optional(),
    /** Só em `type: "template"`. Nome exato aprovado na Meta. */
    template_name: z.string().min(1).max(512).optional(),
    /** Só em `type: "template"`. `pt_BR` e `pt` são templates DISTINTOS. */
    template_language: z.string().min(2).max(16).optional(),
    /**
     * Só em `type: "template"`. Valor por slot, chaveado por `slotKey`
     * (`lib/channels/meta/build-components.ts`) — a MESMA função que o formulário
     * da tela usa. Chave montada de outro jeito é o mismatch voltando.
     */
    template_values: z.record(z.string(), z.string()).optional(),
  })
  /**
   * A carga obrigatória é POR TIPO (spec 006, FR-017).
   *
   * A regra anterior era única para todos — "tem body OU mídia" —, e é ela que
   * explica o defeito que esta spec conserta: `location` e `contact` estavam no
   * enum de tipos e passavam na validação acompanhados de qualquer texto, sem
   * jamais carregar coordenada nem cartão. O pedido saía incompleto e o canal
   * respondia "campos obrigatórios ausentes: latitude e longitude" — descoberto
   * na cara do corretor, depois da rede.
   *
   * A tabela de exigências vive em `lib/messaging/payloads.ts` e é
   * `Record<OutboundMessageType, …>`: tipo novo no vocabulário de envio **não
   * compila** até declarar o que exige. É assim que "aceito e inenviável" para de
   * nascer.
   */
  .superRefine((d, ctx) => {
    const exigencia = EXIGENCIA_POR_TIPO[d.type];
    if (!exigencia) return;

    if (exigencia.kind === "body" && !d.body) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "body é obrigatório neste tipo" });
      return;
    }

    if (exigencia.kind === "media" && !d.media_url && !d.media_storage_path) {
      ctx.addIssue({
        code: "custom",
        path: ["media_storage_path"],
        message: "media_url ou media_storage_path é obrigatório neste tipo",
      });
      return;
    }

    if (exigencia.kind === "payload") {
      if (exigencia.exigeBody && !d.body) {
        ctx.addIssue({
          code: "custom",
          path: ["body"],
          message: `body é obrigatório em type: "${d.type}"`,
        });
        return;
      }
      const valor = (d as Record<string, unknown>)[exigencia.campo];
      if (valor === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [exigencia.campo],
          // Nomear o campo é o que separa "recusado com motivo" de "recusado".
          message: `${exigencia.campo} é obrigatório em type: "${d.type}"`,
        });
        return;
      }
      const r = exigencia.schema.safeParse(valor);
      if (!r.success) {
        ctx.addIssue({
          code: "custom",
          path: [exigencia.campo],
          message: r.error.issues.map((i) => i.message).join("; "),
        });
      }
      return;
    }

    if (exigencia.kind === "template" && !d.template_name) {
      ctx.addIssue({
        code: "custom",
        path: ["template_name"],
        message: 'template_name é obrigatório em type: "template"',
      });
    }
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const claimConversationSchema = z.object({
  expected_assignee: z.string().uuid().nullable().optional(),
});

export type ClaimConversationInput = z.infer<typeof claimConversationSchema>;

/** G3-01: transferência imediata (decisão G1-06d) — reatribui com motivo opcional. */
export const transferConversationSchema = z.object({
  to_user_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type TransferConversationInput = z.infer<typeof transferConversationSchema>;

export const updateConversationStatusSchema = z.object({
  status: conversationStatusSchema,
});

export type UpdateConversationStatusInput = z.infer<typeof updateConversationStatusSchema>;

/**
 * G3-05: normalização reutilizável de tag (mesmo shape de contacts.tags /
 * crm_leads.tags — text[]). trim + lowercase; 1..40 chars por tag.
 */
export const conversationTagSchema = z.string().trim().toLowerCase().min(1).max(40);

/** ≤20 tags, deduplicadas após normalização. */
export const conversationTagsSchema = z
  .array(conversationTagSchema)
  .max(20)
  .transform((tags) => Array.from(new Set(tags)));

export type ConversationTags = z.infer<typeof conversationTagsSchema>;

/** G3-05: PATCH /conversations/[id] aceita status e/ou tags (ao menos um). */
export const patchConversationSchema = z
  .object({
    status: conversationStatusSchema.optional(),
    tags: conversationTagsSchema.optional(),
  })
  .refine((d) => d.status !== undefined || d.tags !== undefined, {
    message: "Informe status ou tags.",
  });

export type PatchConversationInput = z.infer<typeof patchConversationSchema>;

export const listConversationsQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  assigned_to: z.union([z.string().uuid(), z.literal("me"), z.literal("unassigned")]).optional(),
  channel_session_id: z.string().uuid().optional(),
  tag: conversationTagSchema.optional(),
  search: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListConversationsQuery = z.infer<typeof listConversationsQuerySchema>;

export const listMessagesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
