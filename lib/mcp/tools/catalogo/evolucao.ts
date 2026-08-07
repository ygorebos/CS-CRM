/**
 * Capacidades de EVOLUCAO — o que a empresa ja sabe e o que o agente aprende.
 *
 * `description` fala com o modelo; `rotulo`/`explicacao`/`oQueToca` falam com o
 * humano que configura o agente. Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 *
 * DECISAO DELIBERADA — a IA nao aprova a propria melhoria. As propostas do
 * flywheel (`flywheel_distiller_proposals`) sao expostas para LEITURA. Nenhuma
 * capacidade de aprovar entra neste catalogo: o gate humano e o desenho do
 * flywheel, e dar ao agente o poder de aprovar mudancas em si mesmo removeria
 * exatamente a trava que torna a auto-melhoria segura. Aprovar continua sendo
 * um clique de pessoa, na tela do agente.
 */
import { declararTools } from "./tipos";

export const TOOLS_EVOLUCAO = declararTools([
  {
    name: "crm_search_knowledge",
    category: "read",
    description:
      "Busca semantica no acervo de conhecimento da organizacao (RAG). Devolve os trechos mais " +
      "relevantes com a similaridade de cada um. Quando nada passa do limiar, devolve " +
      "`melhor_similaridade` para distinguir 'nao ha nada sobre isso' de 'ha algo perto, mas fraco'.",
    rotulo: "Consultar o que a empresa já sabe",
    explicacao:
      "Procura a resposta nos materiais que você cadastrou, para o assistente responder com a informação da sua empresa em vez de inventar.",
    oQueToca: "Base de conhecimento",
    risco: "seguro",
    pacotes: ["evoluir", "atender"],
  },
  {
    name: "crm_list_knowledge_sources",
    category: "read",
    description:
      "Lista os materiais que compoem o acervo de conhecimento da organizacao, com estado de " +
      "indexacao e contagem de trechos. Util para saber se uma resposta faltou por ausencia de " +
      "material ou por falha de indexacao.",
    rotulo: "Ver os materiais cadastrados",
    explicacao:
      "Mostra quais materiais estão no acervo da empresa e se foram processados, para saber se faltou conteúdo ou se algo falhou.",
    oQueToca: "Base de conhecimento",
    risco: "seguro",
    pacotes: ["evoluir"],
  },
  {
    name: "crm_list_improvement_proposals",
    category: "read",
    description:
      "Lista as propostas de melhoria que o ciclo de aprendizado gerou, com tipo, alvo e a " +
      "evidência que as motivou. LEITURA apenas: aprovar continua sendo decisão de uma pessoa.",
    rotulo: "Ver sugestões de melhoria",
    explicacao:
      "Mostra as melhorias que o sistema sugeriu a partir dos atendimentos, com o motivo de cada uma. Aprovar continua sendo decisão sua.",
    oQueToca: "Aprendizado do assistente",
    risco: "seguro",
    pacotes: ["evoluir"],
  },
  {
    name: "crm_get_org_memory",
    category: "read",
    description:
      "Lê o que a empresa registrou sobre si mesma — políticas, combinados e aprendizados que " +
      "valem para todo atendimento.",
    rotulo: "Consultar as regras da empresa",
    explicacao:
      "Lê as políticas e combinados que valem para todo atendimento, para o assistente seguir a regra da casa em vez de inventar uma.",
    oQueToca: "Regras da empresa",
    risco: "seguro",
    pacotes: ["evoluir", "atender"],
  },
  {
    name: "crm_save_org_memory",
    category: "write",
    description:
      "Registra um aprendizado que vale para toda a operação. Nasce com origem 'agent' para o " +
      "humano distinguir o que a IA anotou do que ele mesmo escreveu.",
    rotulo: "Anotar uma regra aprendida",
    explicacao:
      "Guarda um aprendizado que vale para todos os atendimentos, marcado como escrito pelo assistente para você distinguir do que anotou.",
    oQueToca: "Regras da empresa",
    risco: "atencao",
    pacotes: ["evoluir"],
  },
]);
