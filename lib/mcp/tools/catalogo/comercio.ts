/**
 * Capacidades de COMÉRCIO e PRIVACIDADE — o que o cliente comprou, o que existe
 * à venda, e quem pediu para sair.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_COMERCIO = declararTools([
  {
    name: "crm_list_contact_orders",
    category: "read",
    description:
      "Lista os pedidos de um contato, do mais recente para o mais antigo, com status, valor, " +
      "forma de pagamento, situação de entrega e código de rastreio.",
    rotulo: "Ver as compras do cliente",
    explicacao:
      "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.",
    oQueToca: "Compras do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_search_products",
    category: "read",
    description:
      "Busca produtos do catálogo da loja por parte do nome. Devolve preço, quantidade " +
      "disponível e link.",
    rotulo: "Procurar produto na loja",
    explicacao:
      "Procura um produto pelo nome e devolve preço e quantidade em estoque, para o assistente responder com o dado da loja em vez de estimar.",
    oQueToca: "Catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_list_privacy_requests",
    category: "read",
    description:
      "Lista pedidos de privacidade (LGPD) da organização, com tipo, situação, chegada e prazo. " +
      "NÃO executa nada: é leitura.",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
]);
