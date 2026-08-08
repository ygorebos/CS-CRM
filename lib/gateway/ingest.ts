/**
 * O ingest ÚNICO — a partir do envelope normalizado, para qualquer canal.
 *
 * ## Por que existe um só, e por que ele não escreve contato à mão
 *
 * Antes desta feature, cada provedor trazia o seu ingest inteiro, escrito do
 * zero, sem contrato comum: um terceiro provedor significava um terceiro ingest.
 * Aqui há UM, contra UM formato — canal novo que o gateway aprender chega sem
 * código novo deste lado.
 *
 * As escritas de contato e conversa vão pelas MESMAS RPCs do caminho legado
 * (`fn_upsert_wa_contact`, `fn_upsert_wa_conversation`). Não é economia de
 * digitação: é o que impede uma segunda cópia da regra de posse de nome. Essa
 * regra hoje vive dentro do `coalesce(contacts.display_name, excluded.display_name)`
 * da RPC — o nome vindo do canal só preenche vazio e **nunca** sobrescreve o que
 * um humano escreveu. Um `insert` próprio aqui reintroduziria, em silêncio, o
 * bug de a mensagem recebida apagar a qualificação feita pelo atendente.
 *
 * ## O que este módulo NÃO decide
 *
 * Autenticidade e teto ficam na rota. Aqui já se está depois do ACK: a entrega é
 * durável, e o que acontece é a cadeia viva — contato, conversa, mensagem, turno
 * do agente, follow-up, auditoria.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { numeroCanonicoParaUpsert } from "@/lib/channels/identidade-canonica";
import { env } from "@/lib/env";
import type { EnvelopeNormalizado } from "@/lib/gateway/envelope";
import { logger } from "@/lib/logger";

type Admin = SupabaseClient;

/** Palavra do cliente pedindo para parar. Mesmo vocabulário do caminho legado. */
const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE|DESCADASTRAR)\b/i;

export interface SessaoDeCanal {
  id: string;
  organization_id: string;
}

export type ResultadoIngest =
  | { ok: true; efeito: "ingerida"; messageId: string }
  | { ok: true; efeito: "duplicada" }
  | { ok: true; efeito: "ignorada"; motivo: string }
  | { ok: false; motivo: string };

/**
 * Identidade do participante, no vocabulário que a RPC entende.
 *
 * O envelope entrega um identificador já canonicalizado pelo gateway. Aqui só se
 * classifica: dígitos com `+` ou tamanho de telefone viram `phone`; o resto vira
 * o identificador interno do canal (`lid`). Grupo é decisão de doutrina e não
 * chega a virar contato.
 */
function classificarParticipante(
  externalId: string,
  isGroup: boolean,
): { kind: "phone"; phone: string; lid: null } | { kind: "lid"; phone: null; lid: string } | null {
  if (isGroup) return null;
  const limpo = externalId.trim();
  if (!limpo) return null;

  const digitos = limpo.replace(/^\+/, "");
  if (!/^\d+$/.test(digitos)) return null;

  // Telefone tem código de país + DDD + número: 10 a 15 dígitos (E.164). Abaixo
  // disso é identificador interno do canal, não número discável.
  if (digitos.length >= 10 && digitos.length <= 15) {
    return { kind: "phone", phone: `+${digitos}`, lid: null };
  }
  return { kind: "lid", phone: null, lid: digitos };
}

export async function ingerirEnvelope(
  admin: Admin,
  sessao: SessaoDeCanal,
  envelope: EnvelopeNormalizado,
  requestId: string,
): Promise<ResultadoIngest> {
  if (envelope.eventKind === "read_watermark") {
    // O CRM não tem o conceito de marca de leitura em massa. Ignorar é a decisão
    // — mas ignorar EM SILÊNCIO seria o defeito: quem procurar "por que nada
    // aconteceu" precisa achar o motivo escrito.
    logger.info("gateway.ingest: read_watermark ignorado (CRM não modela leitura em massa)", {
      organization_id: sessao.organization_id,
      request_id: requestId,
    });
    return { ok: true, efeito: "ignorada", motivo: "read_watermark_nao_modelado" };
  }

  if (envelope.eventKind === "status_update") {
    return atualizarEstado(admin, sessao, envelope);
  }

  const msg = envelope.message;
  if (!msg) return { ok: false, motivo: "evento_sem_mensagem" };

  if (msg.isGroup) {
    // Doutrina vigente: conversa de grupo não vira vínculo no CRM. A decisão fica
    // registrada em vez de virar descarte mudo.
    logger.info("gateway.ingest: grupo ignorado por doutrina", {
      organization_id: sessao.organization_id,
      external_id: msg.externalId,
    });
    return { ok: true, efeito: "ignorada", motivo: "grupo_nao_vinculado" };
  }

  const participante = envelope.participant;
  if (!participante) return { ok: false, motivo: "evento_sem_participante" };

  const identidade = classificarParticipante(participante.externalId, msg.isGroup);
  if (!identidade) {
    return { ok: false, motivo: "participante_nao_enderecavel" };
  }

  // O valor que a RPC DEVOLVE é o que vale daqui para a frente. O identificador
  // pode ser canonicalizado no caminho (a mesma pessoa chega ora como número, ora
  // como identificador interno do canal), e gravar a mensagem com o valor que
  // ENTROU partiria o histórico em duas conversas na primeira variante nova.
  const contactId = await upsertContato(admin, sessao.organization_id, identidade, participante);
  if (!contactId) return { ok: false, motivo: "contato_nao_resolvido" };

  const conversationId = await upsertConversa(admin, sessao.organization_id, contactId, sessao.id);
  if (!conversationId) return { ok: false, motivo: "conversa_nao_resolvida" };

  const agora = new Date().toISOString();
  const ehEco = msg.direction === "outbound";

  // Anexo que o PRÓPRIO envelope declara acima do teto não é baixado. Não é
  // economia: baixar para descobrir o que já está escrito no envelope gasta a
  // rede e a memória do processo justamente no caso em que o arquivo é enorme —
  // e o desfecho seria o mesmo. A mensagem entra marcada como anexo
  // indisponível (FR-025); a conversa nunca some por causa de um arquivo.
  const tamanhoDeclarado = envelope.media?.sizeBytes ?? null;
  const anexoGrandeDemais =
    tamanhoDeclarado !== null && tamanhoDeclarado > env.GATEWAY_MAX_MEDIA_BYTES;

  const { data: inserida, error: insErr } = await admin
    .from("messages")
    .insert({
      organization_id: sessao.organization_id,
      conversation_id: conversationId,
      channel_session_id: sessao.id,
      contact_id: contactId,
      external_id: msg.externalId,
      type: msg.type,
      direction: msg.direction,
      status: ehEco ? (envelope.delivery.status ?? "sent") : "received",
      body: msg.body,
      media_url: null,
      media_mime: envelope.media?.mime ?? null,
      media_size_bytes: envelope.media?.sizeBytes ?? null,
      // Eco de mensagem digitada no aparelho do corretor: `sent_by_api=false`
      // significa que o envio NÃO passou por aqui. Marcar como 'crm' faria a
      // conversa mostrar como se o sistema tivesse mandado.
      sent_via: ehEco ? (msg.sentByApi ? "crm" : "external_device") : "external_device",
      sent_at: envelope.occurredAt || agora,
      error_code: envelope.delivery.errorCode,
      error_message: envelope.delivery.errorDetail,
      metadata: {
        ...envelope.metadata,
        ...(anexoGrandeDemais
          ? {
              media_status: "failed",
              media_unavailable_reason: "declared_size_above_limit",
            }
          : {}),
        gateway_event_id: envelope.eventId,
        platform: envelope.platform,
        reply_to_external_id: msg.replyToExternalId,
        media_ref: envelope.media?.ref ?? null,
        media_filename: envelope.media?.filename ?? null,
        window_expires_at: envelope.delivery.windowExpiresAt,
      },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id). É caminho
  // NORMAL, não erro — é o que torna seguro o gateway reentregar e os dois
  // caminhos coexistirem durante a virada.
  if (insErr && insErr.code !== "23505") {
    logger.error("gateway.ingest: insert de mensagem falhou", {
      organization_id: sessao.organization_id,
      external_id: msg.externalId,
      erro: insErr.message,
    });
    return { ok: false, motivo: "insert_falhou" };
  }
  if (insErr?.code === "23505") {
    // Conta o dedup. Sair mudo faria "5 mensagens, 4 turnos" ficar
    // indistinguível entre dedup legítimo e mensagem perdida.
    logger.info("gateway.ingest: ja ingerida, dedup por external_id", {
      organization_id: sessao.organization_id,
      external_id: msg.externalId,
    });
    return { ok: true, efeito: "duplicada" };
  }

  const messageId = inserida?.id as string | undefined;
  if (!messageId) return { ok: false, motivo: "insert_sem_id" };

  await carimbarConversa(
    admin,
    sessao.organization_id,
    conversationId,
    msg.direction,
    (msg.body ?? `[${msg.type}]`).slice(0, 280),
    agora,
  );

  if (!ehEco && msg.body && STOP_RX.test(msg.body)) {
    await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: agora })
      .eq("id", contactId)
      .eq("organization_id", sessao.organization_id);
  }

  // Anexo: pede a persistência DEPOIS de a mensagem já existir, e num evento
  // separado. A ordem é a promessa do FR-025 em forma de código — a conversa
  // aparece na tela mesmo que o arquivo nunca baixe. Fazer o download aqui
  // dentro amarraria a mensagem a um binário de dezenas de MiB vindo de outro
  // processo: anexo lento viraria mensagem atrasada, anexo quebrado viraria
  // mensagem perdida.
  if (envelope.media?.ref && !anexoGrandeDemais) {
    const { error: midiaErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "media.persist_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: { message_id: messageId, organization_id: sessao.organization_id },
      p_metadata: { source: "gateway_webhook", request_id: requestId },
      p_organization_id: sessao.organization_id,
    } as never);
    if (midiaErr) {
      // Não derruba a ingestão: a mensagem já entrou, e é isso que importa.
      // Fica registrado porque, sem o evento, o anexo nunca baixa e o sintoma na
      // tela é um anexo eternamente "carregando" — sinal de progresso para algo
      // que não vai acontecer.
      logger.error("gateway.ingest: emit media.persist_requested falhou", {
        organization_id: sessao.organization_id,
        message_id: messageId,
        erro: midiaErr.message,
      });
    }
  }

  // A cadeia viva. Só para mensagem RECEBIDA: o eco do próprio envio não pede
  // turno de agente — pedir faria o agente responder a si mesmo.
  if (!ehEco) {
    const { error: eventErr } = await admin.rpc("emit_event" as never, {
      p_event_type: "ai_agent.dispatch_requested",
      p_entity_kind: "message",
      p_entity_id: messageId,
      p_payload: {
        organization_id: sessao.organization_id,
        conversation_id: conversationId,
        contact_id: contactId,
        channel_session_id: sessao.id,
        inbound_message_id: messageId,
      },
      p_metadata: { source: "gateway_webhook", request_id: requestId },
      p_organization_id: sessao.organization_id,
    } as never);
    if (eventErr) {
      logger.error("gateway.ingest: emit dispatch_requested falhou", {
        organization_id: sessao.organization_id,
        message_id: messageId,
        erro: eventErr.message,
      });
    }
  }

  return { ok: true, efeito: "ingerida", messageId };
}

/** Ordem dos estados. Serve para nunca REGREDIR o que a tela mostra. */
const ORDEM_DO_ESTADO: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  received: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

async function atualizarEstado(
  admin: Admin,
  sessao: SessaoDeCanal,
  envelope: EnvelopeNormalizado,
): Promise<ResultadoIngest> {
  const externalId = envelope.message?.externalId;
  const novo = envelope.delivery.status;
  if (!externalId || !novo) return { ok: false, motivo: "status_sem_referencia" };

  const { data: atual } = await admin
    .from("messages")
    .select("id, status")
    .eq("organization_id", sessao.organization_id)
    .eq("external_id", externalId)
    .maybeSingle();

  if (!atual) {
    // Confirmação de estado para mensagem que o CRM ainda não conhece. Acontece
    // com entrega fora de ordem, e criar mensagem fantasma seria pior que não
    // fazer nada — ela apareceria na conversa sem corpo e sem autor.
    logger.info("gateway.ingest: status de mensagem desconhecida, ignorado", {
      organization_id: sessao.organization_id,
      external_id: externalId,
    });
    return { ok: true, efeito: "ignorada", motivo: "mensagem_desconhecida" };
  }

  const antes = ORDEM_DO_ESTADO[atual.status as string] ?? -1;
  const depois = ORDEM_DO_ESTADO[novo] ?? -1;
  // `failed` sempre entra: é informação nova mesmo depois de 'read' (mensagem
  // que falhou numa segunda tentativa). Os demais só avançam.
  if (novo !== "failed" && depois <= antes) {
    return { ok: true, efeito: "ignorada", motivo: "estado_nao_regride" };
  }

  const agora = new Date().toISOString();
  const patch: Record<string, unknown> = { status: novo };
  if (novo === "delivered") patch.delivered_at = agora;
  if (novo === "read") patch.read_at = agora;
  if (novo === "failed") {
    patch.error_code = envelope.delivery.errorCode;
    patch.error_message = envelope.delivery.errorDetail;
  }

  const { error } = await admin
    .from("messages")
    .update(patch)
    .eq("id", atual.id)
    .eq("organization_id", sessao.organization_id);

  if (error) return { ok: false, motivo: "update_de_status_falhou" };
  return { ok: true, efeito: "ingerida", messageId: atual.id as string };
}

async function upsertContato(
  admin: Admin,
  orgId: string,
  identidade: { kind: "phone"; phone: string; lid: null } | { kind: "lid"; phone: null; lid: string },
  participante: { externalId: string; displayName: string | null },
): Promise<string | null> {
  // FR-020: o número que vai para o upsert é o JÁ CADASTRADO quando existe, não o
  // que chegou no envelope. A mesma pessoa chega com 13 dígitos no envio e 12 no
  // recebimento (nono dígito brasileiro), e `wa_identity` é `'phone:' ||
  // phone_number` literal — sem esta resolução, o índice único não vê conflito e
  // o cliente vira DOIS cadastros com o mesmo nome, cada um com metade da
  // conversa. Só amplia a busca: o número gravado nunca é reescrito.
  const phone =
    identidade.kind === "phone"
      ? await numeroCanonicoParaUpsert(identidade.phone, (variantes) =>
          buscarContatoPorVariantes(admin, orgId, variantes),
        )
      : null;

  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: orgId,
    p_kind: identidade.kind,
    p_phone: phone,
    p_lid: identidade.lid,
    p_chat_id: participante.externalId,
    // Nome do CANAL. A RPC faz `coalesce(contacts.display_name, excluded...)`,
    // então ele só preenche vazio — nunca sobrescreve o que um humano escreveu.
    p_notify: participante.displayName,
  } as never);
  if (error) {
    logger.error("gateway.ingest: fn_upsert_wa_contact falhou", { erro: error.message });
    return null;
  }
  return (data as string) ?? null;
}

/**
 * Contato já existente sob QUALQUER variante do número, DENTRO da organização.
 *
 * O filtro por `organization_id` não é zelo: sem ele, o número de um tenant
 * decidiria a grafia gravada no de outro — e a busca que existe para unir um
 * histórico passaria a atravessar a fronteira que sustenta o produto inteiro.
 */
async function buscarContatoPorVariantes(
  admin: Admin,
  orgId: string,
  variantes: string[],
): Promise<string | null> {
  const { data } = await admin
    .from("contacts")
    .select("phone_number")
    .eq("organization_id", orgId)
    .in("phone_number", variantes)
    .limit(1)
    .maybeSingle();
  return (data?.phone_number as string | undefined) ?? null;
}

async function upsertConversa(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: orgId,
    p_contact: contactId,
    p_session: sessionId,
  } as never);
  if (error) {
    logger.error("gateway.ingest: fn_upsert_wa_conversation falhou", { erro: error.message });
    return null;
  }
  return (data as string) ?? null;
}

async function carimbarConversa(
  admin: Admin,
  orgId: string,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: convId,
    p_direction: direction,
    p_preview: preview,
    p_at: at,
  } as never);
  if (!error) return;

  // Falha baixo, mas CONTA. A mensagem já entrou; bloquear por causa de uma
  // coluna derivada deixaria o histórico refém dela. Mas log sem destino não
  // vira alerta de ninguém — o evento é o que torna a pergunta respondível.
  await admin.rpc("emit_event" as never, {
    p_event_type: "gateway.conversation_mark_failed",
    p_entity_kind: "conversation",
    p_entity_id: convId,
    // O preview NÃO entra: é o texto do cliente, e isto é registro operacional.
    p_payload: { direction, erro: error.message },
    p_metadata: { severity: "warn" },
    p_organization_id: orgId,
  } as never);
}
