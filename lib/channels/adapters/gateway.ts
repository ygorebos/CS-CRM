/**
 * Adapter do gateway — o envio da spec 004 (T031-T034), atrás do seam.
 *
 * Fala `POST /v1/messages` do `gateway_go` (contrato em
 * `docs/gateway-api-reference.md` daquele repo): `connection_id` + destino +
 * conteúdo, e volta `message_id` — que vira o `external_id` da mensagem e é o
 * MESMO identificador que o ACK devolve depois (FR-019: se não casar, o visto
 * nunca chega).
 *
 * O que este arquivo NÃO faz, por doutrina:
 * - Não decide janela, cap, horário nem retry — é da cadeia `before_send`.
 * - Não carrega `organization_id`: o gateway resolve o dono pela CONEXÃO
 *   (`sessionRef` = `gateway_connection_id` do canal), nunca pelo corpo.
 * - Não fala dialeto de provedor: uazapi/Meta é problema do gateway.
 *
 * `sessionRef` aqui é o `gateway_connection_id` — resolvido do canal por
 * `resolveSessionRef`, fonte confiável (FR-017). O corpo de requisição do
 * usuário nunca escolhe a conexão.
 */
import { env } from "@/lib/env";
import type { ChannelAdapter, OutboundEnvelope, RecipientInput } from "../types";

// `tipo` NÃO se traduz: o gateway fala o MESMO vocabulário inglês do CRM
// (`messages.go:293-306` — text, image, video, audio, document, sticker,
// location, contact). Medido antes de escrever — a primeira versão deste
// arquivo inventou uma tabela "texto"/"imagem" que teria feito TODO envio
// voltar 400. Se o vocabulário divergir um dia, o gateway recusa com erro
// legível, que é o desfecho certo.

function baseUrl(): string {
  return env.GATEWAY_BASE_URL.trim().replace(/\/+$/, "");
}

export const gatewayAdapter: ChannelAdapter = {
  provider: "whatsapp_uazapi",

  resolveRecipient(input: RecipientInput): string | null {
    // Grupo continua impedido pelo caminho novo, com o mesmo desfecho de hoje
    // (FR-025): sem endereço → quem chama grava "sem destinatário", não erro
    // obscuro.
    if (input.isGroup) return null;
    // O gateway aceita E.164 puro; a identidade canônica do contato vem
    // primeiro porque é a que o histórico usa (`phone:+E164` | `lid:<digits>`).
    const identidade = input.waIdentity;
    if (identidade?.startsWith("phone:")) return identidade.slice("phone:".length);
    if (identidade?.startsWith("lid:")) return identidade.slice("lid:".length);
    return input.phoneNumber?.trim() || null;
  },

  isConfigured(): boolean {
    return baseUrl() !== "" && env.GATEWAY_INTERNAL_TOKEN.trim() !== "";
  },

  codes: {
    notConfigured: "gateway_not_configured",
    sendFailed: "gateway_error",
    unknownError: "gateway_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (!this.isConfigured()) return { externalId: null };

    const corpo: Record<string, unknown> = {
      connection_id: envelope.sessionRef,
      to: envelope.to,
      tipo: envelope.kind,
    };
    if (envelope.body) corpo.texto = envelope.body;
    // A CITAÇÃO (spec 006, FR-012). O gateway já tinha o campo — `QuotedID` em
    // `sender.Envio` e `quoted_id` no contrato HTTP; o que faltava era o CRM
    // preenchê-lo. Sem ele, toda resposta a um cliente que mandou cinco perguntas
    // seguidas chega ambígua.
    if (envelope.replyToExternalId) corpo.quoted_id = envelope.replyToExternalId;
    // Carga de localização e de contato: os dois tipos que a API do CRM anunciava
    // e NÃO conseguia entregar, porque o corpo não tinha onde carregá-los. O
    // gateway recusava com "campos obrigatórios ausentes" — e o corretor
    // descobria depois da rede.
    if (envelope.location) {
      corpo.latitude = envelope.location.lat;
      corpo.longitude = envelope.location.lng;
      if (envelope.location.name) corpo.nome = envelope.location.name;
      if (envelope.location.address) corpo.endereco = envelope.location.address;
    }
    if (envelope.contacts && envelope.contacts.length > 0) {
      // O gateway modela UM telefone por entrada (`contatoRequest{Nome,Telefone}`
      // em `internal/handlers/messages.go:78`), não uma lista. Medido antes de
      // escrever: mandar `telefones: []` faria todo envio de contato voltar 400,
      // e o erro falaria de campo obrigatório ausente — diagnóstico que custaria
      // uma rodada inteira. Um contato com dois telefones vira duas entradas, que
      // é como o WhatsApp de fato os mostra no cartão.
      corpo.contatos = envelope.contacts.flatMap((c) =>
        c.phones.map((telefone) => ({ nome: c.name, telefone })),
      );
    }
    if (envelope.menu) {
      corpo.opcoes = envelope.menu.options;
      if (envelope.menu.footer) corpo.texto_rodape = envelope.menu.footer;
    }
    if (envelope.ctaUrl) {
      corpo.rotulo_botao = envelope.ctaUrl.button_label;
      corpo.url_botao = envelope.ctaUrl.button_url;
    }
    if (envelope.media) {
      // Mídia vai por REFERÊNCIA de endereço, nunca embutida (FR-024). A URL
      // assinada de ≥1h é responsabilidade de quem montou o OutboundMedia.
      corpo.midia_url = envelope.media.url;
      corpo.midia_mime = envelope.media.mime ?? undefined;
      corpo.nome_arquivo = envelope.media.filename ?? undefined;
      // A LEGENDA viaja em `texto`, o mesmo campo do envio de texto — é assim
      // que o gateway a repassa ao provedor (`sender/dispatch.go:63`, `Texto`
      // ao lado de `MidiaURL`). Medido na análise da Fase 3: a primeira versão
      // deste arquivo simplesmente não mandava a legenda, e o envio de imagem
      // com texto chegava mudo ao cliente — sem erro, sem log, sem nada. Os
      // dois adapters que já existiam mandam (`lib/waha/media-send.ts:24`,
      // `meta-cloud.ts:51`); só o novo esquecia.
      if (envelope.media.caption) corpo.texto = envelope.media.caption;
    }

    const resposta = await fetch(`${baseUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Credencial SEMPRE em cabeçalho (FR-018) — query string vaza em log.
        Authorization: `Bearer ${env.GATEWAY_INTERNAL_TOKEN}`,
      },
      body: JSON.stringify(corpo),
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => "");
      // 4xx é definitivo, 5xx é reagendável — quem chama decide pelo status.
      // O texto viaja no erro porque `mensagem falhou: 502` sem o corpo é
      // diagnóstico impossível.
      throw new Error(`gateway respondeu ${resposta.status}: ${detalhe.slice(0, 300)}`);
    }

    const dados = (await resposta.json().catch(() => ({}))) as { message_id?: string };
    // A resposta do gateway é ACEITE PROVISÓRIO (FR-021): o estado definitivo
    // vem pelo ACK assíncrono. `message_id` ausente devolve null e o chamador
    // grava "sem id" — nunca inventa um.
    return { externalId: dados.message_id?.trim() || null };
  },
};
