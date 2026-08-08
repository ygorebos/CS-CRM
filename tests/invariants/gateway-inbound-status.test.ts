/**
 * Estado de entrega não anda para trás (T052, US6).
 *
 * ## Por que isto é invariante de banco, e não teste unitário
 *
 * A promessa não é "a função devolve `ignorada`" — é **o que a linha em
 * `messages` mostra depois**. Quem lê a conversa é uma pessoa olhando o selo de
 * entregue/lido, e o defeito que este arquivo vigia aparece exatamente ali: uma
 * confirmação atrasada chegando depois da leitura faria o selo voltar de "lido"
 * para "entregue", na frente do usuário. Com dublê de banco, a asserção seria
 * sobre o valor que o próprio dublê guardou.
 *
 * ## As três regras, e a razão de cada uma
 *
 *  1. **Não regride.** Os provedores entregam confirmação fora de ordem — é
 *     comum, não é exceção. Sem ordenação explícita, a última que chega vence, e
 *     "a última" é acidente de rede.
 *  2. **`failed` sempre entra.** É a única informação que vale mesmo depois de
 *     `read`: uma mensagem pode falhar numa segunda tentativa do provedor, e
 *     esconder isso deixaria o atendente achando que o cliente recebeu.
 *  3. **Confirmação de mensagem desconhecida não cria mensagem.** Criar a linha
 *     "para não perder o estado" produziria, na conversa, uma mensagem sem corpo
 *     e sem autor — pior que a informação faltando.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "./gov-helpers";

const ORG = "dddd0052-0000-4000-8000-000000000001";
const SESSAO = "dddd1052-0000-4000-8000-000000000001";
const CONTATO = "dddd2052-0000-4000-8000-000000000001";
const CONVERSA = "dddd3052-0000-4000-8000-000000000001";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { parseEnvelope } from "@/lib/gateway/envelope";
import { ingerirEnvelope } from "@/lib/gateway/ingest";

// ---------------------------------------------------------------------------
// Client traduzido para SQL (o harness sobe Postgres cru, sem PostgREST).
// ---------------------------------------------------------------------------

function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

type Resultado = { data: unknown; error: { message: string } | null };

class ConsultaFalsa {
  private modo: "select" | "insert" | "update" = "select";
  private colunas = "*";
  private valores: Record<string, unknown> | null = null;
  private filtros: string[] = [];

  constructor(private tabela: string) {}

  select(colunas?: string): this {
    if (this.modo === "select" && colunas) this.colunas = colunas;
    return this;
  }
  insert(dados: Record<string, unknown>): this {
    this.modo = "insert";
    this.valores = dados;
    return this;
  }
  update(dados: Record<string, unknown>): this {
    this.modo = "update";
    this.valores = dados;
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    this.filtros.push(`${coluna} = ${lit(valor)}`);
    return this;
  }
  in(coluna: string, valores: unknown[]): this {
    this.filtros.push(`${coluna} in (${valores.map(lit).join(", ")})`);
    return this;
  }
  is(coluna: string, valor: null): this {
    this.filtros.push(`${coluna} is ${valor === null ? "null" : lit(valor)}`);
    return this;
  }
  limit(): this {
    return this;
  }

  private where(): string {
    return this.filtros.length ? ` where ${this.filtros.join(" and ")}` : "";
  }

  private executar(): Resultado {
    try {
      let query: string;
      if (this.modo === "insert") {
        const cols = Object.keys(this.valores!);
        const vals = cols.map((c) => lit(this.valores![c]));
        query =
          `with w as (insert into public.${this.tabela} (${cols.join(", ")}) ` +
          `values (${vals.join(", ")}) returning *) select coalesce(json_agg(w), '[]') from w;`;
      } else if (this.modo === "update") {
        const sets = Object.entries(this.valores!)
          .map(([k, v]) => `${k} = ${lit(v)}`)
          .join(", ");
        query =
          `with w as (update public.${this.tabela} set ${sets}${this.where()} returning *) ` +
          `select coalesce(json_agg(w), '[]') from w;`;
      } else {
        query = `select coalesce(json_agg(t), '[]') from (select ${this.colunas} from public.${this.tabela}${this.where()} limit 1) t;`;
      }
      const linhas = JSON.parse(sql(query) || "[]") as Array<Record<string, unknown>>;
      return { data: linhas[0] ?? null, error: null };
    } catch (err) {
      const msg = (err as { stderr?: Buffer | string; message?: string });
      return { data: null, error: { message: String(msg.stderr ?? msg.message ?? err) } };
    }
  }

  async maybeSingle(): Promise<Resultado> {
    return this.executar();
  }
  then<T>(onOk: (v: Resultado) => T): Promise<T> {
    return Promise.resolve(this.executar()).then(onOk);
  }
}

function admin(): SupabaseClient {
  return {
    from: (tabela: string) => new ConsultaFalsa(tabela),
    // A cadeia viva não é o objeto aqui; `emit_event` responde ok e o teste
    // olha `messages`, que é onde a promessa vive.
    rpc: async (): Promise<Resultado> => ({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

const SESSAO_REF = { id: SESSAO, organization_id: ORG };

// ---------------------------------------------------------------------------

function semear(): void {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${ORG}', 'inv-t052', 'Org do T052', 'Org do T052')
    on conflict (id) do nothing;
  `);
  sql(`
    insert into public.channel_sessions
      (id, organization_id, waha_session_name, webhook_secret_encrypted,
       provider, ingest_path, gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO}', '${ORG}', 'sessao-t052', '\\x00'::bytea,
       'whatsapp_uazapi', 'gateway', 'conn_t052', 'tok_t052')
    on conflict (id) do nothing;
  `);
  sql(`
    insert into public.contacts (id, organization_id, phone_number, display_name)
    values ('${CONTATO}', '${ORG}', '+5511955550000', 'Cliente do T052')
    on conflict (id) do nothing;
  `);
  sql(`
    insert into public.conversations (id, organization_id, contact_id, channel_session_id)
    values ('${CONVERSA}', '${ORG}', '${CONTATO}', '${SESSAO}')
    on conflict (id) do nothing;
  `);
}

function semearMensagem(externalId: string, status: string): void {
  sql(`
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id,
       external_id, type, direction, status, body, sent_via, sent_at)
    values
      ('${ORG}', '${CONVERSA}', '${SESSAO}', '${CONTATO}',
       '${externalId}', 'text', 'outbound', '${status}', 'mensagem do T052',
       'crm', now());
  `);
}

function estadoDe(externalId: string): string {
  return sql(
    `select status from public.messages where organization_id = '${ORG}' and external_id = '${externalId}' limit 1;`,
  ).trim();
}

function contarMensagens(externalId: string): number {
  return Number(
    sql(
      `select count(*) from public.messages where organization_id = '${ORG}' and external_id = '${externalId}';`,
    ).trim(),
  );
}

let seq = 0;
function envelopeDeEstado(externalId: string, status: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  const parse = parseEnvelope({
    envelope_version: 1,
    event_id: `01H0000000000000000000T052${seq}`,
    event_kind: "status_update",
    occurred_at: "2026-08-08T12:00:00Z",
    platform: "whatsapp_uazapi",
    message: { external_id: externalId, direction: "outbound", type: "text" },
    delivery: { status, ...extra },
  });
  if (!parse.ok) throw new Error(`envelope inválido: ${parse.motivo}`);
  return parse.envelope;
}

// ---------------------------------------------------------------------------

describe("estado de entrega pelo gateway (T052)", () => {
  beforeAll(() => {
    semear();
  });

  it("avança sent → delivered → read e carimba as datas", async () => {
    const id = "T052_AVANCA";
    semearMensagem(id, "sent");

    await ingerirEnvelope(admin(), SESSAO_REF, envelopeDeEstado(id, "delivered"), "req");
    expect(estadoDe(id)).toBe("delivered");

    await ingerirEnvelope(admin(), SESSAO_REF, envelopeDeEstado(id, "read"), "req");
    expect(estadoDe(id)).toBe("read");

    const datas = sql(
      `select (delivered_at is not null) || '|' || (read_at is not null)
         from public.messages where organization_id = '${ORG}' and external_id = '${id}' limit 1;`,
    ).trim();
    // Sem os carimbos, "lido" existe como palavra mas não como momento — e é o
    // momento que responde "há quanto tempo o cliente viu isso e não respondeu".
    expect(datas).toBe("true|true");
  });

  it("NÃO regride: confirmação atrasada de 'delivered' não desfaz 'read'", async () => {
    const id = "T052_NAO_REGRIDE";
    semearMensagem(id, "read");

    const r = await ingerirEnvelope(admin(), SESSAO_REF, envelopeDeEstado(id, "delivered"), "req");

    expect(r).toEqual({ ok: true, efeito: "ignorada", motivo: "estado_nao_regride" });
    // O selo na tela não pode voltar de "lido" para "entregue" na frente do
    // usuário por causa de um pacote que chegou fora de ordem.
    expect(estadoDe(id)).toBe("read");
  });

  it("'failed' entra mesmo depois de 'read' — é informação nova, não regressão", async () => {
    const id = "T052_FALHOU_DEPOIS";
    semearMensagem(id, "read");

    await ingerirEnvelope(
      admin(),
      SESSAO_REF,
      envelopeDeEstado(id, "failed", { error_code: "131047", error_detail: "janela expirada" }),
      "req",
    );

    expect(estadoDe(id)).toBe("failed");
    const erro = sql(
      `select coalesce(error_code, '') || '|' || coalesce(error_message, '')
         from public.messages where organization_id = '${ORG}' and external_id = '${id}' limit 1;`,
    ).trim();
    // Sem o motivo gravado, "falhou" não diz o que fazer — e o atendente fica
    // sem saber se reenvia, se troca de canal, ou se o número não existe.
    expect(erro).toBe("131047|janela expirada");
  });

  it("confirmação para mensagem desconhecida NÃO cria mensagem fantasma", async () => {
    const id = "T052_FANTASMA";
    expect(contarMensagens(id)).toBe(0);

    const r = await ingerirEnvelope(admin(), SESSAO_REF, envelopeDeEstado(id, "delivered"), "req");

    expect(r).toEqual({ ok: true, efeito: "ignorada", motivo: "mensagem_desconhecida" });
    // Criar a linha "para não perder o estado" produziria, na conversa, uma
    // mensagem sem corpo e sem autor — pior que a informação faltando.
    expect(contarMensagens(id)).toBe(0);
  });

  it("estado de OUTRA organização não é alcançado pelo mesmo external_id", async () => {
    const id = "T052_ISOLAMENTO";
    semearMensagem(id, "sent");

    const outraOrg = { id: SESSAO, organization_id: "dddd0052-0000-4000-8000-0000000000ff" };
    const r = await ingerirEnvelope(admin(), outraOrg, envelopeDeEstado(id, "read"), "req");

    // `external_id` é único POR organização. Sem o filtro de org no update, uma
    // conexão conseguiria mexer no histórico de outro cliente só por acertar o
    // identificador do provedor.
    expect(r).toEqual({ ok: true, efeito: "ignorada", motivo: "mensagem_desconhecida" });
    expect(estadoDe(id)).toBe("sent");
  });

  it("read_watermark é ignorado COM motivo registrado, não em silêncio", async () => {
    const parse = parseEnvelope({
      envelope_version: 1,
      event_id: "01H0000000000000000000T052WM",
      event_kind: "read_watermark",
      occurred_at: "2026-08-08T12:00:00Z",
      platform: "whatsapp_uazapi",
      participant: { external_id: "5511955550000" },
    });
    if (!parse.ok) throw new Error("envelope inválido");

    const r = await ingerirEnvelope(admin(), SESSAO_REF, parse.envelope, "req");

    // "Ignorado" precisa ser um desfecho DECLARADO. Um `return` mudo aqui é
    // indistinguível de mensagem perdida quando alguém for contar o que entrou.
    expect(r).toEqual({
      ok: true,
      efeito: "ignorada",
      motivo: "read_watermark_nao_modelado",
    });
  });
});
