/**
 * O teto da rota de recebimento não pode brigar com a rajada (T015a da spec 001).
 *
 * A spec pede duas coisas que puxam para lados opostos: a rota é pública e
 * precisa de teto (Princípio VI), e **200 mensagens em 60 segundos** têm de
 * entrar inteiras (SC-010). Uma campanha respondida por muita gente ao mesmo
 * tempo é exatamente esse cenário — e é um dia bom para o corretor.
 *
 * Sem este arquivo, os dois requisitos coexistiriam no escuro: alguém escolheria
 * um número "prudente", a rajada seria descartada em produção, e o sintoma
 * (mensagens sumindo em pico) seria indistinguível de o sistema estar fora do ar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checarTetoDaConexao,
  JANELA_SEGUNDOS,
  RAJADA_ALVO_POR_MINUTO,
  TETO_POR_CONEXAO,
} from "@/lib/gateway/rate-limit";

/**
 * O contador real é compartilhado (Redis quando configurado). Aqui se exercita a
 * DECISÃO desta camada — teto, folga e cabeçalhos —, então o contador é mockado:
 * um teste que dependesse do balde real seria não-determinístico e acumularia
 * entre execuções, que é exatamente a armadilha que já mordeu a suíte de auth
 * deste repositório.
 */
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(),
}));

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";

const mockado = vi.mocked(checkRateLimit);

function contagem(n: number) {
  mockado.mockResolvedValue({
    allowed: n <= TETO_POR_CONEXAO,
    count: n,
    limit: TETO_POR_CONEXAO,
    window_sec: JANELA_SEGUNDOS,
  });
}

describe("teto de entregas por conexão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("o teto é FOLGADO em relação ao alvo de rajada da spec", () => {
    // É a asserção que impede alguém de "endurecer" o limite sem perceber que
    // está descartando a resposta de clientes reais.
    expect(TETO_POR_CONEXAO).toBeGreaterThan(RAJADA_ALVO_POR_MINUTO);
    expect(JANELA_SEGUNDOS).toBe(60);
  });

  it("a rajada inteira do SC-010 passa dentro da janela", async () => {
    for (const n of [1, 50, RAJADA_ALVO_POR_MINUTO]) {
      contagem(n);
      const v = await checarTetoDaConexao("tok_abc");
      expect(v.permitido, `entrega nº ${n} deveria passar`).toBe(true);
    }
  });

  it("acima do teto recusa e diz quando voltar", async () => {
    contagem(TETO_POR_CONEXAO + 1);
    const agora = 1_800_000_000_000; // ms
    const v = await checarTetoDaConexao("tok_abc", agora);

    expect(v.permitido).toBe(false);
    // Sem `Retry-After` o emissor reentrega em ritmo próprio e pode ficar preso
    // no teto indefinidamente.
    expect(v.cabecalhos["Retry-After"]).toBeDefined();
    expect(Number(v.cabecalhos["Retry-After"])).toBeGreaterThan(0);
    expect(Number(v.cabecalhos["Retry-After"])).toBeLessThanOrEqual(JANELA_SEGUNDOS);
  });

  it("os cabeçalhos de teto vão SEMPRE, inclusive quando a entrega passa", async () => {
    contagem(10);
    const v = await checarTetoDaConexao("tok_abc");
    expect(v.permitido).toBe(true);
    expect(v.cabecalhos["X-RateLimit-Limit"]).toBe(String(TETO_POR_CONEXAO));
    expect(v.cabecalhos["X-RateLimit-Remaining"]).toBe(String(TETO_POR_CONEXAO - 10));
    expect(v.cabecalhos["X-RateLimit-Reset"]).toBeDefined();
    // Só na recusa — mandar Retry-After em resposta aceita confunde o emissor.
    expect(v.cabecalhos["Retry-After"]).toBeUndefined();
  });

  it("o balde é POR CONEXÃO — a organização movimentada não cala as outras", async () => {
    contagem(1);
    await checarTetoDaConexao("tok_org_a");
    await checarTetoDaConexao("tok_org_b");

    const baldes = mockado.mock.calls.map((c) => c[0]);
    expect(baldes[0]).not.toBe(baldes[1]);
    expect(baldes[0]).toContain("tok_org_a");
    expect(baldes[1]).toContain("tok_org_b");
  });

  it("remaining nunca fica negativo", async () => {
    contagem(TETO_POR_CONEXAO + 500);
    const v = await checarTetoDaConexao("tok_abc");
    expect(Number(v.cabecalhos["X-RateLimit-Remaining"])).toBe(0);
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Baixar `TETO_POR_CONEXAO` para algo ≤ `RAJADA_ALVO_POR_MINUTO`
 *     → "o teto é FOLGADO" e "a rajada inteira passa" caem. É a proteção contra
 *       endurecer o limite sem perceber o custo.
 *  2. Trocar a chave do balde por algo fixo (sem o token da conexão)
 *     → "o balde é POR CONEXÃO" cai.
 *  3. Parar de mandar `Retry-After` na recusa
 *     → "acima do teto recusa e diz quando voltar" cai.
 */
