/**
 * Veto de lastro — spec 002 (RAG por operadora), fatia F1.
 *
 * Duas peças, um arquivo: a **classificação** determinística de "afirmação de
 * assistência" e o **gate** que a usa para barrar o envio sem âncora.
 *
 * ## Por que existe
 *
 * Hoje a única defesa contra o agente inventar procedimento de operadora é texto de
 * prompt, e a citação é carimbada por um `update` DEPOIS do envio cujo erro "só loga"
 * (`inbound-turn.ts`). Ou seja: a mensagem já chegou ao cliente quando a falha aparece.
 * FR-009 inverte isso — sem âncora, a mensagem não sai. FR-010 exige que a verificação
 * seja do sistema: instrução de prompt não satisfaz o requisito.
 *
 * ## Por que nasce em arquivo próprio
 *
 * `inbound-turn.ts` tem 1789 linhas e é o hot path do produto (`docs/current-state.md`
 * §5.5). A classificação é lógica pura, testável sem banco e sem modelo — colocá-la lá
 * dentro custaria a testabilidade e engordaria o arquivo que menos pode crescer.
 *
 * ## O viés, declarado (A-03)
 *
 * Na dúvida, é assistência. Classificar conversão como assistência custa uma recusa
 * desnecessária, visível na Central e corrigível. O contrário entrega ao cliente uma
 * informação errada sobre carência, cobertura ou reembolso, e ninguém fica sabendo.
 */

import { detectarAssuntoDeAssistencia, type CategoriaAssistencia } from './lexico-assistencia';
import type { Gate, GateVerdict } from './before-send';

/**
 * Um trecho que fundamenta uma afirmação. É a **prova** de que a frase veio do acervo e
 * não do modelo.
 *
 * `layer` já nasce aqui, na F1, embora só exista a camada do tenant hoje: FR-039 vai
 * exigir que a origem diga de qual camada o trecho veio, e um campo acrescentado depois
 * significa migrar as âncoras já gravadas. Custa uma linha agora.
 */
export interface Grounding {
  readonly chunk_id: string;
  /** `ai_knowledge_sources.id` (camada do tenant) ou `catalog_materials.id` (F2). */
  readonly material_id: string | null;
  readonly layer: 'tenant' | 'catalog';
  readonly similarity: number;
  /** Título, escopo e data de atualização — a cópia histórica que a tela mostra (FR-023). */
  readonly source_ref?: Record<string, unknown>;
}

export interface ClassificacaoDeAssistencia {
  readonly isAssistanceClaim: boolean;
  readonly categorias: readonly CategoriaAssistencia[];
  /** Por que decidiu assim — vai ao trace, ajuda a ajustar o léxico sobre medição. */
  readonly motivo: 'sem_assunto' | 'somente_pergunta' | 'afirmacao';
}

/**
 * Divide em frases preservando o terminador. Quebra de linha conta como fim de frase:
 * mensagem de WhatsApp costuma listar passos em linhas soltas, sem ponto final, e cada
 * passo é uma afirmação independente.
 *
 * **Exportada** porque FR-018 (veto por AFIRMAÇÃO, não por mensagem) precisa da mesma
 * régua: `lastro-por-escopo.ts` decide frase a frase o que pode sair, e duas definições de
 * "frase" fariam a classificação e a partição discordarem sobre o mesmo texto — a
 * divergência apareceria como afirmação recusada que o gate deixaria passar, ou o inverso.
 */
export function frasesDeTexto(texto: string): string[] {
  return texto
    .split(/(?<=[.!?])\s+|\n+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * O agente está **afirmando** algo de assistência, ou apenas perguntando/conversando?
 *
 * Regra, nesta ordem:
 *  1. Nenhum termo de assistência no texto → não é afirmação de assistência. O discurso
 *     de conversão passa inteiro por aqui (FR-020).
 *  2. Termo presente, mas **toda** frase que o contém é pergunta → não é afirmação.
 *     "De qual operadora é o seu plano?" e "Você já tentou a segunda via pelo app?" são
 *     perguntas; barrá-las tornaria impossível ao agente descobrir o escopo do cliente.
 *  3. Qualquer outra combinação → é afirmação. Inclui frase sem pontuação final, que é a
 *     forma mais comum de escrever procedimento em mensagem curta.
 */
export function classificarAfirmacaoDeAssistencia(texto: string): ClassificacaoDeAssistencia {
  const achado = detectarAssuntoDeAssistencia(texto);
  if (!achado.achou) {
    return { isAssistanceClaim: false, categorias: [], motivo: 'sem_assunto' };
  }

  const comAssunto = frasesDeTexto(texto).filter((f) => detectarAssuntoDeAssistencia(f).achou);
  // `comAssunto` vazio só acontece se o termo cruzar fronteira de frase — e nesse caso
  // o texto contém o assunto sem que nenhuma frase isolada o contenha. Bias: afirmação.
  const todasPerguntas = comAssunto.length > 0 && comAssunto.every((f) => f.endsWith('?'));

  if (todasPerguntas) {
    return { isAssistanceClaim: false, categorias: achado.categorias, motivo: 'somente_pergunta' };
  }
  return { isAssistanceClaim: true, categorias: achado.categorias, motivo: 'afirmacao' };
}

/** O que a configuração do agente diz sobre exigir lastro. */
export interface ExigenciaDeLastro {
  readonly enforce: boolean;
  /** Piso de âncoras. 1 quando o guardrail não declara — nunca 0. */
  readonly minCitations: number;
}

/**
 * Lê o guardrail `rag_must_hit` da configuração do agente (FR-015).
 *
 * **Este é o conserto de um defeito real, não uma fiação nova.** O guardrail existe em
 * `lib/ai/guardrails-schema.ts`, é editável na tela, é validado por Zod e é salvo no
 * banco — e nenhum runtime o avaliava. Uma opção de segurança que a interface oferece e
 * o produto ignora é a definição de "a configuração mente" (SC-012), e é o defeito que
 * originou o Princípio XI da constituição.
 *
 * Recebe `unknown` de propósito: a origem é `ai_agents.guardrails`, uma coluna `jsonb`.
 * Confiar no formato aqui seria confiar num dado que qualquer migration antiga pode ter
 * deixado torto — e o modo de falha certo é "não arma", nunca "explode no envio".
 */
export function resolverExigenciaDeLastro(guardrails: unknown): ExigenciaDeLastro {
  if (!Array.isArray(guardrails)) return { enforce: false, minCitations: 1 };

  let enforce = false;
  let minCitations = 1;
  for (const item of guardrails) {
    if (typeof item !== 'object' || item === null) continue;
    const g = item as { kind?: unknown; min_citations?: unknown };
    if (g.kind !== 'rag_must_hit') continue;
    enforce = true;
    // Vários `rag_must_hit` no array: vence o mais exigente. Somar ou pegar o último
    // faria a ordem do array virar regra de segurança, que é lugar nenhum para ela.
    if (typeof g.min_citations === 'number' && Number.isFinite(g.min_citations)) {
      minCitations = Math.max(minCitations, Math.floor(g.min_citations));
    }
  }
  return { enforce, minCitations: Math.max(1, minCitations) };
}

/**
 * Gate `assistance_grounding` — posição (2.5) de `BEFORE_SEND_GATES`, entre `lgpd` e
 * `pacing`.
 *
 * **Por que ali.** Depois dos vetos de conformidade irrevogáveis (stop, LGPD), que não
 * admitem negociação, e ANTES do anti-ban: não faz sentido consumir cota de envio,
 * throttle ou janela de spinning com um texto que vai ser barrado de qualquer forma.
 *
 * **Nasce DESARMADO** (`assistanceGroundingEnforced` ausente = no-op), no mesmo padrão
 * do `internalVocabularyGate` da v6 e pela mesma razão: no caminho do agente o veto volta
 * ao modelo como erro instrutivo e ele reescreve; no caminho determinístico (follow-up
 * por template) não há ninguém para ensinar, e um veto ali seria drop silencioso — o
 * cliente fica mudo, que é pior que o defeito que este gate veio corrigir.
 *
 * Quem arma: o caminho do agente, em `inbound-turn.ts`, quando o agente tem a exigência
 * de lastro ligada (`rag_must_hit`).
 */
export const assistanceGroundingGate: Gate = {
  name: 'assistance_grounding',
  evaluate: (ctx): GateVerdict => {
    // `skipped: 'disarmed'`, nunca `pass` silencioso: o trace precisa distinguir
    // "ninguém armou este gate" de "armado, avaliou e liberou". É sobre essa medição que
    // o léxico vai ser calibrado, e um `pass` apagaria a diferença (T030 / FR-015).
    if (ctx.assistanceGroundingEnforced !== true) return { pass: true, skipped: 'disarmed' };

    // A classificação chega pronta do ctx quando o chamador já a fez (o inbound-turn
    // precisa dela para outras decisões do turno); senão é feita aqui. Nos dois casos é
    // a MESMA função — não existe segunda regra.
    const isClaim = ctx.isAssistanceClaim ?? classificarAfirmacaoDeAssistencia(ctx.body).isAssistanceClaim;
    if (!isClaim) return { pass: true };

    const ancoras = ctx.groundings ?? [];
    // `minCitations` vem do guardrail `rag_must_hit` da tela (FR-015). Ausente = 1: uma
    // âncora é o piso do requisito, não uma preferência configurável para baixo.
    const piso = Math.max(1, ctx.minCitations ?? 1);
    if (ancoras.length >= piso) return { pass: true };

    return {
      pass: false,
      code: 'assistencia_sem_lastro',
      reason:
        'esta mensagem afirma um procedimento da operadora sem nenhum trecho do acervo que a sustente. ' +
        'Não invente o procedimento e não responda "com o que você já sabe": diga ao cliente, em ' +
        'linguagem simples, que a informação será confirmada por uma pessoa, e encerre o turno.',
      // Contagens e categorias fechadas. O corpo NUNCA entra no detail — é o texto que o
      // modelo escreveu sobre um cliente, e detail é persistido em before_send_traces.
      detail: { ancoras: ancoras.length, piso },
    };
  },
};
