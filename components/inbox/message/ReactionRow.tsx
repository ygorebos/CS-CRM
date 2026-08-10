"use client";
import { cn } from "@/lib/utils";
import type { MessageReaction } from "@/lib/messaging/projection/types";

/**
 * As reações, PRESAS à mensagem que as recebeu.
 *
 * Antes, a reação entrava na conversa como mensagem própria: um emoji solto,
 * cronologicamente posicionado como se o cliente tivesse mandado "👍" em vez de
 * ter reagido a alguma coisa. A linha continua existindo no banco — ela é a fonte
 * da verdade do emoji —, mas o lugar dela na tela é aqui.
 *
 * É ESTADO, não histórico: no máximo uma por autor, a mais recente. Reação
 * removida não chega aqui — some na projeção.
 */
export function ReactionRow({
  reactions,
  isOutbound,
}: {
  reactions: MessageReaction[];
  isOutbound: boolean;
}) {
  if (reactions.length === 0) return null;

  return (
    <div
      data-testid="reacoes-da-mensagem"
      className={cn("mt-1 flex flex-wrap gap-1", isOutbound ? "justify-end" : "justify-start")}
    >
      {reactions.map((r) => (
        <span
          key={`${r.actorKind}:${r.emoji}`}
          data-testid="reacao"
          data-autor={r.actorKind}
          title={r.actorKind === "outbound" ? "Reação da sua equipe" : "Reação do contato"}
          className={cn(
            "inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs leading-none",
            isOutbound
              ? "border-primary-foreground/30 bg-primary-foreground/15"
              : "border-border bg-background",
          )}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
