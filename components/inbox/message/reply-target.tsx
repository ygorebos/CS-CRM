"use client";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

/**
 * O alvo da citação em preparo — o estado que liga o gesto na bolha ao campo de
 * escrita (spec 006, US2).
 *
 * ## Por que contexto, e não prop
 *
 * Quem dispara é a `MessageBubble`, lá no fundo da lista; quem consome é o
 * `Composer`, irmão da lista. Descer uma prop atravessaria `ChatThread`, o
 * agrupador por dia e o item — quatro camadas que não têm nada com citação, e que
 * passariam a mudar toda vez que este estado mudasse.
 *
 * ## Por que ele mora fora do Composer
 *
 * Porque o `Composer` desmonta ao trocar de conversa, e o alvo precisa morrer
 * junto — o provider é remontado por conversa, e a citação de uma não vaza para a
 * outra. Guardar isso dentro do Composer daria o mesmo efeito por acidente, não
 * por desenho.
 */

export interface ReplyTarget {
  /** UUID da linha do CRM. É o que a API aceita — nunca o id do canal. */
  messageId: string;
  authorKind: "inbound" | "outbound";
  type: string;
  preview: string;
}

interface Ctx {
  alvo: ReplyTarget | null;
  citar: (alvo: ReplyTarget) => void;
  limpar: () => void;
  /** `false` quando o canal desta conversa não permite citar (FR-018). */
  habilitado: boolean;
}

const ReplyTargetCtx = createContext<Ctx>({
  alvo: null,
  citar: () => {},
  limpar: () => {},
  // Fechado por padrão: sem provider, a ação não aparece. Um default `true` faria
  // a bolha oferecer "responder" em qualquer tela que a reusasse, inclusive onde
  // não há para onde mandar.
  habilitado: false,
});

export function ReplyTargetProvider({
  children,
  habilitado,
}: {
  children: React.ReactNode;
  habilitado: boolean;
}) {
  const [alvo, setAlvo] = useState<ReplyTarget | null>(null);
  const citar = useCallback((a: ReplyTarget) => setAlvo(a), []);
  const limpar = useCallback(() => setAlvo(null), []);
  const valor = useMemo(
    () => ({ alvo, citar, limpar, habilitado }),
    [alvo, citar, limpar, habilitado],
  );
  return <ReplyTargetCtx.Provider value={valor}>{children}</ReplyTargetCtx.Provider>;
}

export function useReplyTarget(): Ctx {
  return useContext(ReplyTargetCtx);
}
