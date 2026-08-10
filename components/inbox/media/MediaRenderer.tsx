"use client";
import { lerContatos, lerLocalizacao } from "@/lib/messaging/payloads";
import type { Message } from "@/lib/types/messaging";
import { ContactCards } from "@/components/inbox/message/ContactCard";
import { LocationCard } from "@/components/inbox/message/LocationCard";

import { AudioPlayer } from "./AudioPlayer";
import { DocumentCard } from "./DocumentCard";
import { ImageMedia } from "./ImageMedia";
import { StickerMedia } from "./StickerMedia";
import { VideoMedia } from "./VideoMedia";

/**
 * Dispatcher de conteúdo por message.type (Onda 1; localização e contato na
 * spec 006).
 *
 * `location` e `contact` NÃO são mídia: não têm arquivo para baixar. Enquanto
 * caíam no `default`, o `DocumentCard` desenhava um anexo sem anexo — e quando
 * nem isso, a bolha ficava em branco com as coordenadas gravadas no banco,
 * invisíveis. Agora cada um tem renderer próprio, e a carga é lida pelo schema
 * central (`lib/messaging/payloads.ts`), nunca por path de jsonb na mão.
 */
export function MediaRenderer({ message }: { message: Message }) {
  const isOutbound = message.direction === "outbound";
  switch (message.type) {
    case "location": {
      const loc = lerLocalizacao(message.metadata);
      // Sem carga válida não há mapa a abrir. Devolver null aqui é seguro: a
      // bolha cai no rótulo de "não sabemos exibir" em vez de ficar vazia.
      return loc ? <LocationCard location={loc} isOutbound={isOutbound} /> : null;
    }
    case "contact": {
      const contatos = lerContatos(message.metadata);
      return contatos.length > 0 ? (
        <ContactCards contacts={contatos} isOutbound={isOutbound} />
      ) : null;
    }
    case "image":
      return <ImageMedia messageId={message.id} alt="Imagem recebida" />;
    case "sticker":
      return <StickerMedia messageId={message.id} />;
    case "audio":
      return <AudioPlayer messageId={message.id} isOutbound={isOutbound} />;
    case "video":
      return <VideoMedia messageId={message.id} />;
    default:
      return (
        <DocumentCard
          messageId={message.id}
          mime={message.media_mime}
          sizeBytes={message.media_size_bytes}
          storagePath={message.media_storage_path}
          isOutbound={isOutbound}
        />
      );
  }
}
