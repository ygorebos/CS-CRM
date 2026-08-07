/**
 * Capacidades de FUNIL — oportunidades de venda e as etapas por onde passam.
 *
 * `description` fala com o modelo; `rotulo`/`explicacao`/`oQueToca` falam com o
 * humano que configura o agente. Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 */
import { declararTools } from "./tipos";

export const TOOLS_FUNIL = declararTools([
  {
    name: "crm_list_leads",
    category: "read",
    description: "Lista leads de um pipeline (com owner_user_name, stage, tags)",
    rotulo: "Listar oportunidades do funil",
    explicacao:
      "Lista as oportunidades de venda de um funil, com a etapa em que cada uma está e quem é o responsável por ela.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_get_lead",
    category: "read",
    description: "Detalhe de lead (com owner_user_name, stage, tags)",
    rotulo: "Ver uma oportunidade",
    explicacao:
      "Abre os detalhes de uma oportunidade de venda: etapa atual, responsável, marcadores e valor do negócio.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender"],
  },
  {
    name: "crm_list_pipelines",
    category: "read",
    description: "Lista pipelines da org",
    rotulo: "Listar funis",
    explicacao:
      "Mostra os funis de venda existentes e suas etapas, para o agente saber onde pode colocar uma oportunidade.",
    oQueToca: "Funil de vendas",
    risco: "seguro",
    pacotes: ["vender", "organizar"],
  },
  {
    name: "crm_create_lead",
    category: "write",
    description: "Cria um lead",
    rotulo: "Criar oportunidade no funil",
    explicacao:
      "Registra uma nova oportunidade de venda no funil, para que o interesse demonstrado pelo cliente não se perca.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_update_lead",
    category: "write",
    description: "Atualiza campos de um lead",
    rotulo: "Atualizar uma oportunidade",
    explicacao:
      "Altera dados de uma oportunidade de venda: valor do negócio, responsável e informações colhidas na conversa.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
  {
    name: "crm_move_lead_stage",
    category: "write",
    description: "Move lead para outro stage",
    rotulo: "Mover oportunidade de etapa",
    explicacao:
      "Move a oportunidade para outra etapa do funil, registrando o avanço da negociação ou a perda do negócio.",
    oQueToca: "Funil de vendas",
    risco: "atencao",
    pacotes: ["vender"],
  },
]);
