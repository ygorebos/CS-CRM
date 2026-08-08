/**
 * A regra que escolhe o número do upsert, como função pura (T027b, FR-020).
 *
 * O invariante irmão (`tests/invariants/gateway-inbound-identidade-canonica.test.ts`)
 * prova que a regra, contra o schema que o clone recebe, colapsa as duas grafias num
 * contato e numa conversa. Aqui se cobra a outra metade: QUANDO ela busca, quando
 * não busca, e o que devolve — inclusive nos casos que ela precisa deixar em paz.
 *
 * O caso mais valioso deste arquivo é o do FIXO. A regra existe para unir a mesma
 * pessoa; unir demais é pior que não unir, porque fusão de contato não tem volta.
 * Um `9` grudado num número de fixo geraria a variante de OUTRA pessoa real, e o
 * histórico de duas pessoas viraria um só — sem sintoma, e sem desfazer.
 */
import { describe, expect, it, vi } from "vitest";

import { numeroCanonicoParaUpsert } from "@/lib/channels/identidade-canonica";

const COM_NONO = "+5531998966398";
const SEM_NONO = "+553198966398";

describe("número canônico para o upsert de contato", () => {
  it("devolve a grafia JÁ CADASTRADA quando o contato existe sob a outra", async () => {
    const buscar = vi.fn(async () => COM_NONO);

    // Chega o `wa_id` do recebimento (12 dígitos) e o cadastro está com 13.
    await expect(numeroCanonicoParaUpsert(SEM_NONO, buscar)).resolves.toBe(COM_NONO);

    // As DUAS grafias vão para a busca: procurar só pela que chegou é
    // exatamente o defeito que a regra existe para consertar.
    expect(buscar).toHaveBeenCalledWith([SEM_NONO, COM_NONO]);
  });

  it("devolve o número recebido quando ninguém está cadastrado ainda", async () => {
    const buscar = vi.fn(async () => null);
    // Primeiro contato da pessoa: grava a grafia que chegou, sem inventar outra.
    await expect(numeroCanonicoParaUpsert(COM_NONO, buscar)).resolves.toBe(COM_NONO);
  });

  it("NÃO busca quando o número não tem contraparte possível", async () => {
    const buscar = vi.fn(async () => null);

    // Fixo brasileiro: o local começa em 3, fora da faixa de celular. Gerar
    // variante aqui produziria o celular de outra pessoa.
    await expect(numeroCanonicoParaUpsert("+553132345678", buscar)).resolves.toBe(
      "+553132345678",
    );
    // Fora do Brasil o nono dígito não existe.
    await expect(numeroCanonicoParaUpsert("+14155550123", buscar)).resolves.toBe(
      "+14155550123",
    );

    // Nenhuma das duas chega a consultar o banco: sem contraparte, a busca seria
    // um `select` que nunca muda a resposta.
    expect(buscar).not.toHaveBeenCalled();
  });

  it("número vazio ou sem dígitos devolve o que chegou, sem consultar", async () => {
    const buscar = vi.fn(async () => null);
    // Nada a canonicalizar. Quem trata identificador inválido é o classificador do
    // ingest; aqui, inventar um número seria pior que devolver o de entrada.
    await expect(numeroCanonicoParaUpsert("", buscar)).resolves.toBe("");
    expect(buscar).not.toHaveBeenCalled();
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Devolver sempre `numeroRecebido`
 *     → "devolve a grafia JÁ CADASTRADA" cai.
 *  2. Mandar só a primeira variante para `buscar`
 *     → a asserção do argumento cai (e o defeito voltaria em silêncio).
 *  3. Remover o corte de `variantes.length === 1`
 *     → "NÃO busca quando o número não tem contraparte" cai.
 */
