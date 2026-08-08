/**
 * De onde sai o endereço da conexão quando o canal é do gateway (spec 004, T035).
 *
 * ## O defeito que este arquivo impede
 *
 * `resolveSessionRef` é o único lugar autorizado a saber de que COLUNA sai o
 * identificador da sessão. Ele nasceu com dois ramos (`waha`, `meta_cloud`) e o
 * `switch` é exaustivo no TypeScript — o que significa que um provider fora da
 * união **não reprova o typecheck**: ele cai fora de todos os `case` e a função
 * devolve `undefined` em tempo de execução.
 *
 * Medido em 2026-08-08, com o adapter do gateway já ligado na matriz: uma sessão
 * `whatsapp_uazapi` produzia `sessionRef: undefined`, e o `JSON.stringify` do
 * corpo **apaga chave undefined**. O gateway recebia um POST sem `connection_id`
 * — isto é, sem saber por qual número mandar. Cada envio de canal migrado
 * morreria assim, com o typecheck zerado e o teste do adapter verde (ele passa o
 * `sessionRef` na mão).
 *
 * É o mesmo defeito que a FR-020 nomeia por outro caminho: mandar para o lugar
 * errado — ou para lugar nenhum — em silêncio.
 *
 * ## Por que o teste é da MATRIZ, e não de um provider
 *
 * O caso `whatsapp_uazapi` consertado sozinho não impede o próximo. Quem
 * acrescentar `instagram` à matriz de envio vai acrescentar um adapter, não uma
 * coluna de referência — e o `undefined` volta pela mesma porta. Por isso a
 * asserção varre `providersQuePodemEnviar()`.
 */
import { describe, expect, it } from "vitest";

import { providersQuePodemEnviar } from "@/lib/channels";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import type { ChannelSessionRef } from "@/lib/channels/session-ref";

/**
 * Uma linha de `channel_sessions` por provider que sabe enviar, com a coluna de
 * referência que o CHECK `channel_sessions_provider_ref_check` exige daquele
 * ramo (`baseline.sql`) — e as outras nulas, como o banco garante.
 */
const LINHA_POR_PROVIDER: Record<string, { linha: ChannelSessionRef; esperado: string }> = {
  waha: {
    linha: { provider: "waha", waha_session_name: "sessao-do-waha" },
    esperado: "sessao-do-waha",
  },
  meta_cloud: {
    linha: { provider: "meta_cloud", meta_phone_number_id: "1234567890" },
    esperado: "1234567890",
  },
  whatsapp_uazapi: {
    linha: { provider: "whatsapp_uazapi", gateway_connection_id: "conn-uuid-do-gateway" },
    esperado: "conn-uuid-do-gateway",
  },
};

describe("endereço da conexão no envio (FR-017 / FR-020)", () => {
  it("todo provider que sabe enviar tem ramo de referência — nenhum devolve undefined", () => {
    for (const provider of providersQuePodemEnviar()) {
      const caso = LINHA_POR_PROVIDER[provider];
      expect(
        caso,
        `O provider '${provider}' entrou na matriz de envio mas ninguém disse de que coluna\n` +
          "sai a referência da sessão dele. Acrescente o ramo em lib/channels/session-ref.ts\n" +
          "e a linha correspondente aqui — sem isso o envio sai sem endereço, em silêncio.",
      ).toBeDefined();

      const ref = resolveSessionRef(caso!.linha);
      expect(
        ref,
        `resolveSessionRef devolveu ${JSON.stringify(ref)} para '${provider}'. ` +
          "JSON.stringify apaga chave undefined: o canal receberia um envio SEM destino.",
      ).toBe(caso!.esperado);
    }
  });

  it("a coluna de cada ramo entra no select — senão o ref chega nulo mesmo com o ramo certo", () => {
    // O `switch` consertado não basta: se a coluna não estiver na lista que as
    // features usam no `select` do PostgREST, ela chega `undefined` do banco e o
    // defeito reaparece idêntico, um nível acima.
    for (const provider of providersQuePodemEnviar()) {
      const linha = LINHA_POR_PROVIDER[provider]?.linha;
      if (!linha) continue;
      const coluna = Object.keys(linha).find((k) => k !== "provider")!;
      expect(
        CHANNEL_SESSION_REF_COLUMNS.split(",").map((c) => c.trim()),
        `'${coluna}' é a referência de '${provider}' e não está em CHANNEL_SESSION_REF_COLUMNS.`,
      ).toContain(coluna);
    }
  });

  it("linha sem a referência do próprio ramo falha ALTO, nunca com undefined", () => {
    // O CHECK do banco proíbe esta linha; ela só existe se alguém esqueceu a
    // coluna no `select`. Falhar aqui vira mensagem `failed` com erro legível no
    // handler de envio (o `resolveSessionRef` é chamado dentro do try) — que é
    // infinitamente melhor que um POST sem destino que o canal aceita calado.
    expect(() =>
      resolveSessionRef({ provider: "whatsapp_uazapi", gateway_connection_id: null } as never),
    ).toThrow(/sem referência|missing_session_ref/i);
  });
});
