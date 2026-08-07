/**
 * Handler do job `operator_turn` — o papel OPERADOR (spec 16 §3.2).
 *
 * O que mexe no sistema, e que **nunca fala com o lead**. Não é regra de prompt:
 * ele não tem `send_message` no toolset. A separação é por AUSÊNCIA, e é a única
 * forma que não depende de o modelo obedecer.
 *
 * ═══ POR QUE ELE NÃO É CHAMADO PELO CONVERSADOR ═══
 *
 * Porque isso devolveria o problema inteiro. Se o Operador só rodasse quando o
 * Conversador lembrasse de acioná-lo, o turno em que ele "não achasse necessário"
 * seria um lead parado no funil, em silêncio — e silêncio é justamente o modo de
 * falha que ninguém vê. O disparo é do RUNTIME, no fim do turno, incondicional.
 * Mesmo argumento que este codebase já usa para a chamada de fechamento.
 *
 * ═══ O CURTO-CIRCUITO, e por que ele é fiel em vez de econômico ═══
 *
 * Quando a declaração (spec 16 §5) diz `nada_a_declarar: true`, o Operador NÃO
 * chama modelo: registra "nada a fazer" e encerra. Não é economia disfarçada de
 * desenho — é a distinção do passo 2 valendo a pena. Quem avaliou o turno foi o
 * Conversador, que estava lá; repetir a avaliação com menos contexto para chegar
 * à mesma conclusão é gastar a chave do self-hoster para nada.
 *
 * Mas quando a declaração está AUSENTE (`null`), ele roda. Ausente significa que
 * NINGUÉM avaliou — o fechamento veio incompleto —, e é exatamente aí que um
 * turno pode ter deixado promessa sem dono. Os dois estados que o passo 2 tomou o
 * cuidado de não colapsar decidem, aqui, se uma chamada de modelo acontece.
 */
import { z } from 'zod';
import type pg from 'pg';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import type { InboundTurnDeps } from './inbound-turn';
import { latestCheckpoint } from './inbound-turn';
import { declaracaoDoTurnoSchema, promessasEmAberto, type DeclaracaoDoTurno } from './declaracao';
import { loadPublishedAgentConfigById } from './agent-config';
import { insertInboxItem } from '../db/repository';
import { buildMcpTurnTools } from '../edge/crm/mcp-tools';
import { runModelCall } from '../edge/llm/run-model-call';
import { avisarCapacidadesAusentes } from './inbound-turn';

/**
 * O que o runtime enfileira ao fim do turno do Conversador. Só PONTEIROS: org e
 * contato vêm da row do job (fonte confiável, regra dura nº 1), nunca daqui.
 *
 * `agent_id` viaja porque o Operador precisa saber QUAL agente atendeu para ler a
 * config do papel (`operator_enabled`, `operator_model`) — e resolvê-lo de novo
 * pelo router aqui poderia dar outro agente, já que o roteamento depende do sinal
 * da mensagem, que não existe mais neste ponto.
 */
export const operatorTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    /** job do turno do Conversador que originou este — correlação no trace. */
    origin_job_id: z.string().uuid(),
    agent_id: z.string().uuid().nullable().default(null),
  })
  .passthrough();

/**
 * O system do papel. Fala de OPERAÇÃO com todas as letras — e pode, porque este
 * texto nunca alcança um cliente: este papel não tem canal.
 *
 * É o inverso exato do prompt do Conversador, e a assimetria é o desenho inteiro
 * da spec 16 em duas frases. Lá, vocabulário de sistema é o defeito (30% de
 * vazamento medido); aqui, é o vocabulário de trabalho.
 */
export const SYSTEM_DO_OPERADOR =
  'Você é o operador do sistema. Seu trabalho é deixar o CRM refletindo o que aconteceu na ' +
  'conversa que acabou de ocorrer — mover o lead, registrar, abrir o que precisa ser aberto.\n\n' +
  'VOCÊ NÃO FALA COM O CLIENTE. Você não tem como enviar mensagem, e não deve tentar: quem ' +
  'conversa é outro. Se algo exigir falar com a pessoa, registre e siga.\n\n' +
  'Use apenas o que a conversa sustenta. Não invente avanço, não registre o que ninguém disse. ' +
  'Se não houver nada a fazer, não faça nada — um turno sem ação é uma resposta válida.';

/** O briefing do turno: o que o Conversador declarou, em linguagem de negócio. */
export function renderBriefingDoOperador(
  declaracao: DeclaracaoDoTurno | null,
  promessas: ReturnType<typeof promessasEmAberto>,
): string {
  if (declaracao === null) {
    // Ausente ≠ vazia, de novo — e aqui a diferença vira instrução. Dizer ao
    // modelo "não houve declaração" e pedir que ele olhe o estado é diferente de
    // deixá-lo achar que o turno foi vazio.
    return [
      'O turno anterior NÃO deixou declaração do que aconteceu (fechamento incompleto).',
      'Verifique o estado do lead e registre o que estiver claramente pendente.',
      'Na dúvida, não faça nada.',
    ].join('\n');
  }
  const linhas = ['Foi isto que aconteceu na conversa que acabou:'];
  if (declaracao.intencoes.length > 0) {
    linhas.push('', 'O que a pessoa quer:');
    for (const i of declaracao.intencoes) linhas.push(`- ${i.o_que} (na conversa: "${i.evidencia}")`);
  }
  if (promessas.length > 0) {
    linhas.push('', 'O que foi prometido a ela (precisa existir no sistema):');
    for (const p of promessas) {
      linhas.push(`- ${p.o_que}${p.prazo === null ? '' : ` — até ${p.prazo}`}`);
    }
  }
  linhas.push('', 'Deixe o sistema refletindo isso. O que já estiver registrado, não repita.');
  return linhas.join('\n');
}

/** O que o Operador decidiu neste turno — vai a log e à timeline. */
export type DesfechoDoOperador =
  | { tipo: 'nada_a_fazer'; porque: 'declaracao_vazia' }
  | { tipo: 'pulado'; porque: 'papel_desligado' | 'sem_agente' | 'sem_checkpoint' }
  | { tipo: 'agiu'; promessas: number };

/**
 * Lê a declaração do último checkpoint do lead.
 *
 * `null` tem DOIS significados aqui e eles não se confundem: sem checkpoint
 * nenhum (turno que morreu antes do fechamento) ou checkpoint sem declaração
 * (modelo não declarou). Os dois levam o Operador a RODAR, não a pular — nos dois
 * casos ninguém avaliou o turno, que é a condição em que ele mais importa.
 */
export async function lerDeclaracaoDoTurno(
  db: pg.Pool,
  tenantId: string,
  leadId: string,
): Promise<{ declaracao: DeclaracaoDoTurno | null; houveCheckpoint: boolean }> {
  const checkpoint = await latestCheckpoint(db, tenantId, leadId);
  if (checkpoint === null) return { declaracao: null, houveCheckpoint: false };
  if (checkpoint.declaracao === null) return { declaracao: null, houveCheckpoint: true };
  // O jsonb do banco não é confiável por vir do banco: foi escrito por um modelo.
  // Shape quebrado é tratado como "não declarou" — a direção segura, porque leva
  // o Operador a rodar em vez de pular.
  const parsed = declaracaoDoTurnoSchema.safeParse(checkpoint.declaracao);
  return { declaracao: parsed.success ? parsed.data : null, houveCheckpoint: true };
}

/**
 * A decisão de RODAR OU NÃO, isolada em função pura para ser testável sem banco,
 * sem modelo e sem fila. É a regra que decide se a chave do self-hoster é gasta.
 */
export function decidirSeRoda(input: {
  papelLigado: boolean;
  declaracao: DeclaracaoDoTurno | null;
}):
  // A união é DISCRIMINADA na origem em vez de `desfecho?: DesfechoDoOperador`:
  // com o opcional, quem lê precisa de `?.` e o compilador aceita ler `porque`
  // de um desfecho que não o tem. Aqui, `roda: false` GARANTE um desfecho de
  // não-execução, e `roda: true` garante que não há desfecho a inspecionar.
  | { roda: true }
  | { roda: false; desfecho: Extract<DesfechoDoOperador, { tipo: 'nada_a_fazer' | 'pulado' }> } {
  if (!input.papelLigado) {
    return { roda: false, desfecho: { tipo: 'pulado', porque: 'papel_desligado' } };
  }
  // Declarou explicitamente que não havia nada: quem avaliou estava lá, com o
  // contexto inteiro. Repetir a avaliação com menos contexto é gastar por nada.
  if (input.declaracao !== null && input.declaracao.nada_a_declarar) {
    return { roda: false, desfecho: { tipo: 'nada_a_fazer', porque: 'declaracao_vazia' } };
  }
  return { roda: true };
}

export function createOperatorTurnHandler(deps: InboundTurnDeps) {
  return async function handleOperatorTurn(
    job: JobRow,
    pool: pg.Pool,
    ctx: { workerId: string },
  ): Promise<void> {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('operator_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = operatorTurnPayloadSchema.parse(job.payload);
    const log = withFields(deps.log, {
      job_id: job.id,
      tenant_id: tenantId,
      lead_id: leadId,
      origin_job_id: payload.origin_job_id,
    });

    const agentConfig =
      payload.agent_id === null ? null : await loadPublishedAgentConfigById(pool, tenantId, payload.agent_id);
    if (agentConfig === null) {
      // Sem agente publicado não há config de papel para ler. Não é erro: é o
      // turno que rodou no genérico. Registrar e sair é honesto.
      log.info('operador pulado — turno sem agente publicado', { desfecho: 'sem_agente' });
      return;
    }

    const { declaracao, houveCheckpoint } = await lerDeclaracaoDoTurno(pool, tenantId, leadId);
    const decisao = decidirSeRoda({ papelLigado: agentConfig.operatorEnabled, declaracao });

    if (!decisao.roda) {
      // "Nada a fazer" é DECISÃO REGISTRADA, não silêncio (invariante 4 do
      // sistema vivo). Um turno em que o Operador não agiu e ninguém soube é
      // indistinguível de um turno em que ele falhou.
      log.info('operador não agiu neste turno', {
        desfecho: decisao.desfecho.tipo,
        porque: decisao.desfecho.porque,
        houve_checkpoint: houveCheckpoint,
      });
      return;
    }

    const promessas = promessasEmAberto(declaracao);

    // A MÃO do papel: só as ferramentas DELE (`operator_tool_ids`), nunca as do
    // Conversador. `send_message` não está aqui e não pode estar — é assim que
    // "nunca fala com o lead" deixa de ser instrução de prompt e vira ausência.
    //
    // Sem ferramenta configurada o papel ainda tem valor e ainda roda: ele
    // registra a promessa em aberto. Chamar o modelo para descobrir que ele não
    // tem mão nenhuma seria gastar a chave do self-hoster para nada.
    let mcp: Awaited<ReturnType<typeof buildMcpTurnTools>> = null;
    if (agentConfig.operatorToolIds.length > 0) {
      try {
        mcp = await buildMcpTurnTools(
          deps.crmCfg,
          { organizationId: tenantId, jobId: job.id },
          // A ponte lê `toolIds`; o papel guarda a lista dele em
          // `operatorToolIds`. A troca acontece AQUI, num ponto só, para que
          // nenhum caminho do Operador alcance a lista do Conversador por
          // engano — que seria dar a ele a mão do outro.
          { ...agentConfig, toolIds: agentConfig.operatorToolIds },
          log,
        );
      } catch (err) {
        // Mesma doutrina do turno do Conversador: capacidade que não montou não
        // derruba o job, mas também não morre no log de um contêiner que
        // ninguém abre — o aviso vai para a Central.
        const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        log.error('capacidades do operador não montadas — o papel segue sem elas', { error: detalhe });
        await avisarCapacidadesAusentes(pool, tenantId, payload.conversation_id, detalhe, log);
      }
    }

    log.info('operador rodou', {
      promessas: promessas.length,
      intencoes: declaracao?.intencoes.length ?? 0,
      declaracao_ausente: declaracao === null,
      houve_checkpoint: houveCheckpoint,
      model: agentConfig.operatorModel ?? agentConfig.model,
      tools: mcp?.toolIds ?? [],
    });

    try {
      if (mcp !== null) {
        await runModelCall(
          pool,
          deps.llmCfg,
          {
            tenantId,
            leadId,
            jobId: job.id,
            // Atribuição de custo própria: sem isto o gasto do Operador entraria
            // como se fosse conversa, e "quanto custa ligar o papel?" — a
            // pergunta que o dono do negócio vai fazer — não teria resposta.
            purpose: 'operator_turn',
            system: SYSTEM_DO_OPERADOR,
            messages: [{ role: 'user', content: renderBriefingDoOperador(declaracao, promessas) }],
            tools: mcp.tools,
            maxSteps: agentConfig.maxSteps,
            ...(agentConfig.operatorModel !== null ? { model: agentConfig.operatorModel } : {}),
          },
          { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log },
        );
      }
    } finally {
      await mcp?.cleanup();
    }

    if (promessas.length > 0) {
      await avisarPromessasEmAberto(pool, tenantId, payload.conversation_id, promessas.length, log);
    }
    void ctx;
  };
}

/**
 * Promessa declarada e não quitada vira item na Central.
 *
 * Best-effort de propósito, pelo mesmo motivo dos outros avisos deste engine: o
 * aviso não pode derrubar o job que ele descreve. Mas o silêncio também não serve
 * — log de worker em VPS não é superfície de nada, e este produto é instalado por
 * quem nunca vai abrir um contêiner.
 */
async function avisarPromessasEmAberto(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
  quantas: number,
  log: { warn: (msg: string, fields?: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await insertInboxItem(db, tenantId, {
      kind: 'promise_unfulfilled',
      severity: 'warn',
      title:
        quantas === 1
          ? 'Uma promessa feita ao cliente ainda não foi cumprida'
          : `${quantas} promessas ainda não foram cumpridas`,
      body:
        'O assistente prometeu algo a esta pessoa nesta conversa e o sistema ainda não registrou o ' +
        'cumprimento. Abra a conversa para ver o que foi combinado.',
      refKind: 'conversation',
      refId: conversationId,
    });
  } catch (err) {
    log.warn('aviso de promessa em aberto não foi gravado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}
