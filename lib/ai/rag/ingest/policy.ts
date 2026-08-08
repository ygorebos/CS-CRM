/**
 * Ingestão de documento de política (PDF/Markdown) para o RAG.
 *
 * O texto é extraído, dividido em passagens (~400 tokens ≈ 1600 chars, com ~50 tokens ≈ 200
 * chars de sobreposição) e **gravado em `ai_source_passages`** (migration 0127). A
 * vetorização NÃO acontece aqui: quem embeda, versiona e ativa é o `rag-indexer`, que lê
 * essas passagens.
 *
 * ═══ T083 · POR QUE GRAVAR, E NÃO SÓ CONTAR ═══
 *
 * Até aqui esta função extraía o texto, devolvia `chunkCount` e **jogava o texto fora**. O
 * corretor subia o manual da operadora, a tela dizia "pronto", e nenhum trecho buscável
 * passava a existir. Material aceito e descartado em silêncio é exatamente o que FR-004
 * proíbe — e o silêncio é pior que o erro, porque a tela afirma o contrário.
 *
 * ═══ DE ONDE VEM O TENANT ═══
 *
 * `organization_id`, `scope_id` e `applies_to_all` da passagem vêm da LINHA da fonte em
 * `ai_knowledge_sources` — nunca do que o chamador afirma nos argumentos. O
 * `organizationId` recebido serve só de conferência: se discordar da linha, é escrita no
 * tenant errado e a função para. O client admin bypassa RLS; aqui não existe rede de
 * segurança do banco embaixo.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { chunkText } from "@/lib/ai/rag/chunker";
import { extractPdfText, PdfExtractError } from "@/lib/ai/rag/extractors/pdf";
import { extractMarkdownText } from "@/lib/ai/rag/extractors/markdown";
import { logger } from "@/lib/logger";

export { PdfExtractError };

// ~400 tokens × 4 chars/token ≈ 1600 chars
const POLICY_MAX_CHARS = 1600;
// ~50 tokens × 4 chars/token ≈ 200 chars
const POLICY_OVERLAP_CHARS = 200;

/** Idioma padrão do acervo. Escrito EXPLICITAMENTE na passagem (em vez de deixar o default
 *  da coluna resolver) para que o valor devolvido a quem chamou seja o mesmo que foi ao
 *  banco — o indexador copia daqui para o `metadata` do trecho. */
const LOCALE_PADRAO = "pt-BR";

// Regex to detect markdown headings (# and ##)
const HEADING_RE = /^#{1,2}\s+.+$/m;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Uma fatia do documento, antes de existir no banco. */
export interface PassagemDeDocumento {
  content: string;
  /**
   * Título da seção que contém a fatia — o heading markdown mais próximo acima dela.
   * `null` quando o formato não diz qual é (FR-022: é isto que transforma a citação em
   * "seu manual, seção Carências" em vez de "trecho 47").
   */
  sectionTitle: string | null;
  /**
   * Página do documento. Hoje **sempre `null` para PDF**: `extractPdfText`
   * (`lib/ai/rag/extractors/pdf.ts`) devolve o documento inteiro como UMA string, com as
   * páginas já concatenadas, e não há como recuperar a fronteira depois sem adivinhar —
   * "\n\n" separa página E parágrafo. Preencher isto exige o extrator devolver texto por
   * página; enquanto não devolver, `null` é a resposta honesta e a coluna fica esperando.
   */
  pageNumber: number | null;
}

/** Uma passagem como ela foi para o banco. */
export interface PassagemPersistida extends PassagemDeDocumento {
  position: number;
  tags: string[];
  locale: string;
}

/**
 * Divide o texto do documento em passagens, respeitando primeiro as fronteiras de seção
 * (headings `#`/`##`) e só então o chunker padrão.
 *
 * O heading não é só um ponto de corte: ele vira `section_title` de todas as fatias da
 * seção. É a âncora que o corretor consegue conferir no documento original.
 */
export function dividirEmPassagens(text: string): PassagemDeDocumento[] {
  if (!HEADING_RE.test(text)) {
    // Sem headings — chunking padrão, e nenhuma âncora de seção a oferecer.
    return chunkText(text, { maxChars: POLICY_MAX_CHARS, overlapChars: POLICY_OVERLAP_CHARS })
      .filter((c) => c.trim().length > 0)
      .map((content) => ({ content, sectionTitle: null, pageNumber: null }));
  }

  // Split on heading lines, keeping heading as part of following section
  const lines = text.split("\n");
  const sections: { titulo: string | null; texto: string }[] = [];
  let current: string[] = [];
  let tituloCorrente: string | null = null;

  const fechar = () => {
    const texto = current.join("\n").trim();
    if (texto.length > 0) sections.push({ titulo: tituloCorrente, texto });
  };

  for (const line of lines) {
    const ehHeading = /^#{1,2}\s+/.test(line);
    if (ehHeading && current.length > 0) {
      // Fecha a seção anterior AINDA com o título dela — só depois o título muda.
      fechar();
      current = [];
    }
    if (ehHeading) tituloCorrente = line.replace(/^#{1,2}\s+/, "").trim() || null;
    current.push(line);
  }
  fechar();

  const passagens: PassagemDeDocumento[] = [];
  for (const section of sections) {
    const sectionChunks = chunkText(section.texto, {
      maxChars: POLICY_MAX_CHARS,
      overlapChars: POLICY_OVERLAP_CHARS,
    });
    for (const content of sectionChunks) {
      if (content.trim().length === 0) continue;
      passagens.push({ content, sectionTitle: section.titulo, pageNumber: null });
    }
  }

  return passagens;
}

/**
 * Descobre o formato pelo caminho do arquivo. Exportada porque quem decide se uma fonte é
 * um DOCUMENTO (e não um par pergunta/resposta) precisa da mesma regra — hoje o
 * `rag-indexer`, ao materializar o texto de uma fonte que ainda não tem passagem.
 */
export function resolverExtensao(caminho: string): "pdf" | "md" | null {
  const ext = caminho.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "md") return "md";
  return null;
}

export interface IngestPolicyArgs {
  organizationId: string;
  agentId: string;
  knowledgeSourceId: string;
  blobPath: string;
  ext: "pdf" | "md";
}

export interface IngestPolicyResult {
  /** Quantas passagens o documento produziu. */
  chunkCount: number;
  /** As passagens como foram gravadas. Vazio quando não houve gravação. */
  passagens: PassagemPersistida[];
  /**
   * Por que NÃO gravou, quando não gravou. `null` quando gravou.
   *
   * `fonte_ainda_nao_existe` é o caminho da rota de upload, que chama isto ANTES de
   * inserir a linha da fonte, só para validar a extração e poder recusar o arquivo antes
   * de criar registro. Sem linha de fonte não há `organization_id` confiável, e inventar
   * um a partir do argumento é a violação que o CLAUDE.md chama pelo nome. Quem fecha o
   * ciclo nesse caminho é o `rag-indexer`, que chama de novo com a fonte já existindo.
   */
  naoPersistidoPorque: "fonte_ainda_nao_existe" | null;
}

interface FonteDeConhecimento {
  id: string;
  organization_id: string;
  scope_id: string | null;
  applies_to_all: boolean;
}

/**
 * Lê a fonte que vai dar tenant e escopo às passagens.
 * Devolve `null` quando o id nem sequer é um UUID — o caso da validação pré-insert.
 */
async function resolverFonte(
  knowledgeSourceId: string,
  organizationIdAfirmado: string,
): Promise<FonteDeConhecimento | null> {
  if (!UUID_RE.test(knowledgeSourceId)) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_knowledge_sources")
    .select("id, organization_id, scope_id, applies_to_all")
    .eq("id", knowledgeSourceId)
    .maybeSingle();

  if (error) {
    throw new Error(
      `[ai-policy-ingest] falha ao ler a fonte ${knowledgeSourceId}: ${error.message}`,
    );
  }
  if (!data) {
    // UUID válido que não resolve é defeito, não caso de borda: alguém pediu para gravar
    // passagem de uma fonte que não existe. Gravar assim deixaria linha órfã de tenant.
    throw new Error(`[ai-policy-ingest] fonte ${knowledgeSourceId} não encontrada`);
  }

  const fonte = data as FonteDeConhecimento;
  if (fonte.organization_id !== organizationIdAfirmado) {
    // O argumento discorda da linha. Não é engano recuperável: é escrita apontada para
    // outro tenant, e o client admin passaria por cima da RLS sem reclamar.
    throw new Error(
      `[ai-policy-ingest] organização do argumento não confere com a da fonte ${knowledgeSourceId}`,
    );
  }
  return fonte;
}

/**
 * Grava as passagens, substituindo o que havia daquela fonte.
 *
 * REPROCESSAR SUBSTITUI, NÃO EMPILHA. São duas metades, e faltar uma delas ainda dobra
 * material:
 *   1. `upsert` com conflito em `(knowledge_source_id, position)` — o índice único da
 *      migration 0127 — sobrescreve as posições que já existiam;
 *   2. o corte das posições que sobraram, quando o documento novo é MENOR que o anterior.
 *      Sem ele, o final do manual velho continuaria buscável dentro da fonte nova.
 *
 * A ordem importa: escrever primeiro e cortar depois nunca deixa a fonte sem passagem
 * nenhuma. Apagar antes de escrever abriria a janela em que o material some (FR-006).
 */
async function persistirPassagens(
  fonte: FonteDeConhecimento,
  passagens: PassagemDeDocumento[],
): Promise<PassagemPersistida[]> {
  const admin = createAdminClient();

  const linhas: PassagemPersistida[] = passagens.map((p, i) => ({
    ...p,
    position: i,
    tags: [],
    locale: LOCALE_PADRAO,
  }));

  if (linhas.length > 0) {
    const { error } = await admin.from("ai_source_passages").upsert(
      linhas.map((p) => ({
        organization_id: fonte.organization_id,
        knowledge_source_id: fonte.id,
        // O eixo de escopo vem da FONTE. É por `scope_id`/`applies_to_all` que
        // `fn_buscar_lastro` filtra depois de o indexador copiá-los para o trecho.
        scope_id: fonte.scope_id,
        applies_to_all: fonte.applies_to_all,
        content: p.content,
        position: p.position,
        section_title: p.sectionTitle,
        page_number: p.pageNumber,
        tags: p.tags,
        locale: p.locale,
      })),
      { onConflict: "knowledge_source_id,position" },
    );

    if (error) {
      // Falha visível: quem chamou decide o que fazer (a rota recusa o upload; o worker
      // marca a fonte como falha). O que não pode é seguir como se tivesse gravado.
      throw new Error(`[ai-policy-ingest] falha ao gravar passagens: ${error.message}`);
    }
  }

  const { error: erroDoCorte } = await admin
    .from("ai_source_passages")
    .delete()
    .eq("knowledge_source_id", fonte.id)
    .eq("organization_id", fonte.organization_id)
    .gte("position", linhas.length);

  if (erroDoCorte) {
    throw new Error(
      `[ai-policy-ingest] falha ao remover passagens excedentes: ${erroDoCorte.message}`,
    );
  }

  return linhas;
}

/**
 * Baixa o documento do Storage, extrai o texto, divide em passagens e as grava em
 * `ai_source_passages`.
 *
 * Lança `PdfExtractError` quando a extração de PDF falha (as duas estratégias esgotadas).
 */
export async function ingestPolicyFile(args: IngestPolicyArgs): Promise<IngestPolicyResult> {
  const { organizationId, knowledgeSourceId, blobPath, ext } = args;
  const admin = createAdminClient();

  // Download blob from private ai-policy bucket
  const { data: blob, error: downloadErr } = await admin.storage
    .from("ai-policy")
    .download(blobPath);

  if (downloadErr || !blob) {
    throw new Error(
      `[ai-policy-upload] Failed to download blob ${blobPath} for org ${organizationId}: ${downloadErr?.message ?? "no data"}`,
    );
  }

  const buffer = Buffer.from(await blob.arrayBuffer());

  // Extract text
  let text: string;
  if (ext === "pdf") {
    text = await extractPdfText(buffer); // may throw PdfExtractError
  } else {
    text = extractMarkdownText(buffer);
  }

  const passagens = dividirEmPassagens(text);
  const fonte = await resolverFonte(knowledgeSourceId, organizationId);

  if (!fonte) {
    logger.warn("ingest de política: texto extraído sem fonte para gravar", {
      organization_id: organizationId,
      knowledge_source_id: knowledgeSourceId,
      ext,
      passagens: passagens.length,
    });
    return {
      chunkCount: passagens.length,
      passagens: [],
      naoPersistidoPorque: "fonte_ainda_nao_existe",
    };
  }

  const gravadas = await persistirPassagens(fonte, passagens);

  logger.info("ingest de política: passagens gravadas", {
    organization_id: fonte.organization_id,
    knowledge_source_id: fonte.id,
    ext,
    passagens: gravadas.length,
  });

  return { chunkCount: gravadas.length, passagens: gravadas, naoPersistidoPorque: null };
}
