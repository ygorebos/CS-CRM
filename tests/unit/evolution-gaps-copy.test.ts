import { describe, it, expect } from "vitest";

import { ASSUNTO_EM_PORTUGUES, boaNoticia, montaLacunas } from "@/components/ai/EvolutionGaps";
import { assuntosDasPerguntas } from "@/app/admin/(protected)/catalogo/_lacunas";
import { descricaoResultado, taxaDeAjuda } from "@/app/app/ai/evolution/_client";
import { aggregateEvolution, type EvolutionInput, type EvolutionPayload } from "@/lib/ai/evolution/aggregate";

/**
 * Estes dois pedaços são INALCANÇÁVEIS pela tela nas orgs que temos: basta um
 * funil com um passo sem etapa para a lista de lacunas nunca esvaziar, e a taxa
 * de ajuda desta org não cai na faixa abaixo de 0,1. Sem teste, nenhuma das duas
 * lógicas teria prova executável — e as duas nasceram justamente de zeros
 * lisonjeiros, o defeito que passa despercebido por parecer boa notícia.
 *
 * Cada caso asserta a frase ESPECÍFICA do ramo, não uma string comum a vários:
 * o caso sem evidência nenhuma passaria por engano se o texto fosse a
 * meia-verdade de outro ramo, porque o pedaço citado aparece nos dois.
 */
describe("boaNoticia — cada afirmação precisa da sua própria evidência", () => {
  it("sem busca na base, NÃO afirma que as perguntas foram respondidas", () => {
    const t = boaNoticia(0, 12, 3);
    expect(t).not.toContain("toda pergunta encontrou resposta");
    expect(t).toContain("toda conversa achou para onde ir");
    expect(t).toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).toContain("ninguém consultou sua base de conhecimento");
  });

  it("sem encaminhamento, NÃO afirma que as conversas acharam destino", () => {
    const t = boaNoticia(30, 0, 3);
    expect(t).toContain("toda pergunta encontrou resposta");
    expect(t).not.toContain("toda conversa achou para onde ir");
    expect(t).toContain("nenhuma conversa foi encaminhada");
  });

  it("sem funil montado, NÃO elogia funis que não existem", () => {
    // Instalação fresca: o instalador não provisiona pipeline nenhum, então zero
    // funis ⇒ zero lacunas ⇒ a lista fica vazia sem que nada esteja certo.
    const t = boaNoticia(30, 12, 0);
    expect(t).not.toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).toContain("você ainda não tem nenhum funil montado");
  });

  it("sem evidência nenhuma, abre pelo motivo e não pela boa notícia", () => {
    const t = boaNoticia(0, 0, 0);
    expect(t).toContain("Ainda não dá para dizer se algo está travando");
    expect(t).not.toContain("Nada travando");
    expect(t).not.toContain("toda pergunta encontrou resposta");
    expect(t).not.toContain("toda conversa achou para onde ir");
    expect(t).not.toContain("todo passo do atendimento tem uma etapa do funil");
  });

  it("com as três evidências, afirma tudo e sem ressalva", () => {
    const t = boaNoticia(30, 12, 3);
    expect(t).toContain("Nada travando neste período");
    expect(t).toContain("toda pergunta encontrou resposta");
    expect(t).toContain("toda conversa achou para onde ir");
    expect(t).toContain("todo passo do atendimento tem uma etapa do funil");
    expect(t).not.toContain("ressalva");
  });
});

/**
 * O ciclo "vejo a lacuna → conserto" é feito de TRÊS coisas que ninguém guardava:
 * para onde o botão aponta, o que ele promete fazer, e os nomes dos passos. As
 * duas primeiras eram só prova de browser (que não roda no CI); a terceira já
 * tinha divergido uma vez — o painel traduzia os sete passos por conta própria
 * enquanto a tela usava `ROTULO_DO_PASSO`, e nada ficava vermelho.
 */
describe("lacuna de funil — o botão fecha o ciclo, e o ciclo tem guarda", () => {
  const semFuniz = {
    pipelines_evaluated: 1,
    knowledge_near_misses: 0,
    knowledge_empty: 0,
    knowledge_unavailable: 0,
    knowledge_by_scope: [],
    knowledge_refusals: [],
    knowledge_divergences: [],
    router_no_match: 0,
    router_failed: 0,
  };
  const lacunaDe = (steps: string[]) =>
    montaLacunas({
      ...semFuniz,
      unmapped_agent_steps: [{ pipeline_name: "Pedidos", steps }],
    })[0]!;

  it("aponta para a tela que conserta, não para o quadro", () => {
    const l = lacunaDe(["new"]);
    expect(l.href).toBe("/app/settings/tenant/pipelines");
    expect(l.href).not.toBe("/app/kanban");
  });

  it("o verbo do botão é de ação, não de observação", () => {
    const l = lacunaDe(["new"]);
    expect(l.cta).toBe("Escolher a etapa de cada passo");
    expect(l.cta).not.toMatch(/^Ver/);
  });

  it("nomeia os passos com o MESMO vocabulário da tela de destino", () => {
    // `ROTULO_DO_PASSO` é a fonte única. Se este arquivo voltar a ter a sua
    // própria tradução, o usuário lê um nome aqui e procura outro lá.
    const l = lacunaDe(["new", "qualifying"]);
    expect(l.texto).toContain("Novo lead");
    expect(l.texto).toContain("Em qualificação");
    expect(l.texto).not.toContain("contato novo");
    expect(l.texto).not.toContain("entendendo o que ele precisa");
  });

  it("promete «você mesmo escolhe» sem ressalva quando dá para escolher", () => {
    const l = lacunaDe(["new", "contacted"]);
    expect(l.texto).toContain("você mesmo escolhe");
    expect(l.texto).not.toContain("é com quem instalou o sistema");
  });

  it("ressalva ganho/perda, porque a tela pode não ter o que oferecer", () => {
    // `is_won`/`is_lost` não são escritos por tela nenhuma: se o funil não tem
    // etapa de fechamento, o destino responde "quem montou o funil precisa
    // marcar" — e o botão teria prometido que o usuário resolve.
    const l = lacunaDe(["new", "won", "lost"]);
    expect(l.texto).toContain("«Ganho» e «Perdido» são exceção");
    expect(l.texto).toContain("é com quem instalou o sistema");
  });
});

describe("descricaoResultado — 'houve atendimento' é mensagem recebida, não custo", () => {
  const base = {
    stage_transitions: 0,
    won: 0,
    lost: 0,
    handoff_rate: 0,
    cost_cents: 0,
    messages_received: 0,
  };

  it("custo alto e ZERO mensagens ainda diz que não houve atendimento", () => {
    // O caso real: `llm_calls` inclui `connection_test` e as chamadas do
    // flywheel, cujo cron julga turnos passados e carimba o custo no dia em que
    // rodou. Se o custo voltar ao guarda, a ressalva some justamente no período
    // em que ela é necessária — e este teste fica vermelho.
    const t = descricaoResultado({ ...base, cost_cents: 1200, handoff_rate: 0.5 });
    expect(t).toContain("Não houve atendimento neste período");
  });

  it("uma mensagem recebida já basta para a descrição normal", () => {
    const t = descricaoResultado({ ...base, messages_received: 1 });
    expect(t).not.toContain("Não houve atendimento");
    expect(t).toContain("compare com o mês anterior");
  });
});

describe("aggregateEvolution expõe o fato exato no payload", () => {
  const vazio: EvolutionInput = {
    range: { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z") },
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

  it("messages_received vem de inboundCount, e não de nenhum substituto", () => {
    expect(aggregateEvolution({ ...vazio, inboundCount: 42, costCents: 999 }).outcome.messages_received).toBe(42);
    expect(aggregateEvolution({ ...vazio, costCents: 999 }).outcome.messages_received).toBe(0);
  });

  it("pipelines_evaluated distingue 'tudo mapeado' de 'não há funil'", () => {
    expect(aggregateEvolution(vazio).gaps.pipelines_evaluated).toBe(0);
    const comFunil = aggregateEvolution({
      ...vazio,
      pipelines: [{ name: "Clínica", hints: ["new", "contacted", "qualifying", "qualified", "negotiating", "won", "lost"] }],
    });
    expect(comFunil.gaps.pipelines_evaluated).toBe(1);
    expect(comFunil.gaps.unmapped_agent_steps).toEqual([]);
  });
});

describe("taxaDeAjuda — o zero tem que ser zero de verdade", () => {
  it("zero real é 0", () => {
    expect(taxaDeAjuda(0)).toBe("0");
  });

  it("1 pedido em 5.000 mensagens NÃO vira 0", () => {
    // 0,02 a cada 100. Com uma casa decimal o formatador diria "0", e a tela
    // afirmaria que a IA nunca precisou de gente.
    expect(taxaDeAjuda(1 / 5000)).toBe("menos de 0,1 a cada 100");
  });

  it("acima de 0,1 mostra o número", () => {
    expect(taxaDeAjuda(0.059)).toBe("5,9 a cada 100");
  });
});

/**
 * A divergência entre camadas na tela (spec 002, FR-035 · SC-016 · T081).
 *
 * A metade do requisito que existia parava no banco: o desempate escolhe o material do
 * corretor e silencia o do catálogo. Sem estes casos, "registrar a divergência" viraria uma
 * contagem — e contagem não diz QUAIS dois textos discordam, que é a única coisa com que o
 * corretor consegue fazer alguma coisa hoje.
 */
describe("lacuna de divergência — o corretor sabe quais dois textos conferir", () => {
  const semNada = {
    unmapped_agent_steps: [],
    pipelines_evaluated: 1,
    knowledge_near_misses: 0,
    knowledge_empty: 0,
    knowledge_unavailable: 0,
    knowledge_by_scope: [],
    knowledge_refusals: [],
    router_no_match: 0,
    router_failed: 0,
  };
  const divergencia = (over: Partial<{
    winner_title: string;
    loser_title: string;
    scope_name: string | null;
    subject: string;
    occurrences: number;
  }> = {}) => ({
    winner_title: "Boletos 2026",
    loser_title: "Segunda via — Operadora A",
    scope_name: "Operadora A",
    subject: "cobranca",
    occurrences: 1,
    ...over,
  });
  const lacuna = (...ds: ReturnType<typeof divergencia>[]) =>
    montaLacunas({ ...semNada, knowledge_divergences: ds });

  it("nomeia OS DOIS materiais — sem isso o aviso é agulha no palheiro", () => {
    const l = lacuna(divergencia())[0]!;
    expect(l.texto).toContain("Boletos 2026");
    expect(l.texto).toContain("Segunda via — Operadora A");
  });

  it("NÃO afirma qual dos dois está errado", () => {
    // O desempate é por ORIGEM, não por correção: o sistema não sabe quem está certo.
    // Mandar "corrija o seu material" faria o corretor desfazer justamente a correção que
    // ele escreveu quando a operadora mudou a regra e o catálogo ficou para trás.
    const l = lacuna(divergencia())[0]!;
    expect(l.texto).not.toMatch(/seu material está errado|corrija o seu/i);
    expect(l.texto).toContain("conferir qual está atualizado");
  });

  it("traduz o assunto para palavra de corretor, não para o nome da categoria", () => {
    expect(lacuna(divergencia({ subject: "prazos" }))[0]!.texto).toContain("prazos e carência");
    expect(lacuna(divergencia({ subject: "rede" }))[0]!.texto).toContain("rede credenciada");
  });

  it("assunto que o léxico não classifica não vira frase quebrada", () => {
    // `subject: ''` é registro legítimo (o texto não caiu em nenhuma categoria). A frase
    // tem que continuar lendo bem, sem "os dois falam de ." pendurado.
    const t = lacuna(divergencia({ subject: "" }))[0]!.texto;
    expect(t).not.toContain("falam de .");
    expect(t).toContain("Boletos 2026");
  });

  it("só menciona repetição quando houve repetição", () => {
    expect(lacuna(divergencia({ occurrences: 1 }))[0]!.texto).not.toContain("Já foi assim");
    expect(lacuna(divergencia({ occurrences: 7 }))[0]!.texto).toContain("Já foi assim em 7 respostas");
  });

  it("cada divergência é uma linha própria, com chave distinta", () => {
    // Duas divergências colapsadas numa só fariam a segunda sumir quando o corretor
    // resolvesse a primeira — e ele nunca saberia que existiu.
    const ls = lacuna(divergencia(), divergencia({ subject: "rede", loser_title: "Rede — Operadora A" }));
    expect(ls).toHaveLength(2);
    expect(new Set(ls.map((l) => l.chave)).size).toBe(2);
  });

  it("o botão leva à tela onde os materiais moram, com verbo de ação", () => {
    const l = lacuna(divergencia())[0]!;
    expect(l.href).toBe("/app/ai/knowledge/sources");
    expect(l.cta).toBe("Conferir os dois materiais");
    expect(l.cta).not.toMatch(/^Ver/);
  });
});

/**
 * A lacuna de conhecimento com contagem, operadora, assunto e a PERGUNTA REAL
 * (spec 002, FR-028/FR-029 · US5 · T114).
 *
 * O que estes casos vigiam é o conselho, não o número. Três coisas passam despercebidas em
 * qualquer revisão de contagem e viram trabalho errado do corretor: (a) a pergunta de
 * exemplo sumir, deixando-o com uma categoria e nenhuma pista do que escrever; (b) "não
 * achei nada" e "achei quase" virarem a mesma frase, que manda escrever de novo um texto
 * que já existe; (c) a falha de infraestrutura entrar na conta de material faltando, que é
 * a única lacuna desta tela cujo dono não é o usuário.
 */
describe("lacuna de conhecimento — o corretor sai sabendo o que escrever", () => {
  const semNada = {
    unmapped_agent_steps: [],
    pipelines_evaluated: 1,
    knowledge_near_misses: 0,
    knowledge_empty: 0,
    knowledge_unavailable: 0,
    knowledge_by_scope: [],
    knowledge_refusals: [],
    knowledge_divergences: [],
    router_no_match: 0,
    router_failed: 0,
  };
  type Recusa = EvolutionPayload["gaps"]["knowledge_refusals"][number];
  const recusa = (over: Partial<Recusa> = {}): Recusa => ({
    scope_name: "Operadora A",
    subject: "cobranca",
    count: 3,
    example_question: "perdi meu boleto, como pego a segunda via?",
    last_seen_at: "2026-07-03T10:00:00Z",
    ...over,
  });
  const daRecusa = (over: Parameters<typeof recusa>[0] = {}) =>
    montaLacunas({ ...semNada, knowledge_refusals: [recusa(over)] })[0]!;

  it("mostra a contagem E a pergunta como o cliente escreveu", () => {
    const l = daRecusa();
    expect(l.texto).toContain("3 conversas");
    expect(l.texto).toContain("«perdi meu boleto, como pego a segunda via?»");
    expect(l.texto).toContain("Operadora A");
  });

  it("traduz o assunto para palavra de corretor, não para o nome da categoria", () => {
    expect(daRecusa({ subject: "rede" }).texto).toContain("rede credenciada");
    expect(daRecusa({ subject: "prazos" }).texto).toContain("prazos e carência");
    expect(daRecusa().texto).not.toContain("cobranca");
  });

  it("uma conversa só não vira «em 1 conversas»", () => {
    const l = daRecusa({ count: 1 });
    expect(l.texto).toContain("Um cliente");
    expect(l.texto).not.toContain("1 conversas");
    expect(l.texto).not.toContain("em 1 conversa");
  });

  it("sem pergunta legível, a frase continua inteira — sem aspas vazias", () => {
    const t = daRecusa({ example_question: null }).texto;
    expect(t).not.toContain("«»");
    expect(t).not.toContain("escreveu:");
    expect(t).toContain("Operadora A");
  });

  it("assunto que o léxico não classificou não deixa «sobre .» pendurado", () => {
    const t = daRecusa({ subject: "" }).texto;
    expect(t).not.toMatch(/sobre\s*[.,]/);
    expect(t).toContain("«perdi meu boleto, como pego a segunda via?»");
  });

  it("sem operadora identificada, diz isso em vez de calar", () => {
    const t = daRecusa({ scope_name: null }).texto;
    expect(t).toContain("não identificou a operadora");
    expect(t).not.toContain(" da null");
  });

  it("o botão manda ESCREVER, não «ver»", () => {
    const l = daRecusa();
    expect(l.href).toBe("/app/ai/knowledge/sources");
    expect(l.cta).toBe("Escrever esse material");
    expect(l.cta).not.toMatch(/^Ver/);
  });

  it("cada assunto é uma linha própria, com chave distinta", () => {
    const ls = montaLacunas({
      ...semNada,
      knowledge_refusals: [recusa(), recusa({ subject: "rede", scope_name: "Operadora B" })],
    });
    expect(ls).toHaveLength(2);
    expect(new Set(ls.map((l) => l.chave)).size).toBe(2);
  });

  it("lista longa não vira ruído: o excedente aponta para os Alertas", () => {
    // Cada linha aqui é uma tarefa. Quinze de uma vez é a lista inteira sendo ignorada —
    // que é como um mecanismo anti-morte morre.
    const muitos = ["cobranca", "rede", "prazos", "acesso", "cobertura", "canais", "regras"].map((s) =>
      recusa({ subject: s }),
    );
    const ls = montaLacunas({ ...semNada, knowledge_refusals: muitos });
    const resto = ls.find((l) => l.chave === "recusas-restantes")!;
    expect(ls).toHaveLength(6);
    expect(resto.texto).toContain("mais 2 assuntos");
    expect(resto.href).toBe("/app/ai/inbox");
  });

  it("diz EM QUAL operadora falta material, sem repetir a totalização", () => {
    const l = montaLacunas({
      ...semNada,
      knowledge_empty: 6,
      knowledge_near_misses: 2,
      knowledge_by_scope: [
        { scope_name: "Operadora A", sem_material: 4, quase_no_limiar: 1, busca_indisponivel: 0 },
        { scope_name: "Operadora B", sem_material: 2, quase_no_limiar: 1, busca_indisponivel: 0 },
      ],
    });
    const vazias = l.find((x) => x.chave === "knowledge-empty")!;
    const quase = l.find((x) => x.chave === "knowledge-near")!;

    expect(vazias.texto).toContain("Onde: Operadora A (4) e Operadora B (2).");
    // O recorte do "quase" é o do QUASE, não o do "não achei nada" repetido: quem lê os
    // dois números iguais conclui que a operadora tem o dobro do problema que tem.
    expect(quase.texto).toContain("Onde: Operadora A (1) e Operadora B (1).");
  });

  it("não escreve «Onde: sem operadora identificada» quando nenhuma foi identificada", () => {
    const l = montaLacunas({
      ...semNada,
      knowledge_empty: 3,
      knowledge_by_scope: [{ scope_name: null, sem_material: 3, quase_no_limiar: 0, busca_indisponivel: 0 }],
    });
    expect(l.find((x) => x.chave === "knowledge-empty")!.texto).not.toContain("Onde:");
  });

  it("falha técnica vira linha PRÓPRIA, que não manda escrever nada", () => {
    const l = montaLacunas({ ...semNada, knowledge_unavailable: 4 });
    const tecnica = l.find((x) => x.chave === "knowledge-unavailable")!;

    expect(tecnica.texto).toContain("falha técnica, não material faltando");
    expect(tecnica.texto).toContain("Não há nada para você escrever");
    expect(tecnica.href).toBe("/app/ai/credentials");
    // E ela não some: lacuna sem linha é lacuna que ninguém conserta.
    expect(l.map((x) => x.chave)).toContain("knowledge-unavailable");
  });

  it("a pergunta real vem antes dos números, porque é ela que diz o que fazer", () => {
    const l = montaLacunas({
      ...semNada,
      knowledge_empty: 9,
      knowledge_refusals: [recusa()],
    });
    expect(l.findIndex((x) => x.chave.startsWith("recusa-"))).toBeLessThan(
      l.findIndex((x) => x.chave === "knowledge-empty"),
    );
  });
});

/**
 * A MESMA leitura do lado do administrador de plataforma (FR-028, segunda metade · T115).
 *
 * O requisito não pede "uma tela para o curador": pede a mesma leitura, restrita à própria
 * instalação. Duas telas sobre o mesmo banco que agrupam por vocabulários diferentes fazem
 * o curador e o corretor chamarem de nomes diferentes a mesma lacuna — e nenhum dos dois
 * descobre isso, porque cada um só vê a sua.
 */
describe("lacunas do catálogo — o curador lê pelo mesmo léxico que o corretor", () => {
  const p = (question: string) => ({ question });

  it("agrupa as perguntas pelas categorias fechadas do léxico de assistência", () => {
    expect(
      assuntosDasPerguntas([
        p("perdi meu boleto, como pego a segunda via?"),
        p("a mensalidade subiu, por quê?"),
        p("esse hospital está credenciado?"),
      ]),
    ).toEqual([
      { assunto: "cobranca", vezes: 2 },
      { assunto: "rede", vezes: 1 },
    ]);
  });

  it("toda categoria que ele agrupa tem tradução no MESMO mapa da tela do corretor", () => {
    // A prova que importa é a de cobertura: se o curador agrupasse por um vocabulário
    // próprio, alguma categoria cairia fora de `ASSUNTO_EM_PORTUGUES` e a tela mostraria o
    // nome técnico da categoria para uma pessoa que nunca viu o léxico.
    const assuntos = assuntosDasPerguntas([
      p("perdi meu boleto"),
      p("preciso da minha carteirinha"),
      p("esse hospital está credenciado?"),
      p("isso está coberto pelo plano?"),
      p("qual é a carência?"),
      p("qual a central de atendimento?"),
      p("como faço a portabilidade?"),
    ]).map((a) => a.assunto);

    expect(assuntos.length).toBeGreaterThanOrEqual(7);
    for (const a of assuntos) expect(ASSUNTO_EM_PORTUGUES[a]).toBeTruthy();
  });

  it("pergunta que o léxico não classifica NÃO some do agrupamento", () => {
    // Some seria perder justamente o assunto que ninguém previu — o mais interessante
    // para quem cura o catálogo.
    expect(assuntosDasPerguntas([p("vocês têm plano com academia inclusa?")])).toEqual([
      { assunto: "", vezes: 1 },
    ]);
  });
});
