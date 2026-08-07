/**
 * Capacidades de GOVERNANCA — fila, direcionamento, marcadores e a passagem
 * do atendimento automatico para uma pessoa.
 *
 * `description` fala com o modelo; `rotulo`/`explicacao`/`oQueToca` falam com o
 * humano que configura o agente. Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 */
import { declararTools } from "./tipos";

export const TOOLS_GOVERNANCA = declararTools([
  {
    name: "crm_get_queue_status",
    category: "read",
    description: "Snapshot da fila de atendimento da org",
    rotulo: "Ver a fila de atendimento",
    explicacao:
      "Mostra quantas pessoas estão esperando atendimento agora e há quanto tempo, para priorizar quem espera mais.",
    oQueToca: "Atendimento",
    risco: "seguro",
    pacotes: ["atender", "escalar"],
  },
  {
    name: "crm_assign_conversation",
    category: "write",
    description: "Atribui/transfere/libera uma conversa",
    rotulo: "Direcionar conversa para alguém",
    explicacao:
      "Passa a conversa para um atendente, transfere para outra pessoa ou devolve o cliente para a fila de espera.",
    oQueToca: "Atendimento",
    risco: "atencao",
    pacotes: ["escalar", "atender"],
  },
  {
    name: "crm_manage_tags",
    category: "write",
    description: "Adiciona/remove tags em conversation/contact/lead",
    rotulo: "Aplicar marcadores",
    explicacao:
      "Adiciona ou remove marcadores numa conversa, cliente ou oportunidade, para organizar e filtrar a operação depois.",
    oQueToca: "Organização da operação",
    risco: "atencao",
    pacotes: ["organizar", "atender"],
  },
  {
    name: "crm_request_human_handoff",
    category: "handoff",
    description: "Solicita handoff para atendente humano",
    rotulo: "Chamar um atendente humano",
    explicacao:
      "Interrompe o atendimento automático e chama uma pessoa, entregando um resumo do que já aconteceu na conversa.",
    oQueToca: "Atendimento",
    risco: "atencao",
    pacotes: ["escalar"],
  },
]);
