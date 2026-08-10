/**
 * A projeção de eventos sobre mensagens — o que faz a conversa parar de esconder
 * o que o cliente disse.
 *
 * # O problema que ela resolve
 *
 * Citação, reação e apagamento chegam pelo MESMO campo do envelope
 * (`message.reply_to_external_id`) e o ingest já os grava. Nada disso era lido:
 * a citação ficava invisível, a reação virava uma bolha solta com um emoji no
 * meio da conversa, e a mensagem apagada virava bolha em branco. Perder o que o
 * cliente disse, sem nenhum sinal de que se perdeu.
 *
 * # Por que projeção na leitura, e não coluna
 *
 * O dado JÁ EXISTE e o vínculo JÁ É uma referência (`external_id`). Gravar de
 * novo numa coluna ou numa tabela seria duplicar sem fonte da verdade declarada
 * (anti-pattern 2), exigiria backfill do histórico, e — o que pesa mais — poria
 * efeito colateral no caminho que recebe mensagem, o mais caro de quebrar neste
 * sistema. A doutrina DIRC responde sozinha: não Duplicar, é Referência, é
 * Calculável.
 *
 * # A direção da busca importa
 *
 * A projeção parte **do alvo, não do evento**: colhe os `external_id` da página e
 * pergunta quem aponta para eles. O contrário (varrer eventos e procurar alvos)
 * traria reação de mensagem que não está na tela, sem lugar onde exibir.
 *
 * # Tenancy
 *
 * `external_id` é único **por organização**, não globalmente. Toda consulta aqui
 * filtra `organization_id` explicitamente, resolvido de fonte confiável pelo
 * chamador. Sem isso, dois tenants com o mesmo id do canal projetariam a reação
 * de um cliente na conversa de outro — vigiado por
 * `tests/invariants/projecao-de-eventos-isolamento.test.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { lerContatos, lerLocalizacao } from "@/lib/messaging/payloads";
import type { Message } from "@/lib/types/messaging";

import {
  PROJECAO_VAZIA,
  type ActorKind,
  type MessageProjection,
  type MessageReaction,
} from "./types";

type SB = SupabaseClient;

/** Colunas que a projeção precisa. Pedir `*` traria mídia e corpo que não usa. */
const COLUNAS_DE_EVENTO =
  "id, external_id, type, direction, body, sent_at, metadata";

interface LinhaDeEvento {
  id: string;
  external_id: string | null;
  type: string;
  direction: ActorKind;
  body: string | null;
  sent_at: string;
  metadata: Record<string, unknown> | null;
}

function meta(m: { metadata?: unknown } | null | undefined): Record<string, unknown> {
  const v = m?.metadata;
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function alvoDe(m: { metadata?: unknown }): string | null {
  const v = meta(m).reply_to_external_id;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function tipoOriginal(m: { metadata?: unknown }): string | null {
  const v = meta(m).original_type;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * O evento de apagamento não é um tipo do banco — chega como `system` com o
 * rótulo cru preservado.
 *
 * Os nomes vêm dos normalizadores do gateway: o canal oficial manda `revoke`; os
 * demais, quando mandarem, tendem a usar o mesmo verbo. Reconhecer uma lista, e
 * não um valor só, é o que evita ter de mexer aqui quando um canal novo aparecer
 * com o sinônimo dele.
 */
const ROTULOS_DE_APAGAMENTO = new Set(["revoke", "revoked", "delete", "deleted", "message_delete"]);

function ehApagamento(m: { type: string; metadata?: unknown }): boolean {
  const original = tipoOriginal(m);
  return m.type === "system" && original !== null && ROTULOS_DE_APAGAMENTO.has(original);
}

/**
 * A linha é um EVENTO sobre outra mensagem, e não uma mensagem da conversa?
 *
 * Evento não aparece na linha do tempo: ele vira `projection` do alvo. Deixá-lo
 * aparecer é o defeito de hoje — o emoji solto e a bolha em branco.
 */
export function ehEventoSobreMensagem(m: { type: string; metadata?: unknown }): boolean {
  return m.type === "reaction" || ehApagamento(m);
}

/**
 * A mensagem renderiza alguma coisa?
 *
 * É o que decide o rótulo de "ainda não sabemos exibir" (FR-009). A pergunta é
 * deliberadamente sobre CONTEÚDO, não sobre tipo: assim um tipo novo que traga
 * corpo aparece como texto, e um tipo conhecido que venha vazio não escapa.
 */
function temAlgoAExibir(m: Message): boolean {
  if (m.body && m.body.trim() !== "") return true;
  if (m.media_url || m.media_storage_path) return true;
  if (lerLocalizacao(m.metadata)) return true;
  if (lerContatos(m.metadata).length > 0) return true;
  return false;
}

function recorte(texto: string | null, tipo: string): string {
  const t = (texto ?? "").trim();
  if (t !== "") return t.slice(0, 160);
  // Anexo sem legenda: a citação diz o QUE é, em vez de ficar vazia (US2-4).
  return "";
}

/**
 * Projeta os eventos da página sobre as mensagens dela.
 *
 * Devolve um mapa `id da mensagem → projeção`. Mensagem sem nada projetado sai
 * com `PROJECAO_VAZIA` — as chaves existem sempre, para que a tela teste uma
 * coisa só.
 *
 * Custo: **duas** consultas por página, ambas por índice — uma para as mensagens
 * citadas (por `external_id`, que já é único por organização) e uma para os
 * eventos que apontam para a página (pelo índice parcial da migration 0132).
 */
export async function projetarEventos(
  supabase: SB,
  organizationId: string,
  page: Message[],
): Promise<Map<string, MessageProjection>> {
  const projecoes = new Map<string, MessageProjection>();
  for (const m of page) {
    projecoes.set(m.id, { ...PROJECAO_VAZIA, reactions: [] });
  }
  if (page.length === 0) return projecoes;

  // ── 1. Quem eu cito, e quem pode apontar para mim ──────────────────────────
  const idsDaPagina = page.map((m) => m.external_id).filter((x): x is string => !!x);
  const idsCitados = [...new Set(page.map(alvoDe).filter((x): x is string => x !== null))];

  // ── 2. As mensagens citadas (podem estar fora da página) ───────────────────
  const citadasPorExternalId = new Map<string, LinhaDeEvento>();
  if (idsCitados.length > 0) {
    const { data, error } = await supabase
      .from("messages")
      .select(COLUNAS_DE_EVENTO)
      .eq("organization_id", organizationId)
      .in("external_id", idsCitados);
    if (error) {
      // A conversa não pode sumir porque a citação não resolveu. Sem o alvo, a
      // citação aparece como indisponível — que é informação verdadeira.
      logger.warn("projecao: consulta de mensagens citadas falhou", {
        organization_id: organizationId,
        erro: error.message,
      });
    }
    for (const l of (data ?? []) as unknown as LinhaDeEvento[]) {
      if (l.external_id) citadasPorExternalId.set(l.external_id, l);
    }
  }

  // ── 3. Os eventos que apontam para a página OU para as citadas ─────────────
  //
  // As duas listas na MESMA consulta: sem isso, saber se a mensagem citada foi
  // apagada custaria uma terceira ida ao banco.
  const alvosDeInteresse = [...new Set([...idsDaPagina, ...idsCitados])];
  const eventos: LinhaDeEvento[] = [];
  if (alvosDeInteresse.length > 0) {
    const { data, error } = await supabase
      .from("messages")
      .select(COLUNAS_DE_EVENTO)
      .eq("organization_id", organizationId)
      .in("metadata->>reply_to_external_id", alvosDeInteresse)
      .order("sent_at", { ascending: true });
    if (error) {
      logger.warn("projecao: consulta de eventos falhou", {
        organization_id: organizationId,
        erro: error.message,
      });
    }
    eventos.push(...((data ?? []) as unknown as LinhaDeEvento[]));
  }

  // ── 4. Reações e apagamentos, por alvo ─────────────────────────────────────
  //
  // Reação é ESTADO: a chave inclui quem reagiu, e a última vence. Emoji vazio é
  // remoção — o par sai do mapa em vez de virar entrada com string vazia.
  const reacoesPorAlvo = new Map<string, Map<ActorKind, MessageReaction>>();
  const apagamentoPorAlvo = new Map<string, { deletedAt: string; deletedByKind: ActorKind }>();
  let orfaos = 0;

  const externalIdsConhecidos = new Set(alvosDeInteresse);

  for (const ev of eventos) {
    const alvo = alvoDe(ev);
    if (!alvo) continue;
    if (!externalIdsConhecidos.has(alvo)) {
      orfaos++;
      continue;
    }

    if (ev.type === "reaction") {
      const emoji =
        (typeof meta(ev).reaction_emoji === "string" ? (meta(ev).reaction_emoji as string) : "") ||
        (ev.body ?? "");
      const porAutor = reacoesPorAlvo.get(alvo) ?? new Map<ActorKind, MessageReaction>();
      if (emoji.trim() === "") {
        porAutor.delete(ev.direction);
      } else {
        porAutor.set(ev.direction, {
          emoji: emoji.trim(),
          actorKind: ev.direction,
          reactedAt: ev.sent_at,
        });
      }
      reacoesPorAlvo.set(alvo, porAutor);
      continue;
    }

    if (ehApagamento(ev)) {
      apagamentoPorAlvo.set(alvo, { deletedAt: ev.sent_at, deletedByKind: ev.direction });
    }
  }

  if (orfaos > 0) {
    // Evento cujo alvo o CRM nunca ingeriu. Não há onde exibir — mas sumir em
    // silêncio seria evento sem consumer, e o número é a única forma de saber
    // que existe um buraco de histórico.
    logger.info("projecao: eventos sem alvo na base", {
      organization_id: organizationId,
      quantidade: orfaos,
    });
  }

  // ── 5. Montar a projeção de cada mensagem da página ────────────────────────
  for (const m of page) {
    const proj: MessageProjection = {
      quote: null,
      reactions: [],
      deletion: null,
      unsupported: null,
    };

    const alvo = alvoDe(m);
    if (alvo) {
      const citada = citadasPorExternalId.get(alvo);
      proj.quote = citada
        ? {
            messageId: citada.id,
            authorKind: citada.direction,
            type: citada.type,
            preview: recorte(citada.body, citada.type),
            isDeleted: apagamentoPorAlvo.has(alvo),
            isUnavailable: false,
          }
        : {
            messageId: null,
            authorKind: "inbound",
            type: "unknown",
            preview: "",
            isDeleted: false,
            // O alvo não existe aqui — mensagem anterior à conexão do canal, ou
            // perdida. A citação continua aparecendo dizendo isso.
            isUnavailable: true,
          };
    }

    if (m.external_id) {
      const porAutor = reacoesPorAlvo.get(m.external_id);
      if (porAutor && porAutor.size > 0) {
        proj.reactions = [...porAutor.values()].sort((a, b) =>
          a.reactedAt.localeCompare(b.reactedAt),
        );
      }
      const apagada = apagamentoPorAlvo.get(m.external_id);
      if (apagada) proj.deletion = apagada;
    }

    if (!temAlgoAExibir(m)) {
      const original = tipoOriginal(m);
      proj.unsupported = {
        originalType: original,
        label: original
          ? `Mensagem de um tipo que ainda não sabemos exibir (${original})`
          : "Mensagem sem conteúdo exibível",
      };
    }

    projecoes.set(m.id, proj);
  }

  return projecoes;
}
