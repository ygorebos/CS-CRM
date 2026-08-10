"use client";
import { useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { Copy, IdentificationCard } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { ContactCard as ContactCardData } from "@/lib/messaging/payloads";

/**
 * O cartão de contato recebido ou enviado.
 *
 * Antes virava bolha em branco. O telefone é COPIÁVEL porque é o que o corretor
 * faz com ele: o cliente manda o contato de um dependente ou de outro corretor, e
 * o passo seguinte é ligar ou cadastrar — reescrever o número à mão é onde nasce
 * o dígito errado.
 */
export function ContactCards({
  contacts,
  isOutbound,
}: {
  contacts: ContactCardData[];
  isOutbound: boolean;
}) {
  return (
    <div data-testid="cartao-de-contato" className="flex flex-col gap-1">
      {contacts.map((c, i) => (
        <UmContato key={`${c.name}:${i}`} contato={c} isOutbound={isOutbound} />
      ))}
    </div>
  );
}

function UmContato({ contato, isOutbound }: { contato: ContactCardData; isOutbound: boolean }) {
  const [copiado, setCopiado] = useState<string | null>(null);

  async function copiar(telefone: string) {
    // Sempre o helper `copyToClipboard`, nunca a API do browser direto: ela só
    // existe em contexto seguro, e o helper cai no fallback de textarea fora
    // dele. Chamada crua faria o botão não fazer NADA — sem erro visível — em
    // qualquer acesso que não fosse https. É régua do repo, com teste que a
    // cobra por varredura de texto (e por isso o nome da API não aparece nem
    // aqui no comentário).
    const ok = await copyToClipboard(telefone);
    if (!ok) return; // o número continua visível e selecionável na tela
    setCopiado(telefone);
    window.setTimeout(() => setCopiado(null), 1500);
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-2 py-2 text-xs",
        isOutbound ? "border-primary-foreground/30" : "border-border",
      )}
    >
      <IdentificationCard
        size={16}
        weight="duotone"
        className="mt-0.5 shrink-0 text-primary"
        aria-hidden
      />
      <div className="min-w-0">
        <div className="font-medium">{contato.name}</div>
        {contato.phones.map((t) => (
          <div key={t} className="flex items-center gap-1">
            <span className="opacity-80">{t}</span>
            <button
              type="button"
              onClick={() => void copiar(t)}
              aria-label={`Copiar telefone ${t}`}
              className="inline-flex items-center rounded p-0.5 opacity-60 hover:opacity-100"
            >
              <Copy size={12} weight="regular" aria-hidden />
            </button>
            {copiado === t && <span className="text-[10px] opacity-70">copiado</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
