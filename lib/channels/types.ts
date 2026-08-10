// `OutboundMedia` é reusado, não redefinido: um segundo tipo com os mesmos 4
// campos diverge em silêncio na primeira vez que um lado ganhar um campo. Só o
// TIPO atravessa (`import type` some na compilação) — o seam não carrega código
// do provider. Quando a Fase 3 absorver `lib/waha/`, este é o único ponteiro a
// mudar de casa.
import type { SendMessageInput } from "@/lib/schemas";
import type { OutboundMedia } from "@/lib/waha/media-send";

export type { OutboundMedia };

/**
 * Os dois primeiros são canais que o CRM fala DIRETO. Os quatro seguintes
 * chegam pelo gateway (spec 001) e espelham `MensagemNormalizada.Platform`
 * dele — o nome é o mesmo dos dois lados de propósito, para que a origem de uma
 * conversa seja legível sem tradução.
 *
 * Este union e o CHECK `channel_sessions_provider_check` falam o mesmo
 * vocabulário, e `tests/invariants/channel-provider-schema.test.ts` reprova se
 * divergirem. Acrescentar valor aqui sem a migration (ou o contrário) quebra o
 * portão de propósito.
 */
export type ChannelProvider =
  | "waha"
  | "meta_cloud"
  | "whatsapp_uazapi"
  | "whatsapp_cloud"
  | "instagram"
  | "messenger";

export interface ChannelCapabilities {
  /** Pode enviar texto livre a qualquer momento? false = exige template fora da janela. */
  freeformOutsideWindow: boolean;
  /** A plataforma hospeda definições de mensagem que precisam de aprovação prévia. */
  requiresTemplates: boolean;
  /** Há risco de banimento por volume/padrão → arma throttle, warm-up e cap. */
  banRisk: boolean;
  /** Intervalo mínimo imposto PELA PLATAFORMA entre msgs ao mesmo destinatário (ms). */
  minIntervalMs: number | null;
  /** 'server-convert' = o canal converte áudio; 'opus-only' = precisamos entregar ogg/opus. */
  voiceNote: "server-convert" | "opus-only";
  groups: "full" | "limited" | "none";
  /** Mensagem entregue gera custo → decisões de envio precisam considerar orçamento. */
  costPerMessage: boolean;

  // ── Formas de mensagem (spec 006) ────────────────────────────────────────
  //
  // Uma por AÇÃO que a tela pode oferecer. Existem porque a tela precisa
  // decidir o que desenhar, e a única pergunta que ela tem direito de fazer é
  // "o canal permite?" — nunca "que canal é este?" (invariante 1 de
  // `docs/doctrine/restricao-de-canal.md`). Oferecer e falhar depois é o defeito
  // que a FR-014 da spec 004 nomeia: canal morto na mão do corretor.

  /** Responder citando uma mensagem específica (`quoted_id` no envio). */
  quotedReply: boolean;
  /** Enviar figurinha como figurinha, e não como imagem. */
  sticker: boolean;
  /** Enviar localização (coordenada + nome + endereço). */
  location: boolean;
  /** Enviar cartão de contato (vCard). */
  contactCard: boolean;
  /**
   * Enviar menu de opções clicáveis. `null` = o canal não tem menu; número =
   * teto de opções que ele aceita. O teto é do CANAL, e é imposto antes do
   * envio — descobrir pelo 422 do provedor é descobrir na cara do corretor.
   */
  menuMaxOptions: number | null;
  /** Enviar botão que abre uma URL. */
  ctaUrl: boolean;
  /** Pedir a localização do contato com um botão. */
  locationRequest: boolean;
}

/**
 * O vocabulário de tipo de mensagem de saída tem UMA fonte: o schema de entrada
 * da API. A Task 3 escreveu aqui uma lista à mão de 5 valores, mas o handler
 * passa `input.type`, que tem 8 (`document`, `sticker`, `location`, `contact`
 * também chegam) — a lista curta não compilava contra o chamador real. Derivar
 * evita a divergência silenciosa na próxima vez que o schema crescer.
 */
export type OutboundKind = SendMessageInput["type"];

/** O que o CRM sabe sobre o destinatário. Quem traduz para o endereço do canal é o adapter. */
export interface RecipientInput {
  isGroup: boolean;
  groupChatId: string | null;
  phoneNumber: string | null | undefined;
  /** `contacts.wa_identity` (migration 0027): 'phone:+E164' | 'lid:<digits>' | null. */
  waIdentity: string | null | undefined;
}

export interface OutboundEnvelope {
  /** Identificador da sessão/número no provider (WAHA: nome da sessão). */
  sessionRef: string;
  /** Endereço já resolvido por `resolveRecipient`. */
  to: string;
  kind: OutboundKind;
  body?: string;
  media?: OutboundMedia;

  // ── Spec 006 ─────────────────────────────────────────────────────────────

  /**
   * Identificador NO CANAL da mensagem citada — já resolvido pelo handler a
   * partir do UUID que a API recebeu.
   *
   * Chega resolvido, e não como UUID, porque traduzir linha do CRM em endereço do
   * canal é trabalho de quem tem o banco na mão; o adapter só fala o dialeto.
   */
  replyToExternalId?: string;
  /** Carga de `kind: "location"`. */
  location?: { lat: number; lng: number; name?: string; address?: string };
  /** Carga de `kind: "contact"`. */
  contacts?: Array<{ name: string; phones: string[] }>;
  /** Carga de `kind: "menu"`. O teto de opções já foi imposto por quem chama. */
  menu?: { options: string[]; footer?: string };
  /** Carga de `kind: "cta_url"`. */
  ctaUrl?: { button_label: string; button_url: string };
}

/**
 * O tradutor de formato de UM canal — e nada mais.
 *
 * Adapter NÃO decide se pode enviar: janela de 24h, cap diário, horário
 * comercial, retry e throttle são da cadeia `before_send`. Um `if` de negócio
 * aqui dentro é o defeito que `docs/doctrine/restricao-de-canal.md` existe para
 * evitar — quem quiser saber o que o canal permite pergunta a `capabilitiesOf`.
 */
export interface ChannelAdapter {
  provider: ChannelProvider;
  /** null = não há endereço possível para este contato neste canal. */
  resolveRecipient(input: RecipientInput): string | null;
  /**
   * O canal tem credencial para enviar? Perguntado ANTES de `send` porque
   * `{externalId: null}` colapsa "não tentei" com "tentei e a resposta não
   * trouxe id" — desfechos que o chamador grava de forma diferente.
   */
  isConfigured(): boolean;
  /** externalId null = canal não configurado (noop) ou resposta sem id reconhecível. */
  send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }>;
  /**
   * Códigos que o chamador grava em `metadata`/`error_code`. Vivem NO ADAPTER
   * porque carregam nome de provider, e o lint da Task 7 proíbe esse nome fora
   * de `lib/channels/`. Quem chama escreve o que o adapter disser.
   */
  readonly codes: { notConfigured: string; sendFailed: string; unknownError: string };

  /**
   * URL da foto de perfil do contato, ou null quando não há (sem foto,
   * privacidade fechada, canal fora do ar).
   *
   * OPCIONAL de propósito: nem todo canal expõe isso. Quem chama testa a
   * presença do método antes de usar, em vez de perguntar QUAL provider é —
   * que é justamente o que o lint de canal proíbe fora daqui.
   *
   * A URL devolvida costuma ser ASSINADA E TEMPORÁRIA (no WhatsApp, ~9 dias
   * medidos). Quem chama deve BAIXAR e persistir, nunca guardar a URL.
   */
  fetchProfilePictureUrl?(input: {
    sessionRef: string;
    recipient: string;
  }): Promise<string | null>;

  /**
   * Todas as formas sob as quais ESTE canal pode ter registrado a MESMA mensagem
   * que acabou de ser enviada — para reconhecer o eco do próprio envio quando ele
   * volta pelo webhook.
   *
   * Existe porque alguns canais são assimétricos: a resposta do envio e o
   * webhook do eco trazem pontas diferentes do mesmo identificador, e comparar
   * as duas strings direto nunca casa. Que formas são essas é conhecimento do
   * canal, não de quem envia — por isso mora aqui e não no handler, que é
   * justamente o que o lint de canal impede.
   *
   * OPCIONAL: um canal simétrico (mesmo id nos dois lados) não implementa, e
   * quem chama cai no próprio `externalId`.
   */
  echoExternalIds?(input: { externalId: string; recipient: string }): string[];
}
