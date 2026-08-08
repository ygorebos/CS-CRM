/**
 * O client `@supabase/supabase-js` traduzido para SQL, para a suíte de invariantes.
 *
 * ## Por que isto existe
 *
 * `scripts/test-db.sh` sobe **Postgres cru** — sem PostgREST, que é quem serve o
 * protocolo do supabase-js. Então um handler ou um módulo do CRM que fale
 * `admin.from(...).select(...)` não tem com quem falar. As opções eram três:
 *
 *  1. subir a pilha inteira do Supabase no CI (lento, e o gate `invariants`
 *     roda em todo push);
 *  2. dublar o banco (e aí "nada foi gravado" vira a resposta que o dublê daria
 *     de qualquer jeito — o falso verde que esta suíte existe para não ter);
 *  3. traduzir a cadeia de chamadas para SQL e mandar no `psql`.
 *
 * A terceira é a que preserva o que importa: as linhas pousam no Postgres de
 * verdade, com CHECK, FK, trigger e default reais no caminho.
 *
 * ## O que ele NÃO é
 *
 * Não é um cliente Supabase. É o subconjunto que os módulos sob teste usam —
 * `select/insert/update` com `eq/in/lt/is/order/limit`, `maybeSingle` e `then`.
 * Método que faltar deve ser acrescentado aqui, e não contornado no teste: o
 * dia em que um teste "adapta a consulta para o dublê entender", ele deixou de
 * exercitar o código de produção.
 */
import { sql } from "./gov-helpers";

export type ResultadoSql = { data: unknown; error: { message: string } | null };

/** Serializa um valor JS para literal SQL. */
export function lit(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export class ConsultaPorSql {
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

  private executar(): ResultadoSql {
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
      return { data: this.umaSo ? (linhas[0] ?? null) : linhas, error: null };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      // O erro do Postgres é devolvido no shape do supabase-js — inclusive o
      // `code`, que é o que o ingest lê para tratar `23505` como caminho normal.
      const texto = String(e.stderr ?? e.message ?? err);
      const codigo = /ERROR:\s+duplicate key value/.test(texto) ? "23505" : undefined;
      return { data: null, error: { message: texto, ...(codigo ? { code: codigo } : {}) } };
    }
  }

  async maybeSingle(): Promise<ResultadoSql> {
    const r = this.executar();
    if (Array.isArray(r.data)) return { ...r, data: (r.data as unknown[])[0] ?? null };
    return r;
  }

  then<T>(onOk: (v: ResultadoSql) => T): Promise<T> {
    return Promise.resolve(this.executar()).then(onOk);
  }
}

export type TratadorDeRpc = (
  nome: string,
  params: Record<string, unknown>,
) => Promise<ResultadoSql> | ResultadoSql;

/**
 * Monta o client. `rpc` é injetado porque cada arquivo precisa de um recorte
 * diferente — um quer `fn_decrypt_oauth` real, outro quer `emit_event` real,
 * outro só precisa que a chamada não exploda. Um tratador único aqui viraria
 * um `switch` que ninguém entende e que todo teste teria de contornar.
 */
export function adminPorSql(rpc?: TratadorDeRpc) {
  return {
    from: (tabela: string) => new ConsultaPorSql(tabela),
    rpc: async (nome: string, params: Record<string, unknown> = {}) =>
      rpc ? await rpc(nome, params) : { data: null, error: null },
  };
}

/** As RPCs reais do banco, chamadas por `psql`. Serve a quem quer o comportamento de verdade. */
export function rpcReal(nome: string, params: Record<string, unknown>): ResultadoSql {
  const nomeados = Object.entries(params)
    .map(([k, v]) => `${k} => ${lit(v)}`)
    .join(", ");
  try {
    const out = sql(`select public.${nome}(${nomeados});`);
    return { data: out || null, error: null };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    return { data: null, error: { message: String(e.stderr ?? e.message ?? err) } };
  }
}
