/**
 * Escalação da recusa por falta de lastro — spec 002, FR-012.
 *
 * O agente recusou uma afirmação de assistência porque não havia trecho do acervo que a
 * sustentasse. Isso **não é erro**: é o comportamento correto do princípio IX. Mas
 * recusar e calar seria abandono — o invariante 4 do sistema vivo diz que nada morre sem
 * próximo passo, e aqui o próximo passo tem dono: o corretor, que precisa carregar o
 * material que falta.
 *
 * ## O que esta escalação NÃO faz, e por quê
 *
 * Não chama `performHumanHandoff`. Aquele caminho grava `contacts.force_human = true` e
 * `bot_silenced_until = 'infinity'` — irrevogável pelo agente, de propósito, porque
 * existe para pedido explícito de humano e para suspeita de opt-out. Aplicá-lo aqui
 * puniria o corretor por uma lacuna no acervo **dele**: o cliente que perguntou uma vez
 * sobre carência ficaria sem atendimento automático para sempre, mesmo depois de o
 * material entrar. A lacuna se resolve carregando conteúdo, e quando ela se resolve o
 * agente tem de voltar a atender sozinho.
 *
 * O que se faz é o suficiente e reversível: a conversa volta para a fila humana (só
 * quando está com a IA — nunca rouba conversa já assumida nem reabre encerrada) e um
 * aviso acionável abre na Central com o que FR-012 exige.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';

export interface EscalacaoSemLastro {
  tenantId: string;
  leadId: string;
  conversationId: string;
  /** A pergunta do cliente, como ela chegou. FR-012 a exige no aviso. */
  perguntaOriginal: string;
  /**
   * O escopo (operadora) envolvido, quando conhecido. Na fatia F1 ainda não existe
   * vínculo cliente↔operadora, então é sempre null e o aviso diz "não identificada" —
   * que é informação honesta, não campo vazio.
   */
  escopo: string | null;
  log: Logger;
}

/** Corta a pergunta para o corpo do aviso sem quebrar no meio de uma palavra. */
function resumirPergunta(texto: string, limite = 400): string {
  const limpo = texto.trim().replace(/\s+/g, ' ');
  if (limpo.length <= limite) return limpo;
  const corte = limpo.slice(0, limite);
  const ultimoEspaco = corte.lastIndexOf(' ');
  return `${ultimoEspaco > limite * 0.6 ? corte.slice(0, ultimoEspaco) : corte}…`;
}

/**
 * Devolve a conversa à fila humana e abre o aviso. Idempotente por episódio: duas
 * recusas na mesma conversa com aviso ainda aberto geram **um** item, no mesmo padrão de
 * dedup do handoff e do jailbreak. Sem isso, um cliente insistente produziria uma lista
 * de avisos idênticos e o corretor pararia de olhar a Central — que é a forma mais comum
 * de um mecanismo anti-morte morrer.
 *
 * Devolve quantos avisos foram criados (0 = já havia um aberto para este contato).
 */
export async function escalarAssistenciaSemLastro(
  db: pg.Pool,
  input: EscalacaoSemLastro,
): Promise<number> {
  // (a) A conversa volta para quem pode responder. Só transiciona de 'ai_handling' —
  // conversa já assumida por humano (claimed) ou encerrada (closed) fica como está.
  await db.query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end
      where organization_id = $1 and id = $2`,
    [input.tenantId, input.conversationId],
  );

  // (b) O aviso acionável, com os três campos que FR-012 exige.
  const { rowCount } = await db.query(
    `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
     select $1, 'assistance_without_grounding', 'warn', $2, $3, 'contact', $4
     where not exists (
       select 1 from agent_inbox_items
       where organization_id = $1
         and kind = 'assistance_without_grounding'
         and ref_kind = 'contact'
         and ref_id = $4
         and status = 'open'
     )`,
    [
      input.tenantId,
      'Pergunta sem material para responder — o cliente está esperando',
      [
        `O cliente perguntou: "${resumirPergunta(input.perguntaOriginal)}"`,
        `Operadora: ${input.escopo ?? 'não identificada'}`,
        'Motivo: não há material carregado que responda a esta pergunta, e o agente não ' +
          'inventa procedimento de operadora. Ele avisou o cliente que uma pessoa vai confirmar.',
        'O que fazer: responda ao cliente e carregue o material que cobre este assunto — ' +
          'da próxima vez o agente responde sozinho.',
      ].join('\n'),
      input.leadId,
    ],
  );

  const criados = rowCount ?? 0;
  input.log.info('assistência recusada por falta de lastro — conversa escalada', {
    conversation_id: input.conversationId,
    aviso_criado: criados > 0,
  });
  return criados;
}
