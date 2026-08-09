/**
 * Quando o corretor troca de número, a conversa vai junto.
 *
 * ─── O defeito que isto conserta (medido em 2026-08-09) ──────────────────────
 *
 * `conversations.channel_session_id` é NOT NULL e aponta para a sessão em que a
 * conversa nasceu. Excluir um número na Central grava `archived_at` na sessão
 * (migration 0106) — mas NÃO mexe nas conversas. Resultado medido na instância
 * de desenvolvimento: 16 conversas ficaram apontando para a sessão arquivada, e
 * `sendMessageHandler` passou a recusar TODAS com `channel_archived`:
 *
 *     "Este número foi excluído da Central de Conexões."
 *
 * A caixa de entrada inteira virou somente-leitura, para sempre, sem caminho de
 * volta pela tela. E o produto já prometia o contrário na própria mensagem de
 * erro do repareamento (`channel-sessions/[id]/reconnect/route.ts`):
 * *"Conecte um número para voltar a atender."* Conectar não trazia ninguém de
 * volta — a promessa existia só no texto.
 *
 * ─── Por que adotar, e não recusar ───────────────────────────────────────────
 *
 * Não existe responder por um número que foi deslogado: a credencial já foi
 * revogada e a sessão removida do transporte. As duas saídas possíveis são
 * *mover a conversa para o número vivo* ou *silêncio permanente*. Silêncio
 * permanente perde o cliente do corretor, que não fez nada de errado — trocar de
 * número é operação normal.
 *
 * O cliente do outro lado VAI ver a mensagem chegar de um número diferente. Isso
 * é consequência inerente de trocar de número, não escolha desta função: é o que
 * aconteceria de qualquer jeito assim que o corretor mandasse a primeira
 * mensagem pelo aparelho novo.
 *
 * ─── Por que só quando há EXATAMENTE um canal vivo ───────────────────────────
 *
 * Com dois ou mais números ativos, escolher um é adivinhar por qual identidade o
 * corretor quer falar com aquele cliente — e a escolha errada manda o histórico
 * pelo número errado, o que é pior que a recusa. Zero ou vários: a função devolve
 * `null` e o chamador mantém o desfecho de hoje, que ao menos é honesto.
 *
 * A adoção é IDEMPOTENTE por natureza: depois dela a conversa não está mais
 * arquivada, então a chamada seguinte nem entra aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { CHANNEL_SESSION_REF_COLUMNS, type ChannelSessionRef } from "./session-ref";

/** A sessão viva que a conversa passou a usar. */
export type CanalVivo = ChannelSessionRef & {
  id: string;
  status: string;
  archived_at?: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = SupabaseClient<any, "public", any>;

export interface AdocaoInput {
  organizationId: string;
  conversationId: string;
  /** A sessão arquivada de onde a conversa está saindo — vai para a auditoria. */
  sessaoAnteriorId: string;
  requestId?: string | null;
  actorUserId?: string | null;
}

/**
 * Repõe a conversa no único canal vivo da organização. Devolve o canal adotado,
 * ou `null` quando não há exatamente um — caso em que nada foi alterado.
 */
export async function adotarCanalVivo(supabase: SB, input: AdocaoInput): Promise<CanalVivo | null> {
  const colunas = (comArchived: boolean) =>
    `id, status, ${CHANNEL_SESSION_REF_COLUMNS}${comArchived ? `, ${ARCHIVED_AT}` : ""}`;

  // `limit(2)` e não `limit(1)`: precisamos distinguir "um canal" de "vários",
  // e um `limit(1)` responderia "achei" nos dois casos — adotando em silêncio
  // justamente na situação ambígua em que a função não deve agir.
  const { data, error } = await queryTolerantToMissingArchived(
    () =>
      supabase
        .from("channel_sessions")
        .select(colunas(true))
        .eq("organization_id", input.organizationId)
        .eq("status", "WORKING")
        .is(ARCHIVED_AT, null)
        .limit(2),
    () =>
      supabase
        .from("channel_sessions")
        .select(colunas(false))
        .eq("organization_id", input.organizationId)
        .eq("status", "WORKING")
        .limit(2),
  );

  if (error || !data || data.length !== 1) return null;

  const vivo = data[0] as unknown as CanalVivo;
  if (vivo.id === input.sessaoAnteriorId) return null;

  // O filtro por organização acompanha o UPDATE mesmo com a conversa já
  // resolvida: este caminho também roda sob service role (agente, automação,
  // MCP), onde a RLS não protege sozinha.
  const { error: erroUpdate } = await supabase
    .from("conversations")
    .update({ channel_session_id: vivo.id })
    .eq("id", input.conversationId)
    .eq("organization_id", input.organizationId);

  if (erroUpdate) return null;

  // Mudar por qual número o cliente recebe é fato relatável — auditar em
  // silêncio seria a mesma classe de defeito que este arquivo conserta.
  void audit({
    action: "channel.conversation_adopted",
    organizationId: input.organizationId,
    actorUserId: input.actorUserId ?? null,
    resourceType: "conversation",
    resourceId: input.conversationId,
    metadata: {
      from_channel_session_id: input.sessaoAnteriorId,
      to_channel_session_id: vivo.id,
      reason: "previous_channel_archived",
    },
    requestId: input.requestId ?? null,
  });

  return vivo;
}
