/**
 * O dreno do recebimento — a rede de baixo do ACK-primeiro (T033, US2).
 *
 * ## O que precisa ser provado aqui, e por que só o banco prova
 *
 * A rota de recebimento responde `202` assim que a entrega vira linha em
 * `webhook_events_log` e dispara a ingestão em segundo plano. Se o processo cair
 * entre uma coisa e outra — deploy, OOM, reinício —, a linha fica `received` e
 * ninguém mais olha para ela. O dreno é quem olha. Três promessas, e nenhuma
 * delas sobrevive a um dublê de banco:
 *
 *   1. linha `received` parada além da carência É recolhida;
 *   2. linha `processed` NÃO é reprocessada — reprocessar é entregar a mesma
 *      mensagem duas vezes ao agente, que responde duas vezes ao cliente;
 *   3. linha que falha N vezes vira `dead` **e abre aviso na Central**. Descarte
 *      silencioso é o defeito que a spec 001 existe para acabar: a mensagem de
 *      um cliente real não chegou, e ninguém fica sabendo.
 *
 * Com dublê, "não foi reprocessada" é a resposta que o dublê daria de qualquer
 * jeito. Aqui as linhas existem no Postgres, com o CHECK de `status`, o CHECK de
 * `agent_inbox_items.kind` e o `emit_event` reais no caminho.
 *
 * ## A carência é do teste tanto quanto do código
 *
 * O dreno só recolhe linha parada há mais de 60s — recém-chegada está sendo
 * processada pelo disparo em segundo plano NESTE instante, e recolhê-la seria
 * criar a duplicata que a carência existe para evitar. Por isso a semeadura
 * empurra `received_at` para trás: o teste não pode dormir um minuto, mas
 * também não pode fingir que a carência não existe — a linha "fresca" do caso 1
 * é semeada dentro da carência e tem de sobrar.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { sql } from "./gov-helpers";

/**
 * `vi.hoisted` porque as fábricas de `vi.mock` sobem para o topo do arquivo: uma
 * constante declarada normalmente ainda não existe quando elas rodam.
 */
const { SEGREDO_DO_CRON, INGERIDAS, FALHAR_PARA } = vi.hoisted(() => ({
  SEGREDO_DO_CRON: "segredo-do-cron-do-invariante-t033",
  /** Marca que a ingestão foi de fato chamada para aquela linha. */
  INGERIDAS: [] as string[],
  /** Linhas cuja ingestão deve FALHAR, para exercer a contagem de tentativas. */
  FALHAR_PARA: new Set<string>(),
}));

const ORG = "dddd0033-0000-4000-8000-000000000001";
const SESSAO = "dddd1033-0000-4000-8000-000000000001";
const TOKEN = "tok_t033_dreno";

vi.mock("@/lib/env", () => ({
  env: { INTERNAL_CRON_SECRET: SEGREDO_DO_CRON, INTERNAL_SECRET: undefined },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * A ingestão de verdade é da US1 e roda por outro caminho. O dublê aqui não é
 * um no-op: ele REGISTRA quem passou por ele. Sem isso, "a linha `processed` não
 * foi reprocessada" seria verdade por construção — nada chamaria nada, e o teste
 * aplaudiria um dreno que reprocessasse tudo.
 */
vi.mock("@/lib/gateway/ingest", () => ({
  ingerirEnvelope: vi.fn(
    async (
      _admin: unknown,
      _sessao: { id: string; organization_id: string },
      envelope: { message?: { externalId?: string } | null },
    ) => {
      const externo = envelope.message?.externalId ?? "?";
      INGERIDAS.push(externo);
      if (FALHAR_PARA.has(externo)) {
        return { ok: false as const, motivo: "falha_forjada_do_teste" };
      }
      return { ok: true as const };
    },
  ),
}));

import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { GET } from "@/app/api/v1/cron/gateway-inbound-drain/route";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

// ---------------------------------------------------------------------------
// Client de serviço traduzido para SQL — o harness sobe Postgres cru, sem
// PostgREST, então o shape do `@supabase/supabase-js` vira `docker exec psql`.
// Mesmo padrão de `gateway-inbound-autenticidade.test.ts`.
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
  private ordem = "";
  private teto = "";
  private umaSo = false;

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

  lt(coluna: string, valor: unknown): this {
    this.filtros.push(`${coluna} < ${lit(valor)}`);
    return this;
  }

  is(coluna: string, valor: null): this {
    this.filtros.push(`${coluna} is ${valor === null ? "null" : lit(valor)}`);
    return this;
  }

  order(coluna: string, opcoes?: { ascending?: boolean }): this {
    this.ordem = ` order by ${coluna} ${opcoes?.ascending === false ? "desc" : "asc"}`;
    return this;
  }

  limit(n?: number): this {
    this.teto = n === undefined ? "" : ` limit ${n}`;
    if (n === 1) this.umaSo = true;
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
        query =
          `select coalesce(json_agg(t), '[]') from (select ${this.colunas} ` +
          `from public.${this.tabela}${this.where()}${this.ordem}${this.teto}) t;`;
      }
      const linhas = JSON.parse(sql(query) || "[]") as Array<Record<string, unknown>>;
      // O dreno lê uma LISTA; o aviso lê no máximo uma linha via `maybeSingle`.
      return { data: this.umaSo ? (linhas[0] ?? null) : linhas, error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  }

  async maybeSingle(): Promise<Resultado> {
    const r = this.executar();
    if (Array.isArray(r.data)) return { ...r, data: (r.data as unknown[])[0] ?? null };
    return r;
  }

  then<T>(onOk: (v: Resultado) => T): Promise<T> {
    return Promise.resolve(this.executar()).then(onOk);
  }
}

function adminSql(): SupabaseClient {
  return {
    from: (tabela: string) => new ConsultaFalsa(tabela),
    // `emit_event` é a função REAL do banco. Dublá-la faria o teste provar que o
    // código chamou o que o próprio teste mandou chamar; assim ele prova que a
    // linha existe em `event_log`, com o CHECK e o trigger reais no caminho.
    rpc: async (nome: string, params: Record<string, unknown>): Promise<Resultado> => {
      if (nome !== "emit_event") {
        return { data: null, error: { message: `rpc não modelada: ${nome}` } };
      }
      try {
        const out = sql(`
          select public.emit_event(
            ${lit(params.p_event_type)},
            ${lit(params.p_entity_kind)},
            ${lit(params.p_entity_id)}::uuid,
            ${lit(params.p_payload)},
            ${lit(params.p_metadata)},
            ${lit(params.p_organization_id)}::uuid
          );
        `);
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

const bloco = (dml: string) => `do $seed$ begin ${dml} exception when others then null; end $seed$;`;

function semear(): void {
  sql(bloco(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'inv-t033', 'Org do T033', 'Org do T033');
  `));

  sql(bloco(`
    insert into public.channel_sessions
      (id, organization_id, waha_session_name, webhook_secret_encrypted,
       provider, ingest_path, gateway_connection_id, webhook_path_token)
    values
      ('${SESSAO}', '${ORG}', 'sessao-t033', '\\x00'::bytea,
       'whatsapp_uazapi', 'gateway', 'conn_t033', '${TOKEN}');
  `));
}

function envelopeCru(externo: string): string {
  return JSON.stringify({
    envelope_version: 1,
    event_id: `01H0000000000000000000T033${externo}`,
    event_kind: "new_message",
    occurred_at: "2026-08-08T12:00:00Z",
    platform: "whatsapp_uazapi",
    message: { external_id: externo, direction: "inbound", type: "text", body: "oi" },
    participant: { external_id: "5511977770000" },
  });
}

/**
 * `atrasoSegundos` é o que decide se a linha está "em voo" ou "abandonada": o
 * dreno tem carência de 60s. Semear tudo com o mesmo carimbo tornaria a carência
 * inobservável.
 */
function semearLinha(opts: {
  externo: string;
  status: string;
  attempts?: number;
  atrasoSegundos: number;
  comSessao?: boolean;
}): void {
  const sessao = opts.comSessao === false ? "null" : `'${SESSAO}'`;
  const org = opts.comSessao === false ? "null" : `'${ORG}'`;
  sql(`
    insert into public.webhook_events_log
      (organization_id, channel_session_id, provider, webhook_path_token, http_method,
       event_type, external_id, raw_body, payload_parsed, status, valid_signature, attempts,
       received_at)
    values
      (${org}, ${sessao}, 'gateway', '${TOKEN}', 'POST',
       'new_message', '${opts.externo}', 'corpo cru',
       '${envelopeCru(opts.externo).replace(/'/g, "''")}'::jsonb,
       '${opts.status}', true, ${opts.attempts ?? 0},
       now() - interval '${opts.atrasoSegundos} seconds');
  `);
}

function statusDaLinha(externo: string): string {
  return sql(
    `select status from public.webhook_events_log where external_id = '${externo}' limit 1;`,
  ).trim();
}

function contar(where: string): number {
  return Number(sql(`select count(*) from public.webhook_events_log where ${where};`).trim());
}

async function drenar(): Promise<Record<string, number>> {
  const req = {
    headers: new Headers({ authorization: `Bearer ${SEGREDO_DO_CRON}` }),
  } as unknown as NextRequest;
  const res = await GET(req);
  const json = (await res.json()) as { data?: Record<string, number> };
  expect(res.status).toBe(200);
  return json.data ?? {};
}

// ---------------------------------------------------------------------------

describe("dreno do recebimento do gateway (T033)", () => {
  beforeAll(() => {
    semear();
    vi.mocked(createAdminClient).mockImplementation(() => adminSql());
  });

  it("recolhe a linha `received` parada além da carência", async () => {
    const externo = "T033_PARADA";
    semearLinha({ externo, status: "received", atrasoSegundos: 600 });

    await drenar();

    expect(INGERIDAS).toContain(externo);
    expect(statusDaLinha(externo)).toBe("processed");
  });

  it("deixa quieta a linha `received` recém-chegada — ela está em voo", async () => {
    const externo = "T033_FRESCA";
    semearLinha({ externo, status: "received", atrasoSegundos: 5 });

    await drenar();

    // Recolher aqui seria processar junto com o disparo em segundo plano, e a
    // mesma mensagem chegaria duas vezes ao agente.
    expect(INGERIDAS).not.toContain(externo);
    expect(statusDaLinha(externo)).toBe("received");
  });

  it("não reprocessa linha `processed`", async () => {
    const externo = "T033_JA_FEITA";
    semearLinha({ externo, status: "processed", atrasoSegundos: 600 });

    await drenar();

    expect(INGERIDAS).not.toContain(externo);
    expect(statusDaLinha(externo)).toBe("processed");
  });

  it("linha que falha volta para `error` com a tentativa contada", async () => {
    const externo = "T033_FALHA";
    FALHAR_PARA.add(externo);
    semearLinha({ externo, status: "received", atrasoSegundos: 600 });

    await drenar();

    expect(statusDaLinha(externo)).toBe("error");
    const tentativas = Number(
      sql(
        `select attempts from public.webhook_events_log where external_id = '${externo}' limit 1;`,
      ).trim(),
    );
    // Sem a contagem subindo, a linha seria retentada para sempre e nunca
    // chegaria ao descarte — o teto de tentativas viraria enfeite.
    expect(tentativas).toBe(1);
  });

  it("linha que estourou o teto vira `dead` E abre aviso na Central", async () => {
    const externo = "T033_MORTA";
    semearLinha({ externo, status: "error", attempts: 5, atrasoSegundos: 600 });

    const antes = Number(
      sql(`select count(*) from public.agent_inbox_items
           where organization_id = '${ORG}' and kind = 'gateway_delivery_dead';`).trim(),
    );

    await drenar();

    expect(statusDaLinha(externo)).toBe("dead");
    // A ingestão nem é tentada: passou do teto, acabou.
    expect(INGERIDAS).not.toContain(externo);

    const depois = Number(
      sql(`select count(*) from public.agent_inbox_items
           where organization_id = '${ORG}' and kind = 'gateway_delivery_dead'
             and status = 'open' and ref_id = '${SESSAO}';`).trim(),
    );
    expect(depois).toBe(antes + 1);

    // E o evento também — as duas superfícies, pelo motivo de cada uma: a
    // Central é o que a PESSOA vê; o `event_log` é o que sobra para diagnóstico.
    const eventos = Number(
      sql(`select count(*) from public.event_log
           where event_type = 'gateway.entrega_descartada' and organization_id = '${ORG}';`).trim(),
    );
    expect(eventos).toBeGreaterThanOrEqual(1);
  });

  it("um segundo descarte não abre um segundo aviso enquanto o primeiro está aberto", async () => {
    const externo = "T033_MORTA_2";
    semearLinha({ externo, status: "error", attempts: 9, atrasoSegundos: 600 });

    const antes = Number(
      sql(`select count(*) from public.agent_inbox_items
           where organization_id = '${ORG}' and kind = 'gateway_delivery_dead' and status = 'open';`).trim(),
    );

    await drenar();

    expect(statusDaLinha(externo)).toBe("dead");
    const depois = Number(
      sql(`select count(*) from public.agent_inbox_items
           where organization_id = '${ORG}' and kind = 'gateway_delivery_dead' and status = 'open';`).trim(),
    );
    // Um destino quebrado mata linhas às dezenas. Sem deduplicar, a Central
    // vira uma parede de avisos idênticos no dia em que ela mais precisa ser
    // lida — e Central inundada é tão ilegível quanto Central vazia.
    expect(depois).toBe(antes);
  });

  it("linha sem conexão nem organização morre com motivo, e não fica rodando para sempre", async () => {
    const externo = "T033_SEM_DONO";
    semearLinha({ externo, status: "received", atrasoSegundos: 600, comSessao: false });

    await drenar();

    expect(statusDaLinha(externo)).toBe("dead");
    const motivo = sql(
      `select error_message from public.webhook_events_log where external_id = '${externo}' limit 1;`,
    ).trim();
    expect(motivo).toBe("linha_sem_conexao_ou_organizacao");
    expect(INGERIDAS).not.toContain(externo);
  });

  it("o dreno não toca em linha de outro provedor", async () => {
    sql(`
      insert into public.webhook_events_log
        (organization_id, channel_session_id, provider, webhook_path_token, http_method,
         event_type, external_id, raw_body, status, valid_signature, attempts, received_at)
      values
        ('${ORG}', '${SESSAO}', 'waha', '${TOKEN}', 'POST', 'message', 'T033_WAHA',
         'corpo cru', 'received', true, 0, now() - interval '600 seconds');
    `);

    await drenar();

    // O caminho legado tem dono próprio. Recolher a linha dele aqui seria
    // ingerir payload cru de provedor pelo caminho do envelope.
    expect(statusDaLinha("T033_WAHA")).toBe("received");
    expect(contar(`provider = 'waha' and status = 'dead'`)).toBe(0);
  });
});
