/**
 * Capacidades de ESCALAÇÃO — o ciclo completo entre o agente e uma pessoa.
 *
 * O pacote nasceu com UMA capacidade: chamar um atendente. Depois disso o agente
 * ficava cego — não listava chamados, não lia o que a pessoa decidiu, não sabia
 * se o caso foi resolvido, não conseguia retomar. E também não enxergava quem
 * estava disponível, então escalava para uma fila que podia não ter ninguém.
 * Na prática ele jogava o problema por cima do muro e sumia.
 *
 * As seis capacidades abaixo fecham as duas direções: o agente participa do
 * atendimento humano em vez de terminar nele.
 *
 * `description` fala com o modelo; `rotulo`/`explicacao`/`oQueToca` falam com o
 * dono da clínica que configura o agente. Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 */
import { declararTools } from "./tipos";

export const TOOLS_ESCALACAO = declararTools([
  {
    name: "crm_list_available_attendants",
    category: "read",
    description:
      "Lista os atendentes da org com disponibilidade, capacidade, carga atual e se podem " +
      "receber uma conversa AGORA (mesmo predicado do worker de roteamento: disponível ∧ com " +
      "folga ∧ dentro do horário). Consulta livre: o caminho de escalação JÁ devolve a " +
      "expectativa sozinho, então isto serve para planejar, não para cumprir obrigação. " +
      "Não devolve e-mail nem telefone.",
    rotulo: "Ver quem pode assumir agora",
    explicacao:
      "Mostra quais pessoas da equipe estão em atendimento neste momento, quantas conversas cada uma já tem e quem ainda tem espaço para receber mais uma.",
    oQueToca: "Equipe de atendimento",
    risco: "seguro",
    pacotes: ["escalar", "atender"],
  },
  {
    name: "crm_list_human_cases",
    category: "read",
    description:
      "Lista os casos humanos da org por estado (abertos = awaiting_human|awaiting_lead; " +
      "fechados = resolved|escalated|cancelled), com título, bloqueio, estado e a conversa de " +
      "origem. Use para saber o que já foi pedido a uma pessoa antes de pedir de novo.",
    rotulo: "Ver os chamados em aberto",
    explicacao:
      "Lista os assuntos que já foram passados para uma pessoa resolver, com o estado de cada um, para o agente não pedir duas vezes a mesma coisa.",
    oQueToca: "Chamados para uma pessoa",
    risco: "seguro",
    pacotes: ["escalar"],
  },
  {
    name: "crm_get_human_case",
    category: "read",
    description:
      "Detalhe de UM caso humano: título, resumo, bloqueio, estado e a timeline completa de " +
      "eventos, incluindo o que o humano decidiu (human_action + texto) e o que o agente " +
      "registrou. Devolve também o bloco de continuidade pronto para retomar a conversa.",
    rotulo: "Ler um chamado e o que a pessoa decidiu",
    explicacao:
      "Abre um chamado e mostra tudo que aconteceu nele, inclusive a decisão que a pessoa tomou e o texto que ela escreveu ao decidir.",
    oQueToca: "Chamados para uma pessoa",
    risco: "seguro",
    pacotes: ["escalar"],
  },
  {
    name: "crm_add_case_note",
    category: "write",
    description:
      "Registra no caso o que aconteceu depois da abertura (kind='agent_noted', actor='agent') " +
      "— o que o lead respondeu, o que já foi tentado, o que mudou. Só funciona em caso ABERTO. " +
      "Serve para o próximo atendente não começar do zero.",
    rotulo: "Registrar o que aconteceu num chamado",
    explicacao:
      "Deixa escrito no chamado o que mudou desde que ele foi aberto, para a pessoa que for atender não precisar começar do zero.",
    oQueToca: "Chamados para uma pessoa",
    risco: "atencao",
    pacotes: ["escalar"],
  },
  {
    name: "crm_close_human_case",
    category: "write",
    description:
      "Encerra um caso aberto com o desfecho registrado: 'resolvido' (o bloqueio foi superado) " +
      "ou 'sem_necessidade' (deixou de fazer sentido). Grava actor='agent' — NUNCA se passa por " +
      "decisão humana. Irreversível pela própria capacidade.",
    rotulo: "Encerrar um chamado com o desfecho",
    explicacao:
      "Fecha um chamado deixando registrado como ele terminou, para ele parar de ocupar a fila de quem atende. Não dá para reabrir por aqui.",
    oQueToca: "Chamados para uma pessoa",
    risco: "critico",
    pacotes: ["escalar"],
  },
  {
    name: "crm_resume_ai_attendance",
    category: "write",
    description:
      "Devolve o atendimento de uma conversa ao agente: solta o dono humano, limpa " +
      "contacts.force_human e o silêncio do bot, e devolve o CONTEXTO do que a pessoa fez " +
      "(decisões nos casos + notas internas). Grava esse contexto no checkpoint do lead, de " +
      "onde o próximo turno o lê. Reativar automação para um cliente que pediu uma pessoa é " +
      "decisão de peso — por isso é capacidade de risco crítico.",
    rotulo: "Retomar o atendimento automático",
    explicacao:
      "Devolve a conversa para o atendimento automático depois que uma pessoa atendeu, levando junto o que ficou combinado com o cliente. Só uma pessoa pode acionar.",
    oQueToca: "Atendimento",
    risco: "critico",
    pacotes: ["escalar"],
  },
]);
