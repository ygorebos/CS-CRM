"use client";
import { Question } from "@/lib/ui/icons";
import type { UnsupportedMessage } from "@/lib/messaging/projection/types";

/**
 * O rótulo que substitui a bolha vazia.
 *
 * Bolha em branco não é detalhe estético: é o corretor perdendo o que o cliente
 * disse **sem nenhum sinal de que perdeu**. Um rótulo é pior que exibir de
 * verdade e infinitamente melhor que o silêncio — ele diz que chegou alguma
 * coisa, e é o que faz o corretor abrir o WhatsApp para ver.
 *
 * É também o mecanismo anti-morte da feature: canal que passe a entregar uma
 * forma nova aparece aqui, com o rótulo cru, em vez de sumir esperando um
 * release.
 */
export function UnsupportedNotice({ unsupported }: { unsupported: UnsupportedMessage }) {
  return (
    <div
      data-testid="mensagem-nao-suportada"
      data-tipo-original={unsupported.originalType ?? ""}
      className="flex items-center gap-1.5 text-xs italic opacity-75"
    >
      <Question size={14} weight="duotone" aria-hidden />
      <span>{unsupported.label}</span>
    </div>
  );
}
