import { describe, it, expect } from "vitest";

import { boaNoticia, montaLacunas } from "@/components/ai/EvolutionGaps";
import { descricaoResultado, taxaDeAjuda } from "@/app/app/ai/evolution/_client";
import { aggregateEvolution, type EvolutionInput } from "@/lib/ai/evolution/aggregate";

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
