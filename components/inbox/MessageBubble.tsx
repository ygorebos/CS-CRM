"use client";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Check, Checks, Robot, WarningOctagon } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Message } from "@/lib/types/messaging";
import { CitationButton } from "@/components/ai/CitationButton";
import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { QuotedPreview } from "@/components/inbox/message/QuotedPreview";
import { ReactionRow } from "@/components/inbox/message/ReactionRow";
import { UnsupportedNotice } from "@/components/inbox/message/UnsupportedNotice";
import { useReplyTarget } from "@/components/inbox/message/reply-target";
import { MenuOptions } from "@/components/inbox/message/MenuOptions";
import { lerContatos, lerLocalizacao, lerMenu } from "@/lib/messaging/payloads";
import { PROJECAO_VAZIA } from "@/lib/messaging/projection/types";
import { ArrowBendUpLeft, Prohibit } from "@/lib/ui/icons";
import {
  deveMostrarOrigem,
  extractCitations,
  isAiGeneratedMessage,
} from "@/lib/ai/citations/types";

interface Props {
  message: Message;
  /**
   * @deprecated Não decide mais se a origem aparece (spec 002, FR-022 · T106).
   *
   * A rastreabilidade saiu de trás do modo de depuração: o corretor chega ao trecho sem
   * ativar interruptor nenhum. A prop continua aceita para não quebrar os chamadores, e
   * é ignorada de propósito — removê-la da assinatura é limpeza de outro commit.
   */
  debugCitations?: boolean;
}

function AckIndicator({ status }: { status: string }) {
  if (status === "read") {
    return <Checks size={12} weight="bold" className="text-blue-400" aria-label="Lida" />;
  }
  if (status === "delivered") {
    return <Checks size={12} weight="bold" className="text-current/70" aria-label="Entregue" />;
  }
  if (status === "sent") {
    return <Check size={12} weight="bold" className="text-current/70" aria-label="Enviada" />;
  }
  return null;
}

export function MessageBubble({ message, debugCitations }: Props) {
  const isOutbound = message.direction === "outbound";
  const time = format(new Date(message.sent_at), "HH:mm", { locale: ptBR });
  const isFailed = message.status === "failed";
  const hasMedia = Boolean(message.media_url || message.media_storage_path);
  // Localização e cartão de contato não têm arquivo, mas têm conteúdo. Enquanto
  // o gate era só `hasMedia`, os dois nunca chegavam ao renderer e a bolha saía
  // em branco com a carga gravada no banco.
  const hasCargaPropria =
    (message.type === "location" && lerLocalizacao(message.metadata) !== null) ||
    (message.type === "contact" && lerContatos(message.metadata).length > 0);
  const hasConteudo = hasMedia || hasCargaPropria;
  // As opções do menu: medido enviando um de verdade, a bolha mostrava só a
  // pergunta e a lista sumia da tela — ver `MenuOptions`.
  const menu = message.type === "menu" ? lerMenu(message.metadata) : null;
  // Figurinha sem caption: sem moldura de bolha (padrão WhatsApp).
  const isBareSticker = hasMedia && message.type === "sticker" && !message.body;
  const projection = message.projection ?? PROJECAO_VAZIA;
  const isDeleted = projection.deletion !== null;
  const { citar, habilitado: podeCitar } = useReplyTarget();
  // Citar exige endereço no canal: sem `external_id` não há o que mandar como
  // `quoted_id`, e oferecer levaria a uma recusa depois do clique.
  const mostrarResponder = podeCitar && Boolean(message.external_id);

  function prepararCitacao() {
    citar({
      messageId: message.id,
      authorKind: message.direction,
      type: message.type,
      preview: (message.body ?? "").slice(0, 160),
    });
  }
  const aiGenerated = isAiGeneratedMessage(message.metadata);
  const citations = extractCitations(message.metadata);
  // FR-022 / T106: a origem aparece por padrão. A regra vive em `deveMostrarOrigem`,
  // testada em `lib/ai/citations/origem.test.ts` — e não recebe `debugCitations`, que é
  // como se garante que nenhum interruptor volte a decidir isto por acidente.
  const showCitationButton = deveMostrarOrigem({
    isOutbound,
    metadata: message.metadata,
  });
  const senderLabel = (() => {
    if (!isOutbound) return null;
    if (message.sent_via === "ai") return "IA";
    return null;
  })();

  return (
    // O testid marca a BOLHA, e não o texto. Contar por texto casa também a
    // prévia da conversa na listagem, que repete o corpo da última mensagem —
    // medido em 2026-08-08: com duas mensagens idênticas no banco, uma contagem
    // por texto devolvia 1 e o teste de "não duplica" passava verde com a
    // idempotência sabotada.
    <div
      data-testid="bolha-de-mensagem"
      className={cn(
        "group flex w-full items-center gap-1 px-4 py-1",
        isOutbound ? "justify-end" : "justify-start",
      )}
    >
      {/* O gesto fica FORA da bolha, do lado de dentro da conversa, e aparece no
          hover — é onde o WhatsApp e todo cliente de chat o põem, então o
          corretor o procura ali sem instrução (SC-008). Ordem invertida por
          direção para que ele nunca cubra o texto. */}
      {mostrarResponder && isOutbound && (
        <BotaoResponder onClick={prepararCitacao} />
      )}
      <div
        className={cn(
          "max-w-[75%] text-sm",
          isBareSticker
            ? "px-0 py-0"
            : cn(
                "rounded-2xl px-3 py-2 shadow-sm",
                isOutbound
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground",
              ),
          isFailed && "border border-destructive",
        )}
      >
        {senderLabel && (
          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-80">
            {senderLabel === "IA" ? (
              <Robot size={10} weight="duotone" aria-hidden />
            ) : null}
            {senderLabel}
          </div>
        )}

        {projection.quote && (
          <QuotedPreview quote={projection.quote} isOutbound={isOutbound} />
        )}

        {isDeleted && (
          // FR-005: a mensagem apagada CONTINUA visível, marcada. A decisão é
          // deliberada e diverge do WhatsApp: o corretor precisa da evidência do
          // que foi combinado antes de o cliente voltar atrás. O que a marca
          // acrescenta é que o contato já não vê aquilo no aparelho dele.
          <div
            data-testid="marca-de-apagada"
            className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide opacity-70"
          >
            <Prohibit size={11} weight="bold" aria-hidden />
            {projection.deletion?.deletedByKind === "outbound"
              ? "Apagada pela sua equipe"
              : "Apagada pelo contato"}
          </div>
        )}

        {hasConteudo && (
          <div className={cn(message.body && "mb-1", isDeleted && "opacity-60")}>
            <MediaRenderer message={message} />
          </div>
        )}

        {message.body && (
          <p
            className={cn(
              "whitespace-pre-wrap break-words leading-snug",
              // Riscado: continua legível, e ninguém confunde com mensagem viva.
              isDeleted && "italic line-through opacity-70",
            )}
          >
            {message.body}
          </p>
        )}

        {menu && <MenuOptions menu={menu} isOutbound={isOutbound} />}

        {projection.unsupported && <UnsupportedNotice unsupported={projection.unsupported} />}

        <div
          className={cn(
            "mt-1 flex items-center justify-end gap-1 text-[10px]",
            isOutbound ? "text-primary-foreground/70" : "text-muted-foreground",
          )}
        >
          <span>{time}</span>
          {showCitationButton && (
            <CitationButton citations={citations} messageId={message.id} />
          )}
          {isOutbound && !isFailed && <AckIndicator status={message.status} />}
          {isFailed && (
            // Provider local: o painel do inbox não tem TooltipProvider ancestral e
            // este Tooltip só monta em mensagem failed — sem o provider, abrir uma
            // conversa com falha de envio derrubava o painel inteiro (error boundary).
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-0.5 font-semibold text-destructive">
                    <WarningOctagon size={10} weight="fill" aria-hidden /> Falhou
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {message.error_message ?? message.error_code ?? "Erro desconhecido"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>

        <ReactionRow reactions={projection.reactions} isOutbound={isOutbound} />
      </div>
      {mostrarResponder && !isOutbound && <BotaoResponder onClick={prepararCitacao} />}
    </div>
  );
}

/**
 * O gesto que prepara a citação.
 *
 * Visível no hover e SEMPRE alcançável por teclado (`focus:opacity-100`): esconder
 * atrás do mouse tiraria a ação de quem navega por Tab, e o teste de tela conta
 * cliques, não pixels.
 */
function BotaoResponder({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="responder-citando"
      aria-label="Responder citando esta mensagem"
      onClick={onClick}
      className="shrink-0 rounded-full p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
    >
      <ArrowBendUpLeft size={14} weight="bold" aria-hidden />
    </button>
  );
}
