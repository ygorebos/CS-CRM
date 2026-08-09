/**
 * A cifra at-rest de segredos, feita na aplicação (`lib/crypto/envelope-secreto.ts`).
 *
 * ## O defeito que estes casos vigiam
 *
 * A cifra morava só no banco, atrás da GUC `app.nuvemshop_oauth_key`. No
 * Supabase gerenciado ela não pode ser setada — `ALTER DATABASE ... SET` de GUC
 * customizada exige superusuário, e o papel `postgres` não é um (medido em
 * 2026-08-08: `permission denied to set parameter`). Consequência: `fn_encrypt_oauth`
 * sempre lançava, `criarConexaoDeCanal` recusava antes de gravar, e NENHUMA
 * conexão de canal conseguia nascer — nem por WAHA nem pelo gateway.
 *
 * O que precisa ficar provado, então, não é "AES funciona". É:
 *  1. com chave no ambiente, a escrita NÃO chama o banco (é isso que destrava);
 *  2. segredo antigo (pgp_sym) continua legível pelo banco depois da virada —
 *     senão a virada apagaria a única conexão que já existe;
 *  3. envelope adulterado devolve null em vez de lançar — a rota do gateway é
 *     fail-closed, e um 500 ali convidaria o emissor a repetir a entrega forjada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CHAVE_HEX = "a".repeat(64);

const rpc = vi.fn();
const admin = { rpc } as unknown as SupabaseClient;

vi.mock("@/lib/env", () => ({
  env: { SECRET_ENCRYPTION_KEY: CHAVE_HEX, NUVEMSHOP_OAUTH_ENCRYPTION_KEY: "" },
}));

async function modulos() {
  const envelope = await import("@/lib/crypto/envelope-secreto");
  const secrets = await import("@/lib/webhooks/secrets");
  return { ...envelope, ...secrets };
}

beforeEach(async () => {
  rpc.mockReset();
  const { esquecerChaveDeCifra } = await modulos();
  esquecerChaveDeCifra();
});

describe("envelope de segredo cifrado na aplicação", () => {
  it("faz round-trip do segredo", async () => {
    const { cifrarSegredo, decifrarSegredo } = await modulos();
    const segredo = "b".repeat(64);
    const cifrado = cifrarSegredo(segredo);
    expect(cifrado.startsWith("\\x")).toBe(true);
    expect(cifrado).not.toContain(segredo);
    expect(decifrarSegredo(cifrado)).toBe(segredo);
  });

  it("produz ciphertext diferente a cada chamada (IV novo)", async () => {
    const { cifrarSegredo } = await modulos();
    expect(cifrarSegredo("mesmo-segredo")).not.toBe(cifrarSegredo("mesmo-segredo"));
  });

  it("devolve null — sem lançar — em envelope adulterado", async () => {
    const { cifrarSegredo, decifrarSegredo } = await modulos();
    const cifrado = cifrarSegredo("segredo");
    // Vira o último byte do ciphertext: a tag GCM tem de recusar.
    const hex = cifrado.slice(2);
    const ultimo = parseInt(hex.slice(-2), 16) ^ 0xff;
    const adulterado = `\\x${hex.slice(0, -2)}${ultimo.toString(16).padStart(2, "0")}`;
    expect(decifrarSegredo(adulterado)).toBeNull();
  });

  it("não confunde ciphertext do pgp_sym com envelope local", async () => {
    const { ehEnvelopeLocal } = await modulos();
    // pgp_sym_encrypt começa no packet tag 0xC3.
    expect(ehEnvelopeLocal("\\xc30d04070302")).toBe(false);
    expect(ehEnvelopeLocal("")).toBe(false);
    expect(ehEnvelopeLocal(null)).toBe(false);
  });
});

describe("secrets.ts com a cifra local configurada", () => {
  it("cifra SEM chamar o banco — é o que destrava a criação de conexão", async () => {
    const { encryptWebhookSecret, decifrarSegredo } = await modulos();
    const cifrado = await encryptWebhookSecret(admin, "segredo-da-conexao");
    expect(rpc).not.toHaveBeenCalled();
    expect(cifrado).not.toBeNull();
    expect(decifrarSegredo(cifrado as string)).toBe("segredo-da-conexao");
  });

  it("lê de volta o que escreveu, sem tocar no banco", async () => {
    const { encryptWebhookSecret, decryptWebhookSecret } = await modulos();
    const cifrado = (await encryptWebhookSecret(admin, "segredo-ida-e-volta")) as string;
    rpc.mockReset();
    expect(await decryptWebhookSecret(admin, cifrado)).toBe("segredo-ida-e-volta");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("segredo ANTIGO continua indo para o RPC do banco", async () => {
    const { decryptWebhookSecret } = await modulos();
    rpc.mockResolvedValue({ data: "segredo-legado", error: null });
    const antigo = "\\xc30d040703024ee0";
    expect(await decryptWebhookSecret(admin, antigo)).toBe("segredo-legado");
    expect(rpc).toHaveBeenCalledWith("fn_decrypt_oauth", { ciphertext: antigo });
  });

  it("hex puro (jsonb de automation_rules) também faz round-trip", async () => {
    const { encryptWebhookSecret, decryptWebhookSecret } = await modulos();
    const cifrado = (await encryptWebhookSecret(admin, "segredo-do-jsonb")) as string;
    const hexPuro = cifrado.replace(/^\\x/, "");
    expect(await decryptWebhookSecret(admin, hexPuro)).toBe("segredo-do-jsonb");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("secrets.ts SEM chave nenhuma no ambiente", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: { SECRET_ENCRYPTION_KEY: "", NUVEMSHOP_OAUTH_ENCRYPTION_KEY: "" },
    }));
  });

  it("cai no RPC e devolve null quando ele falha (contrato preservado)", async () => {
    const { encryptWebhookSecret } = await modulos();
    rpc.mockResolvedValue({ data: null, error: { message: "NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente" } });
    expect(await encryptWebhookSecret(admin, "x")).toBeNull();
    expect(rpc).toHaveBeenCalledWith("fn_encrypt_oauth", { plaintext: "x" });
  });
});
