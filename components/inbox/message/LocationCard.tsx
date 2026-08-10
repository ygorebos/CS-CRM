"use client";
import { MapPin } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { LocationLida } from "@/lib/messaging/payloads";

/**
 * A localização recebida ou enviada.
 *
 * Antes caía no `DocumentCard` (anexo sem arquivo) ou virava bolha em branco: as
 * coordenadas chegavam, eram gravadas em `metadata.location`, e ninguém as lia.
 *
 * O link é `geo:`-agnóstico de propósito — abre no mapa padrão do sistema pelo
 * OpenStreetMap, sem depender de chave de API de mapa nem embutir um iframe de
 * terceiro numa tela que mostra dado de cliente.
 */
export function LocationCard({
  location,
  isOutbound,
}: {
  location: LocationLida;
  isOutbound: boolean;
}) {
  const url = `https://www.openstreetmap.org/?mlat=${location.lat}&mlon=${location.lng}#map=17/${location.lat}/${location.lng}`;
  const titulo = location.name ?? "Localização";

  return (
    <a
      data-testid="cartao-de-localizacao"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-start gap-2 rounded-md border px-2 py-2 text-xs transition-colors",
        isOutbound
          ? "border-primary-foreground/30 hover:bg-primary-foreground/10"
          : "border-border hover:bg-muted",
      )}
    >
      <MapPin size={16} weight="duotone" className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0">
        <span className="block font-medium">{titulo}</span>
        {location.address && <span className="block opacity-75">{location.address}</span>}
        <span className="block opacity-60">
          {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
        </span>
        <span className="mt-0.5 block font-medium underline underline-offset-2">Abrir no mapa</span>
      </span>
    </a>
  );
}
