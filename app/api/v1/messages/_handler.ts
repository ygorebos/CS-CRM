/**
 * Core handlers para messages (list + send).
 *
 * Reusados por:
 *  - POST /api/v1/messages (sendMessageHandler)
 *  - GET  /api/v1/conversations/[id]/messages (listMessagesHandler)
 *  - MCP tools (S-13.04)
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { CAPABILITY_POR_TIPO } from "@/lib/messaging/payloads";
import { adotarCanalVivo } from "@/lib/channels/adocao";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { isMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import {
  ehEventoSobreMensagem,
  projetarEventos,
} from "@/lib/messaging/projection/project-events";
import { PROJECAO_VAZIA } from "@/lib/messaging/projection/types";
import type { ListMessagesQuery, SendMessageInput } from "@/lib/schemas";
import { sendTemplateForSession } from "@/lib/channels/meta/send-template-for-session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Message } from "@/lib/types/messaging";

type SB = SupabaseClient;

/**
 * Validade da referência de mídia entregue ao canal (spec 004, FR-024 / T038).
 *
 * Era **600 s**. Dez minutos cobrem o canal que baixa na hora e mais nada: com o
 * gateway no caminho, a mensagem pode ficar na fila em disco esperando o CRM (ou
 * o próprio gateway) voltar, e só então o provedor vai buscar o arquivo. Uma
 * referência vencida no meio disso vira anexo que não abre no celular do cliente
 * — e o CRM não fica sabendo, porque para ele o envio deu certo.
 *
 * Uma hora é o piso da FR-024: retentativa do gateway + busca do provedor, com
 * margem para reinício. Não é teto — subir é seguro; descer abaixo de 3600
 * quebra o requisito, e o teste vigia.
 */
export const MEDIA_SIGNED_URL_TTL_S = 60 * 60;

/**
 * Remove a linha que o WEBHOOK criou para a mensagem que ESTE envio acabou de
 * mandar — o "eco do próprio envio".
 *
 * A janela: a linha do envio nasce antes de falar com o canal (`queued`,
 * `external_id` NULL) e só recebe o id depois que o adapter volta. Todo envio
 * retorna pelo webhook como `fromMe=true`; o eco que chega nesse intervalo não
 * acha nada para casar e vira uma segunda linha com a mesma frase.
 *
 * POR QUE AQUI E NÃO NO WEBHOOK. Lá, a única coisa disponível para casar seria a
 * própria linha `queued` — e ela não carrega nada que a identifique como sendo
 * daquela mensagem. Casar por ela é casar por "existe um envio em voo nesta
 * conversa", o que vale para o eco e também para uma mensagem legítima que o
 * atendente digitou no celular enquanto o envio estava em voo: medido, esperado
 * 2 mensagens e obtido 1, com a do celular descartada. Seria o defeito do #108
 * de volta — e permanente, porque nada tira uma linha de `queued`.
 *
 * ATUALIZAÇÃO (issue #129): o cron `recover-stuck-messages` passou a existir
 * (`app/api/v1/cron/recover-stuck-messages/route.ts`), mas ele cobre `sending`,
 * não `queued` — e a diferença é deliberada. `queued` é estado de espera com
 * DONO: o agent-engine reagenda o job (`SEND_QUEUED_RETRY_MS`, 5 min por
 * padrão) enquanto a sessão do canal não está WORKING, e o watchdog redirige.
 * Um cron marcando `queued` como falha depois de 5 min brigaria com essa
 * retentativa e perderia mensagem que ia sair. `sending` não tem dono nenhum —
 * é ali que a linha morre em silêncio.
 *
 * Aqui não há ambiguidade: o canal acabou de devolver o id EXATO da mensagem que
 * mandamos. Casa por id, nunca por proximidade.
 *
 * QUAIS formas o mesmo id pode ter é conhecimento do CANAL, não de quem envia —
 * então os candidatos chegam prontos, de `adapter.echoExternalIds`. Um canal
 * simétrico não implementa o método e o chamador cai no próprio `externalId`.
 *
 * ─── Por que o filtro por `sent_via` saiu (medido em 2026-08-09) ────────────
 *
 * Até aqui o escopo era "mesma conversa E nascido de `external_device`" — o
 * carimbo que o eco recebia quando o transporte anterior o escrevia. Com a spec
 * 004 quem escreve o eco é o GATEWAY, e ele carimba `sent_via = 'crm'`. O filtro
 * deixou de casar, o eco sobreviveu, e o desfecho medido na instância de
 * desenvolvimento foi:
 *
 *   409 · 23505 · duplicate key value violates unique constraint
 *                 "messages_org_external_id_unique"
 *
 * O eco chega em ~200 ms (o gateway é local) e toma o `external_id` antes de o
 * UPDATE deste envio conseguir gravá-lo. O UPDATE então falha, a linha do CRM
 * fica `queued` PARA SEMPRE, e a conversa mostra a mesma frase duas vezes — uma
 * com relógio que nunca vira visto, outra entregue. E o erro do UPDATE era
 * descartado (`const { data } =` sem `error`), então nada ficava vermelho: 3174
 * asserções unitárias e os invariantes estavam verdes o tempo todo.
 *
 * O escopo continua estreito pelo que importa: `external_id` EXATO, devolvido
 * pelo canal para ESTE envio, na mesma conversa e na mesma organização. Isso não
 * pode ser a mensagem de outra pessoa. Restringir também por `sent_via` só
 * acrescentava a suposição de qual processo escreveu o eco — e foi exatamente
 * essa suposição que envelheceu.
 */
async function removerEcoDoProprioEnvio(
  supabase: SB,
  organizationId: string,
  conversationId: string,
  minhaLinhaId: string,
  externalId: string | null,
  candidatos: string[],
): Promise<void> {
  if (!externalId || candidatos.length === 0) return;

  // BLINDADO DE PROPÓSITO. Esta chamada roda dentro do `try` do envio, e a
  // mensagem JÁ SAIU quando chegamos aqui: deixar uma exceção subir faria o
  // `catch` de baixo marcar como `failed` uma mensagem que o cliente recebeu —
  // trocar uma duplicata visível por um status mentiroso. O pior caso aceitável
  // é não conseguir remover, que é exatamente o mundo de antes desta função.
  try {
    const { error } = await supabase
      .from("messages")
      .delete()
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .in("external_id", candidatos)
      // ⚠️ ESTA CLÁUSULA É A ÚNICA COISA QUE IMPEDE O PIOR DESFECHO desta função
      // — apagar a mensagem que acabou de ser entregue. Antes havia um
      // `.eq("sent_via", "external_device")` acima dela que a tornava inalcançável;
      // ele saiu (ver comentário do cabeçalho), então agora ela trabalha de
      // verdade. Na prática a linha deste envio ainda tem `external_id` NULL
      // neste instante e não casaria o `in` de qualquer forma — mas depender
      // disso seria depender de uma ordem de operações que um refactor muda sem
      // avisar.
      .neq("id", minhaLinhaId);
    if (error) console.error("[messages.send] não consegui remover o eco do próprio envio", error.message);
  } catch (err) {
    console.error("[messages.send] a remoção do eco lançou", err instanceof Error ? err.message : err);
  }
}

const MSG_COLS =
  "id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, ack, error_code, error_message, body, media_url, media_mime, media_size_bytes, media_storage_path, sent_via, sent_by_user_id, sent_at, delivered_at, read_at, metadata, created_at";

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: actor.type,
      actor_id: actor.id,
      ...(actor.type === "ai_agent" && actor.api_token_id
        ? { actor_api_token_id: actor.api_token_id }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface MsgCursorPayload {
  sent_at: string;
  id: string;
}

function encodeMsgCursor(p: MsgCursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decodeMsgCursor(raw: string): MsgCursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as MsgCursorPayload;
    if (typeof parsed.id !== "string" || typeof parsed.sent_at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface ListMessagesResult {
  messages: Message[];
  cursor: string | null;
  has_more: boolean;
}

export async function listMessagesHandler(
  supabase: SB,
  ctx: HandlerCtx,
  conversationId: string,
  q: ListMessagesQuery,
): Promise<ListMessagesResult> {
  // A CONSULTA VAI DO MAIS NOVO PARA O MAIS VELHO — de propósito.
  //
  // Antes era `ascending: true`: a primeira página trazia as `limit` mensagens
  // MAIS ANTIGAS da conversa, e as novas ficavam atrás do cursor. Numa conversa
  // com mais mensagens que o limite (50, o padrão), o atendente simplesmente
  // NÃO VIA o que acabou de chegar — a tela travava num ponto do passado e não
  // se mexia mais, por mais que o cliente escrevesse.
  //
  // Medido numa instalação real: conversa com 64 mensagens: a tela parava na
  // #50 (16:15) e as 14 seguintes (16:20 → 16:48) eram invisíveis, embora
  // gravadas. E piora com o uso: quanto mais se conversa com alguém, mais
  // mensagens novas somem. Num CRM de WhatsApp, é a conversa mais importante
  // que fica pior.
  //
  // Chat lê de baixo para cima: o padrão certo é buscar as ÚLTIMAS N e paginar
  // para trás ao rolar. O cursor, portanto, passa a andar para o passado
  // (`lt`), e não mais para o futuro.
  let query = supabase
    .from("messages")
    .select(MSG_COLS)
    .eq("conversation_id", conversationId)
    .eq("organization_id", ctx.organization_id)
    // A REAÇÃO SAI DA LINHA DO TEMPO AQUI, no SQL (spec 006, FR-002).
    //
    // Ela continua sendo uma linha de `messages` — é a fonte da verdade do
    // emoji —, mas como ITEM da conversa ela é o defeito: um emoji solto,
    // cronologicamente posicionado como se o cliente tivesse mandado "👍" em vez
    // de ter reagido a alguma coisa. A projeção a devolve presa ao alvo.
    //
    // No SQL, e não em JavaScript depois, porque filtrar depois encolheria a
    // página abaixo de `limit` e desalinharia o cursor. `type` é `not null`, então
    // `neq` não cai na armadilha de `NOT (null = x)` ser desconhecido — que é o
    // motivo de o evento de apagamento ser filtrado adiante, em memória: ele mora
    // num campo de `metadata` que é nulo na esmagadora maioria das linhas.
    .neq("type", "reaction")
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(q.limit + 1);

  if (q.cursor) {
    const c = decodeMsgCursor(q.cursor);
    if (!c) {
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
    }
    query = query.or(`sent_at.lt.${c.sent_at},and(sent_at.eq.${c.sent_at},id.lt.${c.id})`);
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }

  const rows = (data ?? []) as unknown as Message[];
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;

  // Em ordem decrescente, o ÚLTIMO da página é o mais antigo dela — é dele que
  // sai o cursor, porque a próxima página é a que vem ANTES no tempo.
  const oldest = page[page.length - 1];
  const cursor =
    hasMore && oldest ? encodeMsgCursor({ sent_at: oldest.sent_at, id: oldest.id }) : null;

  // O EVENTO DE APAGAMENTO também não é item da conversa.
  //
  // Ele sai aqui, e não no SQL, porque mora em `metadata->>'original_type'` — que
  // é nulo na esmagadora maioria das linhas, e `not.eq` sobre coluna nula devolve
  // desconhecido, o que faria o Postgres descartar quase TODAS as mensagens em
  // silêncio. O cursor já foi calculado acima, sobre a página completa, então
  // remover aqui não desalinha a paginação: só encurta a página nas raras vezes
  // em que houve apagamento.
  const visiveis = page.filter((m) => !ehEventoSobreMensagem(m));

  const projecoes = await projetarEventos(supabase, ctx.organization_id, visiveis);
  const comProjecao = visiveis.map((m) => ({
    ...m,
    projection: projecoes.get(m.id) ?? PROJECAO_VAZIA,
  }));

  // A RESPOSTA continua cronológica (antigo → novo), igual a antes: o consumidor
  // renderiza de cima para baixo sem mudar nada. O que mudou foi QUAIS mensagens
  // entram na página, não a ordem em que saem.
  return { messages: comProjecao.slice().reverse(), cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

function previewFrom(input: {
  body?: string;
  media_url?: string;
  media_storage_path?: string;
  type?: string;
}): string {
  if (input.body) return input.body.slice(0, 280);
  if (input.media_url || input.media_storage_path) return `[${input.type ?? "media"}]`;
  return "";
}

export async function sendMessageHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: SendMessageInput,
): Promise<Message> {
  // `archived_at` entra pelo helper tolerante porque este é O caminho de saída do
  // sistema inteiro (UI, automação, MCP e o agente passam por aqui): num clone que
  // subiu o código sem a migration 0106, pedir a coluna direto derrubaria TODO
  // envio com 42703. Sem a coluna, nada está arquivado — e a consulta sem ela é a
  // consulta certa (ver lib/channels/archived).
  const convSelect = (comArchived: boolean) =>
    `id, organization_id, contact_id, channel_session_id, is_group, group_chat_id, contacts:contact_id(phone_number, wa_identity, is_blocked), channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status${comArchived ? `, ${ARCHIVED_AT}` : ""})`;
  const { data: conv, error: convErr } = await queryTolerantToMissingArchived(
    () => supabase.from("conversations").select(convSelect(true)).eq("id", input.conversation_id).maybeSingle(),
    () => supabase.from("conversations").select(convSelect(false)).eq("id", input.conversation_id).maybeSingle(),
  );

  if (convErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, convErr.message);
  }
  if (!conv) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Conversa não encontrada.");
  }

  type Joined = {
    id: string;
    organization_id: string;
    contact_id: string;
    channel_session_id: string;
    is_group: boolean;
    group_chat_id: string | null;
    contacts: { phone_number: string | null; wa_identity: string | null; is_blocked: boolean } | null;
    channel_sessions: (ChannelSessionRef & { status: string; archived_at?: string | null }) | null;
  };
  const c = conv as unknown as Joined;

  if (c.contacts?.is_blocked) {
    throw new ApiError(
      403,
      "forbidden",
      undefined,
      ctx.requestId,
      "Contato bloqueou o atendimento.",
    );
  }

  // Canal excluído: antes de recusar, tenta mover a conversa para o único
  // número vivo da organização (ver `lib/channels/adocao.ts` para o porquê de
  // "único"). Roda ANTES do insert de propósito — assim a mensagem já nasce com
  // o canal certo, em vez de nascer no canal morto e ser corrigida depois, que
  // deixaria uma janela em que a linha aponta para onde nada sai.
  if (c.channel_sessions?.archived_at) {
    const adotado = await adotarCanalVivo(supabase, {
      organizationId: c.organization_id,
      conversationId: c.id,
      sessaoAnteriorId: c.channel_session_id,
      requestId: ctx.requestId,
      actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    if (adotado) {
      c.channel_session_id = adotado.id;
      c.channel_sessions = adotado;
    }
  }

  if (input.media_storage_path && !isMediaPathOwnedBy(input.media_storage_path, c.organization_id, c.id)) {
    throw new ApiError(
      422,
      "invalid_media_path",
      undefined,
      ctx.requestId,
      "media_storage_path fora da conversa.",
    );
  }

  // ── Capacidade do canal ANTES da rede (spec 006, FR-018/FR-019) ───────────
  //
  // A pergunta é sobre o que o CANAL permite, nunca sobre qual provider é — o
  // lint de canal proíbe o nome fora de `lib/channels/`. A tela já não deveria
  // ter oferecido a ação; a API não confia na tela.
  const capsDoCanal = capabilitiesOf(c.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER);
  const capExigida = CAPABILITY_POR_TIPO[input.type];
  if (capExigida && capExigida !== "menuMaxOptions" && !capsDoCanal[capExigida]) {
    throw new ApiError(
      422,
      "channel_capability_unsupported",
      undefined,
      ctx.requestId,
      `O canal desta conversa não envia mensagem do tipo "${input.type}".`,
    );
  }
  if (capExigida === "menuMaxOptions") {
    const teto = capsDoCanal.menuMaxOptions;
    if (teto === null) {
      throw new ApiError(
        422,
        "channel_capability_unsupported",
        undefined,
        ctx.requestId,
        "O canal desta conversa não envia menu de opções.",
      );
    }
    // O teto é do CANAL e é imposto ANTES da rede (FR-019). Deixar passar faria o
    // provedor recusar, e o corretor descobriria o limite pelo erro — com o
    // número dele, não com o nosso.
    const opcoes = input.menu?.options.length ?? 0;
    if (opcoes > teto) {
      throw new ApiError(
        422,
        "validation_failed",
        undefined,
        ctx.requestId,
        `Este canal aceita no máximo ${teto} opções no menu; você enviou ${opcoes}.`,
      );
    }
  }
  if (input.reply_to_message_id && !capsDoCanal.quotedReply) {
    throw new ApiError(
      422,
      "channel_capability_unsupported",
      undefined,
      ctx.requestId,
      "O canal desta conversa não permite responder citando uma mensagem.",
    );
  }

  // ── O alvo da citação (FR-011/FR-012) ─────────────────────────────────────
  //
  // Resolvido AQUI, antes do insert, porque uma citação que não resolve não pode
  // virar mensagem: sair sem a citação em silêncio é o desfecho que a FR-012
  // proíbe — o cliente receberia a resposta solta, e ninguém saberia.
  let replyToExternalId: string | undefined;
  if (input.reply_to_message_id) {
    const { data: alvo } = await supabase
      .from("messages")
      .select("id, external_id, conversation_id")
      .eq("id", input.reply_to_message_id)
      .eq("organization_id", c.organization_id)
      .eq("conversation_id", c.id)
      .maybeSingle();

    if (!alvo) {
      // 404, e não 403: confirmar a existência de uma linha de outra organização
      // já é vazamento — a resposta diria "existe, mas não é sua".
      throw new ApiError(
        404,
        "not_found",
        undefined,
        ctx.requestId,
        "Mensagem citada não encontrada nesta conversa.",
      );
    }
    const externo = (alvo as { external_id: string | null }).external_id;
    if (!externo) {
      // Mensagem ainda em envio não tem endereço no canal. Recusar é o certo:
      // mandar sem a citação entregaria uma resposta ambígua sem avisar ninguém.
      throw new ApiError(
        422,
        "reply_target_not_addressable",
        undefined,
        ctx.requestId,
        "A mensagem citada ainda não foi confirmada pelo canal. Tente de novo em instantes.",
      );
    }
    replyToExternalId = externo;
  }

  const now = new Date().toISOString();
  const insertRow = {
    organization_id: c.organization_id,
    conversation_id: c.id,
    channel_session_id: c.channel_session_id,
    contact_id: c.contact_id,
    type: input.type,
    direction: "outbound" as const,
    status: "queued",
    body: input.body ?? null,
    media_url: input.media_url ?? null,
    media_mime: input.media_mime ?? null,
    media_storage_path: input.media_storage_path ?? null,
    media_size_bytes: input.media_size_bytes ?? null,
    sent_via: ctx.actor.type !== "user" ? ("ai" as const) : ("user" as const),
    sent_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    sent_at: now,
    metadata: {
      ...(input.metadata ?? {}),
      ...(ctx.actor.type === "ai_agent" ? { ai_actor_id: ctx.actor.id } : {}),
      // A citação é gravada no MESMO campo em que ela chega do canal. É o que faz
      // a projeção exibir a citação da nossa mensagem sem nenhum ramo especial —
      // e o que faz a bolha do corretor mostrar o trecho igual à do cliente.
      ...(replyToExternalId ? { reply_to_external_id: replyToExternalId } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.contacts ? { contacts: input.contacts } : {}),
      ...(input.menu ? { menu: input.menu } : {}),
      ...(input.cta_url ? { cta_url: input.cta_url } : {}),
    },
  };

  const { data: created, error: insErr } = await supabase
    .from("messages")
    .insert(insertRow)
    .select(MSG_COLS)
    .single();

  if (insErr || !created) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      ctx.requestId,
      insErr?.message ?? "insert_failed",
    );
  }
  let message = created as unknown as Message;

  // O canal vem da SESSÃO (migration 0087), não de um literal. O fallback só
  // alcança o caso em que o embed não trouxe a sessão — impossível hoje
  // (`conversations.channel_session_id` é NOT NULL com FK ON DELETE RESTRICT),
  // e ainda assim mantido para não trocar o desfecho desse ramo defensivo.
  const adapter = getAdapter(c.channel_sessions?.provider ?? DEFAULT_CHANNEL_PROVIDER);
  const chatId = adapter.resolveRecipient({
    isGroup: c.is_group,
    groupChatId: c.group_chat_id,
    phoneNumber: c.contacts?.phone_number,
    waIdentity: c.contacts?.wa_identity,
  });

  if (c.channel_sessions?.archived_at) {
    // Canal ARQUIVADO = canal excluído pelo usuário: a sessão já foi deslogada e
    // removida do transporte, e a credencial do canal oficial já foi revogada. É a
    // promessa da migration 0106 ("não é mais elegível para envio") virando
    // comportamento.
    //
    // `failed` e não `queued` de propósito: fila implica "vai sair quando der", e
    // por este canal não vai sair nunca. Falha com código é o que aparece na tela
    // e é o que o ledger do agente lê como desfecho TERMINAL — em `queued` o
    // follow-up ficaria retentando contra um número que não existe mais.
    // Vem ANTES de `isConfigured`: um canal excluído não espera configuração.
    const { data: updated } = await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: "channel_archived",
        error_message: "Este número foi excluído da Central de Conexões.",
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!adapter.isConfigured()) {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: { ...(message.metadata ?? {}), queued_reason: adapter.codes.notConfigured },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!chatId) {
    // Duas causas MUITO diferentes caem aqui, e até 2026-08-08 as duas saíam
    // como "contato sem telefone" (spec 004, FR-025 / T039). Numa conversa de
    // grupo isso é mentira: o grupo não tem telefone nenhum e nunca vai ter, e
    // quem lê fica procurando um cadastro para consertar. O desfecho continua o
    // MESMO — `failed`, o envio segue impedido —, só o motivo passa a ser
    // verdadeiro. Canal que SABE endereçar grupo devolve o endereço em
    // `resolveRecipient` e não chega aqui: nada mudou para ele.
    const ehGrupo = c.is_group;
    const { data: updated } = await supabase
      .from("messages")
      .update({
        status: "failed",
        error_code: ehGrupo ? "group_send_unsupported" : "missing_phone_number",
        error_message: ehGrupo
          ? "Este canal não envia mensagem para conversa de grupo."
          : "Contato sem telefone para envio WhatsApp.",
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else if (!c.channel_sessions || c.channel_sessions.status !== "WORKING") {
    const { data: updated } = await supabase
      .from("messages")
      .update({
        metadata: {
          ...(message.metadata ?? {}),
          queued_reason: "channel_session_not_working",
        },
      })
      .eq("id", message.id)
      .select(MSG_COLS)
      .maybeSingle();
    if (updated) message = updated as unknown as Message;
  } else {
    try {
      // O que separa mídia de texto é a presença de `media` no envelope — o
      // adapter preserva o mesmo branch (e a mesma mensagem de erro de cada
      // método) do outro lado do seam.
      let externalId: string | null;
      if (input.type === "template") {
        // Template é caminho próprio: não passa pelo `adapter.send` (que fala em
        // texto/mídia) porque o payload da plataforma é outro — e porque o envio
        // exige checar o contrato ANTES de sair (bind vigente, valores completos),
        // coisa que só faz sentido para template.
        externalId = await sendTemplateForSession(supabase, {
          organizationId: ctx.organization_id,
          to: chatId,
          name: input.template_name ?? "",
          language: input.template_language ?? "",
          values: input.template_values ?? {},
        });
      } else if (input.media_storage_path) {
        // Storage-first: referência de endereço só pro canal baixar (nunca base64).
        const admin = createAdminClient();
        const { data: signed, error: signErr } = await admin.storage
          .from("whatsapp-media")
          .createSignedUrl(input.media_storage_path, MEDIA_SIGNED_URL_TTL_S);
        if (signErr || !signed?.signedUrl) {
          throw new Error(`storage_sign_failed: ${signErr?.message ?? "no_url"}`);
        }
        const filename = input.media_storage_path.split("/").pop() ?? undefined;
        ({ externalId } = await adapter.send({
          sessionRef: resolveSessionRef(c.channel_sessions),
          to: chatId,
          kind: input.type,
          replyToExternalId,
          media: {
            url: signed.signedUrl,
            mime: input.media_mime ?? "application/octet-stream",
            filename,
            caption: input.body ?? null,
          },
        }));
      } else {
        ({ externalId } = await adapter.send({
          sessionRef: resolveSessionRef(c.channel_sessions),
          to: chatId,
          kind: input.type,
          body: input.body ?? "",
          replyToExternalId,
          // Localização e contato viajam como carga própria, não como texto: o
          // canal precisa de coordenada e de cartão, não de uma frase que os
          // descreva.
          location: input.location,
          contacts: input.contacts,
          menu: input.menu,
          ctaUrl: input.cta_url,
        }));
      }
      await removerEcoDoProprioEnvio(
        supabase,
        ctx.organization_id,
        c.id,
        message.id,
        externalId,
        externalId ? (adapter.echoExternalIds?.({ externalId, recipient: chatId }) ?? [externalId]) : [],
      );
      const carimbo = {
        status: "sent",
        external_id: externalId,
        ack: 0,
        // Colunas só do template — é o que responde custo e conformidade de
        // janela depois, sem varrer jsonb.
        ...(input.type === "template"
          ? { template_name: input.template_name, template_language: input.template_language }
          : {}),
      };
      const carimbar = () =>
        supabase.from("messages").update(carimbo).eq("id", message.id).select(MSG_COLS).maybeSingle();

      let { data: updated, error: erroCarimbo } = await carimbar();

      // 23505 aqui significa UMA coisa: o eco deste mesmo envio chegou entre a
      // remoção acima e este UPDATE, e levou o `external_id`. A janela é de
      // milissegundos e o gateway é local, então ela é ESTREITA mas real — foi o
      // que produziu, medido, linha `queued` permanente com a mensagem entregue.
      // Remover o eco e carimbar de novo preserva a linha do CRM, que é a única
      // que sabe QUEM mandou (`sent_by_user_id`, `sent_via`) — adotar a do eco
      // perderia a autoria.
      if (erroCarimbo?.code === "23505") {
        await removerEcoDoProprioEnvio(
          supabase,
          ctx.organization_id,
          c.id,
          message.id,
          externalId,
          externalId ? (adapter.echoExternalIds?.({ externalId, recipient: chatId }) ?? [externalId]) : [],
        );
        ({ data: updated, error: erroCarimbo } = await carimbar());
      }

      // Falhar aqui NÃO é motivo para marcar `failed`: a mensagem saiu, o
      // cliente recebeu. Mas o silêncio de antes é o que tornou isto invisível
      // por uma spec inteira — o desfecho fica no log, sempre.
      if (erroCarimbo) {
        console.error(
          "[messages.send] mensagem entregue mas a linha não recebeu o external_id",
          JSON.stringify({ message_id: message.id, external_id: externalId, code: erroCarimbo.code }),
        );
      }
      if (updated) message = updated as unknown as Message;
    } catch (err) {
      const msg = err instanceof Error ? err.message : adapter.codes.unknownError;
      // `storage_sign_failed` fica literal: é falha do NOSSO Storage, não do
      // canal — a URL assinada é montada antes de qualquer coisa tocar o adapter.
      const code = msg.startsWith("storage_sign_failed")
        ? "storage_sign_failed"
        : adapter.codes.sendFailed;
      const { data: updated } = await supabase
        .from("messages")
        .update({
          status: "failed",
          error_code: code,
          error_message: msg,
        })
        .eq("id", message.id)
        .select(MSG_COLS)
        .maybeSingle();
      if (updated) message = updated as unknown as Message;
    }
  }

  await supabase
    .from("conversations")
    .update({
      last_outbound_at: now,
      last_message_at: now,
      last_message_preview: previewFrom({
        body: input.body,
        media_url: input.media_url,
        media_storage_path: input.media_storage_path,
        type: input.type,
      }),
    })
    .eq("id", c.id);

  const a = actorAuditPayload(ctx.actor);
  await audit({
    action: "message.sent",
    actorUserId: a.actorUserId,
    organizationId: c.organization_id,
    resourceType: "message",
    resourceId: message.id,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, status: message.status, type: message.type },
  });

  await supabase
    .rpc("emit_event", {
      p_event_type: "message.sent",
      p_entity_kind: "message",
      p_entity_id: message.id,
      p_payload: { status: message.status, conversation_id: c.id },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: c.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[messages.send] emit_event failed", error.message);
    });

  return message;
}
