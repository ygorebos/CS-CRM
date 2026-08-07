/**
 * Capacidades de RETENÇÃO — o pacote "Não perder o cliente".
 *
 * Este é o pacote do invariante 4 da doutrina (`docs/doctrine/sistema-vivo.md`):
 * nenhuma demanda aberta pode ficar sem próximo passo definido e visível. Até
 * esta wave ele estava VAZIO — a máquina de retorno existia, rodava e era
 * invisível para o agente que o dono da clínica configura na tela. Um agente que
 * não consegue marcar um retorno não consegue cumprir a missão do sistema.
 *
 * As duas saídas do invariante estão aqui: marcar o próximo passo (agendar,
 * cancelar, listar retorno) e registrar o desfecho (encerrar a demanda). Sem a
 * segunda, o anti-morte fica pela metade e o radar enche de negócio que já acabou.
 *
 * `description` fala com o modelo; `rotulo`/`explicacao`/`oQueToca` falam com o
 * humano que configura o agente. Ver `docs/handoffs/BRIEFING-ia-360.md` §4.
 *
 * ⚠️ "FOLLOW-UP" NÃO APARECE NO TEXTO DO HUMANO. Para o dono da clínica isso se
 * chama RETORNO ou acompanhamento — o gate mecânico
 * (`tests/unit/catalogo-tools-leigo-friendly.test.ts`) reprova o jargão, e a
 * palavra continua existindo só no `name`, que é contrato de wire.
 */
import { declararTools } from "./tipos";

export const TOOLS_RETENCAO = declararTools([
  {
    name: "crm_schedule_followup",
    category: "write",
    description:
      "Agenda um retorno futuro ao cliente (cron_job one-shot kind='at', job_kind='followup_turn'). " +
      "Informe lead_id OU contact_id; promised_at é ISO 8601 ABSOLUTO e no futuro, dentro da janela " +
      "aceitável da organização. Recusa se já houver retorno vivo para o contato (1 por contato — " +
      "anti-empilhamento). Emite atividade na timeline do negócio.",
    rotulo: "Agendar um retorno para o cliente",
    explicacao:
      "Marca um horário para o agente voltar a falar com o cliente, para que a conversa não morra sem resposta.",
    oQueToca: "Retornos e acompanhamento",
    // `atencao` e não `critico`: agendar não fala com ninguém agora. O envio no
    // horário combinado passa pelos mesmos portões de sempre, e o humano vê o
    // retorno na fila e no Radar, com botão de cancelar. É reversível pela tela —
    // que é exatamente a definição deste nível.
    risco: "atencao",
    pacotes: ["reter"],
  },
  {
    name: "crm_cancel_followup",
    category: "write",
    description:
      "Cancela um retorno agendado que ainda não disparou (marca cancelled_at + cancel_reason). " +
      "Use quando o cliente já respondeu ou o motivo do retorno deixou de existir. " +
      "Recusa se o retorno já disparou ou já foi cancelado. Emite atividade na timeline.",
    rotulo: "Cancelar um retorno agendado",
    explicacao:
      "Desmarca um retorno que ainda não aconteceu, para o agente não insistir com quem já respondeu.",
    oQueToca: "Retornos e acompanhamento",
    risco: "atencao",
    pacotes: ["reter"],
  },
  {
    name: "crm_list_followups",
    category: "read",
    description:
      "Lista os retornos de um cliente (informe lead_id OU contact_id), do mais próximo para o mais " +
      "antigo, com a situação de cada um: agendado, disparado ou cancelado (com o motivo). " +
      "É por aqui que o agente descobre que um humano desmarcou um retorno.",
    rotulo: "Ver os retornos de um cliente",
    explicacao:
      "Mostra os retornos combinados com o cliente: o que está marcado, o que já aconteceu e o que foi desmarcado.",
    oQueToca: "Retornos e acompanhamento",
    risco: "seguro",
    pacotes: ["reter"],
  },
  {
    name: "crm_list_at_risk_leads",
    category: "read",
    description:
      "Radar de risco: oportunidades ABERTAS que passaram da janela de esfriamento do próprio " +
      "estágio, classificadas em critico / em_risco / em_voo (em_voo = há retorno agendado). " +
      "Ordenado por urgência. Aceita limit e min_hours.",
    rotulo: "Ver quem esfriou e está sem resposta",
    explicacao:
      "Lista as oportunidades abertas que passaram do prazo sem movimento, das mais críticas para as menos urgentes.",
    oQueToca: "Radar de risco",
    risco: "seguro",
    pacotes: ["reter"],
  },
  {
    name: "crm_close_demand",
    category: "write",
    description:
      "Encerra a demanda movendo a oportunidade para o estágio terminal do funil: outcome='won' ou " +
      "outcome='lost' (neste, reason é obrigatório). O status e a data de fechamento são do trigger. " +
      "Idempotente. Emite atividade na timeline.",
    rotulo: "Encerrar o negócio como ganho ou perdido",
    explicacao:
      "Fecha a oportunidade dizendo se ela foi ganha ou perdida e por quê, para o que já acabou parar de ser cobrado.",
    oQueToca: "Funil de vendas",
    // `critico` porque encerrar é o desfecho: o negócio sai do quadro, some do
    // radar e das cobranças, e voltar atrás é trabalho manual. Nunca entra ligado
    // por pacote — exige marcação explícita de quem configura.
    risco: "critico",
    pacotes: ["reter"],
  },
  {
    name: "crm_propose_reactivation",
    category: "write",
    description:
      "Cria uma proposta de reativação (crm_lead_reactivations, status='pending') para uma " +
      "oportunidade que esfriou. A proposta VENCE sozinha na mesma janela do esfriamento e o envio " +
      "só acontece se um humano aprovar. Recusa se já houver proposta viva ou se não houver contato.",
    rotulo: "Sugerir retomar contato com quem sumiu",
    explicacao:
      "Cria uma sugestão de retomar o contato com um cliente que esfriou, para uma pessoa aprovar antes de qualquer envio.",
    oQueToca: "Radar de risco",
    // Escreve uma SUGESTÃO que uma pessoa decide — nada sai para o cliente por
    // conta dela. É `atencao`, e o `critico` mora na aprovação humana.
    risco: "atencao",
    pacotes: ["reter"],
  },
]);
