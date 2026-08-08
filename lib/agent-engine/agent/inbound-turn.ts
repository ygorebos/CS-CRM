/**
 * Loop do agente v0 — handler do job `inbound_turn` (F2-09; blueprint 8.8).
 *
 * Cada job vira uma sessão FRESCA do motor LLM (via seam F2-23 — provider
 * instanciado POR CHAMADA, nunca cache por lead em memória de processo): TODO o
 * estado do run (seq de envio, outcomes, mensagens) vive no closure desta
 * invocação — isolamento entre leads por construção (acceptance 3).
 *
 * Ritual imposto pelo RUNTIME, não pelo modelo:
 *   1. abre lendo playbook (system, por ponteiro — F2-07) + checkpoint anterior de
 *      `lead_checkpoints` (compromissos/objeções/next_action + rolling summary) +
 *      `lead_state` (estágio do funil — F2-10) + últimas N mensagens via
 *      get_lead_context (F2-08);
 *   2. o modelo decide tools livremente: `get_lead_context` (releitura),
 *      `send_message` — enviar é SEMPRE tool call (CLAUDE.md princípio 2); texto
 *      direto do modelo NUNCA vira mensagem (é descartado) — e `update_lead_state`
 *      (F2-10): o modelo MARCA avanços; a máquina de estados no código valida e o
 *      avanço é espelhado no CRM (crm_move_lead_stage); falha do espelho NÃO
 *      reverte o harness (fonte da verdade) — vira log + inbox_items;
 *   3. fecha com uma 2ª chamada de modelo (purpose 'checkpoint') que devolve
 *      SOMENTE o JSON do checkpoint, validado por Zod e persistido — mecanismo
 *      escolhido por ser imposto pelo runtime (tool update_checkpoint dependeria
 *      de o modelo lembrar de chamá-la; a chamada de fechamento sempre acontece).
 *
 * Falhas: transporte/tool do CRM viram mensagem de ensino pro modelo no meio do
 * run (padrão F2-08) E erro do job no fim (retry da fila com o ledger segurando
 * duplicata); veto is_blocked cancela o job em definitivo (JobSettledError —
 * main.ts não completa nem re-tenta). PII nunca entra em log/erro de job.
 */
import type pg from 'pg';
import { z } from 'zod';
import { auxModelArgs, type AuxModelArgs } from './aux-model-args';
import type { ChannelAdapter, ChannelSendResult } from '../channel-adapter';

import { withFields, type Logger } from '../obs/logger';
import { getLeadContext, type LeadContext, type LeadContextResult } from '../edge/crm/get-lead-context';
import { registrarGroundings } from './grounding-registry';
import { citationsFromHits, searchKnowledge } from './search-knowledge';
import { escalarAssistenciaSemLastro } from './escalar-sem-lastro';
import { ehAprendizadoDeConversa, type Grounding } from '../guardrails/assistance-grounding';
import { detectarAssuntoDeAssistencia } from '../guardrails/lexico-assistencia';
import {
  blocoDePerguntaDeEscopo,
  carregarEscoposDoTenant,
  carregarVinculoDoContato,
  escopoJaFoiPerguntado,
  escoposDesligadosQueCobririam,
  gravarEscopoDaConversa,
  marcarEscopoPerguntado,
  reconhecerEscoposNoTexto,
  VINCULO_DESCONHECIDO,
  type EscopoConhecido,
  type VinculoDeEscopo,
} from './escopo-do-contato';
import {
  fraseDeRecusaParcial,
  particionarPorEscopo,
  type EscopoRecusado,
  type LastroDeEscopo,
} from './lastro-por-escopo';
import type { CrmEdgeConfig } from '../edge/crm/mcp-client';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
// applySendOutcome é disposição de FILA (cancel/reschedule + cache de opt-out), não
// egress de canal — o envio em si vai pelo adapter (ChannelAdapter). Ver F2-25.
import { applySendOutcome } from '../edge/crm/send-message';
import {
  runModelCall,
  tool,
  type LlmEdgeConfig,
  type ModelMessage,
  type ToolSet,
} from '../edge/llm/run-model-call';
import type { ProviderRegistry } from '../edge/llm/providers';
import { MIRROR_WARN_ONLY, mirrorLeadStageToCrm } from '../edge/crm/move-lead-stage';
import { insertInboxItem } from '../db/repository';
import { buildNativeMediaParts } from './media-parts';
import { enqueueJob, type JobRow, type Queryable } from '../queue/queue';
import { applyLeadStateUpdate, getLeadState, type LeadStage, type LeadStateRow } from './lead-state';
import { applySaveLeadNote, buildNotesIndexBlock, getLeadNoteBody } from './lead-notes';
import { applyScheduleFollowup, type FollowupWindowKnobs } from './schedule-followup';
import {
  applyRequestHumanHandoff,
  buildHandoffSummary,
  detectAmbiguousOptOut,
  detectHumanHandoffRequest,
  isLeadInHandoff,
  performHumanHandoff,
} from './human-handoff';
import { maybeCompact, renderCompactedSummary, trimTranscriptToBudget, type CompactionKnobs } from './compaction';
import { pruneToolResults, type PruneToolResultsKnobs } from './prune-tool-results';
import {
  classifyStage,
  recordStageDivergenceCandidate,
  renderStageHint,
  type StageClassifierKnobs,
} from './stage-classifier';
import { loadPlaybook } from './playbook';
import { DECLARACAO_INSTRUCTION, declaracaoDoTurnoSchema, type DeclaracaoDoTurno } from './declaracao';
import { projetarContexto, projetarRetornoDeTool, turnoProjeta, type ContextoProjetado } from './projecao';
import { capacidadesEntreguesAoOperador, catalogoEntregueAoOperador } from './entrega-de-capacidade';
import { composeSystemPrompt, loadOrgMemory, renderOrgMemory } from './org-memory';
import { matchesHandoffKeyword } from './agent-config';
import { resolveTurnAgent } from './resolve-turn-agent';
import {
  hasOpenCaseForContact,
  getCaseAwaitingLead,
  openCase,
  provideCaseUpdate,
  openHumanCaseInputSchema,
  provideCaseUpdateInputSchema,
} from './human-cases';
import { buildMcpTurnTools } from '../edge/crm/mcp-tools';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import {
  latestInboundSignal,
  loadSkills,
  matchSkills,
  recordSkillMissCandidates,
  renderMatchedSkillBodies,
  renderSkillIndex,
} from './skills';
import { readSkillReference, skillHasReferences } from './skill-references';
import { READ_ONLY_TOOLS, wrapToolsWithBreaker, type ToolBreakerThresholds } from './tool-breaker';
import { loadChannelProvider, runBeforeSend } from '../guardrails/before-send';
import { isStatusSendable } from '../../channels/meta/template-binding';
import { capabilitiesOf } from '@/lib/channels/capabilities';
import { renderTemplateBody } from '@/lib/channels/meta/render-template';
import { sendInBubbles } from './split-message';
import type { DisclosureMode } from '../guardrails/disclosure/template';
import { decidePromise } from '../guardrails/promise/engine';
import { loadPromiseTable } from '../guardrails/promise/table';
import { classifyPromise } from '../guardrails/promise/semantic';
import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { diffCheckpoint } from '@/lib/leads/checkpoint-diff';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';
import { recalculaScoreDoLead } from '@/lib/leads/score-writer';
import {
  JAILBREAK_ESCALATION_LEVEL,
  classifyJailbreak,
  escalateJailbreakPromise,
  type JailbreakClassifierKnobs,
  type JailbreakLevel,
} from '../guardrails/jailbreak/classifier';

/**
 * Superfície ESTÁTICA das tools do agente (description + inputSchema) — parte do
 * prefixo estável de cache (F2-17). Única fonte: o handler monta as tools reais
 * daqui (+ execute do closure) e `scripts/ops-count-prefix.ts` mede o prefixo
 * real sem precisar de um run. Nada volátil entra aqui, por construção.
 */
export const AGENT_TOOL_DEFS = {
  get_lead_context: {
    description:
      'Relê o contexto curado do lead nesta organização: dados do contato e as últimas mensagens da conversa.',
    inputSchema: z.object({}),
  },
  send_message: {
    description:
      'Envia UMA mensagem de WhatsApp ao lead desta conversa. É o ÚNICO jeito de falar com o lead; texto fora desta tool nunca é enviado.',
    inputSchema: z.object({
      body: z.string().min(1).describe('corpo da mensagem, em pt-br, pronto para envio'),
    }),
  },
  update_lead_state: {
    description:
      'Marca um avanço REAL no funil deste lead: stage (new → contacted → qualifying → qualified → ' +
      'negotiating → won | lost; só o PRÓXIMO estágio válido — regressão é rejeitada), qualification ' +
      '(budget/authority/need/timeline), next_action e reason (evidência curta do avanço). ' +
      'Nunca invente avanço sem evidência na conversa.',
    // Schema LARGO só para o SDK (o modelo vê os campos); a validação REAL é a
    // whitelist .strict() dentro de applyLeadStateUpdate — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      stage: z.string().optional().describe('novo estágio do funil (só o próximo válido)'),
      qualification: z.object({}).passthrough().optional().describe('qualificação: budget, authority, need, timeline'),
      next_action: z.string().nullable().optional().describe('próxima ação concreta combinada com o lead'),
      reason: z.string().optional().describe('evidência curta do avanço (vai ao audit do CRM)'),
    }).passthrough(),
  },
  schedule_followup: {
    description:
      'Agenda o SEU próprio retorno a este lead num momento futuro (follow-up). Use sempre que ' +
      'prometer voltar a falar depois (ex.: "te retorno amanhã de manhã", "confirmo na segunda"). ' +
      'Um agendamento por promessa; o sistema fará o follow-up sozinho no horário combinado — ' +
      'depois de agendar, encerre o turno.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applyScheduleFollowup — campo
    // extra/forjado e data inválida viram erro de ENSINO ao modelo, nunca exceção do SDK.
    inputSchema: z.object({
      reason: z.string().describe('por que agendar o retorno'),
      promised_at: z.string().describe('data/hora ISO 8601 do retorno (no futuro), ex.: "2026-07-15T14:00:00Z"'),
      promise: z.string().describe('o que você prometeu ao lead'),
      context_snapshot: z.string().nullable().optional().describe('contexto curto para o seu run futuro'),
    }).passthrough(),
  },
  save_lead_note: {
    description:
      'Salva uma nota DURÁVEL na memória deste lead (persiste entre conversas). Use para fatos que ' +
      'você vai querer lembrar depois: preferências, contexto pessoal, restrições, o que já foi ' +
      'oferecido. A headline (linha curta) entra sempre no índice de memória do lead; o corpo completo ' +
      'fica guardado e você o relê sob demanda com get_lead_note. Para CONSOLIDAR notas antigas, ' +
      'liste os ids delas em "supersedes" (você os vê no índice) — elas são removidas ao salvar a nova.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applySaveLeadNote — campo
    // extra/forjado vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      headline: z.string().describe('linha curta do índice (sempre visível no prompt)'),
      body: z.string().describe('corpo completo da nota (lido sob demanda por get_lead_note)'),
      supersedes: z
        .array(z.string())
        .optional()
        .describe('ids de notas que esta substitui/consolida (vistos no índice de memória)'),
    }).passthrough(),
  },
  get_lead_note: {
    description:
      'Lê o CORPO completo de UMA nota da memória deste lead pelo id (o id aparece no índice de memória, ' +
      'entre colchetes). Use quando a headline no índice não bastar e você precisar do detalhe.',
    inputSchema: z.object({
      note_id: z.string().describe('id da nota (como aparece no índice, entre colchetes)'),
    }).passthrough(),
  },
  search_knowledge: {
    description:
      'Busca na BASE DE CONHECIMENTO da organização (FAQ, políticas, catálogo) os trechos mais ' +
      'relevantes para uma pergunta. Use ANTES de responder qualquer dúvida factual sobre produto, ' +
      'preço, prazo, política ou funcionamento — responda com base nos trechos retornados e não ' +
      'invente o que não encontrar. Sem resultados = diga que vai confirmar, nunca chute.',
    inputSchema: z.object({
      query: z.string().min(2).describe('a pergunta ou termos a buscar, em pt-br'),
    }).passthrough(),
  },
  request_human_handoff: {
    description:
      'Passa a conversa para um ATENDENTE HUMANO imediatamente. Use quando o lead pedir para falar com ' +
      'uma pessoa, quando a situação exigir alguém humano (reclamação séria, questão jurídica/financeira ' +
      'sensível) ou quando você atingir o limite do que pode resolver. Depois de acionar, o bot silencia ' +
      'para este lead — encerre o turno sem enviar mais mensagens.',
    // Schema LARGO para o SDK (o modelo vê o campo); a validação REAL é a whitelist .strict()
    // + guard de prototype pollution dentro de applyRequestHumanHandoff — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      reason: z.string().optional().describe('por que passar ao humano (curto)'),
    }).passthrough(),
  },
  read_skill_reference: {
    description:
      'Lê o conteúdo de UMA reference (arquivo de apoio) do pacote de uma skill situacional que já ' +
      'CASOU neste turno. Use quando o corpo da skill ativa mencionar uma reference e você precisar do ' +
      'detalhe completo dela. Só funciona para skills ativas AGORA — pedir skill não ativa ou caminho ' +
      'fora do manifesto dela volta erro.',
    inputSchema: z.object({
      skill_name: z.string().min(1).describe('nome da skill ativa neste turno (como aparece no bloco de skills)'),
      ref_path: z.string().min(1).describe('caminho da reference dentro do pacote da skill'),
    }).passthrough(),
  },
  open_human_case: {
    description:
      'Abra um caso para um humano de retaguarda quando você NÃO conseguir resolver o pedido do lead ' +
      'sozinho (liberar acesso, corrigir algo num sistema, uma decisão que exige uma pessoa). Você CONTINUA ' +
      'conversando com o lead normalmente — não silencia. Use SEMPRE que for prometer ao lead que alguém vai ' +
      'verificar/resolver: prometer sem abrir o caso é proibido.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() openHumanCaseInputSchema (human-cases.ts) — campo extra/forjado vira
    // erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      title: z.string().describe('título curto, ex.: "Liberar acesso ao painel"'),
      summary: z.string().describe('o que o lead precisa, em pt-br'),
      blocker: z.string().describe('por que você não consegue resolver sozinho'),
    }).passthrough(),
  },
  provide_case_update: {
    description:
      'Quando um caso está esperando informação do cliente e você já colheu essa informação na conversa, ' +
      'use esta tool para devolver a informação ao humano responsável. Não invente — só o que o lead disse.',
    // Schema LARGO para o SDK; a validação REAL é a whitelist .strict()
    // provideCaseUpdateInputSchema (human-cases.ts).
    inputSchema: z.object({
      case_id: z.string().describe('id do caso aberto'),
      info: z.string().describe('a informação colhida do lead'),
    }).passthrough(),
  },
  send_template: {
    description:
      'Envia um TEMPLATE aprovado do WhatsApp. Use SOMENTE quando o send_message for recusado ' +
      'porque a janela de 24 horas com o contato fechou — a mensagem de erro diz quando é o caso. ' +
      'Você precisa do nome exato do template, do idioma e de um valor para CADA parâmetro. ' +
      'Se faltar valor, a resposta diz quais e você pode chamar de novo; qualquer outro erro ' +
      'significa que um humano precisa agir — encerre o turno sem insistir.',
    inputSchema: z.object({
      template_name: z.string().min(1).describe('nome exato do template, como aprovado na Meta'),
      language: z.string().min(2).describe('código do idioma, ex.: pt_BR'),
      values: z
        .record(z.string(), z.string())
        .describe('valor de cada parâmetro, na chave que a tela de templates mostra (ex.: "1", "2")'),
    }).passthrough(),
  },
} as const;

/**
 * Quantos vetos de `internal_vocabulary_leak` o turno tolera antes de o fail-safe soltar
 * o envio (ver o bloco em `send_message.execute`). Mesmo degrau do fail-safe de casos
 * humanos — 1ª vez ensina, a 2ª decide — porque a assimetria é a mesma: uma reescrita
 * que o modelo não fez não vale um cliente sem resposta.
 */
export const MAX_VETOS_DE_VOCABULARIO_INTERNO = 2;

/**
 * O que o cliente ouve quando o agente recusa por falta de material (spec 002, FR-011).
 *
 * Regras que a frase obedece, e que são requisito e não estilo:
 *  - **sem vocabulário interno do produto** — nada de "base de conhecimento", "acervo",
 *    "similaridade", "guardrail" ou nome de papel. O cliente não sabe o que é nada disso,
 *    e explicar a máquina para quem só quer resolver o boleto é o defeito que a doutrina
 *    `separacao-fala-e-operacao.md` existe para matar;
 *  - **sem prometer prazo que o sistema não conhece.** FR-011 pede a expectativa realista
 *    "quando o sistema souber" — e nesta fatia ele não sabe. Inventar "em até 1 hora"
 *    seria trocar uma informação errada sobre a operadora por uma promessa errada sobre
 *    nós, que é o mesmo dano com outra roupa;
 *  - **quem fala é o SISTEMA**, não o modelo: é o que garante que o cliente nunca fica
 *    mudo quando o modelo insiste na afirmação que não pode sair.
 */
export const FRASE_DE_RECUSA_SEM_LASTRO =
  'Sobre essa dúvida eu prefiro não responder de cabeça, para não te passar uma informação errada. ' +
  'Já avisei uma pessoa da equipe para te confirmar isso com segurança. Se puder, me conte mais ' +
  'algum detalhe enquanto isso — ajuda a agilizar.';

/**
 * Job já saiu de 'running' por decisão do próprio run (ex.: cancelJob no veto
 * is_blocked) — o worker NÃO deve completar nem re-tentar. main.ts trata via
 * failJob, que no-opa (lease já não é dele) — estado final é o que o run deixou.
 */
export class JobSettledError extends Error {
  override readonly name = 'job_settled';
}

// Shape que o drain (F2-05) grava no payload do job — organization/lead vêm da
// ROW do job (fonte confiável), nunca daqui; o payload só carrega ponteiros do CRM.
const inboundTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
    crm_event_id: z.string().uuid(),
  })
  .passthrough();

/** Conteúdo do checkpoint — o modelo devolve, o Zod valida, o Postgres guarda. */
export const checkpointContentSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  next_action: z.string().nullable().default(null),
  rolling_summary: z.string().default(''),
  /**
   * A declaração do turno (spec 16 §5) — a fronteira entre FALAR e OPERAR.
   *
   * `.optional()` SEM default, e a diferença importa: `undefined` significa que o
   * modelo não declarou nada (fechamento incompleto — turno a investigar), e é
   * estado distinto de `{nada_a_declarar: true}`, que é uma avaliação registrada.
   * Um `.default({})` aqui apagaria essa distinção e faria "o modelo esqueceu"
   * parecer "não havia nada" — ver o cabeçalho de `declaracao.ts`.
   *
   * Opcional também é o que mantém a retrocompatibilidade: checkpoint gravado
   * antes desta versão, e clone self-host cujo modelo ainda não conhece o campo,
   * seguem validando.
   */
  declaracao: declaracaoDoTurnoSchema.optional(),
});
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;

/**
 * A ROW como o Postgres a devolve. `declaracao` é `Omit`-ada e redeclarada porque
 * o "não sei" tem representação DIFERENTE nas duas pontas: o modelo omite o campo
 * (`undefined`), o banco guarda `null`. Herdar o `?:` do schema faria o tipo
 * prometer `undefined` onde `select *` entrega `null` — e o `=== undefined` de
 * quem lesse a row seria falso justamente no caso que ele quer pegar.
 */
export interface LeadCheckpointRow extends Omit<CheckpointContent, 'declaracao'> {
  id: string;
  seq: string;
  organization_id: string;
  contact_id: string;
  job_id: string | null;
  created_at: Date;
  declaracao: DeclaracaoDoTurno | null;
}

/**
 * Instrução FIXA do fechamento — o runtime a impõe; o teste a usa como marcador.
 *
 * A declaração (spec 16 §5) viaja AQUI, na chamada que já acontece, e não numa
 * tool: uma `declarar_intencao` dependeria de o modelo lembrar de chamá-la, e o
 * turno em que ele esquecesse seria um lead parado em silêncio. É o mesmo
 * argumento que este arquivo já usa para o checkpoint — e sai de graça, porque
 * é a mesma chamada de modelo.
 */
export const CHECKPOINT_INSTRUCTION =
  'Feche o turno AGORA. Responda SOMENTE com um JSON válido no formato ' +
  '{"commitments": string[], "objections": string[], "next_action": string|null, "rolling_summary": string} ' +
  '— compromissos assumidos, objeções do lead, próxima ação e o resumo acumulado ' +
  'da conversa até aqui (inclua o que o resumo anterior já dizia). ' +
  DECLARACAO_INSTRUCTION +
  ' Sem texto fora do JSON.';

/**
 * Bloco de sistema RESIDENTE das tools de caso (spec 15 §5.2) — entra no prefixo
 * cacheável junto do índice de skills quando `casesEnabled`, pra não sumir em
 * conversa longa (ao contrário do índice de skills, este bloco não some).
 */
const CASES_SYSTEM_BLOCK =
  '## Casos para um humano de retaguarda\n' +
  'Quando você NÃO conseguir resolver o pedido do lead sozinho (liberar acesso, corrigir algo num ' +
  'sistema, uma decisão que exige uma pessoa), use a tool open_human_case — você CONTINUA conversando ' +
  'com o lead, não silencia. NUNCA prometa ao lead que um humano vai verificar/resolver sem antes chamar ' +
  'open_human_case. Quando um caso estiver esperando informação do cliente e você já a obteve na ' +
  'conversa, use provide_case_update para devolver ao responsável.';

export interface InboundTurnKnobs {
  /** últimas N mensagens no contexto de abertura (LEAD_CONTEXT_HISTORY_LIMIT) */
  historyLimit: number;
  /** teto do payload do contexto (LEAD_CONTEXT_MAX_TOKENS) */
  maxContextTokens: number;
  /** orçamento fixo do índice de notas do lead injetado no sufixo (LEAD_NOTES_INDEX_MAX_TOKENS) */
  notesIndexMaxTokens: number;
  /** teto de steps do loop de tools por run (AGENT_MAX_STEPS) — circuit breaker fino é F2-15 */
  maxSteps: number;
  /** atraso do reagendamento em veto/queued herdado da F2-06 (SEND_QUEUED_RETRY_MS) */
  queuedRetryDelayMs: number;
  /** circuit breaker de tools por run (F2-15) — env TOOL_BREAKER_* */
  breaker: ToolBreakerThresholds;
  /**
   * Janela aceitável do follow-up agendado pela tool schedule_followup (F3-02).
   * Ausente = a tool NÃO é oferecida ao modelo neste run (main.ts sempre a preenche
   * pelos knobs do env; testes que não exercitam a tool a omitem sem custo).
   */
  followup?: FollowupWindowKnobs;
  /**
   * Compaction + flush pré-compaction (F3-07). Ausente = desligada (o turno usa o
   * transcript cru, capado por get_lead_context) — main.ts sempre a preenche pelos
   * knobs do env; testes que não a exercitam a omitem sem custo.
   */
  compaction?: CompactionKnobs;
  /**
   * Pruning de tool results antigos (F3-10). Ausente = desligado (as responseMessages do
   * run seguem íntegras na chamada de fechamento) — main.ts sempre o preenche pelos knobs
   * do env; testes que não o exercitam o omitem sem custo.
   */
  prune?: PruneToolResultsKnobs;
  /**
   * Skills situacionais (F3-09): diretório onde os near-misses de matching viram
   * candidatos ao golden set (GOLDEN_CANDIDATES_DIR). Ausente = misses NÃO gravados (o
   * matching + injeção de corpo seguem valendo) — main.ts sempre o preenche pelo env;
   * testes injetam um dir TEMP e nunca o golden real (freeze do tree).
   */
  goldenCandidatesDir?: string;
  /**
   * Stage-classifier por turno (F3-11; SalesGPT). Ausente = classificador NÃO roda (o
   * turno segue sem hint de estágio) — main.ts sempre o preenche pelo env; testes que não
   * o exercitam o omitem sem custo. A DIVERGÊNCIA classificador×modelo é gravada em
   * goldenCandidatesDir (mesmo dir da F3-09) — só se ele estiver configurado.
   */
  stageClassifier?: StageClassifierKnobs;
  /**
   * Classifier anti-jailbreak no inbound do lead (F4-04; advisório). Ausente = NÃO roda (o
   * turno segue sem flag) — main.ts sempre o preenche pelo env; testes que não o exercitam o
   * omitem sem custo. Flag ALTA + tentativa de promessa fora de tabela (F4-01) no MESMO turno
   * escala para inbox_items (dedup por episódio).
   */
  jailbreak?: JailbreakClassifierKnobs;
  /**
   * Modo do gate de disclosure (F4-05; DISCLOSURE_MODE): 'inject' (default — o disclosure é
   * sempre adicionado à 1ª mensagem) ou 'veto' (bloqueia + ensina). Ausente = default 'inject'
   * do runBeforeSend. main.ts sempre o preenche pelo env.
   */
  disclosureMode?: DisclosureMode;
  /**
   * Camada SEMÂNTICA de promessa (F4-02) na cadeia before_send (gate 5 da ordem final F4-08).
   * Ausente = camada NÃO roda (o gate fica no-op) — testes que não a exercitam a omitem; main.ts
   * a preenche pelo env (PROMISE_SEMANTIC_*). `enabled=false` também mantém o gate no-op.
   * CUSTO: com enabled, é UMA chamada de modelo auxiliar POR TENTATIVA DE ENVIO (não por turno).
   */
  promiseSemantic?: { enabled: boolean; model?: string };
  /**
   * Onda 5 (Task 5.1) — modelo auxiliar dos turnos `classify`/`decide_timing` do
   * sistema de fluxos de follow-up (lib/agent-engine/agent/followup-flow-classify.ts).
   * Ausente = usa o defaultModel da org (mesma convenção de stageClassifier/jailbreak).
   */
  followupAi?: { model?: string };
}

export interface InboundTurnDeps {
  crmCfg: CrmEdgeConfig;
  llmCfg: LlmEdgeConfig;
  knobs: InboundTurnKnobs;
  log: Logger;
  /** testes: registry com provider fake — produção usa o default do seam */
  registry?: ProviderRegistry;
  /**
   * Seam de canal (F2-25): fábrica do ChannelAdapter para o pool do job. Default =
   * WAHA-via-CRM (o único adapter da v1). Trocar o adapter (ex.: Cloud API) NÃO
   * muda este handler — prova em daemon/test/channel-adapter.test.ts.
   */
  channel?: (pool: pg.Pool) => ChannelAdapter;
  /**
   * Relógio injetável (F2-13) — a janela horária do gate anti-ban é avaliada nele.
   * Default `() => new Date()`; os testes fixam um instante dentro da janela para
   * determinismo.
   */
  clock?: () => Date;
  /**
   * Espera do throttle da cadeia before_send (F2-13) — injetável só para teste.
   * Default = sleep real (runBeforeSend cai em `realSleep`). O E2E de fase (F2-18)
   * passa um spy que registra o waitMs sem esperar de verdade: torna o espaçamento
   * anti-ban observável no artefato de trace de forma determinística.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Checkpoint mais recente do lead — a memória que atravessa sessões. */
export async function latestCheckpoint(
  db: Queryable,
  tenantId: string,
  leadId: string,
): Promise<LeadCheckpointRow | null> {
  const { rows } = await db.query<LeadCheckpointRow>(
    `select * from lead_checkpoints
     where organization_id = $1 and contact_id = $2
     order by seq desc
     limit 1`,
    [tenantId, leadId],
  );
  return rows[0] ?? null;
}

async function insertCheckpoint(
  db: Queryable,
  input: { tenantId: string; leadId: string; jobId: string; content: CheckpointContent },
): Promise<void> {
  await db.query(
    `insert into lead_checkpoints (organization_id, contact_id, job_id, commitments, objections, next_action, rolling_summary, declaracao)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.leadId,
      input.jobId,
      JSON.stringify(input.content.commitments),
      JSON.stringify(input.content.objections),
      input.content.next_action,
      input.content.rolling_summary,
      // NULL (não `'{}'`) quando o modelo não declarou: a coluna preserva a
      // distinção "não declarou" × "declarou que não havia nada" que o schema
      // sustenta em memória. Gravar um objeto vazio aqui jogaria fora, no
      // Postgres, a informação que o Zod tomou o cuidado de manter.
      input.content.declaracao === undefined ? null : JSON.stringify(input.content.declaracao),
    ],
  );
}

/**
 * Extrai e valida o JSON do fechamento. Tolerante a cerca de código e prosa em
 * volta (pega do primeiro '{' ao último '}'); inválido → erro SEM o texto do
 * modelo na mensagem (pode carregar PII da conversa) — o job re-tenta.
 */
export function parseCheckpointText(text: string): CheckpointContent {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('fechamento do turno sem JSON de checkpoint — run re-tentado pela fila');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('JSON de checkpoint inválido no fechamento do turno — run re-tentado pela fila');
  }
  const parsed = checkpointContentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.code}`).join('; ');
    throw new Error(`checkpoint do fechamento com shape inválido (${issues}) — run re-tentado pela fila`);
  }
  return parsed.data;
}

/**
 * Blocos do ritual de abertura (pt-br: é a língua do agente), compartilhados entre
 * o turno inbound e o follow-up (F3-03) — checkpoint + resumo + estado do funil +
 * contexto curado. Só o CABEÇALHO e o RODAPÉ mudam entre os dois tipos de turno.
 */
export function ritualBlocks(
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
  /**
   * Projetar o contexto (spec 16 §4)? Default `false` para não mudar em silêncio
   * o prompt de quem já chama isto (follow-up, resposta de caso) — cada chamador
   * liga quando souber responder a pergunta que a projeção faz: "este turno
   * consegue usar um id para alguma coisa?".
   */
  projeta = false,
): string[] {
  const checkpointBlock = previous
    ? JSON.stringify({
        commitments: previous.commitments,
        objections: previous.objections,
        next_action: previous.next_action,
      })
    : 'primeiro turno — sem checkpoint anterior';
  const summaryBlock = previous?.rolling_summary ? previous.rolling_summary : '—';
  // slot previsto na F2-09, preenchido pela F2-10: estado do funil no ritual de
  // abertura — sem registro ainda, o lead está em "new" (default da 0008).
  const stateBlock = leadState
    ? JSON.stringify({
        stage: leadState.stage,
        qualification: leadState.qualification,
        next_action: leadState.next_action,
      })
    : 'sem registro — o lead está em "new"';
  return [
    '## Checkpoint anterior (compromissos, objeções, próxima ação)',
    checkpointBlock,
    '',
    '## Resumo acumulado da conversa',
    summaryBlock,
    '',
    // Era "## Estado do funil (lead_state)". O nome da tabela no cabeçalho era
    // vazamento gratuito — o modelo o lê e o repete, que é a porta 2 medida, só
    // que sem nem precisar de uma ferramenta para carregá-la. O CONTEÚDO deste
    // bloco (stage: 'qualifying') continua sendo vocabulário interno e continua
    // aqui: `update_lead_state` precisa dele para marcar o próximo estágio.
    // Sai no passo 6 da spec 16, junto com a ferramenta. Dívida declarada.
    '## Estado do funil',
    stateBlock,
    '',
    // Índice da memória durável do lead (F3-05): headlines + id, orçamento fixo. O
    // corpo vem sob demanda (get_lead_note). Injetado AQUI, no SUFIXO — depois do
    // prefixo cacheável (F2-17), como o bloco temporal da F3-03.
    '## Memória do lead (índice de notas — corpo sob demanda via get_lead_note)',
    notesIndexBlock,
    '',
    '## Contexto do lead (contato + últimas mensagens)',
    // A projeção (spec 16 §4) fecha a terceira porta: sem ela, `lead_id`,
    // `conversation_id` e `media_storage_path` chegam crus ao prompt — e UUID
    // cru na tela do cliente foi MEDIDO. Ela só arma quando o turno não tem
    // ferramenta de catálogo (ver `turnoProjeta`), porque é aí que esses ids
    // não têm uso nenhum. Nos demais, quem cobre é o gate de saída.
    JSON.stringify(projeta ? projetarContexto(context) : context),
  ];
}

/** Abertura determinística do run inbound — o ritual em texto (pt-br). */
export function buildOpeningMessage(
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
  projeta = false,
  /**
   * Ferramentas que saíram para o Operador (spec 16, passo 6). O prompt PRECISA
   * deixar de citá-las — e esta é a parte que É a cura, não um acabamento.
   *
   * Remover a ferramenta e manter a instrução produziria o pior dos dois mundos:
   * o modelo tentaria chamar o que não existe, gastaria passo com o erro, E o
   * NOME continuaria no contexto — que é exatamente por onde o vazamento voltou
   * quando limparam só a descrição (`crm_list_webhook_sources`, medido).
   */
  entregues: readonly string[] = [],
): string {
  const entregue = (nome: string): boolean => entregues.includes(nome);
  return [
    'Novo turno de atendimento: o lead enviou uma mensagem (a última inbound do histórico abaixo).',
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock, projeta),
    '',
    'Responda ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
    // Quando o avanço do funil vira trabalho do Operador, o Conversador não
    // precisa saber que existe um funil. É a diferença entre "não fale disso" e
    // "não há disso no seu contexto" — a segunda não depende de obediência.
    ...(entregue('update_lead_state')
      ? []
      : ['Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).']),
    ...(entregue('save_lead_note')
      ? []
      : ['Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).']),
  ].join('\n');
}

/**
 * Parâmetros do run que DIFEREM entre inbound (F2-09) e follow-up (F3-03): os ids
 * de envio (de fonte confiável — payload do drain no inbound, row do lead no
 * follow-up, nunca do payload do modelo) e a montagem da mensagem de abertura,
 * chamada DEPOIS do ritual de leitura (o follow-up injeta o bloco temporal aqui,
 * no SUFIXO — depois do prefixo cacheável, sem invalidar o cache F2-17).
 */
export interface AgentTurnInput {
  /** número (channel_sessions.id do CRM) — chave da serialização anti-ban do envio. */
  channelSessionId: string;
  /** conversa do CRM — destino do send_message. */
  conversationId: string;
  /** monta a abertura APÓS o ritual de leitura (inbound vs. bloco temporal do follow-up). */
  buildOpening: (ritual: {
    previous: LeadCheckpointRow | null;
    leadState: LeadStateRow | null;
    context: LeadContext;
    /** índice da memória do lead (F3-05), já dentro do orçamento; vai no sufixo. */
    notesIndexBlock: string;
    /**
     * Projetar o contexto (spec 16 §4)? Decidido pelo turno, ver `turnoProjeta`.
     *
     * OPCIONAL no tipo, e a razão é externa ao desenho: `tests/invariants/**` é
     * congelado por hook de governança, e torná-lo obrigatório forçaria a editar
     * um invariante existente só para satisfazer o compilador — o que a catraca
     * proíbe, com razão. `runAgentTurn` SEMPRE o passa; o opcional só existe para
     * quem constrói um ritual à mão (testes).
     *
     * O custo está registrado: um chamador novo que esqueça o campo não projeta,
     * em silêncio. A direção do esquecimento é a segura (comportamento de hoje,
     * com o gate de saída cobrindo), mas é esquecimento mesmo assim.
     */
    projeta?: boolean;
    /** ferramentas que saíram para o Operador — o prompt não pode citá-las. */
    entregues?: readonly string[];
  }) => string;
}

/**
 * Núcleo do run do agente, compartilhado por inbound_turn (F2-09) e followup_turn
 * (F3-03): ritual de abertura, loop de tools, fechamento com checkpoint e veto. Não
 * guarda NADA entre invocações — sessão fresca por job (todo estado no closure). O
 * que varia entre os dois tipos de turno vem em `input` (AgentTurnInput).
 */
/**
 * O aviso de que o agente atendeu SEM as capacidades configuradas.
 *
 * Vai para a Central de avisos (`agent_inbox_items`) porque é lá que o dono do
 * negócio olha — log de worker em VPS não é superfície de nada.
 *
 * Dedup por episódio ABERTO da organização (mesmo padrão do handoff): o defeito
 * é sistêmico, não por conversa, e uma retentativa em rajada viraria dezenas de
 * linhas idênticas — inbox inundado é inbox ignorado. Quem resolver o item e
 * vir o problema voltar recebe um item novo, que é o comportamento certo.
 *
 * Best-effort de propósito: se ATÉ o aviso falhar, o turno continua. Derrubar o
 * atendimento do cliente para reclamar de uma tool extra seria trocar um
 * problema pequeno por um grande.
 */
export async function avisarCapacidadesAusentes(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
  detalhe: string,
  log: Logger,
): Promise<void> {
  try {
    await db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'capabilities_missing', 'critical', $2, $3, 'conversation', $4
        where not exists (
          select 1 from agent_inbox_items
           where organization_id = $1 and kind = 'capabilities_missing' and status = 'open'
        )`,
      [
        tenantId,
        'O agente atendeu sem as capacidades que você ligou',
        'As ferramentas configuradas na tela do agente não puderam ser carregadas neste ' +
          'atendimento, e ele respondeu ao cliente sem elas. A conversa não foi interrompida. ' +
          `Motivo técnico: ${detalhe}`,
        conversationId,
      ],
    );
  } catch (err) {
    log.warn('aviso de capacidades ausentes não foi gravado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

export async function runAgentTurn(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  input: AgentTurnInput,
): Promise<void> {
  const tenantId = job.organization_id;
  const leadId = job.contact_id;
  if (leadId === null) {
    throw new Error('job de turno sem contact_id — o CHECK da fila deveria impedir');
  }
  const contextKnobs = { historyLimit: deps.knobs.historyLimit, maxTokens: deps.knobs.maxContextTokens };
  // Contexto do RUN em toda linha de log do turno (F2-16): job_id É o run id.
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId });

  // F4-06 (acceptance 2): lead em handoff humano → NO-OP no INÍCIO do turno, antes de
  // qualquer chamada de modelo/CRM. O bot silenciou (bot_silenced_until='infinity', cache
  // do force_human do CRM) e só o humano/CRM libera — o agente nunca reassume (regra dura 2).
  if (await isLeadInHandoff(pool, tenantId, leadId)) {
    runLog.info('turno pulado — lead em handoff humano (bot silenciado)', { kind: job.kind });
    return;
  }

  // Fase 3: stickiness do router — qual agente já atende esta conversa. Leituras
  // tolerantes a falha (ex.: clone self-host ainda sem a migration 0085 aplicada) —
  // um erro aqui degrada pro fluxo sem router, nunca derruba o turno (review T5).
  let sticky: { active_ai_agent_id: string | null; active_intent: string | null } = {
    active_ai_agent_id: null,
    active_intent: null,
  };
  // Regra 6 do resolver (nunca classifica em follow-up): só busca o sinal em turno
  // inbound de verdade — um follow-up de dias depois não pode reclassificar sobre a
  // mensagem antiga que originou a promessa (review T5, finding 1).
  let routingSignal: string | null = null;
  try {
    const { rows: convRows } = await pool.query<{ active_ai_agent_id: string | null; active_intent: string | null }>(
      'select active_ai_agent_id, active_intent from conversations where organization_id = $1 and id = $2',
      [tenantId, input.conversationId],
    );
    sticky = convRows[0] ?? sticky;
    if (job.kind === 'inbound_turn') {
      // O sinal de roteamento (última inbound) ainda não está disponível aqui —
      // getLeadContext só roda mais abaixo. Leitura direta e barata, só pra alimentar
      // o classificador. Mesma régua de "última inbound" do resto do turno
      // (get-lead-context.ts): sent_at (relógio do WhatsApp), não created_at (now() do
      // insert) — os dois relógios podem divergir (review T5, finding 3).
      const { rows: sigRows } = await pool.query<{ body: string | null }>(
        `select body from messages
         where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
         order by sent_at desc, id desc limit 1`,
        [tenantId, input.conversationId],
      );
      routingSignal = sigRows[0]?.body ?? null;
    }
  } catch (err) {
    runLog.warn('leitura de sticky/sinal do router falhou — turno segue sem router', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  // Fase 2B/3: config do agente por PONTEIRO PUBLICADO (tela ai/agents) — lida a
  // cada turno, zero cache; org/sessão da row do job (fonte confiável). Sem router
  // ativo pra sessão, o resolver devolve o mesmo fluxo de hoje (outcome 'no_router').
  // null = sem agente publicado p/ esta sessão → fallback (playbook + settings + env).
  const routed = await resolveTurnAgent(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      channelSessionId: input.channelSessionId,
      conversationId: input.conversationId,
      signal: routingSignal,
      stickyAgentId: sticky.active_ai_agent_id,
      stickyIntent: sticky.active_intent,
    },
    { log: runLog },
  );
  const agentConfig = routed.config;
  if (agentConfig !== null) {
    runLog.info('config do agente publicada em uso', {
      agent_id: agentConfig.agentId,
      agent_version_id: agentConfig.versionId,
      model: agentConfig.model,
      router_outcome: routed.outcome,
      intent: routed.intentName,
    });
  }
  // Fase 3: grava a decisão de roteamento e a aderência da conversa ao agente.
  // Fire-and-forget — falha de telemetria nunca derruba a resposta ao lead.
  if (routed.routerId !== null) {
    try {
      if (agentConfig !== null) {
        await pool.query(
          `update conversations
           set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
           where organization_id = $1 and id = $2`,
          [tenantId, input.conversationId, agentConfig.agentId, routed.intentName],
        );
      }
      await pool.query(
        `insert into ai_router_decisions
           (organization_id, router_id, conversation_id, intent_name, confidence, agent_id, outcome, job_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, routed.routerId, input.conversationId, routed.intentName, routed.confidence, agentConfig?.agentId ?? null, routed.outcome, job.id],
      );
    } catch (err) {
      runLog.warn('decisão do router não gravada', { error: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
  }
  // Knobs por-turno: a versão publicada vence o env; sem ela, env (main.ts).
  const maxSteps = agentConfig?.maxSteps ?? deps.knobs.maxSteps;
  // Fallback de modelo das chamadas AUXILIARES (classificadores/compaction/promessa):
  // knob de env → modelo do agente PUBLICADO na tela → organizations.settings.llm.
  // Sem isso, self-host que configurou tudo pela tela (que não preenche default_model)
  // morria no primeiro classificador: "modelo LLM não definido".
  // A regra de ONDE o classificador auxiliar tira modelo + provider + credencial
  // mora em `aux-model-args.ts`, fora daqui, para poder ser exercitada por unit:
  // esta função precisa de banco, job e registry para rodar. Ver o defeito que a
  // originou (PR #151) no cabeçalho de lá.
  const argsAux = (configuredModel: string | undefined): AuxModelArgs =>
    auxModelArgs(configuredModel, agentConfig);

  const turnContextKnobs =
    agentConfig !== null
      ? { historyLimit: agentConfig.historyMessageWindow, maxTokens: deps.knobs.maxContextTokens }
      : contextKnobs;

  // Ritual de abertura: playbook por ponteiro + checkpoint + contexto curado.
  // Com agente publicado, o system_prompt DELE é a camada tenant (platform de
  // compliance continua à frente, sempre).
  const playbook = await loadPlaybook(
    pool,
    tenantId,
    agentConfig !== null ? { agentLayer: agentConfig.systemPrompt } : undefined,
  );
  // Skills situacionais (F3-09): índice (name+description) SEMPRE residente — vai junto do
  // system do playbook, no prefixo estável org-wide (disclosure progressivo; cacheável F2-17).
  // O CORPO só carrega no match, no sufixo por-lead (mais abaixo). loadSkills resolve os
  // ponteiros a cada run: trocar/rollback de skill = mover o ponteiro, sem restart.
  const skills = await loadSkills(pool, tenantId);
  const skillIndex = renderSkillIndex(skills);
  // Fase 1 (harness): memória geral da org — prefixo estável, resolvida a cada
  // turno como o playbook (publicar ⇒ próximo turno vale). composeSystemPrompt já
  // encaixa playbook + memória + índice de skills no prefixo cacheável.
  const orgMemory = await loadOrgMemory(pool, tenantId);
  const systemWithMemory = composeSystemPrompt({
    playbookPrompt: playbook.prompt,
    orgMemoryBlock: renderOrgMemory(orgMemory),
    skillIndex,
  });
  // Spec 15 §5.2: bloco das tools de caso SEMPRE residente (não invalida o prefixo
  // cacheável — mesmo espírito do índice de skills) quando a tela habilita.
  const system =
    agentConfig !== null && agentConfig.casesEnabled
      ? `${systemWithMemory}\n\n${CASES_SYSTEM_BLOCK}`
      : systemWithMemory;
  const previous = await latestCheckpoint(pool, tenantId, leadId);
  const leadState = await getLeadState(pool, tenantId, leadId);
  const openingContext = await getLeadContext(
    pool,
    deps.crmCfg,
    { tenantId, leadId, conversationId: input.conversationId },
    turnContextKnobs,
  );
  if (!openingContext.ok) {
    // Sem contexto não há turno: transiente (CRM fora) OU permanente (lead
    // sumiu) — ambos re-tentam pela fila e morrem em 'dead' se persistirem.
    throw new Error(`abertura do turno falhou em get_lead_context (${openingContext.error.code})`);
  }

  // F4-06 (acceptance 1): detecção DETERMINÍSTICA (regex PT-BR, sem LLM) de pedido explícito
  // de atendimento humano na última mensagem do lead. Handoff é cidadão de 1ª classe (exigência
  // Meta fiscalizada, blueprint 5.5) — dispara ANTES do modelo: o bot silencia sem gastar LLM,
  // sem enviar. A ação (CRM force_human + cache + cancela crons + inbox) é idempotente.
  const inboundSignal = latestInboundSignal(openingContext.context.messages);
  if (
    detectHumanHandoffRequest(inboundSignal) ||
    (agentConfig !== null && matchesHandoffKeyword(inboundSignal, agentConfig.handoffKeywords))
  ) {
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      { reason: 'requested_human', conversationSummary: buildHandoffSummary(previous), log: runLog },
    );
    runLog.info('handoff humano acionado por pedido explícito do lead (detecção determinística)', {
      kind: job.kind,
    });
    return; // bot silencia: sem modelo, sem envio neste turno
  }

  // F4-07: STOP AMBÍGUO ("para de me mandar isso", "não quero mais receber", "me tira da
  // lista", ou a palavra-chave STOP/PARAR/SAIR sozinha). Detecção CONSERVADORA — na dúvida
  // é STOP: o bot silencia JÁ (sem LLM, sem envio) via o MESMO mecanismo durável do handoff
  // (bot_silenced_until='infinity', que SOBREVIVE à leitura do CRM que sobrescreve o cache
  // is_opted_out) e escala à inbox para o humano confirmar o opt-out real (is_blocked) no
  // CRM. Cancela os follow-ups agendados de tabela. Nada disso reverte (regra dura nº 2).
  if (detectAmbiguousOptOut(latestInboundSignal(openingContext.context.messages))) {
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      {
        reason: 'suspected_optout',
        conversationSummary: buildHandoffSummary(previous),
        inboxTitle: 'Suspeita de opt-out — confirmar bloqueio do contato no CRM',
        log: runLog,
      },
    );
    runLog.info('possível opt-out detectado no inbound — bot silenciado e escalado ao humano', {
      kind: job.kind,
    });
    return; // bot silencia: sem modelo, sem envio neste turno
  }

  // F3-07: compaction + flush pré-compaction. Quando o histórico cresce além do limiar,
  // o FLUSH grava as notas duráveis (lead_notes) e a compaction resume a conversa com o
  // modelo BARATO; o resumo compactado entra no lugar do rolling summary e o transcript
  // integral é trocado por uma cauda recente sob orçamento (regra de cache 15). O rolling
  // summary DURÁVEL segue vindo do checkpoint de fechamento; aqui ele só alimenta o prompt.
  let effectivePrevious = previous;
  let effectiveContext = openingContext.context;
  if (deps.knobs.compaction !== undefined) {
    const compacted = await maybeCompact(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        context: openingContext.context,
        previousSummary: previous?.rolling_summary ?? '',
        // A compactação é o QUARTO call site da mesma regra, e o #151 só cobriu
        // três: ela também pedia o modelo do agente ao provider default da org.
        // Mesmo 404, mesma morte de turno — só que num caminho que roda quando a
        // conversa já é longa, ou seja, mais tarde e com menos gente olhando.
        knobs: { ...deps.knobs.compaction, ...argsAux(deps.knobs.compaction.model) },
        notesIndexMaxTokens: deps.knobs.notesIndexMaxTokens,
      },
      { registry: deps.registry, log: runLog },
    );
    if (compacted !== null) {
      // Só o rolling_summary é sobrescrito (o resumo compactado carrega compromissos/
      // objeções/estágio/dados pessoais planificados). O `previous` sintético do 1º
      // turno com histórico importado é local — nunca persistido; o fechamento grava o
      // checkpoint real.
      const base: LeadCheckpointRow =
        previous ??
        {
          id: '',
          seq: '0',
          organization_id: tenantId,
          contact_id: leadId,
          job_id: null,
          created_at: new Date(),
          commitments: [],
          objections: [],
          next_action: null,
          rolling_summary: '',
          // Este `previous` é sintetizado a partir de histórico IMPORTADO — não
          // houve turno nosso, logo ninguém declarou nada. `null` é o valor
          // honesto; um objeto vazio afirmaria uma avaliação que não aconteceu.
          declaracao: null,
        };
      effectivePrevious = { ...base, rolling_summary: renderCompactedSummary(compacted) };
      effectiveContext = {
        ...openingContext.context,
        messages: trimTranscriptToBudget(openingContext.context.messages, deps.knobs.compaction.transcriptMaxTokens),
      };
    }
  }

  // Índice da memória durável do lead (F3-05) — headlines dentro do orçamento fixo,
  // injetado no SUFIXO da abertura (não invalida o prefixo cacheável F2-17). Montado
  // DEPOIS do flush (F3-07) para que as notas gravadas neste turno já entrem no índice.
  const notesIndexBlock = await buildNotesIndexBlock(pool, tenantId, leadId, deps.knobs.notesIndexMaxTokens);
  // Observabilidade da memória (Fase 2A): SÓ ids/contagens no log — headline/corpo
  // são PII e nunca saem do prompt. Prova auditável de que a memória durável do
  // lead entrou no contexto DESTE turno.
  {
    const { rows: noteIdRows } = await pool.query<{ id: string }>(
      'select id from lead_notes where organization_id = $1 and contact_id = $2 order by created_at',
      [tenantId, leadId],
    );
    runLog.info('memória do lead injetada no turno', {
      checkpoint_seq: effectivePrevious?.seq ?? null,
      notes_count: noteIdRows.length,
      note_ids: noteIdRows.map((r) => r.id),
    });
  }

  // Seam de canal (F2-25): o envio vai SÓ pela interface ChannelAdapter — o
  // default WAHA-via-CRM envolve o sink F2-06. Instanciado por job (o pool é
  // per-job neste codebase); trocar o adapter não muda nada abaixo.
  // Fase 2B: o envio carrega o ai_agents.id REAL como ator (audit/metadata do
  // CRM apontam o agente publicado, não um id genérico).
  const turnCrmCfg =
    agentConfig !== null ? { ...deps.crmCfg, agentActorId: agentConfig.agentId } : deps.crmCfg;
  const channel = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, turnCrmCfg)))(pool);
  const clock = deps.clock ?? ((): Date => new Date());
  // STOP lido no turno (fonte: CRM via get_lead_context) — combinado com o cache
  // durável leads.is_opted_out no gate 1 da cadeia (F2-13).
  const optedOutThisTurn = openingContext.context.contact.is_blocked;
  // LGPD (F4-09): base legal/anonimização do CRM lidas na abertura do turno (fonte confiável,
  // regra dura nº 1) — o gate LGPD da cadeia veta anonimizado (sempre) e 1º toque de prospecção
  // sem base legal. Resposta a inbound (isProspecting=false) não dispara o veto de base legal.
  const lgpd = openingContext.lgpd;

  // F4-07: STOP no CRM detectado no turno → cancela TODOS os follow-ups agendados do lead
  // (não só o job atual). O stopGate já veta ESTE turno; o cancel garante que nenhum cron
  // futuro dispare em vão (opt-out irrevogável, regra dura nº 2). Idempotente — reusa o
  // cancel compartilhado com o handoff (F4-06).
  if (optedOutThisTurn) {
    const canceled = await cancelPendingCronsForLead(pool, tenantId, leadId);
    if (canceled > 0) {
      runLog.info('opt-out detectado no turno — follow-ups agendados cancelados', { canceled });
    }
  }

  // Estado do RUN — vive só neste closure (isolamento por construção, acc 3).
  let seq = 0;
  // F3-11: estágio que o MODELO confirmou via update_lead_state neste turno (a máquina
  // F2-10 é a única porta). Comparado com a sugestão do classificador no fim → divergência.
  let confirmedStage: LeadStage | null = null;
  // F4-04: a tabela de promessa versionada do tenant (F4-01), carregada uma vez para
  // correlacionar tentativa de promessa fora de tabela com o sinal de jailbreak — a
  // detecção NÃO depende do gate estar na cadeia default (a ordem final é da F4-08).
  const promiseTable = (await loadPromiseTable(pool, tenantId))?.table ?? null;
  // Gate 5 da cadeia (F4-02/F4-08): closure do classificador semântico com tenant/lead/job da
  // ROW do job fechados dentro (regra dura nº 1) — resolvido pelo seam agnóstico. undefined =
  // camada off (gate no-op). CUSTO: uma chamada de modelo POR ENVIO quando ligada.
  const semanticClassifier =
    deps.knobs.promiseSemantic?.enabled === true
      ? (candidate: string) =>
          classifyPromise(
            pool,
            deps.llmCfg,
            { tenantId, leadId, jobId: job.id },
            {
              candidate,
              ...argsAux(deps.knobs.promiseSemantic?.model),
            },
            { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
          )
      : undefined;
  let outOfTablePromiseAttempted = false;
  // Spec 15 (Wave 4 lê este flag): true quando open_human_case abriu um caso NESTE
  // turno — aqui só declara e seta; o consumo (ex.: guardrail de promessa) é da Wave 4.
  let openedCaseThisTurn = false;
  // Wave 4 — contador do fail-safe do guardrail anti-alucinação (case_promise_without_case):
  // 1º veto no turno é erro-de-ensino (o modelo re-tenta); persistir uma 2ª vez aciona o
  // auto-abre-caso (ver send_message.execute). Por turno (closure), nunca cross-turno.
  let casePromiseVetoCount = 0;
  // Contador do fail-safe do gate de vazamento de vocabulário interno
  // (`internal_vocabulary_leak`): 1º veto no turno ensina o modelo a reescrever; persistir
  // solta o envio com registro. Por turno (closure), nunca cross-turno.
  let internalVocabularyVetoCount = 0;
  const outcomes: ChannelSendResult[] = [];
  // Citações acumuladas por buscas de conhecimento DESTE turno — anexadas à
  // próxima outbound enviada (shape de lib/ai/citations/types, que a UI já lê).
  let pendingCitations: ReturnType<typeof citationsFromHits> = [];
  // As MESMAS buscas, na forma que o gate de lastro entende (spec 002, FR-009) — e
  // SEGREGADAS POR OPERADORA (F2, FR-018). Separado de `pendingCitations` de propósito:
  // aquilo é o shape que a UI do inbox renderiza, isto é a prova de que a afirmação veio
  // do acervo. Colapsar os dois faria uma mudança de layout de tela mexer num invariante
  // de envio; colapsar os baldes faria o procedimento de uma operadora ancorar afirmação
  // sobre outra, que é o defeito que a fatia inteira existe para impedir.
  let lastrosPorEscopo: LastroDeEscopo[] = [];
  /**
   * O vetor da última pergunta buscada neste turno.
   *
   * Guardado só para FR-042: quando a recusa acontece, ele responde "existe operadora no
   * catálogo que cobriria isto e está desligada?" sem pagar um segundo `embed`.
   */
  let ultimoEmbeddingDaBusca: string | null = null;
  // Quantas vezes o gate de lastro vetou NESTE turno. Diferente do fail-safe de
  // vocabulário: aqui não existe liberação após N tentativas. Sem material, a afirmação
  // não sai — nem na terceira tentativa. O contador serve para escalar UMA vez.
  let assistenciaSemLastroEscalada = false;
  let runError: Error | null = null;
  const noteRunError = (err: Error): void => {
    runError ??= err;
  };

  // Guideline-matching if-then (F3-09): o SINAL do turno (última mensagem inbound) decide
  // quais skills disparam. Corpos casados vão no SUFIXO da abertura (situacional, por-lead —
  // depois do prefixo cacheável); situação neutra ⇒ nenhum corpo (economia de tokens). Os
  // near-misses (probe sem hard-match) viram candidatos ao golden set, gravados por fs em
  // runtime (não a tool Write) — só se o dir estiver configurado. Calculado AQUI, ANTES de
  // montar rawTools (Fase 2): o gate de read_skill_reference precisa do resultado do match
  // para decidir se a tool entra no turno (mesmo padrão de gate de search_knowledge/
  // request_human_handoff, feito antes do wrapToolsWithBreaker).
  const skillSignal = latestInboundSignal(effectiveContext.messages);
  const skillMatch = matchSkills(skills, skillSignal);
  const matchedSkillsBlock = renderMatchedSkillBodies(skillMatch.matched);
  if (deps.knobs.goldenCandidatesDir !== undefined) {
    await recordSkillMissCandidates(
      deps.knobs.goldenCandidatesDir,
      { tenantId, leadId, jobId: job.id, signal: skillSignal, candidates: skillMatch.missCandidates },
      runLog,
    );
  }
  // Fase 2: telemetria de ativação de skill (hard match + near-miss probe).
  try {
    const rows: Array<[string, string | null, string]> = [
      ...skillMatch.matched.map((s) => [s.name, s.versionId, 'hard'] as [string, string | null, string]),
      ...skillMatch.missCandidates.map((m) => [m.skill, null, 'probe'] as [string, string | null, string]),
    ];
    if (rows.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      rows.forEach(([name, verId, trig], i) => {
        const b = i * 5;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
        params.push(tenantId, name, verId, trig, job.id);
      });
      await pool.query(
        `insert into skill_activations (organization_id, skill_name, skill_version_id, trigger, job_id) values ${values.join(',')}`,
        params,
      );
    }
  } catch (err) {
    runLog.warn('skill_activations não gravadas', { error: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
  }

  // ── DE QUAL OPERADORA É O PLANO DESTE CLIENTE (spec 002, F2 · T060/T061) ────
  //
  // Resolvido AQUI, antes de montar as ferramentas: `search_knowledge` fecha sobre estas
  // variáveis e as lê no momento da chamada, e o sufixo da abertura precisa do bloco de
  // pergunta já decidido.
  //
  // Ordem que FR-017 fixa: o vínculo de `contacts` vale; quando ele não existe, o que o
  // cliente ESCREVEU nesta mensagem cria o vínculo — e nada mais cria. Não há inferência
  // por ser a única cadastrada, pela mais usada, nem por semelhança de texto (T061). O
  // desconhecido é estado tratado: a busca devolve só material "vale para todos".
  //
  // Tolerante a falha de propósito, no mesmo molde da leitura de sticky/router acima: um
  // clone que ainda não aplicou a migration 0118 não tem `knowledge_scopes` nem as colunas
  // de vínculo, e o turno tem de continuar atendendo — sem operadora, que é exatamente o
  // estado que o resto deste código sabe tratar.
  let escoposDoTenant: EscopoConhecido[] = [];
  let vinculoDeEscopo: VinculoDeEscopo = VINCULO_DESCONHECIDO;
  let escoposNomeadosPeloCliente: EscopoConhecido[] = [];
  let precisaPerguntarEscopo = false;
  try {
    [escoposDoTenant, vinculoDeEscopo] = await Promise.all([
      carregarEscoposDoTenant(pool, tenantId),
      carregarVinculoDoContato(pool, tenantId, leadId),
    ]);
    escoposNomeadosPeloCliente = reconhecerEscoposNoTexto(skillSignal, escoposDoTenant);

    // O cliente respondeu (agora ou em qualquer turno anterior desta conversa): grava.
    // `escoposNomeadosPeloCliente.length === 1` é a condição inteira — dois nomes na
    // mesma mensagem é ambiguidade que o cliente criou, e escolher um seria a inferência
    // que FR-017 proíbe. A busca segue por operadora nesse caso (FR-018), sem vínculo.
    const unico = escoposNomeadosPeloCliente.length === 1 ? escoposNomeadosPeloCliente[0] : undefined;
    if (unico !== undefined) {
      // A precedência do cadastro é decidida DENTRO de `gravarEscopoDaConversa` (duas
      // camadas, TS e SQL). Repeti-la aqui criaria uma terceira, que é onde a divergência
      // nasce quando alguém muda uma e esquece as outras.
      const gravou = await gravarEscopoDaConversa(pool, tenantId, leadId, unico.id, vinculoDeEscopo);
      if (gravou) {
        vinculoDeEscopo = {
          scopeId: unico.id,
          displayName: unico.displayName,
          source: 'conversa',
          confirmedAt: clock(),
        };
        runLog.info('operadora do cliente registrada pela conversa', {
          knowledge_scope_id: unico.id,
          origem: 'conversa',
        });
      }
    }

    // A-05: uma pergunta, uma operadora. Perguntar num tenant sem escopo nenhum seria
    // pedir ao cliente um dado que o sistema não tem onde guardar.
    precisaPerguntarEscopo =
      vinculoDeEscopo.scopeId === null &&
      escoposDoTenant.length > 0 &&
      !(await escopoJaFoiPerguntado(pool, tenantId, input.conversationId));
  } catch (err) {
    runLog.warn('operadora do cliente não pôde ser resolvida — turno segue sem ela', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  /**
   * A escalação da recusa por falta de material — UMA vez por turno (FR-012).
   *
   * Vive aqui, e não solta em cada ponto de veto, porque os dois caminhos que a acionam
   * (recusa total e recusa isolada de FR-018) precisam produzir exatamente o mesmo aviso,
   * com a mesma operadora e a mesma informação de FR-042. Dois lugares montando o corpo
   * do aviso divergiriam, e a divergência apareceria como um curador vendo metade das
   * lacunas agrupadas e a outra metade em "não identificada".
   *
   * A operadora do aviso, na ordem: a que a afirmação recusada citava → o vínculo do
   * contato → a única que o cliente nomeou nesta mensagem → nenhuma ("não identificada",
   * que é informação honesta, não campo vazio).
   */
  const escalarRecusaDeAssistencia = async (recusados: readonly EscopoRecusado[]): Promise<void> => {
    if (assistenciaSemLastroEscalada) return;
    assistenciaSemLastroEscalada = true;

    const nomeadoNaRecusa = recusados.find((r) => r.scopeName !== null)?.scopeName ?? null;
    const unicoNomeadoPeloCliente =
      escoposNomeadosPeloCliente.length === 1 ? (escoposNomeadosPeloCliente[0]?.displayName ?? null) : null;
    const escopo = nomeadoNaRecusa ?? vinculoDeEscopo.displayName ?? unicoNomeadoPeloCliente;

    // FR-042 / T137: a recusa que não diz "a resposta existe e está desligada" é o pior
    // desfecho desta feature — o corretor conclui que o produto não sabe, quando ele sabe.
    const desligadasQueCobririam = await escoposDesligadosQueCobririam(
      pool,
      {
        tenantId,
        embedding: ultimoEmbeddingDaBusca,
        threshold: agentConfig?.ragSimilarityThreshold ?? 0.72,
        mencionados: escoposNomeadosPeloCliente,
      },
      runLog,
    );

    try {
      await escalarAssistenciaSemLastro(pool, {
        tenantId,
        leadId,
        conversationId: input.conversationId,
        perguntaOriginal: skillSignal,
        escopo,
        escoposDesligadosQueCobririam: desligadasQueCobririam,
        log: runLog,
      });
    } catch (err) {
      // A escalação falhar não pode impedir o cliente de ser avisado. O aviso na Central
      // é importante; a pessoa do outro lado da conversa é mais.
      runLog.error('escalação da recusa por falta de lastro falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
    }
  };

  /**
   * Os ids de catálogo que de fato ENTRARAM neste turno — não os que a tela
   * marcou. A diferença importa: quando a montagem falha, o turno segue sem elas,
   * e é o turno REAL que decide se a projeção arma. Ler a config aqui faria a
   * projeção ficar desligada num turno que, por acidente, não recebeu ferramenta
   * nenhuma — justo o turno em que ela é gratuita.
   *
   * Declarado ANTES de `rawTools` de propósito: o `execute` de `get_lead_context`
   * fecha sobre ele e o lê no momento da CHAMADA, quando as ferramentas de
   * catálogo já foram montadas (o `push` acontece bem abaixo, antes do loop do
   * modelo). Deixá-lo declarado depois funcionaria, mas esconderia a ordem de que
   * a correção depende.
   */
  const mcpToolIdsDoTurno: string[] = [];

  const rawTools: ToolSet = {
    get_lead_context: tool({
      ...AGENT_TOOL_DEFS.get_lead_context,
      execute: async (): Promise<
        | LeadContextResult
        // A variante PROJETADA é um tipo próprio, não um `LeadContext` disfarçado
        // por cast: são payloads diferentes, e um `as` aqui faria o compilador
        // parar de vigiar exatamente a fronteira que este código existe para
        // manter. Note que `lgpd` não viaja nela — base legal e anonimização são
        // dado de conformidade que o runtime usa nos gates, e que o modelo nunca
        // precisou ler (no caminho não-projetado ele já ia junto; aqui para).
        | { ok: true; context: ContextoProjetado; tokenCount: number }
        | { ok: false; error: { code: string; message: string } }
      > => {
        try {
          const releitura = await getLeadContext(
            pool,
            deps.crmCfg,
            { tenantId, leadId, conversationId: input.conversationId },
            turnContextKnobs,
          );
          // Sem esta linha a projeção da abertura seria decorativa: bastaria o
          // modelo chamar esta ferramenta para receber o contexto CRU de volta,
          // com `lead_id`, `conversation_id` e caminho de mídia. A releitura é a
          // mesma superfície da abertura e tem de obedecer à mesma regra —
          // proteger só a porta da frente é não ter protegido.
          if (releitura.ok && turnoProjeta(mcpToolIdsDoTurno)) {
            return {
              ok: true,
              context: projetarContexto(releitura.context),
              tokenCount: releitura.tokenCount,
            };
          }
          return releitura;
        } catch (err) {
          // bug de programação: ensina o modelo a encerrar E derruba o job no fim
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao ler o contexto — encerre o turno agora.' },
          };
        }
      },
    }),
    send_template: tool({
      ...AGENT_TOOL_DEFS.send_template,
      execute: async ({ template_name, language, values }) => {
        // O texto RENDERIZADO vai como `body` da cadeia: os gates de promessa,
        // spinning e disclosure avaliam exatamente o que o contato vai ler. Sem
        // isso, "usar template" seria a forma de escapar dos guardrails de conteúdo.
        const { rows } = await pool.query<{
          components: unknown;
          parameter_format: string;
          status: string;
        }>(
          `select components, parameter_format, status from meta_templates
            where organization_id = $1 and name = $2 and language = $3`,
          [tenantId, template_name, language],
        );
        const linha = rows[0];
        if (linha === undefined) {
          return {
            ok: false,
            error: {
              code: 'template_desconhecido',
              message:
                `não existe template "${template_name}" em ${language} nesta conta. ` +
                'Encerre o turno; um humano precisa configurá-lo.',
            },
          };
        }
        // "Existe" não é "pode ser disparado". A regra vive em template-binding.ts e
        // o caminho HUMANO já a respeitava (recusa `not_approved` no menu do composer);
        // este caminho não a consultava — e é o que age SEM humano olhando. Um template
        // PENDING ou REJECTED iria à Graph API, voltaria erro genérico, e o modelo
        // trataria como falha de infraestrutura em vez de configuração pendente.
        //
        // Erro SEPARADO de `template_desconhecido` de propósito: as duas causas pedem
        // ações humanas diferentes — criar o template, ou esperar/consertar a análise
        // da Meta. Colapsá-las manda o operador procurar no lugar errado.
        if (!isStatusSendable(linha.status)) {
          return {
            ok: false,
            error: {
              code: 'template_nao_aprovado',
              message:
                `o template "${template_name}" existe mas está ${linha.status} na Meta — ` +
                'só um template APPROVED pode ser disparado. Encerre o turno; ' +
                'um humano precisa resolver a aprovação.',
            },
          };
        }

        const rendered = renderTemplateBody(linha.components, values, {
          name: template_name,
          language,
          parameterFormat: linha.parameter_format,
        });

        const chain = await runBeforeSend({
          pool,
          log: runLog,
          tenantId,
          leadId,
          jobId: job.id,
          channelSessionId: input.channelSessionId,
          body: rendered,
          // Só ESTE gate muda; stop, LGPD e pacing continuam valendo integralmente.
          isTemplate: true,
          optedOutThisTurn,
          crmDailyLimit: null,
          now: clock(),
          sleep: deps.sleep,
          lgpd,
          send: (finalBody: string) => {
            seq += 1;
            return channel.send({
              tenantId,
              leadId,
              jobId: job.id,
              seq,
              conversationId: input.conversationId,
              body: finalBody,
              template: { name: template_name, language, values },
            });
          },
        });

        if (chain.status === 'vetoed') {
          return { ok: false, error: { code: chain.code, message: chain.message } };
        }
        const outcome = chain.outcome;
        outcomes.push(outcome);
        if (outcome.kind === 'sent' || outcome.kind === 'already_sent') {
          return {
            ok: true,
            status: 'enviada',
            message_id: outcome.messageId,
            // Explícito: sem isso o modelo tende a emendar texto livre depois do
            // template — que a janela fechada recusaria.
            message: 'template enviado. Não escreva mais nada neste turno.',
          };
        }
        return { ok: true, status: 'aceita_aguardando_canal' };
      },
    }),
    search_knowledge: tool({
      ...AGENT_TOOL_DEFS.search_knowledge,
      execute: async ({ query }) => {
        if (agentConfig?.activeKbVersionId == null) {
          return {
            ok: false,
            error: { code: 'no_knowledge_base', message: 'este agente não tem base de conhecimento ativa — siga sem ela.' },
          };
        }
        // Quais operadoras estão em jogo NESTA busca, nesta ordem (FR-017/FR-018):
        //   1. as que o próprio texto da busca nomeia — o modelo escreveu "carência Amil";
        //   2. as que o CLIENTE nomeou na mensagem deste turno;
        //   3. o vínculo do contato;
        //   4. nenhuma — e aí `p_scope_id` é NULL, que a função trata como "só o que vale
        //      para todos". NÃO é busca ampla, e não existe caminho aqui que a torne uma.
        const nomeadosNaBusca = reconhecerEscoposNoTexto(query, escoposDoTenant);
        const emJogo =
          nomeadosNaBusca.length > 0
            ? nomeadosNaBusca
            : escoposNomeadosPeloCliente.length > 0
              ? escoposNomeadosPeloCliente
              : escoposDoTenant.filter((e) => e.id === vinculoDeEscopo.scopeId);
        const nomes: Record<string, string> = {};
        for (const e of emJogo) nomes[e.id] = e.displayName;

        const out = await searchKnowledge(pool, {
          organizationId: tenantId,
          // O tenant e o acervo saem DAQUI dentro da função (FR-019). O
          // `organizationId` acima existe só para orçamento de embed e telemetria.
          agentId: agentConfig.agentId,
          kbVersionId: agentConfig.activeKbVersionId,
          scopeIds: emJogo.length > 0 ? emJogo.map((e) => e.id) : [null],
          scopeNames: nomes,
          query,
          topK: agentConfig.ragTopK,
          threshold: agentConfig.ragSimilarityThreshold,
          jobId: job.id,
        }, { log: runLog });

        if (out.ok) {
          ultimoEmbeddingDaBusca = out.embedding;
          const todos = out.porEscopo.flatMap((b) => b.results);
          // As citações são montadas AQUI, pelo código, a partir do resultado
          // cru — é por isso que os ids podem sair do que vai ao modelo sem
          // perder nada: quem precisa deles é esta linha, não o modelo.
          pendingCitations = citationsFromHits(todos);
          // A âncora do gate sai do MESMO resultado, e não de uma segunda leitura: o
          // que o gate exige é exatamente o que a busca devolveu, sem espaço para os
          // dois divergirem. Uma busca que não achou nada ZERA o balde — sem isso, o
          // resultado de uma busca anterior no mesmo turno sustentaria uma afirmação
          // sobre outro assunto (lastro emprestado, pior que lastro nenhum porque
          // parece correto). E os baldes ficam separados por operadora: fundi-los aqui
          // seria refazer, em TypeScript, o defeito que a função de busca evita no SQL.
          lastrosPorEscopo = out.porEscopo.map((b) => ({
            scopeId: b.scopeId,
            scopeName: b.scopeName,
            groundings: b.results.map((r) => ({
              chunk_id: r.chunk_id,
              material_id: r.material_id,
              layer: r.layer,
              similarity: r.similarity,
              // O ASSUNTO do trecho, pela mesma régua que classifica a afirmação (T138).
              // Calculado aqui, onde o texto do trecho existe: o gate recebe categoria
              // fechada e nunca o conteúdo — que não pode entrar no trace persistido.
              categorias: detectarAssuntoDeAssistencia(r.content).categorias,
              // FR-040: trecho tirado de conversa passada não sustenta afirmação de
              // assistência. Ele continua entrando na busca e ajudando o modelo a
              // escrever — o que não pode é virar a PROVA de um procedimento.
              aprendidoDeConversa: ehAprendizadoDeConversa(r.source_ref ?? undefined),
              ...(r.source_ref !== null ? { source_ref: r.source_ref } : {}),
            })),
          }));
        }

        // O que volta ao MODELO é montado à mão, sem um único id: `chunk_id` e
        // `material_id` não são argumento de ferramenta nenhuma, e UUID cru chegando à
        // resposta do cliente foi MEDIDO nesta base. E vem agrupado por operadora, com a
        // instrução explícita de não misturar — é a metade de FR-018 que depende de o
        // modelo saber que os montes são de donos diferentes.
        if (!out.ok) {
          return turnoProjeta(mcpToolIdsDoTurno) ? projetarRetornoDeTool(out) : out;
        }
        const paraOModelo = {
          ok: true as const,
          por_operadora: out.porEscopo.map((b) => ({
            operadora: b.scopeName ?? 'não identificada (só material que vale para qualquer plano)',
            trechos: b.results.map((r) => ({
              conteudo: r.content,
              titulo: typeof r.source_ref?.title === 'string' ? r.source_ref.title : null,
              origem: r.layer === 'catalog' ? 'material do catálogo' : 'material carregado pelo corretor',
              similaridade: r.similarity,
            })),
          })),
          ...(out.porEscopo.length > 1
            ? {
                instrucao:
                  'Estes trechos são de operadoras DIFERENTES. Responda cada operadora separadamente e ' +
                  'NUNCA use o trecho de uma para afirmar algo sobre a outra. A parte que não tiver ' +
                  'trecho, não afirme: diga que uma pessoa vai confirmar.',
              }
            : {}),
        };
        return turnoProjeta(mcpToolIdsDoTurno) ? projetarRetornoDeTool(paraOModelo) : paraOModelo;
      },
    }),
    send_message: tool({
      ...AGENT_TOOL_DEFS.send_message,
      execute: async ({ body }) => {
        // F4-04: sinaliza (independente do gate F4-01/F4-08) se ESTA candidata é uma
        // promessa fora de tabela — usado só para correlacionar com o jailbreak no fim do
        // turno. A detecção é determinística (decidePromise); sem tabela do tenant = no-op.
        if (promiseTable !== null && !decidePromise({ candidate: body, table: promiseTable }).allow) {
          outOfTablePromiseAttempted = true;
        }
        // Cadeia de guardrails (F2-13): stop/opt-out → anti-ban → spinning rodam
        // AQUI, entre a decisão do modelo e o adapter. Se um gate veta, o
        // channel.send NÃO acontece e a razão volta ao modelo como erro instrutivo;
        // seq só avança quando o envio é de fato tentado (gate veto não gasta seq
        // — preserva o alinhamento (job_id, seq) do ledger F2-06 entre re-runs).
        try {
          // Wave 4 (spec 15 §10.2): estado de caso lido FRESCO a cada tentativa de envio
          // (pode ter mudado dentro deste MESMO turno via open_human_case, chamado antes
          // deste send_message). casesEnabled false (tela não habilita) → sempre false,
          // sem query — o casePromiseGate já é no-op nesse caso de qualquer forma.
          const hasOpenCase =
            agentConfig?.casesEnabled === true
              ? await hasOpenCaseForContact(pool, tenantId, input.conversationId)
              : false;

          // ── FR-018 · o veto é por AFIRMAÇÃO, não por mensagem ──────────────────
          //
          // O cliente perguntou sobre o plano dele e o da mãe, de operadoras diferentes.
          // A busca já veio segregada; aqui cada FRASE é conferida contra o material da
          // operadora de que ela fala. A parte sem material é recusada isoladamente e a
          // parte que tem continua saindo — derrubar a mensagem inteira puniria o cliente
          // pela metade que estava certa.
          //
          // Só corta quando a mensagem ATRAVESSA operadoras. Numa resposta sobre uma só,
          // recortar frases e emendar uma recusa produziria um texto pior que a recusa
          // inteira que a fatia F1 já entrega — então esse caso segue exatamente como
          // antes, com o gate vetando o corpo original.
          //
          // E só quando a exigência de lastro está LIGADA: com `rag_must_hit` desligado o
          // corretor escolheu que o agente responde sem material, e recortar a mensagem
          // dele seria aplicar meio guardrail sem que ninguém tivesse pedido nenhum.
          const particao = particionarPorEscopo({
            corpo: body,
            lastros: lastrosPorEscopo,
            escopoPadrao: { scopeId: vinculoDeEscopo.scopeId, scopeName: vinculoDeEscopo.displayName },
            escoposConhecidos: escoposDoTenant,
            minCitations: agentConfig?.minCitations ?? 1,
          });
          const recusaIsolada =
            (agentConfig?.exigeLastro ?? false) &&
            particao.recusados.length > 0 &&
            particao.escoposTocados.length > 1 &&
            particao.corpoAprovado.trim() !== '';
          if (recusaIsolada) {
            runLog.info('resposta recusada por operadora, isoladamente (FR-018)', {
              operadoras_tocadas: particao.escoposTocados.length,
              operadoras_recusadas: particao.recusados.length,
            });
            // As três coisas que o veto sempre produz (contrato do gate): a frase ao
            // cliente — aqui emendada no MESMO envio, porque a outra metade da resposta
            // vai junto —, a escalação, e o item na Central.
            await escalarRecusaDeAssistencia(particao.recusados);
          }
          const corpoCandidato = recusaIsolada
            ? `${particao.corpoAprovado}\n\n${fraseDeRecusaParcial(particao.recusados)}`
            : body;
          // Âncoras do que de fato vai sair. Quando a recusa NÃO é isolada e há afirmação
          // sem lastro, o conjunto vazio é o que faz o gate vetar — a decisão continua
          // sendo dele, este cálculo só diz o que ele vê.
          const ancorasDoCorpo: readonly Grounding[] =
            particao.recusados.length > 0 && !recusaIsolada ? [] : particao.groundings;

          // Args reusados EXATAMENTE (mesmo objeto) no re-run do fail-safe abaixo — só
          // hasOpenCase/openedCaseThisTurn mudam depois do auto-abre-caso.
          const beforeSendArgs = {
            pool,
            log: runLog,
            tenantId,
            leadId,
            jobId: job.id,
            channelSessionId: input.channelSessionId,
            body: corpoCandidato,
            optedOutThisTurn,
            // ponytail: channel_sessions.daily_message_limit do CRM ainda não é lido
            // no runtime — null cai nos degraus de warm-up (conservadores). Injetar
            // aqui quando o drain expuser o limite da sessão.
            crmDailyLimit: null,
            now: clock(),
            sleep: deps.sleep,
            lgpd,
            casesEnabled: agentConfig?.casesEnabled ?? false,
            hasOpenCase,
            openedCaseThisTurn,
            // A rede contra vazamento de vocabulário interno arma AQUI e só aqui: este é
            // o único corpo escrito pelo MODELO, e o único caminho em que o veto vira
            // erro instrutivo que ele pode consertar no turno seguinte. O `send_template`
            // (mais acima) fica desarmado de propósito — o texto lá é do humano e já
            // aprovado pela Meta; vetá-lo devolveria ao modelo a culpa por uma frase que
            // não é dele, e a única saída seria o silêncio. O follow-up determinístico
            // idem (ver GateContext.internalVocabularyEnforced).
            enforceInternalVocabulary: true,
            // O veto de lastro arma AQUI e só aqui, pela mesma razão do gate acima: é o
            // único corpo escrito pelo modelo e o único caminho em que o veto vira erro
            // instrutivo. E só quando o corretor ligou a exigência na tela — é o
            // guardrail `rag_must_hit`, que até esta fatia salvava e ninguém avaliava
            // (FR-015). TODO agente nasce com ela ligada, e não só o do onboarding: é o
            // DEFAULT de `ai_agents.guardrails` (migration 0129). Desligar continua
            // possível, mas virou decisão explícita na tela.
            enforceAssistanceGrounding: agentConfig?.exigeLastro ?? false,
            groundings: ancorasDoCorpo,
            minCitations: agentConfig?.minCitations ?? 1,
            ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
            // Gate 5 (F4-02): classificador semântico roteado pelo MESMO seam agnóstico (budget
            // da org checado nele). Closure com tenant/lead/job da ROW fechados — nunca do payload.
            ...(semanticClassifier !== undefined ? { classifyPromiseSemantic: semanticClassifier } : {}),
            // `finalBody` = corpo após a cadeia (o disclosureGate F4-05 pode prependar o
            // disclosure via inject); é ELE que vai ao canal, não o `body` capturado da tool.
            send: (finalBody: string) =>
              sendInBubbles(finalBody, {
                enabled: agentConfig?.splitMessages ?? false,
                maxChars: agentConfig?.splitMaxChars ?? 600,
                sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                jitter: () => 1200 + Math.floor(Math.random() * 800), // piso no throttle anti-ban (1.2s) — bolhas são mensagens físicas
                send: async (bubble): Promise<ChannelSendResult> => {
                  seq += 1;
                  const enviada = await channel.send({
                    tenantId,
                    leadId,
                    jobId: job.id,
                    seq,
                    conversationId: input.conversationId,
                    body: bubble,
                    // A âncora nasce COM a mensagem (FR-024), não num update depois.
                    // Cada bolha carrega a mesma origem porque as bolhas são recortes
                    // físicos de uma resposta só — dividir a resposta não divide a prova.
                    ...(pendingCitations.length > 0
                      ? { metadata: { citations: pendingCitations, ai_generated: true } }
                      : {}),
                  });
                  // FR-021 · T105: a mesma âncora vira REGISTRO consultável, ao lado da
                  // cópia que já viaja em `metadata`. Depois do envio porque a linha
                  // referencia `messages.id`, que não existe antes dele — e é por isso
                  // que falhar aqui não derruba o turno: a resposta já saiu, e o cliente
                  // já leu. A fronteira está escrita por extenso no docblock de
                  // `grounding-registry.ts`.
                  if (
                    pendingCitations.length > 0 &&
                    (enviada.kind === 'sent' || enviada.kind === 'already_sent') &&
                    enviada.messageId
                  ) {
                    await registrarGroundings(
                      pool,
                      {
                        organizationId: tenantId,
                        messageId: enviada.messageId,
                        citations: pendingCitations,
                      },
                      runLog,
                    );
                  }
                  return enviada;
                },
              }),
          };
          let chain = await runBeforeSend(beforeSendArgs);
          if (chain.status === 'vetoed' && chain.code === 'case_promise_without_case') {
            // Wave 4 — fail-safe da invariante sagrada: o lead NUNCA recebe promessa-de-
            // humano sem caso aberto. 1ª vez no turno: erro-de-ensino (o modelo re-tenta —
            // abre o caso OU reformula sem prometer humano). Persistiu (2ª vez): o SISTEMA
            // abre um caso mínimo e libera o envio — nunca deixa a promessa passar sem caso.
            casePromiseVetoCount += 1;
            if (casePromiseVetoCount < 2) {
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            const auto = await openCase(
              pool,
              { tenantId, conversationId: input.conversationId, agentId: agentConfig?.agentId ?? null },
              {
                title: 'Atendimento que precisa de um humano',
                summary: body, // a mensagem-promessa que a IA tentou enviar
                blocker:
                  'Aberto automaticamente: a IA prometeu envolver um humano e não abriu o caso (fail-safe do guardrail).',
                source: 'guardrail_autofallback',
                contextSnapshot: buildCaseContextSnapshot(),
              },
            );
            if (!auto.ok) {
              // openCase falhou (ex.: já existe outro caso aberto por corrida) — NÃO envie
              // prometendo humano sem caso; mantém a invariante com o erro de ensino original.
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            openedCaseThisTurn = true;
            // Re-roda a cadeia INTEIRA agora que há caso aberto — o send real acontece
            // DENTRO do runBeforeSend (via args.send); nunca chamamos o canal por fora
            // (perderia pacing/lgpd/stop). ponytail: re-roda a cadeia inteira no fail-safe
            // (raro) — pode reaplicar 1 espera de pacing; aceitável pelo caminho ser
            // excepcional.
            chain = await runBeforeSend({ ...beforeSendArgs, hasOpenCase: true, openedCaseThisTurn: true });
          }
          if (chain.status === 'vetoed' && chain.code === 'internal_vocabulary_leak') {
            // Fail-safe do gate de vazamento — O CLIENTE NUNCA FICA SEM RESPOSTA.
            //
            // Este gate é REDE, não invariante sagrada (ao contrário do case_promise, cuja
            // 2ª camada ABRE o caso antes de liberar). Aqui não há o que o sistema possa
            // fazer no lugar do modelo: ou ele reescreve, ou a escolha é entre uma frase
            // com um termo técnico e o silêncio. Silêncio é pior — some com o atendimento
            // sem sintoma, que é o oposto do invariante 4 do sistema vivo. Então: 1º veto
            // ensina (o modelo re-tenta); persistiu, o envio sai DESARMANDO só este gate —
            // todos os outros continuam valendo, porque o re-run passa pela cadeia inteira.
            //
            // O veto da 1ª tentativa já virou linha em `before_send_traces` (com a
            // categoria do vazamento) e atividade na timeline: a liberação não apaga a
            // medição, que é o produto deste gate.
            internalVocabularyVetoCount += 1;
            if (internalVocabularyVetoCount < MAX_VETOS_DE_VOCABULARIO_INTERNO) {
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            runLog.warn('fail-safe do gate de vocabulário interno: envio liberado após vetos seguidos', {
              vetos: internalVocabularyVetoCount,
            });
            // `openedCaseThisTurn` vai pelo valor VIVO (o fail-safe de casos acima pode
            // tê-lo mudado); reusar o do objeto capturado re-vetaria no case_promise.
            chain = await runBeforeSend({
              ...beforeSendArgs,
              openedCaseThisTurn,
              hasOpenCase: hasOpenCase || openedCaseThisTurn,
              enforceInternalVocabulary: false,
            });
          }
          if (chain.status === 'vetoed' && chain.code === 'assistencia_sem_lastro') {
            // Spec 002, FR-011/FR-012. Aqui NÃO existe fail-safe que libere o envio: sem
            // material, a afirmação não sai nem na terceira tentativa. O que existe é a
            // garantia de que o cliente não fica mudo — e ela é do SISTEMA, não do modelo.
            //
            // Por que o sistema fala e não o modelo: se dependêssemos de ele reescrever,
            // o turno em que ele insistisse acabaria sem nenhuma mensagem, e o cliente
            // ficaria no vácuo esperando. Isso é exatamente o "morre sem sintoma" que o
            // invariante 4 do sistema vivo proíbe — e seria causado pelo guardrail que
            // veio melhorar o atendimento.
            if (!assistenciaSemLastroEscalada) {
              // Desde a F2 a escalação sabe QUAL operadora ficou sem material e se existe
              // uma no catálogo, desligada, que cobriria o assunto (T137 / FR-042). Os
              // escopos recusados vêm da partição do corpo — quando ela não identificou
              // nenhum, o helper cai no vínculo do contato e, por último, em "não
              // identificada", que é informação honesta e não campo vazio.
              await escalarRecusaDeAssistencia(particao.recusados);
              const avisoAoCliente = await runBeforeSend({
                ...beforeSendArgs,
                body: FRASE_DE_RECUSA_SEM_LASTRO,
                // A frase não afirma nada sobre a operadora, então a classificação já a
                // deixaria passar. O gate segue ARMADO de propósito: se um dia alguém
                // reescrever a frase e ela virar afirmação, é melhor que o guarda pegue.
                groundings: [],
                openedCaseThisTurn,
                hasOpenCase: hasOpenCase || openedCaseThisTurn,
              });
              if (avisoAoCliente.status === 'sent') {
                outcomes.push(avisoAoCliente.outcome);
              } else {
                runLog.warn('aviso de recusa não chegou ao cliente', {
                  status: avisoAoCliente.status,
                  ...(avisoAoCliente.status === 'vetoed' ? { gate: avisoAoCliente.gate } : {}),
                });
              }
            }
            return {
              ok: true,
              status: 'enviada',
              message:
                'não há material carregado que sustente essa afirmação, então ela não foi enviada. ' +
                'O cliente já foi avisado de que uma pessoa vai confirmar, e a conversa foi escalada. ' +
                'Não escreva mais nada neste turno.',
            };
          }
          if (chain.status === 'vetoed') {
            // Erro de ENSINO pt-br (mesmo shape de get_lead_context/breaker): o
            // modelo o vê no turno seguinte. NÃO é exceção — não derruba o run.
            return { ok: false, error: { code: chain.code, message: chain.message } };
          }
          const outcome = chain.outcome;
          outcomes.push(outcome);
          // As citações NÃO são mais carimbadas aqui. Elas viajam no `metadata` do
          // `channel.send`, ou seja, nascem no MESMO insert da mensagem (spec 002,
          // FR-024). O que existia neste ponto era um `update` pós-envio cujo `catch`
          // dizia *"citação é enriquecimento, não invariante — falha só loga"*: quando
          // ele falhava, a mensagem já estava no telefone do cliente e ninguém mais
          // conseguia dizer de onde ela tinha saído. Rastreabilidade que depende de uma
          // segunda escrita dar certo não é rastreabilidade.
          pendingCitations = [];
          lastrosPorEscopo = [];
          switch (outcome.kind) {
            case 'sent':
            case 'already_sent':
              return { ok: true, status: 'enviada', message_id: outcome.messageId };
            case 'queued':
              return {
                ok: true,
                status: 'aceita_aguardando_canal',
                message:
                  'o canal aceitou a mensagem e vai enviá-la quando a sessão voltar — não reenvie.',
              };
            case 'blocked':
              return {
                ok: false,
                error: {
                  code: 'contato_bloqueado',
                  message:
                    'o contato optou por não receber mensagens (bloqueio irrevogável) — não envie mais nada e encerre o turno.',
                },
              };
            case 'failed':
              return {
                ok: false,
                error: {
                  code: 'envio_falhou',
                  message: 'o canal falhou ao enviar — não tente de novo neste turno; o sistema fará retry.',
                },
              };
            case 'unavailable':
              // transiente (transporte/tool do canal): ensina o modelo a parar; o
              // job re-tenta com a MESMA idempotency_key (ledger ficou 'requested').
              noteRunError(new Error(`canal indisponível no envio (${outcome.reason}) — job re-tentado pela fila`));
              return {
                ok: false,
                error: {
                  code: 'envio_indisponivel',
                  message: 'não consegui enviar agora (canal indisponível) — encerre o turno; o sistema re-tentará.',
                },
              };
          }
        } catch (err) {
          // bug de programação no adapter: ensina o modelo a encerrar E derruba o job.
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno no envio — encerre o turno agora.' },
          };
        }
      },
    }),
    update_lead_state: tool({
      ...AGENT_TOOL_DEFS.update_lead_state,
      execute: async (raw) => {
        try {
          const update = await applyLeadStateUpdate(pool, { tenantId, leadId, jobId: job.id }, raw);
          if (!update.ok) {
            return update; // erro de ensino (payload fora da whitelist / transição inválida)
          }
          if (update.transition !== null) {
            // Espelho no CRM. Falha NUNCA reverte o harness (fonte da verdade do
            // funil) nem falha o job: humano resolve via inbox_items. Os motivos
            // de MIRROR_WARN_ONLY (tenant sem mapa; humano moveu o card antes) são
            // só warn — estado legítimo do produto não é incidente.
            const mirror = await mirrorLeadStageToCrm(pool, deps.crmCfg, {
              tenantId,
              leadId,
              toStage: update.transition.to,
              ...(update.transition.reason !== undefined ? { reason: update.transition.reason } : {}),
            });
            if (!mirror.ok) {
              runLog.warn('espelho de stage no CRM falhou — harness mantido', {
                to_stage: update.transition.to,
                reason: mirror.reason,
              });
              if (!MIRROR_WARN_ONLY.has(mirror.reason)) {
                await insertInboxItem(pool, tenantId, {
                  kind: 'other',
                  title: 'Espelho de stage no CRM falhou — funil possivelmente inconsistente',
                  body: `lead_state avançou para "${update.transition.to}" no harness, mas crm_move_lead_stage falhou (${mirror.reason}: ${mirror.detail}). Reconcilie o stage no CRM manualmente.`,
                  refKind: 'lead',
                  refId: leadId,
                });
              }
            }
          }
          // F3-11: o estágio que o modelo confirmou (a máquina F2-10 gravou) — base da
          // comparação com a sugestão do classificador no fechamento do run.
          confirmedStage = update.state.stage;
          return { ok: true, status: 'estado_atualizado', stage: update.state.stage, message: update.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao atualizar o estado do lead — encerre o turno agora.',
            },
          };
        }
      },
    }),
    // F3-05: memória durável por lead. save_lead_note é MUTANTE (fora de
    // READ_ONLY_TOOLS); tenant/lead vêm da ROW do job (closure), nunca do payload.
    // Hard cap do índice imposto AQUI na escrita (applySaveLeadNote) — estouro vira
    // ensino pedindo consolidação, sem gravar (padrão Hermes).
    save_lead_note: tool({
      ...AGENT_TOOL_DEFS.save_lead_note,
      execute: async (raw) => {
        try {
          const res = await applySaveLeadNote(
            pool,
            { tenantId, leadId },
            { budgetTokens: deps.knobs.notesIndexMaxTokens },
            raw,
          );
          if (!res.ok) {
            return res; // ensino (payload fora da whitelist / orçamento do índice estourado)
          }
          return { ok: true, status: 'nota_salva', superseded: res.superseded, message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao salvar a nota — encerre o turno agora.' },
          };
        }
      },
    }),
    // get_lead_note é READ-ONLY: relê o corpo de UMA nota do lead pelo id (sob demanda —
    // o índice só traz headline). Escopado por (tenant, lead) do closure.
    get_lead_note: tool({
      ...AGENT_TOOL_DEFS.get_lead_note,
      execute: async ({ note_id }) => {
        try {
          const noteId = note_id.trim();
          const body = noteId === '' ? null : await getLeadNoteBody(pool, tenantId, leadId, noteId);
          if (body === null) {
            return {
              ok: false,
              error: {
                code: 'note_not_found',
                message: 'não há nota com esse id na memória deste lead — confira o id no índice de memória.',
              },
            };
          }
          return { ok: true, note_id: noteId, body };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao ler a nota — encerre o turno agora.' },
          };
        }
      },
    }),
    // F4-06: handoff humano acionado pelo PRÓPRIO modelo (cidadão de 1ª classe). MUTANTE
    // (seta force_human no CRM + cancela crons + inbox), fora de READ_ONLY_TOOLS. tenant/
    // lead/conversation vêm da ROW do job (closure), nunca do payload do modelo.
    request_human_handoff: tool({
      ...AGENT_TOOL_DEFS.request_human_handoff,
      execute: async (raw) => {
        try {
          const res = await applyRequestHumanHandoff(
            pool,
            { tenantId, leadId, conversationId: input.conversationId },
            { conversationSummary: buildHandoffSummary(previous), log: runLog },
            raw,
          );
          if (!res.ok) return res; // erro de ensino (payload fora da whitelist)
          return { ok: true, status: res.status, message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao acionar o handoff humano — encerre o turno agora.' },
          };
        }
      },
    }),
  };

  // F3-02: a tool de agendamento (schedule_followup) só entra quando sua janela
  // está configurada — main.ts sempre a preenche pelos knobs do env; tenant/lead
  // vêm da ROW do job (closure), nunca do payload do modelo. É MUTANTE (cria
  // cron_job), por isso fica fora de READ_ONLY_TOOLS.
  const followupKnobs = deps.knobs.followup;
  if (followupKnobs !== undefined) {
    rawTools.schedule_followup = tool({
      ...AGENT_TOOL_DEFS.schedule_followup,
      execute: async (raw) => {
        try {
          // agentId vai junto para a atividade da timeline nascer com AUTORIA: sem
          // ele a linha entra como "Sistema" e o humano não sabe qual agente
          // prometeu voltar — numa org com três agentes isso não responde nada.
          const res = await applyScheduleFollowup(
            pool,
            { clock, knobs: followupKnobs },
            { tenantId, leadId, agentId: agentConfig?.agentId ?? null },
            raw,
          );
          if (!res.ok) {
            return res; // erro de ensino (payload / data no passado / fora da janela)
          }
          return { ok: true, status: 'agendado', agendado_para: res.promisedAt.toISOString(), message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao agendar o retorno — encerre o turno agora.' },
          };
        }
      },
    });
  }

  // Fase 2 (Task 6): read_skill_reference só entra quando alguma skill CASADA neste
  // turno carrega references no manifesto (Task 3) — sem isso oferecer a tool seria
  // ruído. Read-only (tool-breaker.ts); tenant/matched skills vêm do closure
  // (skillMatch, calculado acima), nunca do payload do modelo.
  if (skillMatch.matched.some((s) => skillHasReferences(s))) {
    rawTools.read_skill_reference = tool({
      ...AGENT_TOOL_DEFS.read_skill_reference,
      execute: async ({ skill_name, ref_path }) => {
        try {
          return await readSkillReference(
            { admin: deps.crmCfg.supabase },
            { organizationId: tenantId, matchedSkills: skillMatch.matched, skillName: skill_name, refPath: ref_path },
          );
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao ler a reference da skill — encerre o turno agora.' },
          };
        }
      },
    });
  }

  // Fase 2B: a tela pode DESLIGAR a tool de handoff do modelo (a detecção
  // determinística de pedido de humano continua ativa — guardrail nunca sai).
  if (agentConfig !== null && !agentConfig.handoffToolEnabled) {
    delete rawTools.request_human_handoff;
  }

  // Spec 15: snapshot mínimo do contexto disponível pro humano que for atender o
  // caso — campo de CONVENIÊNCIA pra UI, não load-bearing (nada aqui é relido pelo
  // agente). ponytail: snapshot mínimo; enriquecer se a UI precisar de mais.
  const buildCaseContextSnapshot = (): Record<string, unknown> => ({
    contact_name: effectiveContext.contact.name,
    last_messages: effectiveContext.messages.slice(-5).map((m) => ({ direction: m.direction, body: m.body })),
  });

  // Spec 15 (Wave 3a): tools de caso humano (open_human_case/provide_case_update) só
  // entram quando a tela habilita (cases_enabled) — mesmo padrão do handoff acima.
  // Ids do closure (row do job), nunca do payload; payload inválido é erro de ENSINO
  // ({ok:false}), exceção real vira internal_error (mesma disciplina dos irmãos).
  if (agentConfig !== null && agentConfig.casesEnabled) {
    rawTools.open_human_case = tool({
      ...AGENT_TOOL_DEFS.open_human_case,
      execute: async (raw) => {
        const parsed = openHumanCaseInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'invalid_payload',
              message: 'campos do caso inválidos — informe title, summary e blocker (texto).',
            },
          };
        }
        try {
          const res = await openCase(
            pool,
            { tenantId, conversationId: input.conversationId, agentId: agentConfig.agentId },
            { ...parsed.data, contextSnapshot: buildCaseContextSnapshot() },
          );
          if (!res.ok) return res;
          openedCaseThisTurn = true;
          // ACH-03: a expectativa vai junto com a confirmação. Medido num turno
          // real: o agente abria o caso e prometia ao cliente que "alguém entra
          // em contato" sem nunca ter olhado se havia alguém — a capacidade de
          // consultar existia, estava ligada e montada no turno, e ele não a
          // usou. Capacidade que depende de o modelo lembrar não existe metade
          // das vezes; esta o sistema garante.
          const { frase } = await expectativaDeAtendimento(pool, tenantId, new Date());
          return {
            ok: true,
            case_id: res.caseId,
            message: `caso aberto; continue a conversa com o lead normalmente. ${frase}`,
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao abrir o caso — encerre o turno.' },
          };
        }
      },
    });
    rawTools.provide_case_update = tool({
      ...AGENT_TOOL_DEFS.provide_case_update,
      execute: async (raw) => {
        const parsed = provideCaseUpdateInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: { code: 'invalid_payload', message: 'informe case_id e info (texto).' },
          };
        }
        try {
          const res = await provideCaseUpdate(
            pool,
            { tenantId, conversationId: input.conversationId },
            { caseId: parsed.data.case_id, info: parsed.data.info },
          );
          if (!res.ok) return res;
          return { ok: true, message: 'informação enviada ao responsável; aguarde o retorno pelo caso.' };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao atualizar o caso — encerre o turno.' },
          };
        }
      },
    });
  }

  // Fase 0 (convergência): a tool de conhecimento só entra quando o agente
  // publicado tem KB ativa — def estática permanece no AGENT_TOOL_DEFS (prefixo).
  if (agentConfig?.activeKbVersionId == null) {
    delete rawTools.search_knowledge;
  }

  // A ferramenta de template só entra em canal que EXIGE template fora da janela.
  // Num canal que fala livre a qualquer hora ela nunca teria uso — e tool inútil no
  // prompt não é neutra: gasta contexto e degrada a escolha do modelo.
  {
    const provider = await loadChannelProvider(pool, tenantId, input.channelSessionId);
    if (!capabilitiesOf(provider).requiresTemplates) {
      delete rawTools.send_template;
    }
  }

  // 2B-tools: tools do catálogo MCP habilitadas NA TELA entram no run (audit +
  // role/scope da ponte nativa; envio e handoff do catálogo são bloqueados —
  // ver edge/crm/mcp-tools.ts). As 8 tools do engine têm precedência de nome.
  let mcpCleanup: (() => Promise<void>) | null = null;
  if (agentConfig !== null && agentConfig.toolIds.length > 0) {
    try {
      // As de OPERAÇÃO saem antes de serem montadas, quando o Operador as tem.
      // Medido: são elas que carregavam 2 dos 3 vazamentos (o DADO que devolvem),
      // e tirá-las levou a taxa de 30% para 10% — ver RELATORIO-passo6.md.
      const catalogoEntregue = catalogoEntregueAoOperador({
        operadorLigado: agentConfig.operatorEnabled,
        ferramentasDoOperador: agentConfig.operatorToolIds,
        ferramentasDoConversador: agentConfig.toolIds,
      });
      const configDoTurno =
        catalogoEntregue.length === 0
          ? agentConfig
          : { ...agentConfig, toolIds: agentConfig.toolIds.filter((t) => !catalogoEntregue.includes(t)) };
      if (catalogoEntregue.length > 0) {
        runLog.info('capacidades de catálogo entregues ao operador', { entregues: catalogoEntregue });
      }
      const mcp = await buildMcpTurnTools(deps.crmCfg, { organizationId: tenantId, jobId: job.id }, configDoTurno, runLog);
      if (mcp !== null) {
        mcpCleanup = mcp.cleanup;
        for (const [name, mcpTool] of Object.entries(mcp.tools)) {
          if (!(name in rawTools)) rawTools[name] = mcpTool;
        }
        mcpToolIdsDoTurno.push(...mcp.toolIds);
        runLog.info('tools MCP da tela montadas no turno', { mcp_tool_ids: mcp.toolIds });
      }
    } catch (err) {
      // Tool extra é privilégio, não invariante: falha no mint/montagem NÃO
      // derruba o turno — a conversa do cliente não pode morrer porque uma tool
      // extra falhou. Isso continua certo.
      //
      // O que estava errado era o DEPOIS. A versão anterior deste comentário
      // dizia "o humano vê o log". Não vê: o log sai no stdout do worker, num
      // contêiner de VPS que o dono do negócio nunca abre. Medido num turno
      // real — o agente atendeu sem NENHUMA das capacidades que o humano tinha
      // ligado na tela, e a única pista existia num log que ninguém lê. É
      // falha-em-verde: anunciada na tela, ausente na execução, nada contando.
      const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      runLog.error('tools MCP da tela não montadas — turno segue sem elas', { error: detalhe });
      await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
    }
  }

  // ── A CURA (spec 16, passo 6) ───────────────────────────────────────────────
  //
  // As ferramentas de escrita saem do Conversador quando o Operador as assumiu.
  // O gate de vazamento é rede — barra na saída e ensina; isto é a cura: o
  // modelo não pode repetir o nome de uma ferramenta que nunca viu, e foi pelo
  // NOME que o vazamento voltou depois de a descrição ser limpa.
  //
  // A remoção é CONDICIONAL a o novo dono existir (ver entrega-de-capacidade):
  // tirar de um lado sem garantir o outro não separa papéis, perde capacidade.
  const entregues = capacidadesEntreguesAoOperador({
    operadorLigado: agentConfig?.operatorEnabled ?? false,
    ferramentasDoOperador: agentConfig?.operatorToolIds ?? [],
  });
  for (const nome of entregues) delete rawTools[nome];
  if (entregues.length > 0) {
    runLog.info('capacidades entregues ao operador — fora do turno do conversador', {
      entregues,
    });
  }

  // Circuit breaker de tools (F2-15): estado no closure DESTA invocação — zera
  // entre runs por construção (mesma garantia de isolamento do resto do run).
  const tools = wrapToolsWithBreaker(rawTools, {
    thresholds: deps.knobs.breaker,
    readOnlyTools: READ_ONLY_TOOLS,
    log: runLog, // os warns dos gates do breaker saem carimbados com o run
  });

  // F3-11: stage-classifier auxiliar. Roda ANTES do turno (modelo BARATO pelo seam
  // agnóstico) e sugere o estágio; a sugestão entra como HINT no SUFIXO por-lead — o modelo
  // do agente decide e confirma via update_lead_state (a máquina F2-10 é a única porta). A
  // sugestão fica guardada para comparar com o que o modelo confirmou (divergência, no fim).
  const currentStage: LeadStage = leadState?.stage ?? 'new';
  let stageSuggestion: LeadStage | null = null;
  let stageHintBlock = '';
  if (deps.knobs.stageClassifier !== undefined) {
    stageSuggestion = await classifyStage(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        context: effectiveContext,
        currentStage,
        ...argsAux(deps.knobs.stageClassifier.model),
      },
      { registry: deps.registry, log: runLog },
    );
    if (stageSuggestion !== null) {
      stageHintBlock = renderStageHint(stageSuggestion, currentStage);
    }
  }

  // F4-04: classifier ADVISÓRIO anti-jailbreak sobre a mensagem INBOUND do lead (o
  // skillSignal já é a última inbound). Roda pelo seam agnóstico (modelo BARATO, budget
  // checado nele). NÃO veta o inbound — só FLAGRA o turno no trace; flag/level não são PII
  // (a mensagem/reason nunca vão a log). A correlação com promessa fora de tabela escala no fim.
  let jailbreakLevel: JailbreakLevel = 'none';
  if (deps.knobs.jailbreak !== undefined) {
    const verdict = await classifyJailbreak(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        message: skillSignal,
        ...argsAux(deps.knobs.jailbreak.model),
      },
      { registry: deps.registry, log: runLog },
    );
    jailbreakLevel = verdict.level;
    if (verdict.flag) {
      // trace do turno: só flag/level (não PII) — a mensagem e o reason nunca são logados.
      runLog.warn('jailbreak: sinal detectado na mensagem do lead', {
        jailbreak_flag: true,
        jailbreak_level: verdict.level,
      });
    }
  }

  // Spec 16 §4: a projeção arma quando NENHUMA ferramenta de catálogo entrou —
  // é exatamente o turno em que os ids do contexto não têm uso, e portanto o
  // único em que removê-los não custa nada. Logado porque "por que o prompt
  // deste turno é diferente do daquele?" precisa ter resposta no trace.
  const projetaContexto = turnoProjeta(mcpToolIdsDoTurno);
  runLog.info('projeção do contexto do turno', {
    projeta: projetaContexto,
    mcp_tools_no_turno: mcpToolIdsDoTurno.length,
  });
  const openingBase = input.buildOpening({
    previous: effectivePrevious,
    leadState,
    context: effectiveContext,
    notesIndexBlock,
    projeta: projetaContexto,
    entregues,
  });
  // Sufixos por-lead (situacionais, voláteis — depois do prefixo cacheável F2-17): corpos de
  // skill casadas (F3-09) + hint do classificador (F3-11) + instrução de split (F4-xx, quando
  // split_messages está on — Onda 4). Vazios são omitidos.
  const splitHint = (agentConfig?.splitMessages ?? false)
    ? 'Responda em mensagens curtas e naturais, uma ideia por mensagem — como uma pessoa digitando no WhatsApp. Prefira várias mensagens curtas a um texto único e longo.'
    : '';
  // Spec 15: o `case_id` real do caso 'awaiting_lead' desta conversa, se houver — sem
  // isso o modelo nunca consegue chamar provide_case_update quando o lead simplesmente
  // responde (o caminho comum; case_reply_turn só cobre a AÇÃO do humano). Sufixo
  // por-lead (volátil) — nunca no prefixo cacheável (o case_id muda a cada caso).
  const caseAwaitingLead =
    agentConfig !== null && agentConfig.casesEnabled
      ? await getCaseAwaitingLead(pool, tenantId, input.conversationId)
      : null;
  const caseAwaitingLeadBlock =
    caseAwaitingLead !== null
      ? `## Caso aguardando resposta deste cliente\n` +
        `Há um caso aberto (case_id: ${caseAwaitingLead.id}) esperando uma informação dele: "${caseAwaitingLead.ask}". ` +
        `Se a mensagem dele responde a isso, chame provide_case_update com este case_id e a informação recebida — ` +
        `NÃO diga que já repassou/avisou o responsável sem chamar a tool.`
      : '';
  // Spec 002, T060/A-05: a pergunta da operadora entra no SUFIXO por-lead (volátil, nunca
  // no prefixo cacheável) e só quando ela ainda é desconhecida e nunca foi feita nesta
  // conversa. O bloco carrega, junto, a proibição de supor (T061) — o código impede o
  // vínculo errado de ser GRAVADO, e esta linha impede o modelo de AFIRMAR sobre uma
  // operadora que ele supôs, que é a metade que o cliente sentiria.
  const perguntaDeEscopoBlock = precisaPerguntarEscopo ? blocoDePerguntaDeEscopo(escoposDoTenant) : '';
  const openingSuffixes = [
    matchedSkillsBlock,
    stageHintBlock,
    splitHint,
    caseAwaitingLeadBlock,
    perguntaDeEscopoBlock,
  ].filter((b) => b !== '');
  const openingText =
    openingSuffixes.length === 0 ? openingBase : `${openingBase}\n\n${openingSuffixes.join('\n\n')}`;
  // Onda 3 (aprimoramento): mídia inbound recente vira part nativa (image/file) SÓ para
  // provider+modelo capazes (T2 modelCapabilities) — modelo incapaz/desconhecido → [] e o
  // derivado textual (já embutido em openingText via LeadContextMessage) cobre sozinho.
  const nativeParts = await buildNativeMediaParts({
    messages: effectiveContext.messages,
    provider: agentConfig?.provider ?? 'anthropic',
    model: agentConfig?.model ?? '',
    multimodalInput: agentConfig?.multimodalInput ?? false,
    admin: deps.crmCfg.supabase,
  });
  const openingTextOnly: ModelMessage[] = [{ role: 'user', content: openingText }];
  const openingMessages: ModelMessage[] =
    nativeParts.length === 0
      ? openingTextOnly
      : [{ role: 'user', content: [{ type: 'text', text: openingText }, ...nativeParts] }];

  // O modelo decide tools livremente dentro do teto de steps (knob AGENT_MAX_STEPS).
  const turn = await runModelCall(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      purpose: 'agent_turn',
      system,
      messages: openingMessages,
      tools,
      maxSteps,
      ...(agentConfig !== null
        ? {
            model: agentConfig.model,
            llmOverride: { provider: agentConfig.provider, credentialId: agentConfig.credentialId },
          }
        : {}),
    },
    { registry: deps.registry, log: runLog },
  );

  // F4-04: correlação dos dois sinais do MESMO turno — jailbreak ALTO + tentativa de
  // promessa fora de tabela (F4-01). Ambos estão determinados aqui (o jailbreak rodou na
  // abertura; as tentativas de envio já passaram pelo loop). Dispara escalação humana em
  // inbox_items (dedup por episódio). Advisório: o classifier sozinho nunca escala — o gate
  // determinístico é que confirma a promessa indevida. Feito antes do runError/veto para
  // não se perder num turno que falha o envio depois.
  if (jailbreakLevel === JAILBREAK_ESCALATION_LEVEL && outOfTablePromiseAttempted) {
    const created = await escalateJailbreakPromise(pool, { tenantId, leadId, level: jailbreakLevel });
    if (created > 0) {
      runLog.warn('jailbreak: escalação humana criada (flag alta + promessa fora de tabela no turno)', {
        jailbreak_level: jailbreakLevel,
      });
    }
  }

  // A-05: uma pergunta, uma operadora. A marca é gravada quando o bloco foi injetado E
  // alguma mensagem de fato saiu — não na injeção. A diferença importa nos dois sentidos:
  // marcar na injeção gastaria a única pergunta num turno em que o cliente não recebeu
  // nada (o gate vetou, o canal caiu), e não marcar nunca faria o agente perguntar a
  // mesma coisa em todo turno, que é o incômodo que A-05 nomeia.
  //
  // Fire-and-forget: falhar aqui repete a pergunta uma vez, o que é chato; derrubar o
  // turno por causa disso é pior.
  if (precisaPerguntarEscopo && outcomes.some((o) => o.kind === 'sent' || o.kind === 'already_sent')) {
    try {
      await marcarEscopoPerguntado(pool, tenantId, input.conversationId);
    } catch (err) {
      runLog.warn('marca de "operadora já perguntada" não gravada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  if (runError !== null) {
    throw runError; // job falha → retry da fila; o ledger segura duplicata de envio
  }
  if (outcomes.some((o) => o.kind === 'failed')) {
    // ponytail: retry re-roda o run inteiro (LLM incluso); seq N re-encontra a
    // linha do ledger — 'accepted' pula, 'failed' rotaciona a key (F2-06).
    throw new Error('envio marcado como failed pelo CRM — run re-tentado pela fila');
  }

  // F3-10: poda os tool results antigos da fita do run ANTES de reenviá-los no fechamento
  // (é onde a fita inteira é re-serializada num prompt) — o conteúdo durável já foi para
  // lead_notes pelo flush (F3-07), então o stub não perde nada recuperável. Opera SÓ no
  // sufixo por-lead, nunca no prefixo estável (regra de cache 15).
  const responseMessages =
    deps.knobs.prune !== undefined
      ? pruneToolResults(turn.result.response.messages, deps.knobs.prune)
      : turn.result.response.messages;

  // Fechamento imposto pelo runtime: 2ª chamada, mesma conversa, só o checkpoint.
  const closing = await runModelCall(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      purpose: 'checkpoint',
      ...(agentConfig !== null
        ? {
            model: agentConfig.model,
            llmOverride: { provider: agentConfig.provider, credentialId: agentConfig.credentialId },
          }
        : {}),
      system,
      messages: [
        // prune: o checkpoint reusa a abertura só como texto — a mídia nativa (cara) já
        // fez seu trabalho na 1ª chamada e não precisa ir de novo.
        ...openingTextOnly,
        ...responseMessages,
        { role: 'user', content: CHECKPOINT_INSTRUCTION },
      ],
    },
    { registry: deps.registry, log: runLog },
  );
  const content = parseCheckpointText(closing.result.text);

  // Wave 3 (2.4): o checkpoint anterior é lido ANTES de gravar o novo — a
  // timeline recebe o DIFF, nunca o snapshot. Emitir a cada turno encheria a
  // tela com "a IA pensou" e enterraria a única linha que muda o que alguém
  // faria a seguir.
  const checkpointAnterior = await latestCheckpoint(pool, tenantId, leadId);
  await insertCheckpoint(pool, { tenantId, leadId, jobId: job.id, content });

  // ── O TURNO DO OPERADOR (spec 16 §3.2) ─────────────────────────────────────
  //
  // Enfileirado AQUI, pelo RUNTIME, logo depois de o checkpoint existir — nunca
  // por decisão do modelo. Um Conversador que "chama" o Operador devolveria o
  // problema inteiro: voltaria a depender de o modelo lembrar, e o turno em que
  // ele não achasse necessário seria um lead parado no funil, em silêncio.
  //
  // Depois do checkpoint porque a declaração É o insumo do Operador; enfileirar
  // antes criaria uma corrida em que ele leria o checkpoint do turno ANTERIOR e
  // agiria sobre um turno que não é o seu.
  //
  // Fire-and-forget: falha ao enfileirar NÃO derruba um turno que já respondeu
  // ao cliente. O `sourceEventId` é o job do Conversador, então o retry da fila
  // não gera um segundo Operador para o mesmo turno.
  try {
    const { deduped } = await enqueueJob(pool, tenantId, {
      kind: 'operator_turn',
      leadId,
      sourceEventId: job.id,
      payload: {
        conversation_id: input.conversationId,
        origin_job_id: job.id,
        agent_id: agentConfig?.agentId ?? null,
      },
    });
    runLog.info('turno do operador enfileirado', { deduped });
  } catch (err) {
    runLog.error('turno do operador NÃO foi enfileirado (o turno segue)', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  const mudanca = diffCheckpoint(
    checkpointAnterior
      ? {
          commitments: (checkpointAnterior.commitments ?? []) as string[],
          objections: (checkpointAnterior.objections ?? []) as string[],
          next_action: checkpointAnterior.next_action ?? null,
          rolling_summary: checkpointAnterior.rolling_summary ?? null,
        }
      : null,
    content,
  );

  if (mudanca.emit) {
    try {
      const r = await emitAgentActivityForContact({
        pool,
        organizationId: tenantId,
        contactId: leadId,
        type: "ai_turn",
        sourceModule: "agent",
        sourceId: job.id,
        // O lastro é a chamada de modelo que PRODUZIU este checkpoint
        // (llm_calls.id). Sem ele a linha entraria como 'system' e perderia a
        // autoria justamente no evento mais "de IA" que existe.
        ...(closing.callId ? { evidence: { llm_call_ids: [closing.callId] } } : {}),
        ...(agentConfig?.agentId ? { agentId: agentConfig.agentId } : {}),
        reason: mudanca.reason,
        payload: {
          added_commitments: mudanca.addedCommitments,
          added_objections: mudanca.addedObjections,
          next_action_changed: mudanca.nextActionChanged,
        },
      });
      if (!r.routed) {
        runLog.info('checkpoint sem negócio para pendurar: registrado no event_log', {
          reason: r.reason,
        });
      }
    } catch (err) {
      // A timeline do turno não pode derrubar o turno.
      runLog.error('falha ao registrar atividade de checkpoint (segue)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // ── A NOTA DO NEGÓCIO ──────────────────────────────────────────────────────
  //
  // O turno acabou de mexer em TUDO que a fórmula lê: compromissos e objeções
  // (o checkpoint acima) e a qualificação BANT (`lead_state`, escrita pelo
  // update_lead_state do modelo). Recalcular aqui é recalcular no instante em
  // que os sinais mudaram — não há evento melhor.
  //
  // ⚠️ POR QUE ISTO EXISTE: `recalculaScoreDoLead` estava escrita, testada e
  // com constraint no banco exigindo o `reason` — e SEM UM ÚNICO CHAMADOR no
  // repositório inteiro. Nenhuma nota jamais foi calculada. O modo de falha era
  // mudo: o card simplesmente não mostrava número, e "não tem nota ainda" é
  // indistinguível de "ninguém nunca calcula".
  //
  // Fora do `if (mudanca.emit)` DE PROPÓSITO: o BANT muda em turnos que não
  // mexem no checkpoint, e esses turnos também mudam a nota. Amarrar o cálculo
  // à emissão da atividade faria a nota envelhecer em silêncio — o mesmo
  // defeito, um andar acima.
  //
  // Falha aqui não derruba o turno: nota é derivado, e o próximo turno
  // recalcula. O que não pode é o cliente ficar sem resposta por causa dela.
  try {
    const alvo = await resolveActiveLeadForContact(
      (
        await pool.query<LeadCandidate>(
          `select l.id, l.organization_id, l.pipeline_id, l.status,
                  l.last_activity_at, l.created_at
             from crm_leads l
            where l.organization_id = $1 and l.contact_id = $2`,
          [tenantId, leadId],
        )
      ).rows,
    );
    if (alvo.routed) {
      const r = await recalculaScoreDoLead(pool, tenantId, alvo.leadId);
      runLog.info('score do negócio recalculado', {
        lead_id: alvo.leadId,
        gravou: r.gravou,
        ...(r.motivo !== undefined ? { motivo: r.motivo } : {}),
      });
    }
  } catch (err) {
    runLog.error('falha ao recalcular score (segue)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
  }

  // F3-11: divergência classificador×modelo. O classificador sugeriu um estágio; se o
  // modelo confirmou (via update_lead_state — a máquina F2-10) um estágio DIFERENTE, o
  // desacordo vira candidato ao golden set (fs em runtime — reuso do dir da F3-09). Sem
  // sugestão, sem confirmação, ou concordância ⇒ nenhum arquivo (zero divergência).
  if (
    deps.knobs.goldenCandidatesDir !== undefined &&
    stageSuggestion !== null &&
    confirmedStage !== null &&
    stageSuggestion !== confirmedStage
  ) {
    await recordStageDivergenceCandidate(
      deps.knobs.goldenCandidatesDir,
      {
        tenantId,
        leadId,
        jobId: job.id,
        signal: skillSignal,
        divergence: { suggested: stageSuggestion, confirmed: confirmedStage },
      },
      runLog,
    );
  }

  const blocked = outcomes.find((o) => o.kind === 'blocked');
  if (blocked !== undefined) {
    // veto permanente (regra dura nº 2): cancela o job e cacheia o opt-out —
    // depois do checkpoint (o artefato do turno fica registrado mesmo em veto).
    await applySendOutcome(
      pool,
      blocked,
      { jobId: job.id, workerId: ctx.workerId, tenantId, leadId },
      { queuedRetryDelayMs: deps.knobs.queuedRetryDelayMs },
    );
    throw new JobSettledError(
      'turno encerrado com veto do sink (is_blocked) — job cancelado em definitivo, checkpoint gravado',
    );
  }

  await mcpCleanup?.();

  runLog.info('turno do agente concluído', {
    kind: job.kind,
    messages_sent: outcomes.length,
    model: turn.model,
  });
}

/**
 * Handler de `inbound_turn` para o registry do daemon (main.ts): o lead mandou uma
 * mensagem. Ids de envio vêm do payload do drain (fonte confiável — F2-05); a
 * abertura é o ritual padrão, sem bloco temporal.
 */
export function createInboundTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const payload = inboundTurnPayloadSchema.parse(job.payload);
    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: payload.channel_session_id,
      conversationId: payload.conversation_id,
      buildOpening: ({ previous, leadState, context, notesIndexBlock, projeta, entregues }) =>
        buildOpeningMessage(previous, leadState, context, notesIndexBlock, projeta, entregues),
    });
  };
}
