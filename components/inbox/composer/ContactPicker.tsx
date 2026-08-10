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
import { contactCardSchema, type ContactCard } from "@/lib/messaging/payloads";

/**
 * Escolher o cartão de contato a enviar.
 *
 * Um contato por vez, com um telefone: é o caso real do nicho (indicar outro
 * corretor, passar o telefone da operadora). Vários telefones cabem no contrato e
 * o adapter os desdobra; a tela não precisa oferecer isso antes de alguém pedir.
 *
 * Validação pelo MESMO schema do servidor, importado — não recopiado.
 */
export function ContactPicker({
  open,
  onOpenChange,
  onEnviar,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEnviar: (contatos: ContactCard[]) => void;
}) {
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  function confirmar() {
    const r = contactCardSchema.safeParse({
      name: nome.trim(),
      phones: [telefone.trim()].filter(Boolean),
    });
    if (!r.success) {
      setErro(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    setErro(null);
    onEnviar([r.data]);
    onOpenChange(false);
    setNome("");
    setTelefone("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialogo-contato">
        <DialogHeader>
          <DialogTitle>Enviar contato</DialogTitle>
          <DialogDescription>
            O cliente recebe um cartão que ele consegue salvar na agenda.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ct-nome">Nome</Label>
            <Input
              id="ct-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Dra. Ana Ribeiro"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-telefone">Telefone</Label>
            <Input
              id="ct-telefone"
              value={telefone}
              onChange={(e) => setTelefone(e.target.value)}
              placeholder="+5511999998888"
              inputMode="tel"
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
