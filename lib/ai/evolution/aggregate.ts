/**
 * Agregador puro do Painel de Evolução (Fase 4 do épico do Harness).
 *
 * Recebe linhas cruas das seis fontes que as fases 0-3 depositaram e devolve o
 * payload que a tela consome. Sem efeito colateral, sem acesso a banco — a
 * rota busca, isto raciocina, e o teste não precisa de Postgres.
 *
 * A doutrina do sistema vivo pede que TODO número leve a uma ação. Por isso o
 * payload separa `activity` (o que aconteceu) de `gaps` (o que está travando):
 * o segundo bloco é o que o dono do negócio pode ir consertar hoje.
 */
import { daysBetween, toUtcDay } from '@/lib/ai/usage/aggregate';
import { LEAD_STAGES } from '@/lib/agent-engine/agent/lead-state';
import { detectarAssuntoDeAssistencia } from '@/lib/agent-engine/guardrails/lexico-assistencia';
import { MOTIVO_DE_RECUSA, type MotivoDeRecusa } from '@/lib/ai/knowledge/motivo-de-recusa';

// Reexportado porque o vocabulário nasceu aqui e a tela já o importava daqui. Ele MUDOU DE
// CASA (`lib/ai/knowledge/motivo-de-recusa.ts`) porque quem o EMITE é o agent-engine, e uma
// aresta do motor para o painel de relatório é dependência ao contrário — o dia em que o
// painel for reescrito, ela levaria a busca junto.
export { MOTIVO_DE_RECUSA, type MotivoDeRecusa };


/**
 * ⚠️ A PERGUNTA REAL NÃO SAI DA TELEMETRIA, E ISSO NÃO É DETALHE.
 *
 * FR-028 exige "ao menos uma pergunta real de exemplo". A migration 0086 declara, com todas
 * as letras, que `knowledge_searches` **não grava o texto da pergunta** — telemetria de
 * retenção longa não carrega conteúdo de conversa (mesmo contrato de `ai_router_decisions`
 * e de `knowledge_divergences.subject`). Então o exemplo vem da ÚNICA fonte que legitimamente
 * o tem: o aviso da Central (`agent_inbox_items`, kind `assistance_without_grounding`), que
 * é do próprio tenant, tem dono, tem tratativa e morre com o contato na anonimização.
 *
 * O formato do corpo é escrito por `lib/agent-engine/agent/escalar-sem-lastro.ts`; aqui é
 * onde ele é LIDO. Mudar lá sem mudar aqui faz o agrupamento silenciosamente cair todo em
 * "operadora não identificada" — por isso as duas regex vivem juntas, num lugar só.
 */
const RE_PERGUNTA_DO_AVISO = /^O cliente perguntou:\s*"([\s\S]*?)"\s*$/m;
const RE_OPERADORA_DO_AVISO = /^Operadora:\s*(.+)$/m;

export function perguntaDoAviso(body: string | null): string | null {
  if (!body) return null;
  return RE_PERGUNTA_DO_AVISO.exec(body)?.[1]?.trim() || null;
}

/** `null` quando o aviso não identificou a operadora — nunca um rótulo inventado. */
export function operadoraDoAviso(body: string | null): string | null {
  if (!body) return null;
  const bruto = RE_OPERADORA_DO_AVISO.exec(body)?.[1]?.trim();
  if (!bruto || bruto.toLowerCase() === 'não identificada') return null;
  return bruto;
}

export interface EvolutionInput {
  range: { from: Date; to: Date };
  memoryEntries: Array<{ created_at: string; title: string }>;
  proposalsApplied: Array<{ applied_at: string; type: string; content: string }>;
  /**
   * `skill_pointers` NÃO tem `created_at` — só `updated_at`, e ele é exatamente o
   * momento em que o ponteiro se moveu, isto é, quando a skill foi instalada ou
   * atualizada. É o que a spec chama de "skills instaladas/atualizadas".
   */
  skillInstalls: Array<{ updated_at: string; name: string }>;
  skillActivations: Array<{ created_at: string; skill_name: string }>;
  routerDecisions: Array<{ created_at: string; outcome: string; intent_name: string | null }>;
  knowledgeSearches: Array<{
    created_at: string;
    hits: number;
    top_score: number | null;
    threshold: number;
    /**
     * Em qual operadora a lacuna aconteceu (migration 0126).
     *
     * **Ausente ou nulo nas linhas gravadas antes dela**, e a leitura tolera os dois
     * formatos de propósito: instância única não tem versão de escape, e um painel que só
     * soubesse ler o formato novo mostraria zero lacuna durante toda a janela em que a
     * telemetria antiga ainda domina a tabela.
     */
    scope_id?: string | null;
    /** Nome como o corretor a vê. A rota resolve; o agregador não consulta nada. */
    scope_name?: string | null;
    /** Vocabulário de `MOTIVO_DE_RECUSA`. Nulo = linha anterior à 0126. */
    refusal_reason?: string | null;
  }>;
  /**
   * As recusas por falta de lastro como o corretor as recebe: os avisos da Central
   * (`agent_inbox_items`, kind `assistance_without_grounding`), com o corpo cru.
   *
   * Fonte SEPARADA da telemetria de busca, e não redundante com ela: `knowledgeSearches`
   * responde "quantas buscas não ancoraram, e por quê"; isto responde "o que o cliente
   * perguntou", que é a metade de FR-028 que nenhuma coluna de telemetria pode responder
   * sem quebrar o contrato de PII da 0086. Uma busca vazia nem sempre vira recusa (o modelo
   * pode não ter feito afirmação de assistência), então os dois números não batem — e não
   * deveriam.
   */
  knowledgeRefusals: Array<{ created_at: string; body: string | null }>;
  /**
   * Divergências entre camadas ainda abertas (spec 002, FR-035 · T081).
   *
   * ⚠️ **Não é recortado pela janela do relatório, e isso é deliberado.** As outras fontes
   * respondem "o que aconteceu entre tal e tal dia"; esta responde "o que está errado
   * AGORA". Uma divergência aberta continua produzindo resposta contraditória hoje, mesmo
   * que o desempate que a revelou tenha sido no mês passado — sumir da tela porque o
   * usuário mudou o período seria esconder problema que ninguém resolveu.
   */
  knowledgeDivergences: Array<{
    winner_title: string;
    loser_title: string;
    scope_name: string | null;
    subject: string;
    occurrences: number;
  }>;
  stageTransitions: Array<{ created_at: string; to_stage: string }>;
  costCents: number;
  inboundCount: number;
  handoffCount: number;
  pipelines: Array<{ name: string; hints: Array<string | null> }>;
}

export interface TimelineItem {
  day: string;
  kind: 'memory' | 'proposal' | 'skill';
  title: string;
}

export interface EvolutionPayload {
  range: { from: string; to: string };
  learned: {
    memory_entries: number;
    proposals_applied: number;
    skills_installed: number;
    timeline: TimelineItem[];
  };
  activity: {
    series: {
      skill_activations: Array<{ day: string; value: number }>;
      router_decisions: Array<{ day: string; value: number }>;
      knowledge_searches: Array<{ day: string; value: number }>;
    };
    by_skill: Record<string, number>;
    by_intent: Record<string, number>;
  };
  outcome: {
    stage_transitions: number;
    won: number;
    lost: number;
    handoff_rate: number;
    cost_cents: number;
    /**
     * Mensagens recebidas de clientes na janela — o denominador de `handoff_rate`,
     * e o único campo do payload que responde "houve atendimento?".
     *
     * `cost_cents` NÃO responde: `llm_calls` inclui propósitos que não são
     * atendimento na janela — `connection_test` (script de ops) e os do flywheel,
     * cujo cron julga turnos PASSADOS e carimba o custo no dia em que rodou. Um
     * período sem nenhum atendimento teria custo > 0 e a tela concluiria que houve.
     */
    messages_received: number;
  };
  gaps: {
    unmapped_agent_steps: Array<{ pipeline_name: string; steps: string[] }>;
    /**
     * Quantos funis foram EXAMINADOS para produzir `unmapped_agent_steps`.
     * Sem isto, lista vazia é ambígua: pode ser "todo passo tem etapa" ou
     * "não existe funil nenhum" — e a segunda é o estado de instalação fresca
     * (não há provisionamento de pipeline padrão no install). A tela usaria a
     * ausência de lacuna como elogio a funis que não existem.
     */
    pipelines_evaluated: number;
    knowledge_near_misses: number;
    knowledge_empty: number;
    /**
     * Buscas que não aconteceram — embed ou banco fora do ar (`busca_indisponivel`).
     *
     * FICA FORA de `knowledge_empty` de propósito. Somadas ali, elas diriam ao corretor
     * "seus materiais não responderam" sobre uma pergunta que nunca chegou a ser procurada,
     * e o mandariam escrever material para consertar uma queda de infraestrutura. É o
     * conselho errado com cara de diagnóstico — e a única lacuna desta tela cujo dono não é
     * o usuário.
     */
    knowledge_unavailable: number;
    /**
     * A mesma leitura, POR OPERADORA (FR-029 · migration 0126).
     *
     * Os motivos entram em colunas separadas, nunca somados: "não achei nada" pede material
     * novo e "achei quase" pede reescrever o que já existe. Colapsá-los num número só de
     * lacuna faria o corretor escrever de novo o texto que já tinha — e continuar sem
     * resposta, porque o problema era a palavra, não o conteúdo.
     */
    knowledge_by_scope: Array<{
      scope_name: string | null;
      sem_material: number;
      quase_no_limiar: number;
      busca_indisponivel: number;
    }>;
    /**
     * As recusas agrupadas por operadora E por assunto, com contagem e a pergunta real
     * (FR-028 · US5, cenário 1).
     *
     * O assunto é a categoria FECHADA do léxico de assistência, calculada aqui a partir do
     * texto do aviso (DIRC: Calcular) — não há coluna nova em lugar nenhum. `''` é valor
     * legítimo: pergunta que o léxico não classifica continua sendo lacuna, e engoli-la
     * perderia justamente o assunto que ninguém previu.
     */
    knowledge_refusals: Array<{
      scope_name: string | null;
      subject: string;
      count: number;
      /** Como o cliente escreveu. Vem do aviso da Central, nunca da telemetria. */
      example_question: string | null;
      last_seen_at: string;
    }>;
    /**
     * FR-035, segunda metade: onde o material do corretor contradiz o do catálogo.
     *
     * Vem como LISTA, não contagem, porque o conserto exige saber QUAIS dois textos
     * discordam — "você tem 3 divergências" não diz o que abrir. É a diferença entre um
     * número e uma ação, que é o que a doutrina do sistema vivo cobra de todo dado
     * nesta tela.
     */
    knowledge_divergences: Array<{
      winner_title: string;
      loser_title: string;
      scope_name: string | null;
      subject: string;
      occurrences: number;
    }>;
    router_no_match: number;
    router_failed: number;
  };
}

/** Série diária densa: dia sem evento vale 0, nunca some do eixo. */
function serie(days: string[], rows: Array<{ created_at: string }>): Array<{ day: string; value: number }> {
  const contagem = new Map<string, number>();
  for (const r of rows) {
    const d = r.created_at.slice(0, 10);
    contagem.set(d, (contagem.get(d) ?? 0) + 1);
  }
  return days.map((day) => ({ day, value: contagem.get(day) ?? 0 }));
}

function contaPor<T>(rows: T[], chave: (r: T) => string | null): Record<string, number> {
  // ⚠️ SEM PROTÓTIPO, de propósito. As chaves aqui são nome de skill e nome de
  // intenção — texto do cliente (skill vem de .zip enviado; intenção é digitada
  // na config do roteador), e `skill_pointers.name` só exige `length > 0`. Num
  // objeto literal, `out['__proto__'] = (out['__proto__'] ?? 0) + 1` NÃO cria
  // propriedade própria: o setter de `__proto__` descarta o não-objeto e a
  // contagem some sem erro nenhum. `Object.create(null)` faz a chave virar dado
  // comum. Medido em node, não deduzido.
  const out: Record<string, number> = Object.create(null);
  for (const r of rows) {
    const k = chave(r);
    if (k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Quanto abaixo do limiar ainda conta como "quase acertou".
 *
 * É a MESMA margem que `lib/agent-engine/agent/search-knowledge.ts` usa para medir o
 * quase-acerto e que `app/api/v1/catalog/gaps/route.ts` usa do lado do curador. Duas
 * definições do mesmo termo fariam as três telas discordarem sobre o mesmo banco.
 */
const PERTO = 0.1;

type BuscaCrua = EvolutionInput['knowledgeSearches'][number];

/**
 * "Quase acertou" é a busca que NÃO trouxe nada e cujo melhor candidato ficou logo abaixo
 * do limiar. Separa "a base não tem isso" de "a base tem e o corte está apertado demais" —
 * dois problemas com consertos opostos.
 */
function quaseNoLimiar(k: BuscaCrua): boolean {
  // ⚠️ COERÇÃO OBRIGATÓRIA. `top_score` e `threshold` são `numeric` no Postgres, e
  // `numeric` não tem parser default no node-postgres — chega como STRING ('0.910667'). A
  // comparação string×string não lança e não erra sempre: `'0.144' >= '0.62'` dá false pelo
  // motivo errado, e `'0.9' >= '0.72'` dá true também pelo motivo errado. O tipo declarado
  // é `number`, então o TypeScript não pega — é o pior formato de defeito, o que acerta por
  // acaso. Medido na prova real da Task 2, contra o banco.
  // `?? NaN` porque `Number(null)` é **0**, não NaN. Sem ele, um limiar ausente vira corte
  // zero e TODA busca vazia conta como "quase acertou" — a tela diria ao dono do negócio
  // "seu corte está apertado demais" sobre uma base que simplesmente não tem o conteúdo.
  // O `not null` da 0086 torna isso inalcançável pela produção; o guarda existe pela
  // assimetria do custo, não pela probabilidade.
  const nota = Number(k.top_score ?? NaN);
  const limiar = Number(k.threshold ?? NaN);
  // `nota < limiar` é a metade "abaixo do limiar" da regra. Hoje o emissor garante
  // `hits === 0 ⇒ top_score < threshold`, mas essa é invariante de OUTRO arquivo: sem os 4
  // caracteres, este código depende dela em silêncio e passa a contar acerto como
  // quase-acerto no dia em que ela mudar.
  return Number.isFinite(nota) && Number.isFinite(limiar) && nota < limiar && nota >= limiar - PERTO;
}

/**
 * Por que esta busca não ancorou nada. `null` = ancorou, não é lacuna.
 *
 * Três origens, nesta ordem, e a ordem é a regra:
 *  1. **o motivo declarado pelo emissor**, quando ele está no vocabulário. É o único que
 *     sabe de `busca_indisponivel` — nenhuma comparação de nota distingue "não achei" de
 *     "não procurei";
 *  2. **derivação pelas notas**, quando o motivo é NULO. São as linhas anteriores à 0126, e
 *     elas continuam no banco: instância única não tem versão de escape, e um leitor que só
 *     entendesse o formato novo mostraria zero lacuna sobre uma tabela cheia;
 *  3. **`'outro'`**, quando o motivo existe mas não é conhecido. Vocabulário ABERTO produz
 *     valor novo por construção — e adivinhar que ele é "falta material" é como a tela
 *     mandaria escrever texto para consertar, por exemplo, um escopo desligado, que se
 *     resolve com um clique. Ele conta como lacuna e fica FORA do balde acionável.
 */
function motivoDaBusca(k: BuscaCrua): MotivoDeRecusa | 'outro' | null {
  if (k.hits > 0) return null;
  const declarado = k.refusal_reason ?? null;
  if (declarado === null) {
    return quaseNoLimiar(k) ? MOTIVO_DE_RECUSA.QUASE_NO_LIMIAR : MOTIVO_DE_RECUSA.SEM_MATERIAL;
  }
  if (
    declarado === MOTIVO_DE_RECUSA.SEM_MATERIAL ||
    declarado === MOTIVO_DE_RECUSA.QUASE_NO_LIMIAR ||
    declarado === MOTIVO_DE_RECUSA.BUSCA_INDISPONIVEL
  ) {
    return declarado;
  }
  return 'outro';
}

interface BaldeDeEscopo {
  scope_name: string | null;
  sem_material: number;
  quase_no_limiar: number;
  busca_indisponivel: number;
}

function classificaBuscas(buscas: readonly BuscaCrua[]): {
  nearMisses: number;
  empty: number;
  indisponiveis: number;
  porEscopo: BaldeDeEscopo[];
} {
  let nearMisses = 0;
  let empty = 0;
  let indisponiveis = 0;
  // `Map` e não objeto literal: a chave é id de escopo, e o balde sem escopo usa `''` —
  // nenhum dos dois colide com protótipo, mas o mapa deixa a intenção explícita e sobrevive
  // a uma chave vinda de texto no futuro.
  const porEscopo = new Map<string, BaldeDeEscopo>();

  for (const k of buscas) {
    const motivo = motivoDaBusca(k);
    if (motivo === null) continue;

    if (motivo === MOTIVO_DE_RECUSA.BUSCA_INDISPONIVEL) indisponiveis += 1;
    else empty += 1;
    if (motivo === MOTIVO_DE_RECUSA.QUASE_NO_LIMIAR) nearMisses += 1;
    // Motivo que esta versão não conhece entra no total e para por aqui: ver o docblock de
    // `motivoDaBusca`. Aparecer no número e não aparecer no conselho é o comportamento
    // certo — some do conselho, não do relatório.
    if (motivo === 'outro') continue;

    const chave = k.scope_id ?? '';
    const balde = porEscopo.get(chave) ?? {
      scope_name: k.scope_name ?? null,
      sem_material: 0,
      quase_no_limiar: 0,
      busca_indisponivel: 0,
    };
    balde[motivo] += 1;
    // O nome pode faltar numa linha e existir na seguinte (escopo apagado depois, `set
    // null` da 0126). Preencher quando aparecer evita que a ordem das linhas decida se a
    // operadora tem nome na tela.
    balde.scope_name ??= k.scope_name ?? null;
    porEscopo.set(chave, balde);
  }

  return {
    nearMisses,
    empty,
    indisponiveis,
    // Do maior problema para o menor. Empate desfeito pelo nome para a ordem não depender
    // da ordem de chegada das linhas — tela que troca de ordem a cada recarga parece bug.
    porEscopo: [...porEscopo.values()].sort((a, b) => {
      const total = (x: BaldeDeEscopo) => x.sem_material + x.quase_no_limiar + x.busca_indisponivel;
      return total(b) - total(a) || (a.scope_name ?? '').localeCompare(b.scope_name ?? '');
    }),
  };
}

interface BaldeDeRecusa {
  scope_name: string | null;
  subject: string;
  count: number;
  example_question: string | null;
  last_seen_at: string;
}

/**
 * As recusas da Central agrupadas por operadora e por assunto (FR-028).
 *
 * O exemplo guardado é o da recusa MAIS RECENTE do balde, e a escolha é feita comparando
 * datas em vez de confiar na ordem de chegada: o agregador é puro, e função pura cujo
 * resultado depende da ordem em que a rota resolveu ler é uma armadilha para o próximo que
 * mexer na consulta.
 */
function agrupaRecusas(avisos: readonly { created_at: string; body: string | null }[]): BaldeDeRecusa[] {
  const baldes = new Map<string, BaldeDeRecusa>();

  for (const aviso of avisos) {
    const pergunta = perguntaDoAviso(aviso.body);
    const escopo = operadoraDoAviso(aviso.body);
    // Mesma convenção de `assuntoDaDivergencia`: a primeira categoria do léxico, e `''`
    // quando nada casa. Sem pergunta legível não há o que classificar — e o balde continua
    // existindo, porque a recusa aconteceu.
    const subject = pergunta ? (detectarAssuntoDeAssistencia(pergunta).categorias[0] ?? '') : '';
    // Separador que NENHUM dos dois lados pode conter: o assunto vem de um léxico
    // fechado, mas o nome da operadora é texto do corretor. Com um separador comum,
    // uma operadora chamada "Amil|cobranca" cairia no mesmo balde de (Amil, cobrança) —
    // duas lacunas somadas numa, e a segunda desaparecendo da tela.
    const chave = `${escopo ?? ''}\u0000${subject}`;

    const balde = baldes.get(chave);
    if (!balde) {
      baldes.set(chave, {
        scope_name: escopo,
        subject,
        count: 1,
        example_question: pergunta,
        last_seen_at: aviso.created_at,
      });
      continue;
    }
    balde.count += 1;
    if (Date.parse(aviso.created_at) >= Date.parse(balde.last_seen_at)) {
      balde.last_seen_at = aviso.created_at;
      if (pergunta) balde.example_question = pergunta;
    } else {
      balde.example_question ??= pergunta;
    }
  }

  return [...baldes.values()].sort(
    (a, b) =>
      b.count - a.count ||
      Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at) ||
      (a.scope_name ?? '').localeCompare(b.scope_name ?? '') ||
      a.subject.localeCompare(b.subject),
  );
}

export function aggregateEvolution(input: EvolutionInput): EvolutionPayload {
  const days = daysBetween(input.range.from, input.range.to);

  // Ordena pelo timestamp CRU e só depois trunca para o dia. Ordenar por `day`
  // desempata pelo bloco de origem (memória → proposta → skill), não pela hora:
  // uma proposta aplicada às 23h apareceria ABAIXO de uma skill instalada às 8h
  // do mesmo dia. Como o payload descarta a hora, a tela não teria como
  // consertar — a ordem tem que nascer certa aqui. `Date.parse` em vez de
  // comparação de texto porque as três fontes podem serializar o fuso diferente
  // ('…Z' vs '…+00:00'), e aí a ordem lexicográfica mente.
  const timeline: TimelineItem[] = [
    ...input.memoryEntries.map((m) => ({ at: m.created_at, kind: 'memory' as const, title: m.title })),
    ...input.proposalsApplied.map((p) => ({
      at: p.applied_at,
      kind: 'proposal' as const,
      title: p.content.slice(0, 120),
    })),
    ...input.skillInstalls.map((s) => ({ at: s.updated_at, kind: 'skill' as const, title: s.name })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map(({ at, kind, title }) => ({ day: at.slice(0, 10), kind, title }));

  const {
    nearMisses,
    empty,
    indisponiveis,
    porEscopo: buscasPorEscopo,
  } = classificaBuscas(input.knowledgeSearches);
  const recusas = agrupaRecusas(input.knowledgeRefusals);

  const unmapped = input.pipelines
    .map((p) => {
      const declarados = new Set(p.hints.filter((h): h is string => h !== null));
      return {
        pipeline_name: p.name,
        steps: LEAD_STAGES.filter((s) => !declarados.has(s)),
      };
    })
    .filter((p) => p.steps.length > 0);

  return {
    range: { from: toUtcDay(input.range.from), to: toUtcDay(input.range.to) },
    learned: {
      memory_entries: input.memoryEntries.length,
      proposals_applied: input.proposalsApplied.length,
      skills_installed: input.skillInstalls.length,
      timeline,
    },
    activity: {
      series: {
        skill_activations: serie(days, input.skillActivations),
        router_decisions: serie(days, input.routerDecisions),
        knowledge_searches: serie(days, input.knowledgeSearches),
      },
      by_skill: contaPor(input.skillActivations, (r) => r.skill_name),
      by_intent: contaPor(
        // Só estes três outcomes carregam `intent_name` não-nulo (ver
        // `resolve-turn-agent.ts`); os demais já cairiam no filtro de null.
        // Nomear a lista deixa a regra explícita em vez de acidental.
        input.routerDecisions.filter((r) => r.outcome === 'classified' || r.outcome === 'sticky' || r.outcome === 'reclassified'),
        (r) => r.intent_name,
      ),
    },
    outcome: {
      stage_transitions: input.stageTransitions.length,
      won: input.stageTransitions.filter((t) => t.to_stage === 'won').length,
      lost: input.stageTransitions.filter((t) => t.to_stage === 'lost').length,
      handoff_rate: input.inboundCount > 0 ? input.handoffCount / input.inboundCount : 0,
      cost_cents: input.costCents,
      messages_received: input.inboundCount,
    },
    gaps: {
      unmapped_agent_steps: unmapped,
      pipelines_evaluated: input.pipelines.length,
      knowledge_near_misses: nearMisses,
      knowledge_empty: empty,
      knowledge_unavailable: indisponiveis,
      knowledge_by_scope: buscasPorEscopo,
      knowledge_refusals: recusas,
      knowledge_divergences: input.knowledgeDivergences,
      router_no_match: input.routerDecisions.filter((r) => r.outcome === 'no_match').length,
      router_failed: input.routerDecisions.filter((r) => r.outcome === 'classifier_failed').length,
    },
  };
}
