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
   * O escopo (operadora) envolvido, quando conhecido. `null` quando o vínculo do contato
   * não existe e o cliente não nomeou nenhuma — o aviso diz "não identificada", que é
   * informação honesta, não campo vazio.
   *
   * Desde a fatia F2 este campo carrega a operadora de verdade: o vínculo de `contacts`
   * ou o nome que o cliente escreveu na conversa. A rota de lacunas
   * (`app/api/v1/catalog/gaps`) agrupa por ele lendo a linha `Operadora:` do corpo — mudar
   * o formato daquela linha quebra o agrupamento do curador.
   */
  escopo: string | null;
  /**
   * FR-042 (T137): operadoras que existem no catálogo, cobririam este assunto, e estão
   * **desligadas** para este corretor.
   *
   * Sem esta informação, a decisão A-20 ("tudo nasce desligado") produz o pior desfecho da
   * feature: o corretor lê a recusa, conclui que o sistema não sabe responder, e desiste —
   * quando o sistema sabe e ninguém ligou. Vazio = não há nada assim, e o aviso não
   * inventa uma sugestão para parecer útil.
   */
  escoposDesligadosQueCobririam?: readonly string[];
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

  // (b) O aviso acionável, com os três campos que FR-012 exige — e, quando ela existe, a
  // linha de FR-042 que transforma "o sistema não sabe" em "o sistema sabe, ligue aqui".
  const desligadas = input.escoposDesligadosQueCobririam ?? [];
  const linhaFr042 =
    desligadas.length > 0
      ? [
          `Já existe material pronto sobre este assunto para: ${desligadas.join(', ')}. ` +
            'Está desligado para você — por padrão nada vem ligado, para o agente não falar de ' +
            'operadora que você não vende.',
          'O que fazer agora: ligue essa operadora na tela de Operadoras (menu IA › Conhecimento). ' +
            'É um clique, e a partir dele o agente responde sozinho este tipo de pergunta.',
        ]
      : [
          'O que fazer: responda ao cliente e carregue o material que cobre este assunto — ' +
            'da próxima vez o agente responde sozinho.',
        ];

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
        ...linhaFr042,
      ].join('\n'),
      input.leadId,
    ],
  );

  const criados = rowCount ?? 0;
  input.log.info('assistência recusada por falta de lastro — conversa escalada', {
    conversation_id: input.conversationId,
    aviso_criado: criados > 0,
    // Contagem, nunca os nomes: o log é lido em agregado e nome de operadora num
    // aviso pontual não ajuda ninguém a diagnosticar. Quem precisa vê na Central.
    escopo_identificado: input.escopo !== null,
    operadoras_desligadas_que_cobririam: desligadas.length,
  });
  return criados;
}
