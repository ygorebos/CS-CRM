import { describe, expect, it } from 'vitest';

import { MOTIVO_DE_RECUSA, aggregateEvolution, type EvolutionInput } from './aggregate';

const range = { from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-03T00:00:00Z') };

function base(): EvolutionInput {
  return {
    range,
    memoryEntries: [],
    proposalsApplied: [],
    skillInstalls: [],
    skillActivations: [],
    routerDecisions: [],
    knowledgeSearches: [],
    knowledgeRefusals: [],
    knowledgeDivergences: [],
    stageTransitions: [],
    costCents: 0,
    inboundCount: 0,
    handoffCount: 0,
    pipelines: [],
  };
}

describe('aggregateEvolution', () => {
  it('monta a linha do tempo de aprendizado ordenada do mais recente para o mais antigo', () => {
    const p = aggregateEvolution({
      ...base(),
      memoryEntries: [{ created_at: '2026-07-01T10:00:00Z', title: 'Nunca prometer prazo' }],
      proposalsApplied: [{ applied_at: '2026-07-03T09:00:00Z', type: 'playbook_bullet', content: 'Confirmar por escrito' }],
      skillInstalls: [{ updated_at: '2026-07-02T08:00:00Z', name: 'objecao-preco' }],
    });

    expect(p.learned.memory_entries).toBe(1);
    expect(p.learned.proposals_applied).toBe(1);
    expect(p.learned.skills_installed).toBe(1);
    expect(p.learned.timeline.map((t) => t.kind)).toEqual(['proposal', 'skill', 'memory']);
    expect(p.learned.timeline[0]!.day).toBe('2026-07-03');
  });

  it('série diária cobre TODOS os dias do intervalo, inclusive os vazios', () => {
    const p = aggregateEvolution({
      ...base(),
      skillActivations: [{ created_at: '2026-07-02T12:00:00Z', skill_name: 'agendamento' }],
    });

    // Dia sem atividade tem que valer 0, não sumir: buraco no gráfico vira
    // "acabou o dado", zero vira "não aconteceu".
    expect(p.activity.series.skill_activations).toEqual([
      { day: '2026-07-01', value: 0 },
      { day: '2026-07-02', value: 1 },
      { day: '2026-07-03', value: 0 },
    ]);
    expect(p.activity.by_skill).toEqual({ agendamento: 1 });
  });

  it('conta como "quase acertou" só a busca sem hit cujo melhor candidato ficou ABAIXO do limiar', () => {
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        { created_at: '2026-07-01T10:00:00Z', hits: 0, top_score: 0.703, threshold: 0.72 }, // quase
        { created_at: '2026-07-01T11:00:00Z', hits: 0, top_score: 0.12, threshold: 0.72 },  // a base não tem
        { created_at: '2026-07-01T12:00:00Z', hits: 3, top_score: 0.91, threshold: 0.72 },  // achou
        { created_at: '2026-07-01T13:00:00Z', hits: 0, top_score: null, threshold: 0.72 },  // base vazia
      ],
    });

    expect(p.gaps.knowledge_near_misses).toBe(1);
    expect(p.gaps.knowledge_empty).toBe(3);
  });

  it('conta certo mesmo quando o driver entrega numeric como STRING', () => {
    // Este teste não é paranoia: a prova real da Task 2 mediu `top_score` voltando
    // como '0.910667' — `numeric` não tem parser default no node-postgres. Sem
    // coerção, a comparação vira string×string, não lança, e acerta metade dos
    // casos por acidente. Os tipos declarados são `number`, então o TypeScript
    // não protege: é o defeito que passa no verde.
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        // '0.703' está a 0.017 do limiar => quase acertou.
        { created_at: '2026-07-01T10:00:00Z', hits: 0, top_score: '0.703' as never, threshold: '0.72' as never },
        // '0.12' está longe => a base não tem.
        { created_at: '2026-07-01T11:00:00Z', hits: 0, top_score: '0.12' as never, threshold: '0.72' as never },
      ],
    });

    expect(p.gaps.knowledge_near_misses).toBe(1);
    expect(p.gaps.knowledge_empty).toBe(2);
  });

  it('não conta quase-acerto ACIMA do limiar, nem trata limiar ausente como corte zero', () => {
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        // Acima do limiar sem hit: hoje inalcançável porque `search-knowledge.ts`
        // garante `hits === 0 ⇒ top_score < threshold`. É invariante de OUTRO
        // arquivo; a regra escrita aqui diz "ABAIXO do limiar e perto dele".
        { created_at: '2026-07-01T10:00:00Z', hits: 0, top_score: 0.9, threshold: 0.72 },
        // Limiar ausente. `Number(null)` é 0, e similaridade de cosseno pode ser
        // negativa — sem guarda, esta linha vira "quase acertou" contra um corte
        // zero que ninguém configurou.
        { created_at: '2026-07-01T11:00:00Z', hits: 0, top_score: -0.05, threshold: null as never },
      ],
    });

    expect(p.gaps.knowledge_near_misses).toBe(0);
    expect(p.gaps.knowledge_empty).toBe(2);
  });

  it('ordena a linha do tempo pela HORA, não pelo bloco de origem, dentro do mesmo dia', () => {
    // As horas estão escolhidas para DISCRIMINAR: a ordem cronológica correta
    // (skill 23h → memória 12h → proposta 8h) é diferente da ordem de
    // concatenação (memória → proposta → skill), então nenhum desempate estável
    // por `day` produz o esperado por acaso. Uma versão anterior deste teste
    // usava horas que coincidiam com a ordem dos blocos: ela passava mesmo com
    // a ordenação por dia, isto é, não media nada.
    const p = aggregateEvolution({
      ...base(),
      memoryEntries: [{ created_at: '2026-07-02T12:00:00Z', title: 'memoria-12h' }],
      proposalsApplied: [{ applied_at: '2026-07-02T08:00:00Z', type: 'playbook_bullet', content: 'proposta-8h' }],
      skillInstalls: [{ updated_at: '2026-07-02T23:00:00Z', name: 'skill-23h' }],
    });

    // O payload descarta a hora, então a tela não teria como consertar: ou a
    // ordem nasce certa aqui, ou a "linha do tempo" mente para sempre.
    expect(p.learned.timeline.map((t) => t.title)).toEqual(['skill-23h', 'memoria-12h', 'proposta-8h']);
    expect(p.learned.timeline.map((t) => t.day)).toEqual(['2026-07-02', '2026-07-02', '2026-07-02']);
  });

  it('aponta os passos do agente que nenhum estágio do pipeline recebe', () => {
    const p = aggregateEvolution({
      ...base(),
      pipelines: [
        { name: 'Vendas', hints: ['new', 'contacted', 'won', 'lost'] },
        { name: 'Pós-venda', hints: ['new', 'contacted', 'qualifying', 'qualified', 'negotiating', 'won', 'lost'] },
      ],
    });

    // Vendas não recebe qualifying/qualified/negotiating — o agente vai querer
    // avançar e o card vai ficar parado sem ninguém saber por quê.
    expect(p.gaps.unmapped_agent_steps).toEqual([
      { pipeline_name: 'Vendas', steps: ['qualifying', 'qualified', 'negotiating'] },
    ]);
  });

  it('taxa de handoff é sobre conversas recebidas, e 0 recebidas não vira divisão por zero', () => {
    const cheio = aggregateEvolution({ ...base(), inboundCount: 200, handoffCount: 20 });
    expect(cheio.outcome.handoff_rate).toBeCloseTo(0.1);

    const vazio = aggregateEvolution({ ...base(), inboundCount: 0, handoffCount: 0 });
    expect(vazio.outcome.handoff_rate).toBe(0);
  });

  it('conta ganhos e perdas pelas transições terminais do funil do agente', () => {
    const p = aggregateEvolution({
      ...base(),
      stageTransitions: [
        { created_at: '2026-07-01T10:00:00Z', to_stage: 'won' },
        { created_at: '2026-07-02T10:00:00Z', to_stage: 'won' },
        { created_at: '2026-07-02T11:00:00Z', to_stage: 'lost' },
        { created_at: '2026-07-02T12:00:00Z', to_stage: 'qualifying' },
      ],
    });

    expect(p.outcome.won).toBe(2);
    expect(p.outcome.lost).toBe(1);
    expect(p.outcome.stage_transitions).toBe(4);
  });

  it('roteamento sem match entra nas lacunas, não na atividade normal', () => {
    const p = aggregateEvolution({
      ...base(),
      routerDecisions: [
        { created_at: '2026-07-01T10:00:00Z', outcome: 'classified', intent_name: 'agendamento' },
        { created_at: '2026-07-01T11:00:00Z', outcome: 'no_match', intent_name: null },
        { created_at: '2026-07-01T12:00:00Z', outcome: 'classifier_failed', intent_name: null },
      ],
    });

    expect(p.activity.by_intent).toEqual({ agendamento: 1 });
    expect(p.gaps.router_no_match).toBe(1);
    expect(p.gaps.router_failed).toBe(1);
  });

  it('não perde a contagem de um nome que colide com chave herdada de Object', () => {
    // Medido em node: `out['__proto__'] = (out['__proto__'] ?? 0) + 1` num objeto
    // literal NÃO cria propriedade própria — o setter de __proto__ ignora
    // não-objeto e a contagem some sem erro. `skill_pointers.name` só exige
    // length > 0, e nome de skill vem de .zip enviado pelo cliente: nada impede
    // 'constructor' ou '__proto__'. O mapa some da tela e ninguém sabe por quê.
    const p = aggregateEvolution({
      ...base(),
      skillActivations: [
        { created_at: '2026-07-02T12:00:00Z', skill_name: '__proto__' },
        { created_at: '2026-07-02T13:00:00Z', skill_name: 'constructor' },
        { created_at: '2026-07-02T14:00:00Z', skill_name: 'agendamento' },
      ],
    });

    expect(p.activity.by_skill['__proto__']).toBe(1);
    expect(p.activity.by_skill['constructor']).toBe(1);
    expect(p.activity.by_skill['agendamento']).toBe(1);
  });
});

/**
 * A lacuna por operadora e por assunto (spec 002, FR-028/FR-029 · T109/T113).
 *
 * O defeito que estes casos vigiam não é aritmético, é de CONSELHO: "não achei nada" pede
 * material novo e "achei quase" pede reescrever o que já existe. Uma implementação que some
 * os dois num número de lacuna produz um painel que passa em qualquer teste de contagem e
 * manda o corretor fazer o trabalho errado — reescrever um texto que não existe, ou escrever
 * de novo um que já estava lá com outras palavras.
 */
const AMIL = '00000000-0000-4000-8000-0000000000a1';
const UNIMED = '00000000-0000-4000-8000-0000000000a2';

/** Uma busca vazia, com os campos que a migration 0126 acrescentou. */
function busca(over: Partial<EvolutionInput['knowledgeSearches'][number]> = {}): EvolutionInput['knowledgeSearches'][number] {
  return {
    created_at: '2026-07-01T10:00:00Z',
    hits: 0,
    top_score: 0.12,
    threshold: 0.72,
    scope_id: null,
    scope_name: null,
    refusal_reason: MOTIVO_DE_RECUSA.SEM_MATERIAL,
    ...over,
  };
}

/** Um aviso da Central no formato que `escalar-sem-lastro.ts` escreve. */
function aviso(pergunta: string | null, operadora: string | null, created_at = '2026-07-01T10:00:00Z') {
  return {
    created_at,
    body: [
      ...(pergunta === null ? [] : [`O cliente perguntou: "${pergunta}"`]),
      `Operadora: ${operadora ?? 'não identificada'}`,
      'Motivo: não há material carregado que responda a esta pergunta.',
    ].join('\n'),
  };
}

describe('lacuna de conhecimento — por operadora e por assunto', () => {
  it('agrupa por operadora sem SOMAR motivos cujo conserto é diferente', () => {
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        busca({ scope_id: AMIL, scope_name: 'Amil' }),
        busca({ scope_id: AMIL, scope_name: 'Amil' }),
        busca({ scope_id: AMIL, scope_name: 'Amil', top_score: 0.703, refusal_reason: MOTIVO_DE_RECUSA.QUASE_NO_LIMIAR }),
        busca({ scope_id: UNIMED, scope_name: 'Unimed' }),
        // Achou: não é lacuna de ninguém, e não pode entrar em balde nenhum.
        busca({ scope_id: UNIMED, scope_name: 'Unimed', hits: 4, top_score: 0.91, refusal_reason: null }),
      ],
    });

    expect(p.gaps.knowledge_by_scope).toEqual([
      { scope_name: 'Amil', sem_material: 2, quase_no_limiar: 1, busca_indisponivel: 0 },
      { scope_name: 'Unimed', sem_material: 1, quase_no_limiar: 0, busca_indisponivel: 0 },
    ]);
    // Os totais continuam valendo: `quase` é subconjunto de `empty`, como a tela diz.
    expect(p.gaps.knowledge_empty).toBe(4);
    expect(p.gaps.knowledge_near_misses).toBe(1);
  });

  it('classifica pelas NOTAS a linha gravada antes da 0126, que não tem motivo', () => {
    // Instância única não tem versão de escape: as linhas antigas continuam na tabela por
    // 90 dias de janela. Um leitor que só entendesse o formato novo mostraria zero lacuna
    // sobre uma tabela cheia — e ninguém desconfiaria, porque zero lacuna parece elogio.
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        { created_at: '2026-07-01T10:00:00Z', hits: 0, top_score: 0.703, threshold: 0.72 },
        { created_at: '2026-07-01T11:00:00Z', hits: 0, top_score: 0.12, threshold: 0.72 },
      ],
    });

    expect(p.gaps.knowledge_empty).toBe(2);
    expect(p.gaps.knowledge_near_misses).toBe(1);
    expect(p.gaps.knowledge_by_scope).toEqual([
      { scope_name: null, sem_material: 1, quase_no_limiar: 1, busca_indisponivel: 0 },
    ]);
  });

  it('busca que ficou FORA DO AR não conta como material faltando', () => {
    // Somá-la a `knowledge_empty` mandaria o corretor escrever material para consertar uma
    // queda de infraestrutura: trabalho inútil com a sensação de estar consertando.
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [
        busca({ scope_id: AMIL, scope_name: 'Amil', top_score: null, refusal_reason: MOTIVO_DE_RECUSA.BUSCA_INDISPONIVEL }),
        busca({ scope_id: AMIL, scope_name: 'Amil' }),
      ],
    });

    expect(p.gaps.knowledge_unavailable).toBe(1);
    expect(p.gaps.knowledge_empty).toBe(1);
    expect(p.gaps.knowledge_near_misses).toBe(0);
    expect(p.gaps.knowledge_by_scope).toEqual([
      { scope_name: 'Amil', sem_material: 1, quase_no_limiar: 0, busca_indisponivel: 1 },
    ]);
  });

  it('motivo de vocabulário NOVO entra na conta e fica fora do conselho', () => {
    // `refusal_reason` é coluna de vocabulário ABERTO — valor novo aparece por construção.
    // Derivar "falta escrever material" de um motivo desconhecido é como a tela mandaria
    // escrever texto para consertar, por exemplo, um escopo desligado, que é um clique.
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [busca({ scope_id: AMIL, scope_name: 'Amil', refusal_reason: 'escopo_desligado' })],
    });

    expect(p.gaps.knowledge_empty).toBe(1);
    expect(p.gaps.knowledge_near_misses).toBe(0);
    expect(p.gaps.knowledge_by_scope).toEqual([]);
  });

  it('agrupa as recusas por operadora E por assunto, com contagem e pergunta real', () => {
    const p = aggregateEvolution({
      ...base(),
      knowledgeRefusals: [
        aviso('como faço a segunda via do boleto?', 'Amil', '2026-07-01T10:00:00Z'),
        aviso('meu boleto não chegou, e agora?', 'Amil', '2026-07-02T10:00:00Z'),
        aviso('o hospital Santa Casa está credenciado?', 'Amil', '2026-07-02T11:00:00Z'),
        aviso('esse hospital está credenciado no meu plano?', 'Unimed', '2026-07-03T10:00:00Z'),
      ],
    });

    // Amil/cobrança tem 2; os outros dois baldes têm 1 cada. Mesma operadora com assuntos
    // diferentes NÃO colapsa: são dois materiais distintos a escrever.
    expect(p.gaps.knowledge_refusals).toEqual([
      {
        scope_name: 'Amil',
        subject: 'cobranca',
        count: 2,
        example_question: 'meu boleto não chegou, e agora?',
        last_seen_at: '2026-07-02T10:00:00Z',
      },
      {
        scope_name: 'Unimed',
        subject: 'rede',
        count: 1,
        example_question: 'esse hospital está credenciado no meu plano?',
        last_seen_at: '2026-07-03T10:00:00Z',
      },
      {
        scope_name: 'Amil',
        subject: 'rede',
        count: 1,
        example_question: 'o hospital Santa Casa está credenciado?',
        last_seen_at: '2026-07-02T11:00:00Z',
      },
    ]);
  });

  it('o exemplo é a pergunta MAIS RECENTE, não a que a rota devolveu primeiro', () => {
    // O agregador é puro: resultado que dependesse da ordem em que a consulta resolveu ler
    // é uma armadilha para o próximo que trocar o `order` da rota.
    const crescente = aggregateEvolution({
      ...base(),
      knowledgeRefusals: [
        aviso('boleto antigo', 'Amil', '2026-07-01T10:00:00Z'),
        aviso('boleto novo', 'Amil', '2026-07-03T10:00:00Z'),
      ],
    });
    const decrescente = aggregateEvolution({
      ...base(),
      knowledgeRefusals: [
        aviso('boleto novo', 'Amil', '2026-07-03T10:00:00Z'),
        aviso('boleto antigo', 'Amil', '2026-07-01T10:00:00Z'),
      ],
    });

    expect(crescente.gaps.knowledge_refusals[0]?.example_question).toBe('boleto novo');
    expect(decrescente.gaps.knowledge_refusals).toEqual(crescente.gaps.knowledge_refusals);
  });

  it('aviso sem operadora e sem assunto reconhecido continua sendo lacuna', () => {
    // Engolir a recusa que o léxico não classifica perderia justamente o assunto que
    // ninguém previu — o caso mais suspeito de todos.
    const p = aggregateEvolution({
      ...base(),
      knowledgeRefusals: [
        aviso('vocês têm plano com academia inclusa?', null),
        { created_at: '2026-07-02T10:00:00Z', body: 'aviso em formato antigo, sem as linhas de sempre' },
        { created_at: '2026-07-02T11:00:00Z', body: null },
      ],
    });

    expect(p.gaps.knowledge_refusals).toEqual([
      {
        scope_name: null,
        subject: '',
        count: 3,
        example_question: 'vocês têm plano com academia inclusa?',
        last_seen_at: '2026-07-02T11:00:00Z',
      },
    ]);
  });

  it('a pergunta de exemplo NUNCA sai da telemetria de busca', () => {
    // A migration 0086 declara que `knowledge_searches` não grava texto de conversa. Com
    // telemetria cheia e nenhum aviso, não há pergunta real para mostrar — e a lista sai
    // vazia em vez de inventar uma.
    const p = aggregateEvolution({
      ...base(),
      knowledgeSearches: [busca({ scope_id: AMIL, scope_name: 'Amil' }), busca({ scope_id: AMIL, scope_name: 'Amil' })],
      knowledgeRefusals: [],
    });

    expect(p.gaps.knowledge_empty).toBe(2);
    expect(p.gaps.knowledge_refusals).toEqual([]);
  });
});
