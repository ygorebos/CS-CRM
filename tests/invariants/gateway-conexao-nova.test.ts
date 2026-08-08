/**
 * A conexão nova nasce no caminho que a instalação usa (T058b, US4).
 *
 * ## A diferença entre "funciona" e "parece funcionar"
 *
 * O default de `channel_sessions.ingest_path` é `'legacy'`, e está certo assim:
 * as linhas que já existiam quando a 0116 rodou estavam recebendo pelo caminho
 * antigo naquele instante, e virar a chave delas em massa seria mudar o
 * comportamento de todo mundo sem aviso.
 *
 * Para conexão criada DEPOIS, herdar esse default é defeito silencioso: o
 * gateway está de pé, o operador conecta um número, e o número recebe pelo
 * caminho legado. As mensagens entram — então ninguém percebe — mas o serviço
 * novo nunca é exercitado, e a primeira vez que alguém confia nele é em
 * produção.
 *
 * ## Por que este arquivo é de banco
 *
 * O que se cobra é o VALOR QUE POUSA na coluna, com o default, o CHECK e a
 * migration reais no caminho. Um teste unitário sobre a função de decisão prova
 * a regra; só o banco prova que a regra chegou à linha — e é a linha que a rota
 * de recebimento vai ler.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";
import { caminhoDeIngestaoParaConexaoNova } from "@/lib/gateway/caminho-de-ingestao";

const ORG = "dddd0058-0000-4000-8000-000000000001";

function semear(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'inv-t058', 'Org do T058', 'Org do T058')
    on conflict (id) do nothing;
  `);
}

function criarConexao(sufixo: string, ingestPath?: string): string {
  const colunaExtra = ingestPath ? ", ingest_path" : "";
  const valorExtra = ingestPath ? `, '${ingestPath}'` : "";
  sql(`
    insert into public.channel_sessions
      (organization_id, waha_session_name, webhook_secret_encrypted,
       webhook_path_token${colunaExtra})
    values
      ('${ORG}', 'sessao-${sufixo}', '\\x00'::bytea, 'tok_${sufixo}'${valorExtra});
  `);
  return sql(
    `select ingest_path from public.channel_sessions where webhook_path_token = 'tok_${sufixo}' limit 1;`,
  ).trim();
}

describe("caminho de ingestão da conexão nova (T058b)", () => {
  it("a coluna existe com default 'legacy' — a linha antiga não muda de comportamento sozinha", () => {
    semear();
    // Este é o caso da instalação que já rodava antes da 0116: sem valor
    // explícito, continua no caminho em que estava.
    expect(criarConexao("t058_default")).toBe("legacy");
  });

  it("com o recebimento LIGADO, a regra manda a conexão nova nascer no gateway", () => {
    semear();
    const decidido = caminhoDeIngestaoParaConexaoNova(true);
    expect(decidido).toBe("gateway");
    // E o valor decidido pousa mesmo — o CHECK da 0116 aceita, e não vira
    // `legacy` no meio do caminho.
    expect(criarConexao("t058_ligado", decidido)).toBe("gateway");
  });

  it("com o recebimento DESLIGADO, a conexão nova nasce no legado", () => {
    semear();
    const decidido = caminhoDeIngestaoParaConexaoNova(false);
    // Nascer 'gateway' aqui criaria a combinação que o aviso da 0119 denuncia:
    // conexão apontada para uma rota desligada, que responde 404 e faz o
    // gateway descartar sem retentar. A conexão nasceria muda.
    expect(decidido).toBe("legacy");
    expect(criarConexao("t058_desligado", decidido)).toBe("legacy");
  });

  it("o CHECK recusa um terceiro caminho — vocabulário fechado, e não texto livre", () => {
    semear();
    let recusou = false;
    try {
      criarConexao("t058_invalido", "sei_la");
    } catch {
      recusou = true;
    }
    // Sem o CHECK, um typo (`gatewey`) faria a conexão cair no caminho legado
    // em silêncio — que é o defeito com a pior relação entre custo de digitar
    // e custo de descobrir.
    expect(recusou).toBe(true);
  });

  it("conexão que já existia em 'legacy' NÃO é convertida por nada disto", () => {
    semear();
    criarConexao("t058_antiga", "legacy");
    // A regra vale para o nascimento. Converter em massa é decisão de operação,
    // com prova antes e caminho de volta — não efeito colateral de um deploy.
    const depois = sql(
      `select ingest_path from public.channel_sessions where webhook_path_token = 'tok_t058_antiga' limit 1;`,
    ).trim();
    expect(depois).toBe("legacy");
  });
});
