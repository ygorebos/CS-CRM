/**
 * `POST`/`GET /api/v1/knowledge-scopes/{id}/materials` (spec 002, T088 e T092).
 *
 * O que estes testes vigiam, e por que cada um deles falharia sem a rota:
 *
 * 1. **FR-001 — a declaração é obrigatória e a recusa é legível.** Material que não nomeia
 *    a operadora nem se declara "vale para todas" volta `400 material_sem_escopo`, em
 *    português, sem tocar no banco. O CHECK `ai_knowledge_sources_scope_xor_all` também
 *    barraria — com "new row violates check constraint", que não termina cadastro nenhum.
 * 2. **FR-007 — o que cabe é dito ANTES do envio.** O `GET` declara formatos e tamanho
 *    máximo no `meta`, e as recusas de formato/tamanho acontecem antes de qualquer leitura
 *    de conteúdo ou escrita.
 * 3. **FR-004 — nada é aceito para morrer depois.** Arquivo do qual não sai conteúdo
 *    indexável é recusado com `422`, e nenhuma linha fica para trás.
 * 4. **Teto por ORGANIZAÇÃO** (item 6 do Definition of Done): org A estourar não impede a
 *    org B de carregar material.
 * 5. **T092 — gestor e trilha.** `viewer` lê, `agent` não escreve, e toda carga aceita
 *    emite `api_audit_log`.
 *
 * O que NÃO está aqui: RLS de verdade (é banco, exige `pnpm test:db`), a indexação (é
 * `workers/rag-indexer.ts`) e a prova pela tela (doutrina de QA Visual).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { PdfExtractError, extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// O extrator de PDF é dublado porque um PDF de verdade não cabe num teste unitário — o
// que interessa aqui é o que a ROTA faz com cada desfecho dele.
vi.mock("@/lib/ai/rag/extractors/pdf", () => {
  class PdfExtractError extends Error {}
  return { PdfExtractError, extractPdfText: vi.fn() };
});

import { GET, POST } from "./route";
import { TAMANHO_MAXIMO_BYTES, TETO_DE_MATERIAL } from "../../_escopos";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "77777777-7777-4777-8777-777777777777";
const ANA = "11111111-1111-4111-8111-111111111111";
const AGENTE = "55555555-5555-4555-8555-555555555555";
const ESCOPO = "33333333-3333-4333-8333-333333333333";
const MATERIAL = "66666666-6666-4666-8666-666666666666";

const MARKDOWN = [
  "## Pergunta: Como pedir a segunda via do boleto?",
  "## Resposta: Pelo aplicativo, em Financeiro > Segunda via.",
].join("\n");

// ---------------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------------

function sessao(orgId: string, papel: Role = "manager") {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    organizations: [{ organization_id: orgId, organization_name: "Corretora", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId, name: "Corretora", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

// ---------------------------------------------------------------------------
// Dublês de banco
// ---------------------------------------------------------------------------

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filtros: Record<string, unknown>;
}

const linhaDoMaterial = {
  id: MATERIAL,
  agent_id: AGENTE,
  scope_id: ESCOPO,
  applies_to_all: false,
  source_type: "policy",
  name: "Manual da Unimed",
  status: "ready",
  chunks_count: 0,
  last_index_status: null,
  last_index_error: null,
  last_indexed_at: null,
  valid_until: null,
  is_active: true,
  source_metadata: { filename: "manual.md" },
  created_at: "2026-08-08T10:00:00.000Z",
  updated_at: "2026-08-08T10:00:00.000Z",
};

/**
 * Um dublê só para os dois clients: o de sessão (leituras de agente/escopo/lista) e o
 * admin (escritas). Registram na mesma lista, porque o que os testes perguntam é "o que
 * esta rota escreveu", não "por qual client".
 */
function fazerBanco(opcoes: { agenteExiste?: boolean; escopoExiste?: boolean; lista?: unknown[] } = {}) {
  const { agenteExiste = true, escopoExiste = true, lista = [linhaDoMaterial] } = opcoes;
  const chamadas: Chamada[] = [];

  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, op: "select", filtros: {} };
    chamadas.push(chamada);
    const resolver = () => {
      if (chamada.op === "insert" && tabela === "ai_knowledge_sources") {
        return Promise.resolve({ data: linhaDoMaterial, error: null });
      }
      if (chamada.op === "insert" || chamada.op === "delete") {
        return Promise.resolve({ data: null, error: null });
      }
      if (tabela === "ai_agents") {
        return Promise.resolve({ data: agenteExiste ? { id: AGENTE } : null, error: null });
      }
      if (tabela === "knowledge_scopes") {
        return Promise.resolve({ data: escopoExiste ? { id: ESCOPO } : null, error: null });
      }
      if (tabela === "organizations") {
        return Promise.resolve({ data: { settings: {} }, error: null });
      }
      return Promise.resolve({ data: lista, error: null });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      insert: (v: unknown) => {
        chamada.op = "insert";
        chamada.payload = v;
        return chain;
      },
      update: (v: unknown) => {
        chamada.op = "update";
        chamada.payload = v;
        return chain;
      },
      delete: () => {
        chamada.op = "delete";
        return chain;
      },
      eq: (coluna: string, valor: unknown) => {
        chamada.filtros[coluna] = valor;
        return chain;
      },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      single: resolver,
      maybeSingle: resolver,
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => resolver().then(ok, err),
    };
    return chain;
  };

  const rpc = vi.fn(async () => ({ data: null, error: null }));
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  vi.mocked(createAdminClient).mockReturnValue({ from, rpc } as never);
  return { chamadas, rpc };
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------

function colado(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/knowledge-scopes/x/materials", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

/**
 * Pedido multipart montado à mão.
 *
 * `req.formData()` real reconstrói o `File` a partir do fio, e com isso perderia o `size`
 * forjado do teste de 20 MB — e mandar 20 MB de verdade a cada execução seria cobrar da
 * suíte o preço de testar o parser da undici, que não é nosso. A rota só usa
 * `headers.get("content-type")` e `formData()`; é o que este dublê entrega.
 */
function arquivo(form: FormData): NextRequest {
  return {
    headers: new Headers({ "content-type": "multipart/form-data; boundary=teste" }),
    formData: async () => form,
  } as unknown as NextRequest;
}

function formularioComArquivo(f: File, campos: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set("file", f);
  form.set("agent_id", AGENTE);
  form.set("name", "Manual da Unimed");
  for (const [k, v] of Object.entries(campos)) form.set(k, v);
  return form;
}

function rota(id: string) {
  return { params: Promise.resolve({ id }) };
}

const baldes = new Map<string, number>();

beforeEach(() => {
  vi.clearAllMocks();
  baldes.clear();
  vi.mocked(checkRateLimit).mockImplementation(async (balde, limite, janelaSeg) => {
    const contagem = (baldes.get(balde) ?? 0) + 1;
    baldes.set(balde, contagem);
    return { allowed: contagem <= limite, count: contagem, limit: limite, window_sec: janelaSeg };
  });
  sessao(ORG_A);
  fazerBanco();
});

// ---------------------------------------------------------------------------
// FR-001 — a declaração
// ---------------------------------------------------------------------------

describe("FR-001 · material sem escopo e sem 'vale para todas' é recusado", () => {
  it("segmento que não é operadora nem `todas` volta 400 em português, sem escrever nada", async () => {
    const { chamadas } = fazerBanco();
    // É o que a tela manda quando ninguém escolheu na lista: a URL sai com `undefined`.
    const res = await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota("undefined"));

    expect(res.status).toBe(400);
    const corpo = (await res.json()) as { error: { code: string; message: string; details: unknown } };
    expect(corpo.error.code).toBe("material_sem_escopo");
    // Motivo ACIONÁVEL: diz o gesto que resolve, não só que faltou um campo.
    expect(corpo.error.message).toMatch(/escolhendo-a na lista/i);
    expect(corpo.error.message).toMatch(/vale para todas/i);
    // Nem o insert nem a leitura do agente: a recusa é anterior a tudo.
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("`todas` grava applies_to_all e NENHUM escopo — é o outro lado do XOR", async () => {
    const { chamadas } = fazerBanco();
    const res = await POST(colado({ agent_id: AGENTE, name: "Regras gerais", markdown_blob: MARKDOWN }), rota("todas"));

    expect(res.status).toBe(202);
    const insert = chamadas.find((c) => c.op === "insert" && c.tabela === "ai_knowledge_sources");
    expect(insert?.payload).toMatchObject({
      organization_id: ORG_A,
      scope_id: null,
      applies_to_all: true,
    });
    // Nenhuma linha de `knowledge_scopes` é consultada: `todas` não é escopo fictício.
    expect(chamadas.filter((c) => c.tabela === "knowledge_scopes")).toHaveLength(0);
  });

  it("uuid de escopo grava o escopo e applies_to_all falso", async () => {
    const { chamadas } = fazerBanco();
    const res = await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota(ESCOPO));

    expect(res.status).toBe(202);
    const insert = chamadas.find((c) => c.op === "insert" && c.tabela === "ai_knowledge_sources");
    expect(insert?.payload).toMatchObject({ scope_id: ESCOPO, applies_to_all: false });
  });

  it("escopo de outra organização é 404 — o filtro de org não devolve linha", async () => {
    fazerBanco({ escopoExiste: false });
    const res = await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota(ESCOPO));
    expect(res.status).toBe(404);
  });

  it("declarar escopo pelo CORPO é 422 — a declaração não vem por onde o cliente escolhe", async () => {
    const res = await POST(
      colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN, applies_to_all: true }),
      rota(ESCOPO),
    );
    expect(res.status).toBe(422);
  });

  it("organization_id no corpo é 422 — nunca fonte de tenancy", async () => {
    const res = await POST(
      colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN, organization_id: ORG_B }),
      rota(ESCOPO),
    );
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// FR-007 — formato e tamanho, ANTES
// ---------------------------------------------------------------------------

describe("FR-007 · formato e tamanho declarados antes de aceitar", () => {
  it("o GET declara formatos e tamanho máximo no meta", async () => {
    const res = await GET(new NextRequest("http://localhost/x"), rota(ESCOPO));
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as {
      meta: { upload: { accepted_formats: string[]; max_bytes: number } };
    };
    expect(corpo.meta.upload.accepted_formats).toEqual(["pdf", "md"]);
    expect(corpo.meta.upload.max_bytes).toBe(TAMANHO_MAXIMO_BYTES);
  });

  it("arquivo maior que o teto é 413 material_muito_grande, e o limite vem junto", async () => {
    const { chamadas } = fazerBanco();
    const grande = new File(["x"], "manual.pdf", { type: "application/pdf" });
    Object.defineProperty(grande, "size", { value: TAMANHO_MAXIMO_BYTES + 1 });

    const res = await POST(arquivo(formularioComArquivo(grande)), rota(ESCOPO));

    expect(res.status).toBe(413);
    const corpo = (await res.json()) as {
      error: { code: string; message: string; details: { max_bytes: number } };
    };
    expect(corpo.error.code).toBe("material_muito_grande");
    expect(corpo.error.message).toMatch(/limite é 20 MB/);
    expect(corpo.error.details.max_bytes).toBe(TAMANHO_MAXIMO_BYTES);
    // Recusa ANTES de ler o conteúdo e antes de qualquer escrita.
    expect(vi.mocked(extractPdfText)).not.toHaveBeenCalled();
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("formato fora da lista é 415 formato_nao_suportado, dizendo o que enviar", async () => {
    const { chamadas } = fazerBanco();
    const planilha = new File(["a;b"], "tabela.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const res = await POST(arquivo(formularioComArquivo(planilha)), rota(ESCOPO));

    expect(res.status).toBe(415);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("formato_nao_suportado");
    expect(corpo.error.message).toMatch(/PDF|Markdown/);
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("markdown dentro do teto é aceito com 202 e nasce em `building`", async () => {
    const md = new File([MARKDOWN], "faq.md", { type: "text/markdown" });
    const res = await POST(arquivo(formularioComArquivo(md)), rota(ESCOPO));

    expect(res.status).toBe(202);
    const corpo = (await res.json()) as { data: { status: string; chunks_count: number } };
    // 202 + `building`: o material está durável, o trecho buscável ainda não existe.
    expect(corpo.data.status).toBe("building");
    expect(corpo.data.chunks_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FR-004 — nada aceito em silêncio
// ---------------------------------------------------------------------------

describe("FR-004 · o que não vira conteúdo buscável é recusado na hora", () => {
  it("PDF só de imagem é 422 material_sem_texto_extraivel, sem deixar linha para trás", async () => {
    const { chamadas } = fazerBanco();
    vi.mocked(extractPdfText).mockRejectedValueOnce(new PdfExtractError("sem camada de texto"));
    const pdf = new File(["%PDF"], "manual.pdf", { type: "application/pdf" });

    const res = await POST(arquivo(formularioComArquivo(pdf)), rota(ESCOPO));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("material_sem_texto_extraivel");
    expect(corpo.error.message).toMatch(/imagem/i);
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("arquivo legível do qual não sai nenhum par pergunta/resposta é 422 com instrução", async () => {
    const { chamadas } = fazerBanco();
    const prosa = new File(["Texto corrido, sem marcação nenhuma."], "manual.md", {
      type: "text/markdown",
    });

    const res = await POST(arquivo(formularioComArquivo(prosa)), rota(ESCOPO));

    expect(res.status).toBe(422);
    const corpo = (await res.json()) as { error: { code: string; message: string } };
    expect(corpo.error.code).toBe("material_sem_texto_extraivel");
    expect(corpo.error.message).toMatch(/## Pergunta:/);
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("texto colado sem conteúdo nenhum é 422 de validação, não 202", async () => {
    const res = await POST(colado({ agent_id: AGENTE, name: "Vazio" }), rota(ESCOPO));
    expect(res.status).toBe(422);
  });

  it("aceito, o conteúdo vira itens e o evento de indexação é emitido", async () => {
    const { chamadas, rpc } = fazerBanco();
    await POST(colado({ agent_id: AGENTE, name: "FAQ", markdown_blob: MARKDOWN }), rota(ESCOPO));

    const itens = chamadas.find((c) => c.op === "insert" && c.tabela === "ai_faq_items");
    expect(itens?.payload).toEqual([
      expect.objectContaining({
        organization_id: ORG_A,
        knowledge_source_id: MATERIAL,
        question: "Como pedir a segunda via do boleto?",
        position: 0,
      }),
    ]);
    // Sem o evento, o material ficaria "processando" para sempre — aceito e descartado.
    expect(rpc).toHaveBeenCalledWith(
      "emit_event",
      expect.objectContaining({ p_event_type: "knowledge_source.updated", p_organization_id: ORG_A }),
    );
  });
});

// ---------------------------------------------------------------------------
// FR-005 — o estado é derivado, não copiado
// ---------------------------------------------------------------------------

describe("FR-005 · o GET diz o estado de cada material", () => {
  it("traduz last_index_status no estado que a tela mostra", async () => {
    fazerBanco({
      lista: [
        { ...linhaDoMaterial, id: "a", last_index_status: null },
        { ...linhaDoMaterial, id: "b", last_index_status: "success", chunks_count: 12 },
        { ...linhaDoMaterial, id: "c", last_index_status: "failed", last_index_error: "PDF ilegível." },
        { ...linhaDoMaterial, id: "d", status: "archived", last_index_status: "success" },
      ],
    });

    const res = await GET(new NextRequest("http://localhost/x"), rota(ESCOPO));
    const corpo = (await res.json()) as {
      data: { id: string; status: string; chunks_count: number; last_index_error: string | null }[];
    };

    expect(corpo.data.map((m) => [m.id, m.status])).toEqual([
      ["a", "building"],
      ["b", "ready"],
      ["c", "failed"],
      ["d", "archived"],
    ]);
    expect(corpo.data[1]?.chunks_count).toBe(12);
    // O motivo acionável chega ao cliente — é metade do que FR-005 pede.
    expect(corpo.data[2]?.last_index_error).toBe("PDF ilegível.");
  });

  it("o caminho interno do blob não sai na projeção", async () => {
    fazerBanco({
      lista: [
        { ...linhaDoMaterial, source_metadata: { filename: "manual.md", blob_path: "org/x.md" } },
      ],
    });
    const res = await GET(new NextRequest("http://localhost/x"), rota(ESCOPO));
    const texto = await res.text();
    expect(texto).toContain("manual.md");
    expect(texto).not.toContain("blob_path");
  });
});

// ---------------------------------------------------------------------------
// Teto por organização
// ---------------------------------------------------------------------------

describe("teto de requisições por organização", () => {
  async function gastarOOrcamento() {
    for (let i = 0; i < TETO_DE_MATERIAL.limite; i += 1) {
      const res = await POST(colado({ agent_id: AGENTE, name: `M${i}`, markdown_blob: MARKDOWN }), rota(ESCOPO));
      expect(res.status).toBe(202);
    }
  }

  it("estourado, devolve 429 com Retry-After e sem gravar material", async () => {
    await gastarOOrcamento();
    const { chamadas } = fazerBanco();

    const res = await POST(colado({ agent_id: AGENTE, name: "Passa do teto", markdown_blob: MARKDOWN }), rota(ESCOPO));

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(chamadas.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  it("org A estourar não impede a org B de carregar material", async () => {
    await gastarOOrcamento();
    expect((await POST(colado({ agent_id: AGENTE, name: "x", markdown_blob: MARKDOWN }), rota(ESCOPO))).status).toBe(429);

    sessao(ORG_B);
    fazerBanco();
    const daOutraCorretora = await POST(
      colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }),
      rota(ESCOPO),
    );
    expect(daOutraCorretora.status).toBe(202);
  });

  it("o balde é o de material, com a organização do requireRole", async () => {
    await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota(ESCOPO));
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(
      `${TETO_DE_MATERIAL.balde}:${ORG_A}`,
      TETO_DE_MATERIAL.limite,
      TETO_DE_MATERIAL.janelaSeg,
    );
  });
});

// ---------------------------------------------------------------------------
// T092 — papel e trilha
// ---------------------------------------------------------------------------

describe("T092 · gestor para escrever, trilha em toda mutação", () => {
  it("agent não carrega material (é mutação, exige gestor)", async () => {
    sessao(ORG_A, "agent");
    const res = await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota(ESCOPO));
    expect(res.status).toBe(403);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("viewer LÊ a lista de materiais", async () => {
    sessao(ORG_A, "viewer");
    expect((await GET(new NextRequest("http://localhost/x"), rota(ESCOPO))).status).toBe(200);
  });

  it("carga aceita emite api_audit_log com autor, organização e o balde do material", async () => {
    await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota(ESCOPO));

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: ANA,
        organizationId: ORG_A,
        resourceType: "ai_knowledge_source",
        resourceId: MATERIAL,
        metadata: expect.objectContaining({ scope_id: ESCOPO, applies_to_all: false, items_count: 1 }),
      }),
    );
  });

  it("agente de outra organização é 404, e nada é auditado", async () => {
    fazerBanco({ agenteExiste: false });
    const res = await POST(colado({ agent_id: AGENTE, name: "Manual", markdown_blob: MARKDOWN }), rota(ESCOPO));
    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
