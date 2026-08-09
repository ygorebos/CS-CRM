/**
 * Envelope de segredo cifrado NA APLICAÇÃO (AES-256-GCM), alternativa ao
 * `fn_encrypt_oauth` do banco.
 *
 * ## O defeito que fez este arquivo existir (medido em 2026-08-08)
 *
 * A cifra at-rest de segredos dependia da GUC `app.nuvemshop_oauth_key`, que o
 * provisioning manda injetar com `ALTER DATABASE ... SET`. Na nossa instância
 * isso NUNCA rodou — e não podia:
 *
 * ```
 * alter database postgres set app.nuvemshop_oauth_key = '…'
 * ERROR:  permission denied to set parameter "app.nuvemshop_oauth_key"
 * ```
 *
 * O papel `postgres` do Supabase gerenciado não é superusuário (`rolsuper=f`), e
 * desde o PG15 GUC customizada em `ALTER DATABASE/ROLE` exige superusuário. O
 * passo documentado descrevia algo inexecutável, então `fn_encrypt_oauth` sempre
 * devolveu `P0001 NUVEMSHOP_OAUTH_ENCRYPTION_KEY ausente` — e TODA criação de
 * conexão de canal morria em 422, incluindo a primeira do corretor.
 *
 * ## Por que cifrar aqui é melhor, e não só mais fácil
 *
 * Com a GUC, a chave e o cofre moram no MESMO banco: quem lê o dump lê os dois.
 * Aqui a chave vive no ambiente do app e o ciphertext no banco — comprometer um
 * não entrega o outro. A dependência de superusuário some junto.
 *
 * ## Formato (auto-descritivo de propósito)
 *
 * `magic(5) ‖ iv(12) ‖ tag(16) ‖ ciphertext`, gravado como `\x<hex>` — o mesmo
 * literal `bytea` que o PostgREST já aceita, então NENHUMA coluna muda de tipo.
 * O magic existe para que a leitura reconheça o formato pelo DADO, não por
 * configuração: ciphertext antigo (`pgp_sym`, que começa em `0xC3`) continua
 * indo para o RPC do banco, sem migração de dados e sem janela de indecisão.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/** "DCSE1" — Deskcomm Cipher Secret Envelope v1. `pgp_sym` começa em 0xC3. */
const MAGIC = Buffer.from("DCSE1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

let chaveCache: Buffer | null | undefined;

/**
 * A chave da vez, ou `null` se a instalação não configurou nenhuma.
 *
 * Duas origens porque a virada é por CONFIGURAÇÃO, não por release:
 * `SECRET_ENCRYPTION_KEY` é o nome honesto; `NUVEMSHOP_OAUTH_ENCRYPTION_KEY` é o
 * que as instalações já têm no `.env` (o nome herdou do épico onde a cifra
 * nasceu, e nunca teve relação com a Nuvemshop). Aceitar as duas evita exigir
 * edição de ambiente para destravar o que já estava quebrado.
 */
function chave(): Buffer | null {
  if (chaveCache !== undefined) return chaveCache;
  const bruta = (env.SECRET_ENCRYPTION_KEY || env.NUVEMSHOP_OAUTH_ENCRYPTION_KEY || "").trim();
  if (!bruta) {
    chaveCache = null;
    return null;
  }
  // Hex de 64 chars e base64 de 32 bytes são as duas formas que o repo já usa
  // para chave de 256 bits — aceitar as duas evita "chave configurada que não
  // funciona por causa da codificação", que é falha silenciosa.
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(bruta)) buf = Buffer.from(bruta, "hex");
  else {
    const tentativa = Buffer.from(bruta, "base64");
    if (tentativa.length === KEY_BYTES) buf = tentativa;
  }
  if (!buf || buf.length !== KEY_BYTES) {
    throw new Error(
      "SECRET_ENCRYPTION_KEY (ou NUVEMSHOP_OAUTH_ENCRYPTION_KEY) inválida: " +
        "esperado 32 bytes em hex (64 chars) ou base64. Gere com: openssl rand -hex 32",
    );
  }
  chaveCache = buf;
  return buf;
}

/** Só para teste: a chave é lida uma vez e memorizada no módulo. */
export function esquecerChaveDeCifra(): void {
  chaveCache = undefined;
}

/** Esta instalação sabe cifrar sem depender do banco? */
export function cifraLocalDisponivel(): boolean {
  return chave() !== null;
}

/** Bytes do que o PostgREST devolve numa coluna `bytea` (ou do hex puro do jsonb). */
function paraBytes(valor: unknown): Buffer | null {
  if (Buffer.isBuffer(valor)) return valor;
  if (valor instanceof Uint8Array) return Buffer.from(valor);
  if (typeof valor !== "string" || valor === "") return null;
  const hex = valor.startsWith("\\x") ? valor.slice(2) : valor;
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

/** O ciphertext está no formato desta aplicação (e não no do `pgp_sym`)? */
export function ehEnvelopeLocal(valor: unknown): boolean {
  const buf = paraBytes(valor);
  if (!buf || buf.length < MAGIC.length) return false;
  // timingSafeEqual em magic público é gratuito e evita que alguém copie o
  // padrão daqui para comparar tag ou segredo com `===` mais adiante.
  return timingSafeEqual(buf.subarray(0, MAGIC.length), MAGIC);
}

/**
 * Cifra e devolve a literal `\x<hex>` pronta para `bytea`. Lança se a chave não
 * estiver configurada — quem chama decide o que fazer, e chamar isto sem chave é
 * erro de programação, não estado normal (use `cifraLocalDisponivel()`).
 */
export function cifrarSegredo(plaintext: string): string {
  const k = chave();
  if (!k) throw new Error("cifrarSegredo chamado sem chave configurada");
  if (!plaintext) throw new Error("cifrarSegredo: plaintext vazio");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `\\x${Buffer.concat([MAGIC, iv, tag, ct]).toString("hex")}`;
}

/**
 * Decifra um envelope local. `null` em qualquer falha — adulteração, chave
 * errada, truncamento. Nunca lança: quem chama está numa rota de webhook, e um
 * 500 ali diria ao emissor "tente de novo" quando a resposta certa é recusar.
 */
export function decifrarSegredo(valor: unknown): string | null {
  const k = chave();
  if (!k) return null;
  const buf = paraBytes(valor);
  if (!buf || !ehEnvelopeLocal(buf)) return null;
  const minimo = MAGIC.length + IV_BYTES + TAG_BYTES;
  if (buf.length <= minimo) return null;
  try {
    const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = buf.subarray(MAGIC.length + IV_BYTES, minimo);
    const ct = buf.subarray(minimo);
    const decipher = createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
