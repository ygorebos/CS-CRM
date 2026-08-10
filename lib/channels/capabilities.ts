/**
 * O ÚNICO lugar do sistema que pode conhecer a diferença entre os canais.
 *
 * Feature nenhuma pergunta *com quem* falamos — pergunta *o que o canal permite*
 * (invariante 1 de `docs/doctrine/restricao-de-canal.md`). Cada capability abaixo
 * nasce de uma diferença real e medida entre WAHA e Meta Cloud; capability que
 * ninguém consome é código morto, e o teste de matriz reprova.
 */
import type { ChannelCapabilities, ChannelProvider } from "./types";

export type { ChannelProvider, ChannelCapabilities };

export const CHANNEL_CAPABILITIES: Record<ChannelProvider, ChannelCapabilities> = {
  // Auto-restrição: falo quando quiser, mas o WhatsApp me bane se eu abusar.
  waha: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: false,
    // As formas novas da spec 006 saem pelo caminho do GATEWAY. Este adapter é o
    // caminho direto, herdado, e não as monta. Declarar `true` aqui ofereceria na
    // tela um botão que falharia no envio — que é exatamente o "canal morto na mão
    // do corretor" que a capability existe para impedir. O dia em que o adapter
    // direto aprender a montá-las, estas linhas mudam JUNTO com ele, nunca antes.
    quotedReply: false,
    sticker: false,
    location: false,
    contactCard: false,
    menuMaxOptions: null,
    ctaUrl: false,
    locationRequest: false,
  },
  // Hetero-restrição: não me banem, mas a Meta me proíbe e me cobra.
  meta_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    // Mesmo motivo do `waha`: caminho direto, não monta as formas novas.
    quotedReply: false,
    sticker: false,
    location: false,
    contactCard: false,
    menuMaxOptions: null,
    ctaUrl: false,
    locationRequest: false,
  },

  // ── Canais que chegam pelo gateway (spec 001) ────────────────────────────
  //
  // A física é a do CANAL, não a de quem transporta. O gateway muda por onde a
  // mensagem entra; não muda quem pode banir o número nem quem cobra por
  // mensagem. Por isso os dois de WhatsApp repetem exatamente a matriz dos seus
  // equivalentes diretos — divergir aqui inventaria uma regra que a plataforma
  // não tem.

  // WhatsApp não-oficial (uazapi). Mesma física do WAHA: auto-restrição.
  whatsapp_uazapi: {
    freeformOutsideWindow: true,
    requiresTemplates: false,
    banRisk: true,
    minIntervalMs: null,
    voiceNote: "server-convert",
    groups: "full",
    costPerMessage: true,
    // Medido na matriz do gateway (`internal/sender/capability.go`), não suposto:
    // figurinha, localização, contato e menu são `Total` nesta plataforma.
    quotedReply: true,
    sticker: true,
    location: true,
    contactCard: true,
    // 10 é o teto de LINHAS DE LISTA do WhatsApp — o mesmo `LimiteLinhasOficial`
    // que o gateway impõe no canal oficial. Aqui ele não impõe, mas o WhatsApp
    // impõe: mandar mais falha no provedor, e falhar no provedor é falhar na cara
    // do corretor. Até 3 opções o canal desenha botões; acima disso, lista.
    menuMaxOptions: 10,
    // `NaoImplementado` no gateway para esta plataforma — não é "o WhatsApp não
    // tem", é "o caminho não existe". Ficar `false` é o que impede oferecer.
    ctaUrl: false,
    locationRequest: false,
  },
  // WhatsApp oficial pela Cloud API, entregue pelo gateway. Mesma física do
  // meta_cloud: hetero-restrição.
  whatsapp_cloud: {
    freeformOutsideWindow: false,
    requiresTemplates: true,
    banRisk: false,
    minIntervalMs: 6000,
    voiceNote: "opus-only",
    groups: "limited",
    costPerMessage: true,
    quotedReply: true,
    sticker: true,
    location: true,
    contactCard: true,
    // `Restrito` na matriz do gateway: no máximo 3 botões de resposta OU 10 linhas
    // de lista (`LimiteBotoesOficial` / `LimiteLinhasOficial`), e só dentro da
    // janela de 24 h.
    menuMaxOptions: 10,
    ctaUrl: true,
    locationRequest: true,
  },
  // Instagram Direct. Hetero-restrição sem cobrança por mensagem: a Meta fecha a
  // janela de 24h e não existe template como no WhatsApp — fora da janela só se
  // fala com etiqueta de atendimento humano, que NÃO é template aprovado. Por
  // isso `requiresTemplates: false` com `freeformOutsideWindow: false`: a
  // combinação é o que descreve a realidade, e é o que faz o guardrail escalar
  // ao humano em vez de tentar um template que não existe.
  instagram: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    banRisk: false,
    minIntervalMs: null,
    voiceNote: "opus-only",
    groups: "none",
    costPerMessage: false,
    // Citar existe na Messaging API da Meta (`reply_to`), e é o único da lista
    // que existe aqui. Figurinha de arquivo próprio NÃO passa (só `like_heart`),
    // localização e cartão de contato não existem na Messaging API, e menu
    // interativo não está disponível no Instagram — medido em
    // `internal/sender/capability.go`, com o motivo escrito lá.
    quotedReply: true,
    sticker: false,
    location: false,
    contactCard: false,
    menuMaxOptions: null,
    ctaUrl: false,
    locationRequest: false,
  },
  // Messenger. Mesma família do Instagram: janela de 24h, etiquetas em vez de
  // template, sem custo por mensagem e sem grupo.
  messenger: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    banRisk: false,
    minIntervalMs: null,
    voiceNote: "opus-only",
    groups: "none",
    costPerMessage: false,
    // Citar NÃO existe no Messenger: a Send API da Meta não tem resposta citada,
    // e o gateway recusa `quoted_id` com 422 nesta plataforma
    // (`internal/handlers/messages.go:264`). Figurinha só do catálogo da Meta por
    // `sticker_id` — arquivo próprio não passa. Quick replies existem na
    // plataforma, mas o gateway ainda não expõe botões no contrato de envio.
    quotedReply: false,
    sticker: false,
    location: false,
    contactCard: false,
    menuMaxOptions: null,
    ctaUrl: false,
    locationRequest: false,
  },
};

/**
 * O que assumir quando o banco NÃO diz qual é o canal — só quando a linha de
 * `channel_sessions` não pôde ser lida (a coluna é `not null default 'waha'`,
 * então uma sessão que existe sempre responde).
 *
 * Espelha o default da coluna de propósito: é o que mantém o comportamento
 * idêntico ao dos literais que as Tasks 4b/5 deixaram no código. E é o canal
 * CONSERVADOR dos dois — banRisk armado, throttle e warm-up ligados; errar para
 * o lado do meta_cloud desarmaria o anti-ban num número que pode ser banido.
 */
export const DEFAULT_CHANNEL_PROVIDER: ChannelProvider = "waha";

/**
 * Constantes nomeadas dos providers. Existem para que nenhum arquivo fora deste
 * módulo precise escrever a string — é o que o `scripts/lint-channels.ts` cobra.
 */
export const CHANNEL_PROVIDER_WAHA: ChannelProvider = "waha";
export const CHANNEL_PROVIDER_META: ChannelProvider = "meta_cloud";
/**
 * O canal que o provisionamento pelo gateway cria hoje (spec 004, T043).
 *
 * Um só, e nomeado, porque o gateway atende N plataformas mas a Central de
 * Conexões só oferece esta — oferecer as outras antes de o envio delas existir
 * criaria o "canal morto na mão do corretor" que a FR-014 nomeia (a matriz de
 * `getAdapter` só tem envio para esta).
 */
export const CHANNEL_PROVIDER_GATEWAY_WHATSAPP: ChannelProvider = "whatsapp_uazapi";

export function capabilitiesOf(provider: ChannelProvider): ChannelCapabilities {
  const caps = CHANNEL_CAPABILITIES[provider];
  // Fail-closed: provider fora da matriz não herda o default do WAHA. O tipo
  // barra em compilação; isto barra o que vem do banco em runtime.
  if (!caps) throw new Error(`unknown_channel_provider: ${provider}`);
  return caps;
}
