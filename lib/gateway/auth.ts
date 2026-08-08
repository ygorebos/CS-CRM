/**
 * Autenticidade da entrega do gateway — fail-closed, SEM válvula de escape.
 *
 * ## Por que esta rota não herda a válvula do caminho legado
 *
 * O módulo de autenticação do webhook legado tem
 * uma flag que torna a assinatura opcional, desligada por padrão, e o motivo
 * está escrito lá: o emissor daquele caminho **não sabe assinar**. Medido numa
 * VPS real, os eventos chegam sem header nenhum mesmo com o segredo
 * configurado no contêiner; exigir assinatura por default derrubaria a
 * ingestão de todo mundo. A regra 3 daquele módulo — "sem assinatura e sem
 * exigência ⇒ aceita" — é uma concessão a um emissor limitado.
 *
 * Aqui essa desculpa não existe. O emissor é o **nosso** gateway, ele assina
 * sempre, e um modo que aceite entrega não verificada seria exatamente o buraco
 * fail-open que já foi explorado neste produto: quem soubesse a URL injetava
 * mensagem falsa em CRM alheio, escolhia o remetente e fazia o canal da
 * vítima responder para um número arbitrário.
 *
 * ## O que a assinatura cobre, e por que o timestamp entra nela
 *
 * HMAC-SHA512 sobre `"{timestamp}.{corpo}"`, não sobre o corpo sozinho. Assinar
 * só o corpo deixa a entrega **reenviável para sempre**: quem capturasse uma
 * entrega legítima poderia repeti-la meses depois, com assinatura perfeitamente
 * válida. O timestamp dentro do material assinado é o que fecha isso, e a janela
 * curta é o que limita a repetição — sem exigir estado nem memória de eventos já
 * vistos.
 *
 * A janela é de 5 minutos para os dois lados: relógio de contêiner desliza, e
 * recusar entrega legítima por 40 segundos de diferença seria trocar um risco
 * remoto por uma falha diária.
 *
 * Contrato: `contracts/gateway-inbound-v1.md` §2, na spec 001.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Curto demais para ser segredo de verdade — é placeholder ou lixo de decrypt.
 * Mesmo limiar do caminho legado, e pelo mesmo motivo: as rotas que criam sessão
 * gravavam `Buffer.from([0])`, um byte de enfeite, e tratar isso como segredo
 * válido é o que transforma "fail-closed" em teatro.
 */
export const TAMANHO_MINIMO_DO_SEGREDO = 16;

/** Tolerância de relógio, em segundos, para cada lado. */
export const JANELA_DE_VALIDADE_SEGUNDOS = 300;

export type MotivoRecusaDeAuth =
  | "assinatura_ausente"
  | "assinatura_invalida"
  | "timestamp_ausente"
  | "timestamp_invalido"
  | "timestamp_fora_da_janela"
  | "segredo_nao_provisionado";

export type ResultadoAuth = { ok: true } | { ok: false; motivo: MotivoRecusaDeAuth };

export interface EntradaDeAuth {
  /** O corpo EXATO como chegou. Reserializar muda bytes e quebra a assinatura. */
  corpoCru: string;
  assinatura: string | null;
  timestamp: string | null;
  /** Segredo por conexão, já decifrado. `null` quando não há ou não decifrou. */
  segredo: string | null;
  /** Injetável para o teste não depender do relógio da máquina. */
  agoraEmSegundos?: number;
}

/**
 * Material assinado. Exportado porque o teste — e, um dia, um diagnóstico de
 * produção — precisa reproduzir exatamente o que o gateway assinou.
 */
export function materialAssinado(timestamp: string, corpoCru: string): string {
  return `${timestamp}.${corpoCru}`;
}

export function assinarEntrega(timestamp: string, corpoCru: string, segredo: string): string {
  return createHmac("sha512", segredo)
    .update(materialAssinado(timestamp, corpoCru), "utf8")
    .digest("hex");
}

export function autenticarEntregaDoGateway(entrada: EntradaDeAuth): ResultadoAuth {
  const { corpoCru, assinatura, timestamp, segredo } = entrada;

  // Ordem deliberada: o segredo é checado ANTES da assinatura. Sem segredo não
  // há como verificar nada, e responder "assinatura inválida" mandaria o
  // operador caçar o problema no lado errado — o defeito é de provisionamento
  // desta conexão, e o motivo próprio é o que faz o aviso certo aparecer na
  // Central em vez de virar silêncio.
  if (!segredo || segredo.length < TAMANHO_MINIMO_DO_SEGREDO) {
    return { ok: false, motivo: "segredo_nao_provisionado" };
  }

  if (!assinatura || !assinatura.trim()) return { ok: false, motivo: "assinatura_ausente" };
  if (!timestamp || !timestamp.trim()) return { ok: false, motivo: "timestamp_ausente" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) {
    return { ok: false, motivo: "timestamp_invalido" };
  }

  const agora = entrada.agoraEmSegundos ?? Math.floor(Date.now() / 1000);
  // Os dois lados: um timestamp no futuro é tão suspeito quanto um velho, e
  // aceitar futuro daria uma janela arbitrariamente longa a quem escolhe o valor.
  if (Math.abs(agora - ts) > JANELA_DE_VALIDADE_SEGUNDOS) {
    return { ok: false, motivo: "timestamp_fora_da_janela" };
  }

  const esperada = assinarEntrega(timestamp, corpoCru, segredo);
  const recebida = assinatura.replace(/^sha512=/i, "").trim();

  // Comparar comprimento antes evita que `timingSafeEqual` lance — e o retorno
  // é o mesmo `false`, então não há canal lateral novo.
  if (recebida.length !== esperada.length) return { ok: false, motivo: "assinatura_invalida" };

  try {
    const igual = timingSafeEqual(Buffer.from(recebida, "hex"), Buffer.from(esperada, "hex"));
    return igual ? { ok: true } : { ok: false, motivo: "assinatura_invalida" };
  } catch {
    // hex malformado cai aqui. Recusa, nunca exceção que vire 500 — 500 num
    // webhook faz o emissor retentar para sempre um payload que nunca vai passar.
    return { ok: false, motivo: "assinatura_invalida" };
  }
}
