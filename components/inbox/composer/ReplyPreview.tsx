"use client";
import { ArrowBendUpLeft, Plus } from "@/lib/ui/icons";
import type { ReplyTarget } from "@/components/inbox/message/reply-target";

/** O que dizer quando o alvo não tem texto — anexo sem legenda, por exemplo. */
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

/**
 * A citação em preparo, acima do campo de escrita.
 *
 * Ela é o que torna a ação reversível: sem o cancelar visível, o corretor que
 * clicou na mensagem errada só descobre o engano depois de o cliente receber. E
 * é o que faz a contagem de SC-003 fechar em duas ações — preparar e enviar —,
 * porque a preparação já mostra o resultado.
 */
export function ReplyPreview({
  alvo,
  onCancelar,
}: {
  alvo: ReplyTarget;
  onCancelar: () => void;
}) {
  const autor = alvo.authorKind === "outbound" ? "Você" : "Contato";
  const texto = alvo.preview.trim() !== "" ? alvo.preview : (ROTULO_POR_TIPO[alvo.type] ?? "Mensagem");

  return (
    <div
      data-testid="citacao-em-preparo"
      data-message-id={alvo.messageId}
      className="mb-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/60 px-2 py-1.5 text-xs"
    >
      <ArrowBendUpLeft size={14} weight="bold" className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Respondendo a {autor}</div>
        <div className="truncate opacity-70">{texto}</div>
      </div>
      <button
        type="button"
        onClick={onCancelar}
        aria-label="Cancelar citação"
        className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
      >
        {/* `Plus` girado 45° é o "x" do barril de ícones — o barril não exporta um
            X, e importar direto do Phosphor é o que o ADR-05 proíbe. */}
        <Plus size={14} weight="bold" className="rotate-45" aria-hidden />
      </button>
    </div>
  );
}
