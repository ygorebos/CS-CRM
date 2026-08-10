"use client";
import { ArrowBendUpLeft } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { MessageQuote } from "@/lib/messaging/projection/types";

/**
 * O trecho citado, acima da mensagem que responde.
 *
 * Sem isto, uma resposta a um cliente que mandou cinco perguntas seguidas é
 * ambígua: lê-se "pode ser" sem saber a qual pergunta. O vínculo sempre existiu
 * no banco; o que faltava era exibi-lo.
 */

/** O que dizer quando o citado não tem texto — anexo sem legenda, por exemplo. */
const ROTULO_POR_TIPO: Record<string, string> = {
  image: "Foto",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
  template: "Mensagem modelo",
};

export function QuotedPreview({
  quote,
  isOutbound,
}: {
  quote: MessageQuote;
  isOutbound: boolean;
}) {
  const autor = quote.isUnavailable ? null : quote.authorKind === "outbound" ? "Você" : "Contato";

  // Ordem importa: indisponível primeiro (não há nada a dizer sobre o conteúdo),
  // depois o texto, e só então o rótulo do tipo. Trocar a ordem faria um anexo
  // com legenda mostrar "Foto" em vez da legenda.
  const texto = quote.isUnavailable
    ? "Mensagem original indisponível"
    : quote.preview !== ""
      ? quote.preview
      : (ROTULO_POR_TIPO[quote.type] ?? "Mensagem");

  return (
    <div
      data-testid="citacao-de-mensagem"
      data-indisponivel={quote.isUnavailable ? "true" : "false"}
      className={cn(
        "mb-1 flex gap-1.5 rounded-md border-l-2 px-2 py-1 text-[11px] leading-snug",
        isOutbound
          ? "border-primary-foreground/50 bg-primary-foreground/10"
          : "border-primary/50 bg-foreground/5",
      )}
    >
      <ArrowBendUpLeft size={12} weight="bold" className="mt-0.5 shrink-0 opacity-60" aria-hidden />
      <div className="min-w-0">
        {autor && <div className="font-semibold opacity-80">{autor}</div>}
        <div
          className={cn(
            "truncate opacity-70",
            // Mensagem apagada continua legível na citação, marcada — a mesma
            // regra da bolha (FR-005): a evidência do que foi dito não some
            // porque o contato voltou atrás.
            quote.isDeleted && "italic line-through",
          )}
        >
          {texto}
        </div>
        {quote.isDeleted && (
          <div className="text-[10px] font-medium opacity-60">apagada pelo contato</div>
        )}
      </div>
    </div>
  );
}
