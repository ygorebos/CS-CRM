/**
 * A carga de cada tipo de mensagem — UM schema, para quem escreve e para quem lê.
 *
 * # Por que isto existe
 *
 * A carga (coordenada de uma localização, telefone de um cartão de contato,
 * opções de um menu) vive em `messages.metadata`, que é `jsonb`. Sem um schema
 * central, cada tela leria `metadata.location.lat` na mão e cada emissor
 * escreveria o que lembrasse — o anti-pattern 6 do `CLAUDE.md` (`jsonb` lock-in),
 * cujo modo de falha é a tela ler um caminho que ninguém mais escreve, em
 * silêncio, sem erro.
 *
 * Colunas dedicadas seriam a alternativa, e foram rejeitadas na pesquisa (R6):
 * oito colunas nulas em 99% das linhas, contra a doutrina DIRC.
 *
 * # A regra que este arquivo impõe
 *
 * **Tipo que a API aceita enviar tem carga declarada aqui.** É o que a spec chama
 * de FR-017 e o que `tests/unit/tipo-aceito-e-enviavel.test.ts` cobra: hoje
 * `location` e `contact` são aceitos pelo enum de envio e IMPOSSÍVEIS de entregar
 * — o pedido não tem onde carregar coordenada nem cartão, e o canal recusa com
 * "campos obrigatórios ausentes". Anunciar e não entregar é pior que não ter.
 */
import { z } from "zod";

import type { OutboundMessageType } from "@/lib/messaging/message-types";

// ── Localização ────────────────────────────────────────────────────────────────

export const locationPayloadSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Nome do lugar ("Clínica São Lucas"). Opcional: nem todo ponto tem nome. */
  name: z.string().trim().min(1).max(200).optional(),
  address: z.string().trim().min(1).max(500).optional(),
});

export type LocationPayload = z.infer<typeof locationPayloadSchema>;

// ── Cartão de contato ──────────────────────────────────────────────────────────

export const contactCardSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * Ao menos um telefone. Cartão sem telefone é o caso em que o canal aceita e o
   * contato recebe um cartão que não serve para nada — recusar aqui é mais
   * honesto que entregar vazio.
   */
  phones: z.array(z.string().trim().min(3).max(30)).min(1).max(5),
});

export const contactsPayloadSchema = z.array(contactCardSchema).min(1).max(10);

export type ContactCard = z.infer<typeof contactCardSchema>;

// ── Menu de opções ─────────────────────────────────────────────────────────────

export const menuPayloadSchema = z.object({
  /**
   * O teto NÃO está aqui: ele é do CANAL (`ChannelCapabilities.menuMaxOptions`) e
   * é imposto no handler, com o número do canal na mensagem de erro. Um teto fixo
   * neste schema seria a matriz de capacidade escrita duas vezes.
   */
  options: z.array(z.string().trim().min(1).max(24)).min(1),
  footer: z.string().trim().min(1).max(60).optional(),
});

export type MenuPayload = z.infer<typeof menuPayloadSchema>;

// ── Botão de URL ───────────────────────────────────────────────────────────────

export const ctaUrlPayloadSchema = z.object({
  button_label: z.string().trim().min(1).max(20),
  /**
   * `https` obrigatório: um botão que abre `http` num aparelho de cliente é
   * downgrade de transporte oferecido pelo nosso produto.
   */
  button_url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), { message: "a URL do botão precisa ser https" }),
});

export type CtaUrlPayload = z.infer<typeof ctaUrlPayloadSchema>;

// ── O catálogo: o que cada tipo EXIGE ──────────────────────────────────────────

/**
 * O que um tipo precisa ter para poder sair.
 *
 * - `body`: texto obrigatório
 * - `media`: anexo obrigatório (`media_url` ou `media_storage_path`)
 * - `payload`: chave própria no corpo, validada pelo schema desta tabela
 * - `template`: os campos de template, que já existiam
 */
export type ExigenciaDeEnvio =
  | { kind: "body" }
  | { kind: "media"; captionOpcional: true }
  | { kind: "payload"; campo: string; schema: z.ZodType; exigeBody?: true }
  | { kind: "template" };

/**
 * ⚠️ `Record<OutboundMessageType, …>` é a guarda: tipo novo no vocabulário de
 * envio **não compila** até declarar aqui o que ele exige. É assim que "aceito e
 * inenviável" para de nascer.
 */
export const EXIGENCIA_POR_TIPO: Record<OutboundMessageType, ExigenciaDeEnvio> = {
  text: { kind: "body" },
  image: { kind: "media", captionOpcional: true },
  video: { kind: "media", captionOpcional: true },
  audio: { kind: "media", captionOpcional: true },
  document: { kind: "media", captionOpcional: true },
  sticker: { kind: "media", captionOpcional: true },
  location: { kind: "payload", campo: "location", schema: locationPayloadSchema },
  contact: { kind: "payload", campo: "contacts", schema: contactsPayloadSchema },
  template: { kind: "template" },
  // `exigeBody` porque opções sem pergunta chegam ao cliente como botões sem
  // contexto, e um botão de URL sem texto é um link solto no meio da conversa.
  // A carga sozinha não basta nestes dois.
  menu: { kind: "payload", campo: "menu", schema: menuPayloadSchema, exigeBody: true },
  cta_url: { kind: "payload", campo: "cta_url", schema: ctaUrlPayloadSchema, exigeBody: true },
  // O pedido de localização é um botão com um TEXTO — a pergunta que o corretor
  // faz. Sem o texto, o cliente recebe um botão sem contexto.
  location_request: { kind: "body" },
};

/**
 * A capability que cada tipo exige do canal. `null` = todo canal faz.
 *
 * Existe para que o handler pergunte **capacidade**, e não provider — a tela
 * também consome esta tabela, então as duas nunca divergem sobre o que oferecer.
 */
export const CAPABILITY_POR_TIPO: Record<
  OutboundMessageType,
  "sticker" | "location" | "contactCard" | "menuMaxOptions" | "ctaUrl" | "locationRequest" | null
> = {
  text: null,
  image: null,
  video: null,
  audio: null,
  document: null,
  sticker: "sticker",
  location: "location",
  contact: "contactCard",
  template: null,
  menu: "menuMaxOptions",
  cta_url: "ctaUrl",
  location_request: "locationRequest",
};

// ── Leitura: a mesma carga, do lado de quem exibe ─────────────────────────────

/**
 * Como a carga aparece em `messages.metadata` depois de gravada.
 *
 * O ingest do gateway já grava `metadata.location` no formato do envelope
 * (`{lat, lng, nome, endereco}` — em português, porque quem monta é o gateway),
 * enquanto o envio grava no formato do contrato da API (`{lat, lng, name,
 * address}`). Ler os dois é o que a doutrina de expand/contract chama de leitura
 * tolerante: o histórico já tem linhas do primeiro formato, e reescrevê-las seria
 * mudança destrutiva num banco que não tem versão de escape.
 */
export const locationLidaSchema = z
  .object({
    lat: z.number(),
    lng: z.number(),
    name: z.string().optional().nullable(),
    address: z.string().optional().nullable(),
    // Formato do envelope do gateway.
    nome: z.string().optional().nullable(),
    endereco: z.string().optional().nullable(),
  })
  .transform((v) => ({
    lat: v.lat,
    lng: v.lng,
    name: v.name ?? v.nome ?? null,
    address: v.address ?? v.endereco ?? null,
  }));

export type LocationLida = z.infer<typeof locationLidaSchema>;

/** Lê a localização de um `metadata`, ou `null` se não houver uma válida. */
export function lerLocalizacao(metadata: unknown): LocationLida | null {
  if (!metadata || typeof metadata !== "object") return null;
  const bruto = (metadata as Record<string, unknown>).location;
  const r = locationLidaSchema.safeParse(bruto);
  return r.success ? r.data : null;
}

/** Lê os cartões de contato de um `metadata`, ou `[]` se não houver. */
export function lerContatos(metadata: unknown): ContactCard[] {
  if (!metadata || typeof metadata !== "object") return [];
  const bruto = (metadata as Record<string, unknown>).contacts;
  const r = contactsPayloadSchema.safeParse(bruto);
  return r.success ? r.data : [];
}
