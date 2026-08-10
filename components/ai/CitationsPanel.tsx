"use client";
import { descreverOrigem, type Citation } from "@/lib/ai/citations/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  citations: Citation[];
  messageId?: string;
}

const SOURCE_LABEL: Record<string, string> = {
  faq: "FAQ",
  policy: "Política",
  conversation: "Conversa",
  conversations: "Conversa",
  catalog: "Catálogo",
  nuvemshop_catalog: "Catálogo",
};

export function CitationsPanel({
  open,
  onOpenChange,
  citations,
  messageId,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Citações da resposta IA</SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-4 overflow-y-auto pr-2">
          {citations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Resposta sem RAG hits — modelo respondeu sem usar a base de
              conhecimento.
            </p>
          ) : (
            citations.map((c, i) => {
              // FR-039 / T107: a camada não é enfeite — ela diz A QUEM o corretor cobra a
              // correção. Material dele, ele mesmo; material do catálogo, quem o cura.
              const origem = descreverOrigem(c);
              return (
                <div
                  key={c.chunk_id ?? `cit-${i}`}
                  className="rounded-md border p-3 text-sm"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1">
                      {origem.camadaRotulo && (
                        <Badge
                          variant={origem.camada === "tenant" ? "default" : "outline"}
                        >
                          {origem.camadaRotulo}
                        </Badge>
                      )}
                      <Badge variant="secondary">
                        {SOURCE_LABEL[c.source_type ?? ""] ??
                          c.source_type ??
                          "Fonte"}
                      </Badge>
                    </div>
                    {typeof c.score === "number" && (
                      <span className="text-xs text-muted-foreground">
                        {Math.round(c.score * 100)}%
                      </span>
                    )}
                  </div>
                  {(origem.titulo || origem.escopo) && (
                    <p className="mb-1 text-xs font-medium text-foreground/80">
                      {[origem.escopo, origem.titulo].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {c.source_anchor && (
                    <p className="mb-1 text-xs text-muted-foreground">
                      {c.source_anchor}
                    </p>
                  )}
                  {(c.snippet ?? c.text) && (
                    <p className="line-clamp-4 text-foreground/90">
                      {(c.snippet ?? c.text ?? "").slice(0, 200)}
                    </p>
                  )}
                  {origem.atualizadoEm && (
                    // Data DO MATERIAL, não da resposta: é o que deixa o corretor ver que
                    // ancorou em algo de janeiro quando a regra mudou em junho.
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      material atualizado em{" "}
                      {new Date(origem.atualizadoEm).toLocaleDateString("pt-BR")}
                    </p>
                  )}
                </div>
              );
            })
          )}
          {messageId && (
            <p className="pt-2 text-[10px] text-muted-foreground">
              message_id: {messageId}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
