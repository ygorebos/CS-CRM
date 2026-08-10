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
import { locationPayloadSchema, type LocationPayload } from "@/lib/messaging/payloads";

/**
 * Escolher a localização a enviar.
 *
 * Sem mapa embutido de propósito: um iframe de terceiro nesta tela levaria o dado
 * do cliente para fora, e a tela do corretor não é lugar de tracker. O corretor
 * cola a coordenada (que o app de mapa dele copia pronta) ou digita.
 *
 * A validação é a MESMA do servidor — o schema de `lib/messaging/payloads.ts`,
 * importado, não recopiado. Uma segunda régua aqui divergiria da primeira na
 * primeira mudança, e o sintoma seria o formulário aceitar o que a API recusa.
 */
export function LocationPicker({
  open,
  onOpenChange,
  onEnviar,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onEnviar: (payload: LocationPayload) => void;
}) {
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  function confirmar() {
    const r = locationPayloadSchema.safeParse({
      lat: Number(lat.replace(",", ".")),
      lng: Number(lng.replace(",", ".")),
      name: name.trim() || undefined,
      address: address.trim() || undefined,
    });
    if (!r.success) {
      // O motivo é do CAMPO, não "dados inválidos": o corretor precisa saber qual
      // número está errado.
      setErro(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    setErro(null);
    onEnviar(r.data);
    onOpenChange(false);
    setLat("");
    setLng("");
    setName("");
    setAddress("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialogo-localizacao">
        <DialogHeader>
          <DialogTitle>Enviar localização</DialogTitle>
          <DialogDescription>
            Cole a coordenada do mapa ou digite. Nome e endereço são opcionais.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="loc-lat">Latitude</Label>
              <Input
                id="loc-lat"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="-23.5613"
                inputMode="decimal"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="loc-lng">Longitude</Label>
              <Input
                id="loc-lng"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="-46.6565"
                inputMode="decimal"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loc-nome">Nome do lugar</Label>
            <Input
              id="loc-nome"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Clínica São Lucas"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="loc-endereco">Endereço</Label>
            <Input
              id="loc-endereco"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Av. Paulista, 1000"
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
