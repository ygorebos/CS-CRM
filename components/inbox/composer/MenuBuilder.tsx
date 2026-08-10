"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash } from "@/lib/ui/icons";
import { menuPayloadSchema, type MenuPayload } from "@/lib/messaging/payloads";

/**
 * Montar um menu de opções clicáveis.
 *
 * O TETO vem do canal (`menuMaxOptions`), não daqui: o WhatsApp desenha botões
 * até 3 opções e lista acima disso, e o canal oficial recusa acima de 10. Um
 * número fixo nesta tela seria a matriz de capacidade escrita duas vezes — e a
 * segunda cópia envelhece.
 *
 * O limite é imposto **antes** do envio, com o número do canal na mensagem:
 * descobrir o teto pelo erro do provedor é descobrir na cara do corretor.
 */
export function MenuBuilder({
  open,
  onOpenChange,
  maxOptions,
  onEnviar,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  maxOptions: number;
  onEnviar: (texto: string, menu: MenuPayload) => void;
}) {
  const [texto, setTexto] = useState("");
  const [opcoes, setOpcoes] = useState<string[]>(["", ""]);
  const [rodape, setRodape] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  function confirmar() {
    const limpas = opcoes.map((o) => o.trim()).filter(Boolean);
    if (texto.trim() === "") {
      setErro("Escreva a pergunta que acompanha as opções.");
      return;
    }
    if (limpas.length > maxOptions) {
      setErro(`Este canal aceita no máximo ${maxOptions} opções; você montou ${limpas.length}.`);
      return;
    }
    const r = menuPayloadSchema.safeParse({
      options: limpas,
      footer: rodape.trim() || undefined,
    });
    if (!r.success) {
      setErro(r.error.issues.map((i) => i.message).join("; "));
      return;
    }
    setErro(null);
    onEnviar(texto.trim(), r.data);
    onOpenChange(false);
    setTexto("");
    setOpcoes(["", ""]);
    setRodape("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialogo-menu">
        <DialogHeader>
          <DialogTitle>Enviar opções</DialogTitle>
          <DialogDescription>
            O cliente responde tocando, em vez de digitar. Até {maxOptions} opções neste canal.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="menu-texto">Pergunta</Label>
            <Input
              id="menu-texto"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Qual plano te interessa?"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Opções</Label>
            {opcoes.map((o, i) => (
              <div key={i} className="flex items-center gap-1">
                <Input
                  value={o}
                  aria-label={`Opção ${i + 1}`}
                  onChange={(e) =>
                    setOpcoes((atual) => atual.map((v, j) => (j === i ? e.target.value : v)))
                  }
                  placeholder={i === 0 ? "Individual" : "Familiar"}
                />
                {opcoes.length > 1 && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remover opção ${i + 1}`}
                    onClick={() => setOpcoes((atual) => atual.filter((_, j) => j !== i))}
                  >
                    <Trash size={14} aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {opcoes.length < maxOptions && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="justify-start"
                onClick={() => setOpcoes((atual) => [...atual, ""])}
              >
                <Plus size={14} aria-hidden /> Acrescentar opção
              </Button>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="menu-rodape">Rodapé</Label>
            <Input
              id="menu-rodape"
              value={rodape}
              onChange={(e) => setRodape(e.target.value)}
              placeholder="Responda tocando"
            />
          </div>
          {erro && (
            <p role="alert" className="text-xs text-destructive">
              {erro}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button type="button" onClick={confirmar}>
            Enviar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
