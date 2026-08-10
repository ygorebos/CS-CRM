/**
 * A bolha nunca fica vazia (spec 006, FR-009) — e a mensagem apagada continua
 * legível, marcada (FR-005).
 *
 * O defeito que estes casos vigiam era invisível justamente por ser vazio: a
 * bolha existia, ocupava espaço, tinha hora — e não dizia nada. Nenhum erro,
 * nenhum log, nenhum sinal de que o corretor tinha acabado de perder o que o
 * cliente mandou.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MessageProjection } from "@/lib/messaging/projection/types";
import type { Message } from "@/lib/types/messaging";

// Os renderers de mídia baixam por URL assinada e não são o objeto deste teste.
vi.mock("@/components/inbox/media/ImageMedia", () => ({
  ImageMedia: () => <div data-testid="midia-imagem" />,
}));
vi.mock("@/components/inbox/media/VideoMedia", () => ({
  VideoMedia: () => <div data-testid="midia-video" />,
}));
vi.mock("@/components/inbox/media/AudioPlayer", () => ({
  AudioPlayer: () => <div data-testid="midia-audio" />,
}));
vi.mock("@/components/inbox/media/StickerMedia", () => ({
  StickerMedia: () => <div data-testid="midia-figurinha" />,
}));
vi.mock("@/components/inbox/media/DocumentCard", () => ({
  DocumentCard: () => <div data-testid="midia-documento" />,
}));

import { MessageBubble } from "@/components/inbox/MessageBubble";

const VAZIA: MessageProjection = {
  quote: null,
  reactions: [],
  deletion: null,
  unsupported: null,
};

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    organization_id: "org",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: "wamid.A",
    type: "text",
    direction: "inbound",
    status: "received",
    ack: null,
    error_code: null,
    error_message: null,
    body: null,
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "system",
    sent_by_user_id: null,
    sent_at: "2026-08-09T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    created_at: "2026-08-09T12:00:00.000Z",
    projection: VAZIA,
    ...over,
  };
}

/** O que a bolha mostra além da hora e dos indicadores de entrega. */
function conteudoUtil(): string {
  const bolha = screen.getByTestId("bolha-de-mensagem");
  return (bolha.textContent ?? "")
    .replace(/\d{2}:\d{2}/g, "")
    .replace(/Lida|Entregue|Enviada|Falhou/g, "")
    .trim();
}

describe("bolha de mensagem — nunca em branco", () => {
  it("mensagem sem corpo e sem anexo mostra o rótulo, não o vazio", () => {
    render(
      <MessageBubble
        message={msg({
          type: "system",
          metadata: { original_type: "postback" },
          projection: {
            ...VAZIA,
            unsupported: {
              originalType: "postback",
              label: "Mensagem de um tipo que ainda não sabemos exibir (postback)",
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId("mensagem-nao-suportada")).toBeTruthy();
    expect(conteudoUtil()).not.toBe("");
  });

  it("localização recebida abre no mapa em vez de virar bolha vazia", () => {
    render(
      <MessageBubble
        message={msg({
          type: "location",
          metadata: { location: { lat: -23.5613, lng: -46.6565, nome: "Clínica São Lucas" } },
        })}
      />,
    );
    const cartao = screen.getByTestId("cartao-de-localizacao");
    expect(cartao.getAttribute("href")).toContain("-23.5613");
    expect(screen.getByText("Clínica São Lucas")).toBeTruthy();
  });

  it("cartão de contato mostra nome e telefone", () => {
    render(
      <MessageBubble
        message={msg({
          type: "contact",
          metadata: { contacts: [{ name: "Dra. Ana", phones: ["+5511999998888"] }] },
        })}
      />,
    );
    expect(screen.getByTestId("cartao-de-contato")).toBeTruthy();
    expect(screen.getByText("+5511999998888")).toBeTruthy();
  });

  it("menu enviado mostra AS OPÇÕES, não só a pergunta", () => {
    // Medido em 2026-08-10 mandando um menu de verdade pelo canal conectado: a
    // bolha exibia apenas "qual plano te interessa?" e engolia a lista. Quem
    // reabre a conversa amanhã precisa saber o que ofereceu — é a lista que
    // determina o que o cliente pôde responder, e sem ela a resposta chega sem
    // referente.
    render(
      <MessageBubble
        message={msg({
          type: "menu",
          direction: "outbound",
          body: "Qual plano te interessa?",
          metadata: { menu: { options: ["Individual", "Familiar"], footer: "Responda tocando" } },
        })}
      />,
    );
    expect(screen.getByTestId("opcoes-do-menu")).toBeTruthy();
    expect(screen.getByText("Individual")).toBeTruthy();
    expect(screen.getByText("Familiar")).toBeTruthy();
    expect(screen.getByText("Responda tocando")).toBeTruthy();
  });

  it("menu com carga inválida não quebra a bolha — a pergunta continua na tela", () => {
    // Linha antiga, ou gravada por um caminho que não validou. Cair aqui não pode
    // custar a mensagem inteira.
    render(
      <MessageBubble
        message={msg({
          type: "menu",
          direction: "outbound",
          body: "Qual plano te interessa?",
          metadata: { menu: { options: [] } },
        })}
      />,
    );
    expect(screen.queryByTestId("opcoes-do-menu")).toBeNull();
    expect(screen.getByText("Qual plano te interessa?")).toBeTruthy();
  });

  it("localização SEM carga válida cai no rótulo, e ainda assim não fica vazia", () => {
    // O caso que a leitura tolerante precisa cobrir: linha antiga, gravada antes
    // de a carga existir. Sem o rótulo, seria exatamente a bolha em branco.
    render(
      <MessageBubble
        message={msg({
          type: "location",
          metadata: {},
          projection: {
            ...VAZIA,
            unsupported: { originalType: null, label: "Mensagem sem conteúdo exibível" },
          },
        })}
      />,
    );
    expect(conteudoUtil()).not.toBe("");
  });
});

describe("bolha de mensagem — citação, reação e apagamento", () => {
  it("mostra o trecho citado e de quem era", () => {
    render(
      <MessageBubble
        message={msg({
          body: "É 30%",
          direction: "outbound",
          projection: {
            ...VAZIA,
            quote: {
              messageId: "m0",
              authorKind: "inbound",
              type: "text",
              preview: "Qual o valor da coparticipação?",
              isDeleted: false,
              isUnavailable: false,
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId("citacao-de-mensagem")).toBeTruthy();
    expect(screen.getByText("Qual o valor da coparticipação?")).toBeTruthy();
    expect(screen.getByText("Contato")).toBeTruthy();
  });

  it("citação de alvo ausente diz que o original não está aqui", () => {
    render(
      <MessageBubble
        message={msg({
          body: "pode ser",
          projection: {
            ...VAZIA,
            quote: {
              messageId: null,
              authorKind: "inbound",
              type: "unknown",
              preview: "",
              isDeleted: false,
              isUnavailable: true,
            },
          },
        })}
      />,
    );
    expect(screen.getByTestId("citacao-de-mensagem").getAttribute("data-indisponivel")).toBe(
      "true",
    );
    expect(screen.getByText("Mensagem original indisponível")).toBeTruthy();
  });

  it("a reação aparece PRESA à bolha, e não como item da conversa", () => {
    render(
      <MessageBubble
        message={msg({
          body: "Proposta enviada",
          projection: {
            ...VAZIA,
            reactions: [
              { emoji: "👍", actorKind: "inbound", reactedAt: "2026-08-09T12:01:00.000Z" },
            ],
          },
        })}
      />,
    );
    const bolha = screen.getByTestId("bolha-de-mensagem");
    // Dentro da MESMA bolha da mensagem — é isso que "presa" quer dizer, e é o
    // que separa a correção do defeito (emoji solto na linha do tempo).
    expect(bolha.querySelector('[data-testid="reacoes-da-mensagem"]')).toBeTruthy();
    expect(screen.getByTestId("reacao").textContent).toBe("👍");
  });

  it("mensagem apagada CONTINUA legível, sob a marca (FR-005)", () => {
    render(
      <MessageBubble
        message={msg({
          body: "A mensalidade é 480",
          projection: {
            ...VAZIA,
            deletion: { deletedAt: "2026-08-09T12:05:00.000Z", deletedByKind: "inbound" },
          },
        })}
      />,
    );
    expect(screen.getByTestId("marca-de-apagada").textContent).toContain("Apagada pelo contato");
    // A evidência do que foi dito não some porque o cliente voltou atrás — foi a
    // decisão do dono, e diverge do WhatsApp de propósito.
    expect(screen.getByText("A mensalidade é 480")).toBeTruthy();
  });

  it("apagada pela própria equipe se distingue da apagada pelo contato", () => {
    render(
      <MessageBubble
        message={msg({
          body: "valor errado",
          direction: "outbound",
          projection: {
            ...VAZIA,
            deletion: { deletedAt: "2026-08-09T12:05:00.000Z", deletedByKind: "outbound" },
          },
        })}
      />,
    );
    expect(screen.getByTestId("marca-de-apagada").textContent).toContain("Apagada pela sua equipe");
  });

  it("mensagem sem projeção nenhuma não quebra a bolha", () => {
    // Compatibilidade: a mesma interface descreve a linha crua do banco. Um
    // consumidor antigo (MCP, automação) não perde a tela por causa disso.
    const semProjecao = msg({ body: "oi" });
    delete (semProjecao as { projection?: unknown }).projection;
    render(<MessageBubble message={semProjecao} />);
    expect(screen.getByText("oi")).toBeTruthy();
  });
});
