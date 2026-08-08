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
  /**
   * Assuntos DO TRECHO, pela mesma régua que classifica a afirmação (T138).
   *
   * **Obrigatório de propósito.** Opcional, ele seria esquecido em algum produtor novo e
   * o buraco voltaria em silêncio — com a suíte verde, que é como este defeito nasceu.
   * Obrigatório, o compilador aponta cada lugar que constrói uma âncora.
   */
  readonly categorias: readonly CategoriaAssistencia[];
  /**
   * O trecho veio de conhecimento gerado AUTOMATICAMENTE a partir de conversas (FR-040)?
   *
   * **Obrigatório pelo mesmo motivo de `categorias`**: opcional, algum produtor novo o
   * esqueceria, o `undefined` seria lido como "não" e o buraco voltaria em silêncio.
   */
  readonly aprendidoDeConversa: boolean;
  /** Título, escopo e data de atualização — a cópia histórica que a tela mostra (FR-023). */
  readonly source_ref?: Record<string, unknown>;
}

/**
 * Os `source_type` que significam "isto foi extraído de conversa, sozinho".
 *
 * Constante compartilhada, nunca literal espalhada: o CHECK do banco aceita as duas grafias
 * (`conversations` e `conversation`), e uma lista escrita à mão em cada lugar erraria uma
 * delas — a falha seria o gate deixando passar exatamente o que FR-040 proíbe.
 */
const ORIGENS_APRENDIDAS = new Set(['conversations', 'conversation']);

/**
 * A âncora nasceu de aprendizado automático? (FR-040)
 *
 * ═══ POR QUE ISTO É UMA REGRA E NÃO UMA PREFERÊNCIA ═══
 *
 * O acervo indexa conversas passadas. Isso é ótimo para tom, jeito de responder e as
 * dúvidas que os clientes realmente têm — e é veneno como fonte de fato de assistência:
 * o que um atendente humano disse sobre carência há oito meses vira "material", e o agente
 * o repete com a mesma cara de certeza que teria o manual da operadora. Um erro humano
 * pontual vira regra institucional, com citação para provar.
 *
 * O trecho continua entrando na busca e ajudando o modelo a escrever. O que ele não pode
 * é SUSTENTAR a afirmação — que é a diferença entre aprender a falar e aprender a mentir.
 */
export function ehAprendizadoDeConversa(sourceRef: Record<string, unknown> | undefined): boolean {
  const tipo = sourceRef?.source_type;
  return typeof tipo === 'string' && ORIGENS_APRENDIDAS.has(tipo);
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

    // FR-040 · T123: o que foi aprendido de conversa NÃO ancora afirmação de assistência.
    // O corte é aqui em cima, antes de qualquer contagem, e não num `if` lá embaixo: o que
    // não pode sustentar a afirmação também não pode ENGROSSAR o número que a libera.
    // Ver `ehAprendizadoDeConversa` para o porquê.
    const todasAsAncoras = ctx.groundings ?? [];
    const ancoras = todasAsAncoras.filter((a) => !a.aprendidoDeConversa);
    const descartadasPorOrigem = todasAsAncoras.length - ancoras.length;
    // `minCitations` vem do guardrail `rag_must_hit` da tela (FR-015). Ausente = 1: uma
    // âncora é o piso do requisito, não uma preferência configurável para baixo.
    const piso = Math.max(1, ctx.minCitations ?? 1);

    // ── Pertinência (T138): a âncora tem de falar DO QUE a afirmação diz ──────────────
    //
    // Contar âncora não basta, e isto foi MEDIDO, não temido: com embeddings reais no
    // limiar do produto (0.40), "como funciona o reembolso" ancorou em "Como consultar a
    // rede credenciada" com 0.460. Um texto de rede autorizava uma afirmação sobre
    // reembolso — e a resposta saía COM citação, parecendo mais confiável.
    //
    // Não se conserta no limiar: a âncora correta mais fraca medida foi 0.495, colada na
    // errada mais forte. Não há corte que as separe. Similaridade mede distância entre
    // vetores; o que falta é ASSUNTO, e o assunto já existe aqui — a mesma classificação
    // determinística que decide se a frase é afirmação de assistência.
    //
    // A régua é por FRASE, e não pela mensagem inteira, pelo mesmo motivo de FR-018: uma
    // frase ancorada não empresta lastro para a de baixo. "O reembolso sai em 30 dias. A
    // rede tem 40 hospitais." com âncora só de reembolso é meia mensagem inventada.
    const assistivas = frasesDeTexto(ctx.body)
      .map((f) => classificarAfirmacaoDeAssistencia(f))
      .filter((c) => c.isAssistanceClaim);

    const pertinente = (a: Grounding, cats: readonly CategoriaAssistencia[]): boolean =>
      a.categorias.some((c) => cats.includes(c));

    // Chamador afirmou que é assistência num corpo sem termo do léxico. Não há categoria
    // para comparar, e inventar uma seria pior que declarar que não avaliou: o gate volta
    // a contar, e o trace diz que a pertinência não foi julgada (T030 — o léxico é
    // calibrado sobre medição, e um `pass` mudo apagaria o caso).
    if (assistivas.length === 0) {
      if (ancoras.length >= piso) return { pass: true };
      return {
        pass: false,
        code: 'assistencia_sem_lastro',
        reason: RECUSA_SEM_LASTRO,
        detail: {
          ancoras: ancoras.length,
          piso,
          pertinencia: 'nao_avaliada',
          // Sem isto, uma recusa com citações na tela pareceria defeito do gate. É o
          // número que explica "havia âncora, mas era de conversa" (FR-040).
          descartadas_por_origem: descartadasPorOrigem,
        },
      };
    }

    const categorias = [...new Set(assistivas.flatMap((c) => c.categorias))];
    const pertinentes = ancoras.filter((a) => pertinente(a, categorias));
    const frasesSemAncora = assistivas.filter(
      (c) => !ancoras.some((a) => pertinente(a, c.categorias)),
    ).length;

    if (frasesSemAncora === 0 && pertinentes.length >= piso) return { pass: true };

    return {
      pass: false,
      code: 'assistencia_sem_lastro',
      reason: pertinentes.length === 0 && ancoras.length > 0 ? RECUSA_SEM_PERTINENCIA : RECUSA_SEM_LASTRO,
      // Contagens e categorias FECHADAS. O corpo e os termos casados NUNCA entram — o
      // detail é persistido em `before_send_traces`, e o corpo é texto sobre um cliente.
      detail: {
        ancoras: ancoras.length,
        pertinentes: pertinentes.length,
        piso,
        // Vocabulário fechado, seguro para o trace — os TERMOS casados nunca saem daqui.
        categorias: categorias.join(','),
        frases_sem_ancora: frasesSemAncora,
        descartadas_por_origem: descartadasPorOrigem,
      },
    };
  },
};

const RECUSA_SEM_LASTRO =
  'esta mensagem afirma um procedimento da operadora sem nenhum trecho do acervo que a sustente. ' +
  'Não invente o procedimento e não responda "com o que você já sabe": diga ao cliente, em ' +
  'linguagem simples, que a informação será confirmada por uma pessoa, e encerre o turno.';

const RECUSA_SEM_PERTINENCIA =
  'os trechos recuperados do acervo falam de OUTRO assunto que não o desta afirmação — eles não a ' +
  'sustentam, por mais parecidos que tenham parecido na busca. Não use trecho de um assunto para ' +
  'afirmar sobre outro: diga ao cliente, em linguagem simples, que a informação será confirmada ' +
  'por uma pessoa, e encerre o turno.';
