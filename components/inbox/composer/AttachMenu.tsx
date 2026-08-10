"use client";
import { useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  FileText,
  IdentificationCard,
  ImageSquare,
  ListBullets,
  MapPin,
  Plus,
  Smiley,
} from "@/lib/ui/icons";
import type { ChannelCapabilities } from "@/lib/channels/types";
import type { ContactCard, LocationPayload, MenuPayload } from "@/lib/messaging/payloads";

import { ContactPicker } from "./ContactPicker";
import { LocationPicker } from "./LocationPicker";
import { MenuBuilder } from "./MenuBuilder";

interface Props {
  disabled?: boolean;
  onPick: (file: File) => void;
  /**
   * O que o canal desta conversa permite. Cada entrada abaixo só aparece se a
   * capacidade correspondente estiver ligada — oferecer e falhar depois é o
   * "canal morto na mão do corretor" (spec 006, FR-018).
   */
  caps: Pick<ChannelCapabilities, "sticker" | "location" | "contactCard" | "menuMaxOptions">;
  onEnviarLocalizacao: (p: LocationPayload) => void;
  onEnviarContato: (c: ContactCard[]) => void;
  onEnviarMenu: (texto: string, menu: MenuPayload) => void;
  /** Anexo escolhido explicitamente COMO FIGURINHA — não inferido do MIME. */
  onPickFigurinha: (file: File) => void;
}

/** Menu "+" do composer (padrão WhatsApp). */
export function AttachMenu({
  disabled,
  onPick,
  caps,
  onEnviarLocalizacao,
  onEnviarContato,
  onEnviarMenu,
  onPickFigurinha,
}: Props) {
  const mediaRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);
  const stickerRef = useRef<HTMLInputElement | null>(null);
  const [abrirLocal, setAbrirLocal] = useState(false);
  const [abrirContato, setAbrirContato] = useState(false);
  const [abrirMenu, setAbrirMenu] = useState(false);

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
  };

  const handleFigurinha = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onPickFigurinha(file);
    e.target.value = "";
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0"
            aria-label="Anexar"
            disabled={disabled}
          >
            <Plus size={18} weight="regular" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-52 p-1">
          <ItemDoMenu
            icone={<ImageSquare size={18} weight="duotone" className="text-primary" aria-hidden />}
            rotulo="Fotos e vídeos"
            onClick={() => mediaRef.current?.click()}
          />
          <ItemDoMenu
            icone={<FileText size={18} weight="duotone" className="text-primary" aria-hidden />}
            rotulo="Documento"
            onClick={() => docRef.current?.click()}
          />
          {caps.sticker && (
            <ItemDoMenu
              icone={<Smiley size={18} weight="duotone" className="text-primary" aria-hidden />}
              rotulo="Figurinha"
              onClick={() => stickerRef.current?.click()}
            />
          )}
          {caps.location && (
            <ItemDoMenu
              icone={<MapPin size={18} weight="duotone" className="text-primary" aria-hidden />}
              rotulo="Localização"
              onClick={() => setAbrirLocal(true)}
            />
          )}
          {caps.contactCard && (
            <ItemDoMenu
              icone={
                <IdentificationCard
                  size={18}
                  weight="duotone"
                  className="text-primary"
                  aria-hidden
                />
              }
              rotulo="Contato"
              onClick={() => setAbrirContato(true)}
            />
          )}
          {caps.menuMaxOptions !== null && (
            <ItemDoMenu
              icone={<ListBullets size={18} weight="duotone" className="text-primary" aria-hidden />}
              rotulo="Opções clicáveis"
              onClick={() => setAbrirMenu(true)}
            />
          )}
        </PopoverContent>
      </Popover>

      <LocationPicker
        open={abrirLocal}
        onOpenChange={setAbrirLocal}
        onEnviar={onEnviarLocalizacao}
      />
      <ContactPicker
        open={abrirContato}
        onOpenChange={setAbrirContato}
        onEnviar={onEnviarContato}
      />
      {caps.menuMaxOptions !== null && (
        <MenuBuilder
          open={abrirMenu}
          onOpenChange={setAbrirMenu}
          maxOptions={caps.menuMaxOptions}
          onEnviar={onEnviarMenu}
        />
      )}

      {/* Os inputs vivem FORA do PopoverContent: o Radix desmonta o conteúdo do
          popover ao fechar, e um input desmontado no meio do clique perde o
          file picker ("nada acontece"). Aqui os refs seguem válidos após o
          fechamento — o .click() síncrono no onClick preserva o user-gesture. */}
      <input ref={mediaRef} type="file" accept="image/*,video/*" className="hidden" onChange={handle} />
      <input
        ref={docRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
        className="hidden"
        onChange={handle}
      />
      {/* Figurinha tem input PRÓPRIO porque a diferença é de INTENÇÃO, não de
          arquivo: um `.webp` escolhido em "Fotos e vídeos" é foto; o mesmo
          arquivo escolhido aqui é figurinha. Inferir pelo MIME é o que fazia
          figurinha não existir — todo webp virava imagem. */}
      <input
        ref={stickerRef}
        type="file"
        accept="image/webp,image/png"
        className="hidden"
        onChange={handleFigurinha}
      />
    </>
  );
}

function ItemDoMenu({
  icone,
  rotulo,
  onClick,
}: {
  icone: React.ReactNode;
  rotulo: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
      onClick={onClick}
    >
      {icone}
      {rotulo}
    </button>
  );
}
