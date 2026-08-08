/**
 * Teto de entregas por conexão, na rota de recebimento do gateway.
 *
 * ## O número não é palpite, e não pode ser apertado
 *
 * A spec exige duas coisas que puxam para lados opostos: a rota é pública e
 * precisa de teto (Princípio VI), e uma rajada de **200 mensagens em 60
 * segundos** tem de entrar inteira, sem perda nem duplicata (SC-010). Uma
 * campanha respondida por muita gente ao mesmo tempo é exatamente esse cenário —
 * e é um dia BOM para o corretor, não um ataque.
 *
 * Teto apertado demais aqui não "protege": ele descarta a resposta do cliente e
 * fica indistinguível de o sistema estar fora do ar. Por isso o limite nasce
 * como **múltiplo declarado** do alvo de rajada, e não como número escolhido a
 * dedo.
 *
 * ## Por que é por conexão, e não por IP
 *
 * Quem entrega é sempre o mesmo gateway, do mesmo endereço. Um teto por IP
 * juntaria todas as conexões de todas as organizações num balde só: a
 * organização mais movimentada calaria as outras. A chave é o token de caminho
 * da conexão, que já identifica tenant e canal.
 *
 * O gateway respeita `Retry-After` e reentrega, então bater no teto atrasa, não
 * perde. Mas atraso visível também é defeito — daí a folga.
 */
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

/** O alvo que a spec exige suportar: 200 mensagens em 60 segundos (SC-010). */
export const RAJADA_ALVO_POR_MINUTO = 200;

/**
 * Fator de folga sobre o alvo. Três porque a rajada pode chegar concentrada nos
 * primeiros segundos da janela, e porque estado de entrega (`delivered`, `read`)
 * chega como entrega própria — uma mensagem real produz mais de um evento.
 */
export const FATOR_DE_FOLGA = 3;

export const JANELA_SEGUNDOS = 60;
export const TETO_POR_CONEXAO = RAJADA_ALVO_POR_MINUTO * FATOR_DE_FOLGA;

export interface VeredictoDeTeto {
  permitido: boolean;
  /** Cabeçalhos a devolver SEMPRE — inclusive quando permitido. */
  cabecalhos: Record<string, string>;
}

export async function checarTetoDaConexao(
  webhookPathToken: string,
  agoraMs: number = Date.now(),
): Promise<VeredictoDeTeto> {
  const r = await checkRateLimit(
    `gateway:inbound:${webhookPathToken}`,
    TETO_POR_CONEXAO,
    JANELA_SEGUNDOS,
  );

  const restante = Math.max(0, r.limit - r.count);
  // Fim da janela atual — é o instante em que o contador zera, e é o que o
  // emissor precisa para saber quando voltar.
  const fimDaJanela =
    (Math.floor(agoraMs / (JANELA_SEGUNDOS * 1000)) + 1) * JANELA_SEGUNDOS;

  const cabecalhos: Record<string, string> = {
    "X-RateLimit-Limit": String(r.limit),
    "X-RateLimit-Remaining": String(restante),
    "X-RateLimit-Reset": String(fimDaJanela),
  };
  if (!r.allowed) {
    cabecalhos["Retry-After"] = String(
      Math.max(1, fimDaJanela - Math.floor(agoraMs / 1000)),
    );
  }

  return { permitido: r.allowed, cabecalhos };
}
