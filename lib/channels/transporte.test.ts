/**
 * A resolução de transporte (spec 005, T001/T007).
 *
 * O que se cobra aqui não é só a tabela-verdade: é a **equivalência com as três
 * formas antigas**. Elas continuam existindo no histórico e na cabeça de quem
 * revisa, e a única prova de que a unificação não mudou comportamento é rodar as
 * quatro sobre a mesma combinação de ambiente e exigir o mesmo desfecho.
 *
 * A forma antiga que mais importa é a do onboarding — `getWahaClient() !== null`
 * —, porque foi ela que ficou para trás e produziu o defeito que a spec conserta:
 * gateway ligado, WAHA ausente, e a primeira tela do usuário dizendo que o
 * serviço está indisponível.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { GATEWAY_BASE_URL: "", GATEWAY_ADMIN_TOKEN: "" },
}));
import { env as envFalso } from "@/lib/env";

import { legadoConfigurado, transporteDaInstalacao } from "./transporte";
import { provisionamentoConfigurado } from "@/lib/gateway/provisionamento";
import { getWahaClient } from "@/lib/waha/client";

/** Liga ou desliga cada transporte pelo mesmo lugar que a produção lê. */
function ambiente(opcoes: { gateway: boolean; legado: boolean }) {
  envFalso.GATEWAY_BASE_URL = opcoes.gateway ? "https://gw.exemplo" : "";
  envFalso.GATEWAY_ADMIN_TOKEN = opcoes.gateway ? "tok-admin" : "";
  if (opcoes.legado) {
    vi.stubEnv("WAHA_API_BASE_URL", "https://waha.exemplo");
    vi.stubEnv("WAHA_API_KEY", "chave-de-verdade");
  } else {
    vi.stubEnv("WAHA_API_BASE_URL", "");
    vi.stubEnv("WAHA_API_KEY", "");
  }
}

beforeEach(() => {
  ambiente({ gateway: false, legado: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("transporteDaInstalacao", () => {
  it("com os dois configurados, o gateway ganha", () => {
    ambiente({ gateway: true, legado: true });
    // A precedência é regra de produto, não detalhe: nascer no legado com o
    // serviço novo de pé cria, no ato do cadastro, uma migração a mais para a
    // Fase 2 fazer depois.
    expect(transporteDaInstalacao()).toBe("gateway");
  });

  it("só gateway", () => {
    ambiente({ gateway: true, legado: false });
    expect(transporteDaInstalacao()).toBe("gateway");
  });

  it("só legado", () => {
    ambiente({ gateway: false, legado: true });
    expect(transporteDaInstalacao()).toBe("legacy");
  });

  it("nenhum transporte devolve null, e null não é erro", () => {
    ambiente({ gateway: false, legado: false });
    expect(transporteDaInstalacao()).toBeNull();
  });

  it("a chave de exemplo não conta como legado configurado", () => {
    // Instalação que copiou o `.env.example` e não trocou a chave se declararia
    // pronta e falharia só na primeira mensagem. As duas formas antigas já
    // tinham esta guarda; perdê-la na unificação seria regressão silenciosa.
    envFalso.GATEWAY_BASE_URL = "";
    envFalso.GATEWAY_ADMIN_TOKEN = "";
    vi.stubEnv("WAHA_API_BASE_URL", "https://waha.exemplo");
    vi.stubEnv("WAHA_API_KEY", "dev_plaintext_change_me");
    expect(legadoConfigurado()).toBe(false);
    expect(transporteDaInstalacao()).toBeNull();
  });

  it("as fontes são injetáveis e lidas a cada chamada", () => {
    let gatewayLigado = false;
    const fontes = {
      gatewayPronto: () => gatewayLigado,
      legadoPronto: () => false,
    };
    expect(transporteDaInstalacao(fontes)).toBeNull();
    gatewayLigado = true;
    // Se a resolução congelasse no import, esta segunda chamada ainda devolveria
    // null — e num processo longo, como o worker, a resposta envelheceria.
    expect(transporteDaInstalacao(fontes)).toBe("gateway");
  });
});

describe("equivalência com as três formas antigas", () => {
  const combinacoes = [
    { gateway: false, legado: false },
    { gateway: false, legado: true },
    { gateway: true, legado: false },
    { gateway: true, legado: true },
  ];

  it.each(combinacoes)(
    "gateway=$gateway legado=$legado: a nova concorda com as antigas",
    (combinacao) => {
      ambiente(combinacao);

      // Forma antiga 1 — app/onboarding/connect-whatsapp/page.tsx
      const formaOnboarding = getWahaClient() !== null;
      // Forma antiga 2 — app/api/v1/channel-sessions/route.ts
      const formaCentral = provisionamentoConfigurado();
      // Forma antiga 3 — app/app/connections/page.tsx
      const formaConexoes = formaOnboarding || formaCentral;

      const novo = transporteDaInstalacao();

      // O que a Central perguntava: "provisiono pelo gateway?"
      expect(novo === "gateway").toBe(formaCentral);
      // O que a tela de Conexões perguntava: "há ALGUM caminho?"
      expect(novo !== null).toBe(formaConexoes);
      // E o legado sozinho continua sendo medido igual.
      expect(legadoConfigurado()).toBe(formaOnboarding);
    },
  );

  it("o caso que o onboarding errava: gateway ligado e WAHA ausente", () => {
    ambiente({ gateway: true, legado: false });
    // A forma antiga do onboarding respondia `false` aqui, e a tela mostrava
    // "serviço indisponível" a quem acabara de se cadastrar. É O defeito.
    expect(getWahaClient() !== null).toBe(false);
    // A nova responde que há transporte — e a tela mostra o QR.
    expect(transporteDaInstalacao()).toBe("gateway");
  });
});
