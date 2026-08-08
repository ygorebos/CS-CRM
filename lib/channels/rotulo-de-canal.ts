/**
 * Como o canal de origem se chama na tela.
 *
 * ## Por que existe um arquivo só para isto
 *
 * O `provider` da conexão é vocabulário de banco (`whatsapp_uazapi`,
 * `meta_cloud`, `instagram`). Mostrar isso ao corretor seria mostrar o nome
 * interno de uma decisão de infraestrutura: ele não escolheu "uazapi", ele
 * escolheu WhatsApp. E o rótulo vai aparecer em mais de um lugar (lista,
 * cabeçalho, e o que vier) — duplicar o mapa é o caminho conhecido para a lista
 * dizer "WhatsApp" e o cabeçalho dizer "uazapi" na mesma conversa.
 *
 * ## O que acontece com um canal que este build não conhece
 *
 * Devolve `null`, e a tela não mostra selo nenhum. Não inventa nome e não mostra
 * o valor cru: um selo escrito "telegram_novo_beta" é pior que selo nenhum, e o
 * gateway pode aprender canal antes de o CRM ganhar release — é a promessa da
 * US4 e não pode virar defeito visual.
 */

/** Canais que sabemos nomear. Chave = `channel_sessions.provider`. */
const ROTULOS: Record<string, string> = {
  waha: "WhatsApp",
  whatsapp_uazapi: "WhatsApp",
  meta_cloud: "WhatsApp",
  whatsapp_cloud: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
};

/**
 * Canais em que o rótulo ACRESCENTA informação.
 *
 * WhatsApp é o canal de 100% das conversas hoje: marcar todas com "WhatsApp"
 * seria ruído em toda linha da lista, e ruído constante deixa de ser lido — o
 * dia em que aparecesse um Instagram, o olho já teria aprendido a pular o selo.
 * O selo existe para dizer "esta aqui é diferente".
 */
const IMPLICITO = new Set(["waha", "whatsapp_uazapi", "meta_cloud", "whatsapp_cloud"]);

export function rotuloDeCanal(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return ROTULOS[provider] ?? null;
}

/** O rótulo que vale mostrar como selo — `null` quando o canal é o implícito. */
export function seloDeCanal(provider: string | null | undefined): string | null {
  if (!provider || IMPLICITO.has(provider)) return null;
  return rotuloDeCanal(provider);
}
