/**
 * A dispensa de MFA e a trava que a torna segura.
 *
 * O caso que importa aqui NÃO é "a chave desliga o MFA" — é o contrário: a
 * chave ligada num ambiente com URL pública **não desliga nada**. Uma variável
 * que remove segundo fator é exatamente o que viaja escondido num `.env`
 * copiado para o servidor, e o sintoma de um vazamento desses é a ausência de
 * uma tela, que ninguém repara.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = { NEXT_PUBLIC_APP_URL: "", MFA_DISPENSADA_LOCAL: "" };

vi.mock("@/lib/env", () => ({ env: envMock }));

async function dispensada(appUrl: string, chave: string): Promise<boolean> {
  envMock.NEXT_PUBLIC_APP_URL = appUrl;
  envMock.MFA_DISPENSADA_LOCAL = chave;
  const { mfaDispensadaNesteAmbiente } = await import("@/lib/auth/mfa-ambiente");
  return mfaDispensadaNesteAmbiente();
}

beforeEach(() => {
  envMock.NEXT_PUBLIC_APP_URL = "";
  envMock.MFA_DISPENSADA_LOCAL = "";
});

describe("dispensa de MFA fora de produção", () => {
  it("dispensa em localhost com a chave ligada", async () => {
    expect(await dispensada("http://localhost:3000", "true")).toBe(true);
    expect(await dispensada("http://127.0.0.1:3100", "true")).toBe(true);
  });

  it("NÃO dispensa em endereço público, mesmo com a chave ligada", async () => {
    expect(await dispensada("https://app.deskcomm.com.br", "true")).toBe(false);
    expect(await dispensada("https://localhost", "true")).toBe(false); // https = produção
    expect(await dispensada("http://crm.exemplo.com", "true")).toBe(false);
  });

  it("NÃO dispensa sem a chave, mesmo em localhost", async () => {
    expect(await dispensada("http://localhost:3000", "")).toBe(false);
    expect(await dispensada("http://localhost:3000", "1")).toBe(false);
    expect(await dispensada("http://localhost:3000", "sim")).toBe(false);
  });

  it("NÃO dispensa com URL ausente ou malformada", async () => {
    expect(await dispensada("", "true")).toBe(false);
    expect(await dispensada("localhost:3000", "true")).toBe(false);
  });
});
