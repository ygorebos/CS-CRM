/**
 * POST /api/v1/knowledge-scopes/{id}/materials — carrega material PRÓPRIO do tenant
 * GET  /api/v1/knowledge-scopes/{id}/materials — o estado de cada material (FR-005)
 *
 * Spec 002 (RAG por operadora), T088. Contrato em
 * `specs/002-rag-por-operadora/contracts/rotas-http.md`.
 *
 * ## FR-001 — a declaração mora no PATH
 *
 * Todo material tem de declarar a qual operadora se aplica **ou** que vale para todas. O
 * segmento `{id}` é essa declaração: um UUID de `knowledge_scopes` (visível a esta
 * organização) ou a palavra reservada `todas`. Qualquer outra coisa — inclusive o
 * `undefined` que uma tela monta quando ninguém escolheu na lista — é **400
 * `material_sem_escopo`**, com uma frase que diz o que fazer em seguida.
 *
 * O CHECK `ai_knowledge_sources_scope_xor_all` (migration 0118) também barraria. Ele
 * continua sendo a garantia final, e é bom que seja — mas a mensagem dele é "new row
 * violates check constraint", que não ajuda o corretor a terminar o cadastro. A validação
 * aqui existe para a recusa ser LEGÍVEL, não para substituir a do banco.
 *
 * A camada — a outra metade de FR-001 — é implícita e não precisa ser declarada: esta rota
 * só escreve em `ai_knowledge_sources`, que é o acervo do tenant. O catálogo curado tem
 * superfície própria (`/api/v1/catalog/*`), alcançável só por `is_platform_admin`.
 *
 * ## FR-007 — o que cabe é dito ANTES do envio
 *
 * `GET` devolve `meta.upload` com formatos, MIMEs e tamanho máximo. É a mesma tela em que o
 * corretor está quando decide arrastar o arquivo, então ele sabe o que cabe antes de gastar
 * o upload. As recusas repetem a declaração em `details`, para quem integra pela API
 * descobrir o teto pela primeira resposta em vez de por tentativa e erro.
 *
 * ## FR-004 — nada é aceito para morrer depois
 *
 * O texto é extraído e transformado em itens indexáveis **dentro do pedido**. Se o arquivo
 * não rende nenhum item, a resposta é `422 material_sem_texto_extraivel` e nada é gravado:
 * é a diferença entre recusar na cara do corretor e aceitar um material que o indexador
 * nunca vai conseguir ler.
 *
 * ⚠️ **Limite conhecido, e é por isso que a recusa é ampla hoje**: o indexador só lê pares
 * pergunta/resposta (`workers/rag-indexer.ts`), e prosa extraída de PDF ainda não tem onde
 * ser gravada — é o buraco de modelagem de T140, que bloqueia T083/T084. Enquanto ele
 * existir, um PDF de prosa corrida é RECUSADO aqui em vez de aceito e engolido. Quando o
 * destino da prosa existir, esta recusa vira o caminho de aceitação; o contrato da rota não
 * muda.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { extractMarkdownText } from "@/lib/ai/rag/extractors/markdown";
import { PdfExtractError, extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { parseFaqMarkdown, type FaqItem } from "@/lib/ai/rag/ingest/faq";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  ACAO_MATERIAL_CRIADO,
  COLUNAS_DO_MATERIAL,
  TAMANHO_MAXIMO_BYTES,
  TETO_DE_MATERIAL,
  aplicarTetoDaOrganizacao,
  colunasDaDeclaracao,
  declaracaoDeAceite,
  declararEscopo,
  formatoDoArquivo,
  materialColadoSchema,
  projetarMaterial,
  rotuloDoTenant,
  type LinhaDeMaterial,
} from "../../_escopos";

export const dynamic = "force-dynamic";

const RECURSO = "knowledge_scope_materials";

interface Rota {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// GET — o estado de cada material (FR-005)
// ---------------------------------------------------------------------------

export async function GET(_req: NextRequest, { params }: Rota): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const { id } = await params;
  const declaracao = declararEscopo(id);
  // Na LEITURA, um segmento que não nomeia nada é 404 e não 400: aqui ele não é uma
  // declaração malfeita, é um endereço que não existe.
  if (!declaracao) {
    return fail("not_found", "Escopo de conhecimento não encontrado.", 404, { requestId });
  }

  const supabase = await createClient();
  const colunas = colunasDaDeclaracao(declaracao);

  let consulta = supabase
    .from("ai_knowledge_sources")
    .select(COLUNAS_DO_MATERIAL)
    // Filtro explícito além da RLS — doutrina do CLAUDE.md, e o que segura a linha se a
    // policy mudar de forma.
    .eq("organization_id", org.orgId)
    .eq("applies_to_all", colunas.applies_to_all)
    .order("created_at", { ascending: false })
    .limit(500);

  consulta =
    colunas.scope_id === null ? consulta : consulta.eq("scope_id", colunas.scope_id);

  const { data, error } = await consulta;
  if (error) {
    logger.error("[knowledge-scopes/materials] leitura falhou", {
      error: error.message,
      request_id: requestId,
    });
    return fail("internal_error", "Erro ao listar os materiais.", 500, { requestId });
  }

  const linhas = (data ?? []) as unknown as LinhaDeMaterial[];
  return ok(linhas.map(projetarMaterial), {
    requestId,
    meta: {
      total: linhas.length,
      has_more: linhas.length === 500,
      // FR-007: o que cabe, dito ANTES do envio — e não depois de o upload falhar.
      upload: declaracaoDeAceite(),
    },
  });
}

// ---------------------------------------------------------------------------
// POST — carregar material
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest, { params }: Rota): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: RECURSO });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  // Teto DEPOIS do papel (o 403 não gasta orçamento de quem pode escrever) e ANTES de ler
  // o corpo — que aqui pode ser um arquivo de 20 MB.
  const teto = await aplicarTetoDaOrganizacao(org.orgId, TETO_DE_MATERIAL, requestId);
  if (teto.excedido) return teto.excedido;

  const { id } = await params;
  const declaracao = declararEscopo(id);
  if (!declaracao) {
    const rotulo = await rotuloDoTenant(await createClient(), org.orgId);
    // O rótulo entra como substantivo puro: outra instalação configura "Convênio"
    // (masculino) e uma frase concordando em gênero viraria erro de português.
    return fail(
      "material_sem_escopo",
      `Diga a que ${rotulo.singular.toLowerCase()} este material se aplica, escolhendo-a na lista, ou marque que ele vale para todas. Material sem essa declaração não entra na base.`,
      400,
      { requestId, headers: teto.headers, details: { received: id } },
    );
  }

  const tipoDeConteudo = req.headers.get("content-type") ?? "";
  const extraido = tipoDeConteudo.includes("multipart/form-data")
    ? await lerArquivo(req)
    : await lerTextoColado(req);

  if (!extraido.ok) {
    return fail(extraido.codigo, extraido.mensagem, extraido.status, {
      requestId,
      headers: teto.headers,
      details: { ...declaracaoDeAceite(), ...(extraido.details ?? {}) },
    });
  }

  const pedido = extraido.valor;

  const supabase = await createClient();

  // ── o agente tem de ser desta organização ─────────────────────────────────
  // Client de SESSÃO (a RLS isola) + filtro explícito de organização. A FK pegaria um id
  // de outra org com 23503, mas devolveria erro de Postgres onde cabe um 404 legível.
  const { data: agente, error: erroDoAgente } = await supabase
    .from("ai_agents")
    .select("id")
    .eq("id", pedido.agentId)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (erroDoAgente) {
    logger.error("[knowledge-scopes/materials] leitura do agente falhou", {
      error: erroDoAgente.message,
      request_id: requestId,
    });
    return fail("internal_error", "Erro ao validar o agente.", 500, {
      requestId,
      headers: teto.headers,
    });
  }
  if (!agente) {
    return fail("not_found", "Agente não encontrado nesta organização.", 404, {
      requestId,
      headers: teto.headers,
    });
  }

  // ── o escopo tem de existir E ser visível a esta organização ──────────────
  const colunas = colunasDaDeclaracao(declaracao);
  if (declaracao.tipo === "escopo") {
    const { data: escopo, error: erroDoEscopo } = await supabase
      .from("knowledge_scopes")
      .select("id")
      .eq("id", declaracao.id)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (erroDoEscopo) {
      logger.error("[knowledge-scopes/materials] leitura do escopo falhou", {
        error: erroDoEscopo.message,
        request_id: requestId,
      });
      return fail("internal_error", "Erro ao validar o escopo de conhecimento.", 500, {
        requestId,
        headers: teto.headers,
      });
    }
    if (!escopo) {
      return fail("not_found", "Escopo de conhecimento não encontrado.", 404, {
        requestId,
        headers: teto.headers,
      });
    }
  }

  // ── a fonte ───────────────────────────────────────────────────────────────
  // Admin client com `organization_id` explícito, resolvido de `requireRole` — nunca do
  // corpo (anti-pattern nº 10). O caminho de sessão não serve porque a linha nasce com
  // itens filhos, e um INSERT parcial barrado no meio deixaria fonte sem conteúdo.
  const admin = createAdminClient();
  const { data: criado, error: erroDaFonte } = await admin
    .from("ai_knowledge_sources")
    .insert({
      organization_id: org.orgId,
      agent_id: pedido.agentId,
      source_type: pedido.sourceType,
      name: pedido.name,
      // `status: "ready"` é o estado da FONTE (viva, elegível), não o da indexação: o
      // `workers/rag-indexer.ts` só enxerga fontes `ready`, então nascer `building` a
      // tornaria invisível para quem deveria indexá-la — material aceito e nunca
      // indexado, que é justamente o que FR-004 proíbe. O estado que o corretor lê
      // (`building | ready | failed | archived`) é DERIVADO em `projetarMaterial`, a
      // partir de `last_index_status`, e nasce `building` porque ainda não houve rodada.
      status: "ready",
      scope_id: colunas.scope_id,
      applies_to_all: colunas.applies_to_all,
      valid_until: pedido.validUntil,
      ingested_at: new Date().toISOString(),
      source_metadata: pedido.metadata,
    })
    .select(COLUNAS_DO_MATERIAL)
    .single();

  if (erroDaFonte || !criado) {
    logger.error("[knowledge-scopes/materials] insert da fonte falhou", {
      error: erroDaFonte?.message,
      code: erroDaFonte?.code,
      request_id: requestId,
    });
    return fail("internal_error", "Erro ao registrar o material.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const linha = criado as unknown as LinhaDeMaterial;

  // ── os itens ──────────────────────────────────────────────────────────────
  const { error: erroDosItens } = await admin.from("ai_faq_items").insert(
    pedido.itens.map((item, posicao) => ({
      organization_id: org.orgId,
      knowledge_source_id: linha.id,
      question: item.question,
      answer: item.answer,
      tags: item.tags,
      locale: item.locale,
      position: posicao,
    })),
  );

  if (erroDosItens) {
    // Fonte sem item é fonte que o indexador vai pular para sempre. Desfazê-la é o oposto
    // de aceitar em silêncio: melhor o corretor tentar de novo do que ficar com uma linha
    // na tela que nunca sai de "processando".
    await admin.from("ai_knowledge_sources").delete().eq("id", linha.id).eq("organization_id", org.orgId);
    logger.error("[knowledge-scopes/materials] insert dos itens falhou", {
      error: erroDosItens.message,
      request_id: requestId,
    });
    return fail("internal_error", "Erro ao gravar o conteúdo do material.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  // ── o gatilho da indexação ────────────────────────────────────────────────
  // Fire-and-forget de propósito, e é o que torna a resposta 202 honesta: o material está
  // DURÁVEL, o processamento é de outro. Falhar aqui não desfaz nada — o evento é
  // reemitido pela reindexação manual, e o estado na tela continua "processando" em vez de
  // mentir "pronto".
  const { error: erroDoEvento } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: linha.id,
    p_payload: {
      knowledge_source_id: linha.id,
      agent_id: pedido.agentId,
      source_type: pedido.sourceType,
    },
    p_organization_id: org.orgId,
  } as never);
  if (erroDoEvento) {
    logger.warn("[knowledge-scopes/materials] emit_event falhou (não bloqueia)", {
      error: erroDoEvento.message,
      request_id: requestId,
    });
  }

  void audit({
    action: ACAO_MATERIAL_CRIADO,
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: linha.id,
    requestId,
    metadata: {
      scope_id: colunas.scope_id,
      applies_to_all: colunas.applies_to_all,
      source_type: pedido.sourceType,
      name: pedido.name,
      items_count: pedido.itens.length,
      origem_do_conteudo: pedido.origem,
    },
  });

  // 202, não 201: o recurso existe e é durável, mas o que o corretor quer — trecho
  // buscável — ainda não aconteceu. O estado final chega pela tela (FR-005), não por
  // polling do cliente.
  return ok(projetarMaterial(linha), {
    status: 202,
    requestId,
    headers: teto.headers,
    meta: { upload: declaracaoDeAceite() },
  });
}

// ---------------------------------------------------------------------------
// Leitura do pedido — as duas formas convergem no mesmo objeto
// ---------------------------------------------------------------------------

interface PedidoDeMaterial {
  agentId: string;
  name: string;
  sourceType: "faq" | "policy";
  validUntil: string | null;
  itens: FaqItem[];
  metadata: Record<string, unknown>;
  /** Para a auditoria distinguir upload de texto colado sem abrir o metadata. */
  origem: "arquivo" | "texto";
}

type Recusa = {
  ok: false;
  codigo:
    | "invalid_request"
    | "validation_failed"
    | "formato_nao_suportado"
    | "material_muito_grande"
    | "material_sem_texto_extraivel";
  mensagem: string;
  status: number;
  details?: Record<string, unknown>;
};

type Leitura = { ok: true; valor: PedidoDeMaterial } | Recusa;

/**
 * A mensagem que toda recusa por falta de conteúdo indexável usa.
 *
 * Uma frase só, em um lugar só: o corretor que recebe a recusa no upload e o que recebe no
 * texto colado precisam ler a mesma instrução, senão cada tela ensina uma coisa.
 */
const SEM_CONTEUDO =
  "Consegui ler o arquivo, mas não achei nenhum par de pergunta e resposta. " +
  "Marque as seções com `## Pergunta:` e `## Resposta:` (ou `## P:` e `## R:`) e envie de novo.";

/** `multipart/form-data` — o caminho do arquivo. */
async function lerArquivo(req: NextRequest): Promise<Leitura> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return {
      ok: false,
      codigo: "invalid_request",
      mensagem: "Não consegui ler o formulário enviado.",
      status: 400,
    };
  }

  const arquivo = form.get("file");
  if (!(arquivo instanceof File)) {
    return {
      ok: false,
      codigo: "invalid_request",
      mensagem: "Anexe o arquivo no campo `file`.",
      status: 400,
    };
  }

  // TAMANHO ANTES DE TUDO (FR-007): recusar depois de ler 20 MB para a memória é a recusa
  // que custa caro justamente quando o pedido é abusivo.
  if (arquivo.size > TAMANHO_MAXIMO_BYTES) {
    return {
      ok: false,
      codigo: "material_muito_grande",
      mensagem: `O arquivo tem ${Math.ceil(arquivo.size / (1024 * 1024))} MB e o limite é ${Math.floor(TAMANHO_MAXIMO_BYTES / (1024 * 1024))} MB. Divida o material em partes menores e envie uma de cada vez.`,
      status: 413,
      details: { size_bytes: arquivo.size },
    };
  }

  const formato = formatoDoArquivo(arquivo.name, arquivo.type);
  if (!formato) {
    return {
      ok: false,
      codigo: "formato_nao_suportado",
      mensagem:
        "Este formato não é lido pela base de conhecimento. Envie PDF (.pdf) ou Markdown (.md).",
      status: 415,
      details: { filename: arquivo.name, mime_type: arquivo.type },
    };
  }

  const nome = (form.get("name") ?? arquivo.name)?.toString().trim() ?? "";
  if (nome.length < 2 || nome.length > 120) {
    return {
      ok: false,
      codigo: "validation_failed",
      mensagem: "Dê um nome ao material, entre 2 e 120 caracteres.",
      status: 422,
    };
  }

  const agentId = form.get("agent_id")?.toString().trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    return {
      ok: false,
      codigo: "validation_failed",
      mensagem: "Campo `agent_id` ausente ou fora do formato UUID.",
      status: 422,
    };
  }

  const validUntilBruto = form.get("valid_until")?.toString().trim() ?? "";
  if (validUntilBruto !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(validUntilBruto)) {
    return {
      ok: false,
      codigo: "validation_failed",
      mensagem: "Campo `valid_until` deve estar no formato AAAA-MM-DD.",
      status: 422,
    };
  }

  const buffer = Buffer.from(await arquivo.arrayBuffer());
  let texto: string;
  try {
    texto = formato === "pdf" ? await extractPdfText(buffer) : extractMarkdownText(buffer);
  } catch (erro) {
    if (erro instanceof PdfExtractError) {
      return {
        ok: false,
        codigo: "material_sem_texto_extraivel",
        mensagem:
          "Não consegui extrair texto deste PDF — ele parece ser só imagem. Envie a versão em texto, ou cole o conteúdo direto na tela.",
        status: 422,
      };
    }
    return {
      ok: false,
      codigo: "material_sem_texto_extraivel",
      mensagem: "Não consegui ler o conteúdo deste arquivo. Confira se ele não está corrompido.",
      status: 422,
    };
  }

  const itens = parseFaqMarkdown(texto);
  if (itens.length === 0) {
    return { ok: false, codigo: "material_sem_texto_extraivel", mensagem: SEM_CONTEUDO, status: 422 };
  }

  return {
    ok: true,
    valor: {
      agentId,
      name: nome,
      sourceType: "policy",
      validUntil: validUntilBruto === "" ? null : validUntilBruto,
      itens,
      metadata: {
        filename: arquivo.name,
        mime_type: arquivo.type,
        size_bytes: arquivo.size,
        format: formato,
      },
      origem: "arquivo",
    },
  };
}

/** `application/json` — o caminho do texto colado. */
async function lerTextoColado(req: NextRequest): Promise<Leitura> {
  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return {
      ok: false,
      codigo: "invalid_request",
      mensagem: "Body JSON inválido.",
      status: 400,
    };
  }

  const parsed = materialColadoSchema.safeParse(bruto);
  if (!parsed.success) {
    return {
      ok: false,
      codigo: "validation_failed",
      mensagem: "Dados inválidos.",
      status: 422,
      details: { fields: parsed.error.flatten().fieldErrors as Record<string, unknown> },
    };
  }

  const corpo = parsed.data;
  const itens: FaqItem[] =
    corpo.items && corpo.items.length > 0
      ? corpo.items.map((item) => ({
          question: item.question,
          answer: item.answer,
          tags: item.tags ?? [],
          locale: item.locale ?? "pt-BR",
        }))
      : parseFaqMarkdown(corpo.markdown_blob ?? "");

  if (itens.length === 0) {
    return { ok: false, codigo: "material_sem_texto_extraivel", mensagem: SEM_CONTEUDO, status: 422 };
  }

  return {
    ok: true,
    valor: {
      agentId: corpo.agent_id,
      name: corpo.name,
      sourceType: corpo.source_type ?? "faq",
      validUntil: corpo.valid_until ?? null,
      itens,
      metadata: { items_count: itens.length },
      origem: "texto",
    },
  };
}
