import { cn } from "@/lib/utils";
import type { MenuPayload } from "@/lib/messaging/payloads";

/**
 * As opções clicáveis de um menu, no registro da conversa.
 *
 * ## O defeito que isto fecha
 *
 * Medido em 2026-08-10, enviando um menu de verdade pelo canal conectado: a bolha
 * mostrava apenas a pergunta e as duas opções sumiam da tela — ficavam só no
 * `metadata`. O corretor que reabre a conversa precisa saber **o que ofereceu**,
 * porque é a lista que determina o que o cliente pôde responder; sem ela, a
 * resposta "Familiar" chega sem referente.
 *
 * ## Por que não são botões aqui
 *
 * Quem clica é o cliente, no aparelho dele. Desenhar botões clicáveis no CRM
 * convidaria o corretor a clicar no próprio menu — gesto sem efeito nenhum. O que
 * a tela precisa é do REGISTRO do que foi oferecido, então cada opção é um
 * rótulo, numerado na mesma ordem em que o canal as entrega.
 */
export function MenuOptions({ menu, isOutbound }: { menu: MenuPayload; isOutbound: boolean }) {
  return (
    <div data-testid="opcoes-do-menu" className="mt-1.5 flex flex-col gap-1">
      {menu.options.map((opcao, i) => (
        <div
          key={`${i}:${opcao}`}
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
            isOutbound ? "border-primary-foreground/30" : "border-border",
          )}
        >
          <span className="opacity-60 tabular-nums">{i + 1}.</span>
          <span className="min-w-0 break-words">{opcao}</span>
        </div>
      ))}
      {menu.footer && <div className="text-[10px] opacity-70">{menu.footer}</div>}
    </div>
  );
}
