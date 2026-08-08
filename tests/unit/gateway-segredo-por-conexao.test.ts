/**
 * O segredo de webhook de uma conexão precisa SER um segredo (T017a da spec 001).
 *
 * ## O defeito que este arquivo congela
 *
 * As duas rotas que criam conexão gravavam `webhook_secret_encrypted:
 * Buffer.from([0])` — um byte. A coluna é `NOT NULL`, alguém precisou pôr algo,
 * e o que foi posto não era segredo.
 *
 * Passou despercebido porque o único consumidor era o webhook legado, cuja
 * autenticação tem uma válvula que aceita entrega sem assinatura (o emissor
 * daquele caminho não sabe assinar). O placeholder caía no ramo de exceção — e o
 * ramo de exceção era o estado PERMANENTE de toda instalação.
 *
 * A entrega do gateway é fail-closed **sem válvula**. Com o placeholder ela
 * recusaria 100% das entregas de qualquer conexão criada pelo onboarding, que é
 * o caminho do corretor.
 *
 * Este arquivo é unitário de propósito: ele vigia o GERADOR e o DETECTOR de
 * placeholder, que são puros. A prova de que a rota realmente grava o segredo
 * gerado — e de que nenhuma linha nasce com placeholder — é de banco, e vive em
 * `tests/invariants/`.
 */
import { describe, expect, it } from "vitest";

import { TAMANHO_MINIMO_DO_SEGREDO } from "@/lib/gateway/auth";
import {
  gerarSegredoDeWebhook,
  pareceSegredoPlaceholder,
} from "@/lib/webhooks/provisionar-segredo";

describe("segredo de webhook por conexão", () => {
  it("o segredo gerado é longo o bastante para a verificação de assinatura aceitar", () => {
    const s = gerarSegredoDeWebhook();
    // Se este número cair abaixo do mínimo, TODA entrega do gateway passa a ser
    // recusada com `segredo_nao_provisionado` — e o sintoma aparece longe daqui.
    expect(s.length).toBeGreaterThanOrEqual(TAMANHO_MINIMO_DO_SEGREDO);
    expect(s.length).toBe(64);
    expect(s).toMatch(/^[0-9a-f]+$/);
  });

  it("dois segredos nunca são iguais — vazamento num tenant não abre outro", () => {
    const amostra = new Set(Array.from({ length: 200 }, () => gerarSegredoDeWebhook()));
    expect(amostra.size).toBe(200);
  });

  it("o placeholder de um byte é reconhecido como não-segredo", () => {
    // É literalmente o que as duas rotas gravavam: Buffer.from([0]).
    expect(pareceSegredoPlaceholder("\\x00")).toBe(true);
    expect(pareceSegredoPlaceholder("00")).toBe(true);
    expect(pareceSegredoPlaceholder("")).toBe(true);
    expect(pareceSegredoPlaceholder(null)).toBe(true);
    expect(pareceSegredoPlaceholder(undefined)).toBe(true);
  });

  it("um envelope cifrado de verdade NÃO é confundido com placeholder", () => {
    // `pgp_sym_encrypt` de um segredo de 64 chars produz centenas de bytes; o
    // limiar existe para separar isso do `\x00`, não para julgar conteúdo.
    const cifradoRealista = "\\x" + "ab".repeat(180);
    expect(pareceSegredoPlaceholder(cifradoRealista)).toBe(false);
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Voltar `gerarSegredoDeWebhook` para `randomBytes(4)`
 *     → "o segredo gerado é longo o bastante" cai.
 *  2. Fazer `pareceSegredoPlaceholder` devolver sempre `false`
 *     → "o placeholder de um byte é reconhecido" cai, e a cura das linhas
 *       antigas passaria por cima de todas elas sem curar nenhuma.
 */
