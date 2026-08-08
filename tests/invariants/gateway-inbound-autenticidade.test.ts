/**
 * As sete requisições do quickstart §3 — o que não é autêntico não entra (T040, US3).
 *
 * ## Por que este arquivo é de BANCO, e não unitário
 *
 * `tests/unit/gateway-tenant-do-token-e-recusa-registrada.test.ts` já cobre os
 * códigos de resposta com o banco dublado. O que ele NÃO consegue provar é a
 * metade que importa numa recusa: que **nada pousou**. Com um dublê, "zero
 * linhas" é a resposta que o dublê daria de qualquer jeito. Aqui as linhas ou
 * existem no Postgres ou não existem, com as constraints, os defaults e os
 * triggers reais no caminho — e a suíte roda no gate `invariants`, que é
 * obrigatório na branch protection.
 *
 * ## O sentinela de ingestão, e por que ele existe
 *
 * A ingestão de verdade (contato, conversa, mensagem, turno do agente) é da US1
 * e roda por outro caminho; replicá-la aqui seria reimplementar meio produto num
 * teste. Mas simplesmente dublá-la com um no-op criaria o pior falso verde deste
 * arquivo: `messages` ficaria vazia mesmo que a rota chamasse a ingestão numa
 * entrega forjada, e o teste aplaudiria.
 *
 * Então o dublê de `ingerirEnvelope` **grava uma linha real** no banco a cada
 * chamada. "Nada foi gravado" passa a incluir "a ingestão nem foi chamada", que é
 * exatamente a promessa; e a entrega legítima tem de produzir esse sentinela,
 * senão o caminho feliz estaria morto e os seis casos de recusa passariam por
 * inércia.
 *
 * ## Uma leitura declarada do quickstart
 *
 * A tabela diz "zero linhas gravadas". Isso vale para os dados de NEGÓCIO —
 * mensagem, contato, conversa. A linha de recusa em `webhook_events_log` é
 * obrigatória pelo SC-012 (a recusa tem de ser reconstruível sem log de
 * aplicação), então ela é EXIGIDA, não tolerada. As duas coisas convivem: o
 * atacante não escreve no CRM, e o dono da conexão consegue ver que tentaram.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "./gov-helpers";

const CHAVE_DE_CIFRA = "chave-de-teste-do-invariante-t040-0123456789";

const ORG_A = "dddd0001-0000-4000-8000-000000000001";
const ORG_B = "dddd0002-0000-4000-8000-000000000002";
const SESSAO_A = "dddd1001-0000-4000-8000-000000000001";
const SESSAO_B = "dddd1002-0000-4000-8000-000000000002";
const SESSAO_SEM_CHAVE = "dddd1003-0000-4000-8000-000000000003";

const TOKEN_A = "tok_t040_org_a";
const TOKEN_B = "tok_t040_org_b";
const TOKEN_SEM_CHAVE = "tok_t040_sem_chave";

const SEGREDO_A = "aaaaaaaaaaaaaaaa1111111111111111";
const SEGREDO_B = "bbbbbbbbbbbbbbbb2222222222222222";

/**
 * Marca deixada no banco a cada chamada da ingestão. É o que impede o "nada foi
 * gravado" de ser verdade por construção — ver o cabeçalho.
 */
const SENTINELA_INGEST = "T040_INGEST_FOI_CHAMADA";

/**
 * O vocabulário de recusa que a rota grava em `event_type`. Escrito aqui, e não
 * importado de `MotivoRecusaDeAuth`, porque o que se cobra é o valor que POUSA
 * na coluna: importar o tipo faria o teste seguir uma renomeação em silêncio,
 * e é justamente essa coluna que alguém vai consultar num incidente daqui a um
 * ano, sem o código à mão.
 */
const MOTIVOS_DE_RECUSA = [
  "assinatura_ausente",
  "assinatura_invalida",
  "timestamp_ausente",
  "timestamp_invalido",
  "timestamp_fora_da_janela",
  "segredo_nao_provisionado",
  "connection_not_migrated",
] as const;

vi.mock("@/lib/gateway/ingest", () => ({
  ingerirEnvelope: vi.fn(
    async (
      _admin: unknown,
      sessao: { id: string; organization_id: string },
      envelope: { message?: { externalId: string } | null },
    ) => {
      sql(`
        insert into public.webhook_events_log
          (organization_id, channel_session_id, provider, webhook_path_token, http_method,
           event_type, external_id, raw_body, status, valid_signature, attempts)
        values
          ('${sessao.organization_id}', '${sessao.id}', 'gateway', 'sentinela', 'POST',
           '${SENTINELA_INGEST}', ${lit(`SENT_${envelope.message?.externalId ?? "?"}`)},
           'sentinela de ingestão', 'processed', true, 0);
      `);
      return { ok: true as const };
    },
  ),
}));

// `audit()` abriria um client Supabase real contra a URL falsa da config de
// banco. A tentativa falha rápido e é engolida lá dentro, mas mockar deixa o
// arquivo determinístico — e a auditoria da tentativa de forçar tenant já é
// cobrada no unitário, onde ela é o objeto do teste.
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { POST } from "@/app/api/v1/webhooks/gateway/[token]/route";
import { assinarEntrega } from "@/lib/gateway/auth";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

// ---------------------------------------------------------------------------
// Client de serviço traduzido para SQL — mesmo padrão de
// `webhooks-trigger-events.test.ts`: o harness sobe Postgres cru, sem PostgREST,
// então o shape do `@supabase/supabase-js` é traduzido para `docker exec psql`.
// O que pousa no banco é linha de verdade.
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

  /** O único uso é `.is(archived_at, null)` — canal excluído não ingere. */
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
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  async maybeSingle(): Promise<Resultado> {
    return this.executar();
  }

  // A rota faz `await admin.from(...).update(...).eq(...)` sem `maybeSingle`.
  then<T>(onOk: (v: Resultado) => T): Promise<T> {
    return Promise.resolve(this.executar()).then(onOk);
  }
}

function adminSql(): SupabaseClient {
  return {
    from: (tabela: string) => new ConsultaFalsa(tabela),
    rpc: async (nome: string, params: Record<string, unknown>): Promise<Resultado> => {
      if (nome !== "fn_decrypt_oauth") {
        return { data: null, error: { message: `rpc não modelada: ${nome}` } };
      }
      try {
        // O segredo é decifrado pela função REAL do banco. É o mesmo caminho da
        // produção — e é o que faz o caso "segredo removido" ser um estado do
        // banco, não uma variável do teste.
        const hex = String(params.ciphertext);
        const out = sql(`select public.fn_decrypt_oauth('${hex.replace(/'/g, "''")}'::bytea);`);
        return { data: out || null, error: null };
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } };
      }
    },
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Semeadura
// ---------------------------------------------------------------------------

function semear(): void {
  // A chave de cifra vive na sessão do Postgres; posta no BANCO para valer em
  // toda conexão nova que o `sql()` abre.
  sql(`alter database postgres set app.nuvemshop_oauth_key = '${CHAVE_DE_CIFRA}';`);

  const bloco = (dml: string) => `do $seed$ begin ${dml} exception when others then null; end $seed$;`;

  sql(bloco(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'inv-t040-a', 'Org A do T040', 'Org A do T040'),
      ('${ORG_B}', 'inv-t040-b', 'Org B do T040', 'Org B do T040');
  `));

  sql(bloco(`
    insert into public.channel_sessions
      (id, organization_id, webhook_secret_encrypted, provider, ingest_path,
       gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO_A}', '${ORG_A}', public.fn_encrypt_oauth('${SEGREDO_A}'),
       'whatsapp_uazapi', 'gateway', 'conn_t040_a', '${TOKEN_A}'),
      ('${SESSAO_B}', '${ORG_B}', public.fn_encrypt_oauth('${SEGREDO_B}'),
       'whatsapp_uazapi', 'gateway', 'conn_t040_b', '${TOKEN_B}'),
      -- O placeholder de um byte: o estado real de um clone que atualizou pela
      -- metade. Decifrar isto falha, e a conexão não tem como verificar nada.
      ('${SESSAO_SEM_CHAVE}', '${ORG_A}', '\\x00'::bytea,
       'whatsapp_uazapi', 'gateway', 'conn_t040_sem', '${TOKEN_SEM_CHAVE}');
  `));
}

// ---------------------------------------------------------------------------
// Emissão
// ---------------------------------------------------------------------------

let contador = 0;

function envelope(extra: Record<string, unknown> = {}) {
  contador += 1;
  return {
    envelope_version: 1,
    event_id: `01H0000000000000000000T040${contador}`,
    event_kind: "new_message",
    occurred_at: "2026-08-08T12:00:00Z",
    platform: "whatsapp_uazapi",
    message: {
      external_id: `EVT_T040_${contador}`,
      direction: "inbound",
      type: "text",
      body: "oi",
    },
    participant: { external_id: "5511988880000" },
    ...extra,
  };
}

interface Opcoes {
  segredo?: string | null;
  timestamp?: string;
  assinaturaCrua?: string;
}

async function entregar(token: string, corpo: unknown, o: Opcoes = {}) {
  const corpoCru = JSON.stringify(corpo);
  const ts = o.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers = new Headers({ "content-type": "application/json" });
  if (o.assinaturaCrua !== undefined) {
    headers.set("X-Gateway-Timestamp", ts);
    headers.set("X-Gateway-Signature", o.assinaturaCrua);
  } else if (o.segredo) {
    headers.set("X-Gateway-Timestamp", ts);
    headers.set("X-Gateway-Signature", assinarEntrega(ts, corpoCru, o.segredo));
  }

  const req = { headers, text: async () => corpoCru } as unknown as NextRequest;
  return POST(req, { params: Promise.resolve({ token }) });
}

/** Contagem por tabela — o que EXISTE, sem RLS no caminho (service role). */
function conta(tabela: string, filtro = "true"): number {
  return Number(sql(`select count(*) from public.${tabela} where ${filtro}`).trim());
}

function fotografia() {
  return {
    messages: conta("messages"),
    contacts: conta("contacts"),
    conversations: conta("conversations"),
    sentinelas: conta("webhook_events_log", `event_type = '${SENTINELA_INGEST}'`),
  };
}

/**
 * A ingestão é disparada em segundo plano (é o que sustenta o ACK-primeiro), de
 * modo que medir logo depois do `202` mediria a corrida, não o comportamento.
 */
async function esperarSentinela(alvo: number): Promise<number> {
  const limite = Date.now() + 5_000;
  let atual = fotografia().sentinelas;
  while (atual < alvo && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 50));
    atual = fotografia().sentinelas;
  }
  return atual;
}

beforeAll(() => {
  semear();
  vi.mocked(createAdminClient).mockImplementation(adminSql);
});

describe("T040 — autenticidade na porta do gateway (quickstart §3)", () => {
  it("1. sem X-Gateway-Signature: 401, e nada de negócio pousa", async () => {
    const antes = fotografia();
    const res = await entregar(TOKEN_A, envelope());

    expect(res.status).toBe(401);
    expect(fotografia()).toEqual(antes);
  });

  it("2. assinatura inválida: 401, e nada de negócio pousa", async () => {
    const antes = fotografia();
    const res = await entregar(TOKEN_A, envelope(), { assinaturaCrua: "f".repeat(128) });

    expect(res.status).toBe(401);
    expect(fotografia()).toEqual(antes);
  });

  it("3. assinatura válida com timestamp de 10 minutos atrás: 401 (fora da janela)", async () => {
    const antes = fotografia();
    const velho = String(Math.floor(Date.now() / 1000) - 600);
    const res = await entregar(TOKEN_A, envelope(), { segredo: SEGREDO_A, timestamp: velho });

    // Sem janela, uma entrega capturada seria reenviável para sempre — a
    // assinatura continua fechando, porque o corpo não mudou.
    expect(res.status).toBe(401);
    expect(fotografia()).toEqual(antes);
  });

  it("4. assinatura válida da org A entregue no token da org B: 401, nada em nenhuma das duas", async () => {
    const antes = fotografia();
    const corpo = envelope();
    const corpoCru = JSON.stringify(corpo);
    const ts = String(Math.floor(Date.now() / 1000));

    const res = await entregar(TOKEN_B, corpo, {
      assinaturaCrua: assinarEntrega(ts, corpoCru, SEGREDO_A),
      timestamp: ts,
    });

    // O segredo é POR CONEXÃO. Um segredo global faria qualquer tenant assinar
    // entrega para qualquer outro — vazamento num, vazamento em todos.
    expect(res.status).toBe(401);
    expect(fotografia()).toEqual(antes);
    expect(conta("webhook_events_log", `organization_id = '${ORG_A}' and status = 'received'`)).toBe(0);
  });

  it("5. organization_id no corpo apontando outra org: o token vence", async () => {
    const res = await entregar(TOKEN_A, envelope({ organization_id: ORG_B }), {
      segredo: SEGREDO_A,
    });

    expect(res.status).toBe(202);

    const daOrgErrada = conta(
      "webhook_events_log",
      `organization_id = '${ORG_B}' and webhook_path_token = '${TOKEN_A}'`,
    );
    expect(daOrgErrada).toBe(0);
    expect(
      conta(
        "webhook_events_log",
        // `processed` entra junto porque a ingestão em segundo plano pode ter
        // avançado o status entre o ACK e esta consulta. Exigir `received` mediria
        // a corrida; o que se cobra aqui é DE QUEM é a linha.
        `organization_id = '${ORG_A}' and webhook_path_token = '${TOKEN_A}' ` +
          `and status in ('received', 'processed')`,
      ),
    ).toBeGreaterThan(0);
  });

  it("6. segredo removido da conexão: fecha, nunca abre", async () => {
    const antes = fotografia();
    const res = await entregar(TOKEN_SEM_CHAVE, envelope(), { segredo: SEGREDO_A });

    // 503 e não 401 é desvio deliberado do quickstart (T017e): o defeito é
    // DESTE lado e é curável, e o contrato manda o gateway retentar 5xx — com
    // 401 as entregas do período quebrado virariam buraco permanente. O que a
    // tabela exige, e continua valendo, é que NÃO passe.
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(202);
    expect(fotografia()).toEqual(antes);

    // E o silêncio é quebrado: a conexão quebrada aparece para o operador.
    expect(
      conta(
        "agent_inbox_items",
        `kind = 'channel_secret_missing' and ref_id = '${SESSAO_SEM_CHAVE}' and status = 'open'`,
      ),
    ).toBe(1);
  });

  it("7. entrega legítima: 202, linha na org certa, e a ingestão REALMENTE roda", async () => {
    const antes = fotografia();
    const res = await entregar(TOKEN_A, envelope(), { segredo: SEGREDO_A });

    expect(res.status).toBe(202);

    // Sem esta asserção os seis casos acima passariam com a rota recusando tudo.
    expect(await esperarSentinela(antes.sentinelas + 1)).toBe(antes.sentinelas + 1);
    expect(
      conta("webhook_events_log", `organization_id = '${ORG_A}' and event_type = '${SENTINELA_INGEST}'`),
    ).toBeGreaterThan(0);
  });
});

describe("T040/SC-012 — as recusas se reconstroem só pelo webhook_events_log", () => {
  it("cada recusa deixou linha com motivo, e nenhuma delas alega assinatura válida", () => {
    // A pergunta que um incidente faz é "quantas entregas forjadas chegaram
    // nesta conexão, e quando". Ela tem de ser respondível pelo banco: num
    // self-host, o log de aplicação não sobrevive a um `docker compose up`.
    const recusas = Number(
      sql(`
        select count(*) from public.webhook_events_log
        where status = 'error' and provider = 'gateway'
          and channel_session_id in ('${SESSAO_A}', '${SESSAO_B}', '${SESSAO_SEM_CHAVE}')
      `).trim(),
    );
    expect(recusas).toBeGreaterThanOrEqual(5);

    // Nenhuma recusa de AUTENTICIDADE pode alegar assinatura válida — era assim
    // que a coluna mentia no caminho legado, justamente para quem fosse auditar.
    //
    // O escopo é por motivo, e não "toda linha em error", porque as duas coisas
    // são diferentes: uma entrega legitimamente assinada que falha DEPOIS do ACK
    // também termina em `error`, e ali `valid_signature = true` é a verdade. Ler
    // as duas juntas transformaria a coluna em "deu erro", perdendo exatamente a
    // distinção que ela existe para registrar.
    expect(
      conta(
        "webhook_events_log",
        `event_type in (${MOTIVOS_DE_RECUSA.map((m) => `'${m}'`).join(", ")}) ` +
          `and valid_signature = true ` +
          `and channel_session_id in ('${SESSAO_A}', '${SESSAO_B}', '${SESSAO_SEM_CHAVE}')`,
      ),
    ).toBe(0);

    // E o motivo está lá: sem ele a linha diz "algo foi recusado" e nada mais.
    const semMotivo = conta(
      "webhook_events_log",
      `status = 'error' and provider = 'gateway' and coalesce(event_type, '') in ('', 'unknown') ` +
        `and channel_session_id in ('${SESSAO_A}', '${SESSAO_B}', '${SESSAO_SEM_CHAVE}')`,
    );
    expect(semMotivo).toBe(0);

    // O corpo cru também: sem ele não se reconstrói o que chegou.
    expect(
      conta(
        "webhook_events_log",
        `status = 'error' and provider = 'gateway' and coalesce(raw_body, '') = '' ` +
          `and channel_session_id in ('${SESSAO_A}', '${SESSAO_B}', '${SESSAO_SEM_CHAVE}')`,
      ),
    ).toBe(0);
  });

  it("a recusa é atribuída à conexão certa — auditar uma não mostra a outra", () => {
    // A entrega assinada pela org A foi endereçada ao token da org B; a linha
    // tem de nascer na org B, que é a dona do token. Atribuí-la a A esconderia
    // o ataque de quem precisa vê-lo.
    expect(
      conta("webhook_events_log", `channel_session_id = '${SESSAO_B}' and status = 'error'`),
    ).toBeGreaterThan(0);
    expect(
      conta("webhook_events_log", `channel_session_id = '${SESSAO_B}' and organization_id = '${ORG_A}'`),
    ).toBe(0);
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Trocar `timingSafeEqual` por `===` em `lib/gateway/auth.ts`
 *     → não basta: a comparação continua correta. A sabotagem que vale é
 *       ACEITAR assinatura ausente ou divergente (a válvula do caminho legado)
 *       → casos 1, 2 e 4 caem.
 *  2. Ampliar `JANELA_DE_VALIDADE_SEGUNDOS` para cobrir 10 minutos
 *     → caso 3 cai.
 *  3. Ler `organization_id` do corpo em vez da linha de `channel_sessions`
 *     → caso 5 cai.
 *  4. Aceitar entrega quando o segredo não decifra
 *     → caso 6 cai.
 *  5. Gravar `valid_signature: true` fixo
 *     → "nenhuma delas alega assinatura válida" cai.
 */
export {};
