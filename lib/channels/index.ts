/**
 * A porta de entrada do seam. Feature nenhuma importa `lib/waha/*` direto —
 * pede o adapter do provider da conversa e o descritor de capabilities.
 */
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { wahaAdapter } from "./adapters/waha";
import type { ChannelAdapter, ChannelProvider } from "./types";

const ADAPTERS: Record<ChannelProvider, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  // Canais que chegam pelo gateway (spec 001). `null` NÃO é lacuna esquecida: a
  // spec 001 trata de RECEBIMENTO, e o envio continua pelo caminho atual. Sem
  // adapter, `getAdapter()` lança — que é o comportamento certo. Fingir que
  // sabemos enviar por um canal cujo envio ninguém escreveu manda a mensagem
  // para o lugar errado ou para lugar nenhum, em silêncio.
  whatsapp_uazapi: null,
  whatsapp_cloud: null,
  instagram: null,
  messenger: null,
};

/**
 * Fail-closed: provider sem adapter (ou fora da matriz) lança em vez de cair no
 * WAHA por default. Enviar pelo canal errado é pior que não enviar.
 */
export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`unknown_channel_provider: ${provider}`);
  return adapter;
}

/**
 * O canal deste provider consegue ENVIAR hoje? (spec 004, FR-014 / T030)
 *
 * `getAdapter` já é fail-closed, mas ele falha **no envio** — fundo na pilha,
 * horas ou dias depois de o corretor ter parear o número, e com mensagem de erro
 * técnica (`unknown_channel_provider`). Para quem está na tela, o desfecho é um
 * canal que conectou, recebe, e nunca responde: o "canal morto na mão do
 * corretor" que a FR-014 nomeia.
 *
 * Esta função existe para a recusa acontecer **na criação**, onde ainda dá para
 * explicar. Hoje nenhuma rota de criação produz provider sem adapter — as duas
 * gravam `waha` e `meta_cloud` —, então isto é **guarda preventiva**, e é
 * deliberado: a spec 004 vai acrescentar providers do gateway, e o momento em
 * que alguém acrescentar um sem adapter é exatamente o momento em que ninguém
 * vai lembrar desta consequência.
 */
export function providerPodeEnviar(provider: ChannelProvider): boolean {
  return ADAPTERS[provider] != null;
}

/** Os providers que hoje sabem enviar. Serve ao teste que vigia a matriz. */
export function providersQuePodemEnviar(): ChannelProvider[] {
  return (Object.keys(ADAPTERS) as ChannelProvider[]).filter(providerPodeEnviar);
}

export { capabilitiesOf, CHANNEL_CAPABILITIES, DEFAULT_CHANNEL_PROVIDER } from "./capabilities";
export { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "./session-ref";
export type { ChannelSessionRef } from "./session-ref";
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelProvider,
  OutboundEnvelope,
  OutboundKind,
  OutboundMedia,
  RecipientInput,
} from "./types";
