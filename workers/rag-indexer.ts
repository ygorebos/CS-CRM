/**
 * RAG indexer worker — consumes domain events and indexes content into
 * `ai_chunks` + `ai_knowledge_versions` for semantic retrieval.
 *
 * Events handled:
 *   - nuvemshop.product_synced  → fetches product, embeds chunks, activates version
 *   - knowledge_source.updated  → reconstrói UMA versão com todas as fontes `ready`
 *
 * Regra que atravessa os dois caminhos (FR-006): a versão nova só é ATIVADA quando
 * **todos** os trechos planejados entraram. Falha no meio deixa a versão anterior valendo
 * por inteiro — base pela metade responde errado onde a base velha recusaria.
 *
 * Service-role caveat (CLAUDE.md §multi-tenancy): every query filters
 * `organization_id` from the trusted event row, never from user input.
 */

import { isEmbeddingProviderConfigured } from "@/lib/ai/gateway";
import { embedText } from "@/lib/ai/embed";
import { acquireDebounce } from "@/lib/ai/rag/debounce";
import { chunkText, computeContentHash } from "@/lib/ai/rag/chunker";
import { estimateTokens } from "@/lib/ai/runtime/history";
import { formatProductForRag, type NuvemshopProduct } from "@/lib/ai/rag/format-product";
import {
  createKnowledgeVersion,
  markVersionReady,
  markVersionFailed,
  activateVersion,
} from "@/lib/ai/rag/version";
import type { EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { NuvemshopApiClient } from "@/lib/nuvemshop/api-client";

const DEBOUNCE_TTL_SEC = 30;
const LAG_WARN_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkipResult = { type: "skip"; reason: string };
type ErrorResult = { type: "error"; detail: string };
type OkResult = { type: "ok"; versionId: string; chunkCount: number };
type ProcessResult = SkipResult | ErrorResult | OkResult;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skip(reason: string): SkipResult {
  return { type: "skip", reason };
}

/**
 * Grava o estado da indexação **só nas fontes que participaram desta rodada** (T097,
 * FR-003).
 *
 * O laço anterior percorria TODAS as fontes `ready` do agente e carimbava
 * `last_index_status='failed'` + `chunks_count=0` em qualquer uma que não tivesse
 * produzido trecho nesta rodada. Fonte que o indexador ainda não sabe ler (PDF/política,
 * T084) produz zero trechos SEMPRE — então carregar um FAQ novo marcava o manual da
 * outra operadora como "falhou" e zerava a contagem dele na tela. Isso é exatamente o que
 * FR-003 proíbe: carregar material não pode desativar, apagar ou substituir material não
 * relacionado. Quem não entrou na rodada não é tocado — o estado dele continua descrevendo
 * a última rodada em que ele de fato entrou.
 *
 * Na falha, `chunks_count` e `last_indexed_at` **não** são escritos: o acervo que continua
 * ativo é o anterior, e a contagem na tela tem de continuar descrevendo esse acervo
 * (FR-006). Só o estado e o motivo mudam, para a falha não ser silenciosa (FR-004).
 */
async function registrarEstadoDasFontes(
  organizationId: string,
  estado:
    | { tipo: "sucesso"; porFonte: Map<string, number> }
    | { tipo: "falha"; fontes: string[]; motivo: string },
): Promise<void> {
  const admin = createAdminClient();

  if (estado.tipo === "sucesso") {
    const agora = new Date().toISOString();
    for (const [fonteId, gravados] of estado.porFonte) {
      await admin
        .from("ai_knowledge_sources")
        .update({
          last_index_status: "success",
          last_index_error: null,
          last_indexed_at: agora,
          // O que REALMENTE entrou, nao o que eu pretendia gravar: contar o planejado
          // fazia a tela anunciar "4 chunks indexados" com zero chunks no banco.
          chunks_count: gravados,
        })
        .eq("id", fonteId)
        .eq("organization_id", organizationId);
    }
    return;
  }

  for (const fonteId of estado.fontes) {
    await admin
      .from("ai_knowledge_sources")
      .update({
        last_index_status: "failed",
        last_index_error: estado.motivo,
      })
      .eq("id", fonteId)
      .eq("organization_id", organizationId);
  }
}

/**
 * Loads the default active agent for the org.
 * Returns null when no agent is configured.
 */
async function resolveAgent(
  organizationId: string,
): Promise<{ id: string; active_kb_version_id: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ai_agents")
    .select("id, organization_id, active_kb_version_id, is_active, is_default")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!data) return null;
  return {
    id: (data as { id: string }).id,
    active_kb_version_id:
      (data as { active_kb_version_id: string | null }).active_kb_version_id ?? null,
  };
}

/**
 * Loads the decrypted Nuvemshop access token + store ID for the org.
 * Returns null when the integration is not connected.
 */
async function resolveNuvemshopCredentials(
  organizationId: string,
): Promise<{ accessToken: string; storeId: string } | null> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("tenant_integrations")
    .select("id, organization_id, provider, store_metadata, oauth_access_token_encrypted")
    .eq("organization_id", organizationId)
    .eq("provider", "nuvemshop")
    .eq("status", "active")
    .maybeSingle();

  if (error || !data) return null;

  // store_metadata carries the storeId as { store_id: string } or { id: number }
  const meta = (data as { store_metadata: Record<string, unknown> | null }).store_metadata ?? {};
  const storeId = String(
    meta["store_id"] ?? meta["id"] ?? "",
  );
  if (!storeId) return null;

  // Decrypt the access token via Postgres helper fn_decrypt_oauth.
  // We use RPC to avoid shipping plaintext bytes through the app layer.
  const { data: decrypted, error: decErr } = await admin.rpc(
    "fn_decrypt_oauth" as never,
    {
      p_organization_id: organizationId,
      p_integration_id: (data as { id: string }).id,
    } as never,
  );

  if (decErr || !decrypted) return null;

  const accessToken = String(decrypted);
  if (!accessToken) return null;

  return { accessToken, storeId };
}

/**
 * Fetches a single product from Nuvemshop REST API.
 * Returns null when credentials are unavailable or product not found.
 */
async function fetchNuvemshopProduct(
  organizationId: string,
  productId: string,
): Promise<NuvemshopProduct | null> {
  const creds = await resolveNuvemshopCredentials(organizationId);
  if (!creds) {
    // Wave 4 stub — full Nuvemshop credential resolution implemented in S-06.x
    // Concern: fn_decrypt_oauth RPC may not exist; if so, this returns null gracefully.
    logger.warn("rag-indexer: credencial Nuvemshop indisponível, produto não buscado", {
      organization_id: organizationId,
    });
    return null;
  }

  const client = new NuvemshopApiClient({
    storeId: creds.storeId,
    accessToken: creds.accessToken,
  });

  try {
    const product = await client.get<NuvemshopProduct>(`/products/${productId}`);
    return product ?? null;
  } catch (err) {
    logger.warn("rag-indexer: falha ao buscar produto na Nuvemshop", {
      organization_id: organizationId,
      product_id: productId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleProductSynced(
  row: EventRow,
  agentId: string,
): Promise<ProcessResult> {
  const productId = String(row.payload["product_id"] ?? "");
  if (!productId) {
    return skip("missing_product_id_in_payload");
  }

  const product = await fetchNuvemshopProduct(row.organization_id, productId);
  if (!product) {
    return skip("product_fetch_failed_or_stub");
  }

  const text = formatProductForRag(product);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    return skip("no_chunks_generated");
  }

  // Create a new version in 'building' status.
  const { versionId, versionNumber } = await createKnowledgeVersion({
    agentId,
    organizationId: row.organization_id,
    sourceType: "nuvemshop_product",
  });

  logger.info("rag-indexer: versão criada para catálogo Nuvemshop", {
    organization_id: row.organization_id,
    version_id: versionId,
    version_number: versionNumber,
    trechos_planejados: chunks.length,
  });

  // Embed and upsert each chunk.
  const admin = createAdminClient();
  let successCount = 0;

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i] ?? "";
    if (!content) continue;
    const contentHash = computeContentHash(content);

    let embedding: number[];
    try {
      const result = await embedText(content, { organizationId: row.organization_id });
      embedding = result.embedding;
    } catch (err) {
      // If embedding fails mid-way, abort and fail the version.
      const detail = err instanceof Error ? err.message : String(err);
      // `markVersionFailed` aqui e não no chamador: `processRagIndexer` só conhece o
      // `versionId` quando o resultado é "ok" (a atribuição é depois do switch), então o
      // `if (versionId)` do bloco de erro dele nunca é verdadeiro. Sem esta linha a versão
      // ficava em `building` para sempre — um fantasma que a tela não sabe interpretar.
      await markVersionFailed(versionId, row.organization_id, `embed_failed@${i}: ${detail}`);
      return { type: "error", detail: `embed_failed at chunk ${i}: ${detail}` };
    }

    // Upsert chunk — conflict on (organization_id, kb_version_id, content_hash) → do nothing
    const { error: upsertErr } = await admin
      .from("ai_chunks")
      .upsert(
        {
          organization_id: row.organization_id,
          kb_version_id: versionId,
          knowledge_source_id: null, // product-level indexing; source link deferred to S-06.05
          position: i,
          content,
          content_hash: contentHash,
          // NOT NULL no banco. Nenhum dos dois caminhos preenchia, e todo
          // insert morria com "null value in column token_count".
          token_count: estimateTokens(content),
          embedding: embedding as unknown as string,
          metadata: {
            source_type: "nuvemshop_product",
            product_id: productId,
          },
        },
        {
          // A constraint que existe no banco e ai_chunks_position_unique
          // (knowledge_source_id, kb_version_id, position). O alvo antigo
          // (organization_id, kb_version_id, content_hash) nao existe, e o
          // Postgres respondia "there is no unique or exclusion constraint
          // matching the ON CONFLICT specification" — TODO chunk falhava ao
          // gravar. Como cada reindexacao cria uma versao nova, na pratica
          // nunca ha conflito; o alvo certo e o que faz o insert passar.
          onConflict: "knowledge_source_id,kb_version_id,position",
          ignoreDuplicates: true,
        },
      );

    if (upsertErr) {
      logger.warn("rag-indexer: falha ao gravar trecho de produto", {
        organization_id: row.organization_id,
        version_id: versionId,
        position: i,
        erro: upsertErr.message,
      });
    } else {
      successCount++;
    }
  }

  // FR-006 · a mesma regra tudo-ou-nada do caminho de FAQ. Ativar uma versão com parte
  // dos trechos troca uma base íntegra por uma base pela metade — que responde errado em
  // vez de recusar. Falhando aqui, a versão anterior continua ativa por inteiro.
  if (successCount < chunks.length) {
    await markVersionFailed(
      versionId,
      row.organization_id,
      `base parcial: ${successCount} de ${chunks.length} trechos gravados`,
    );
    return {
      type: "error",
      detail: successCount === 0 ? "no_chunks_written" : "base_parcial",
    };
  }

  await markVersionReady(versionId, row.organization_id, successCount);
  await activateVersion({
    agentId,
    versionId,
    organizationId: row.organization_id,
  });

  return { type: "ok", versionId, chunkCount: successCount };
}


/**
 * Reindexa a base de conhecimento do tenant (FAQ, política) — S-06.05/06/07.
 *
 * Decisão de arquitetura: **reconstrói UMA versão com TODAS as fontes**, em vez
 * de uma versão por fonte. A busca (`retrieve_top_k_chunks`) recebe um único
 * `kb_version_id`, e o agente aponta para uma única versão ativa
 * (`ai_agents.active_kb_version_id`). Se cada fonte criasse a própria versão,
 * ativar o FAQ desativaria o catálogo e vice-versa — o RAG degradaria em
 * silêncio, que é pior que não ter.
 *
 * Custo: re-embeddar tudo a cada mudança. Para a base de um tenant (dezenas de
 * itens) são centavos, e a alternativa incremental exigiria diferenciar chunk a
 * chunk. Caminho de evolução, quando a base crescer: reaproveitar os chunks
 * cujo `content_hash` não mudou da versão anterior.
 *
 * A versão só é ATIVADA depois de todos os chunks entrarem: se algo falhar no
 * meio, a versão anterior continua valendo e o agente segue respondendo com a
 * base antiga em vez de ficar sem base nenhuma.
 */
async function handleKnowledgeSourceUpdated(
  row: EventRow,
  agentId: string,
): Promise<ProcessResult> {
  const admin = createAdminClient();

  // T085 · `scope_id` e `applies_to_all` entram no SELECT porque o TRECHO precisa
  // carregá-los. `fn_buscar_lastro` (migration 0123) filtra por `ai_chunks.scope_id` e
  // `ai_chunks.applies_to_all` — os mesmos nomes de coluna — antes de qualquer join.
  // Trecho que chega sem eixo não é um trecho "neutro": ou some da busca (escopo nulo
  // nunca casa com o escopo resolvido), ou, se alguém "consertar" com
  // `applies_to_all = true`, passa a responder pergunta da operadora errada. Os dois
  // desfechos são o defeito que a spec inteira existe para evitar.
  const { data: sourceRows, error: srcErr } = await admin
    .from("ai_knowledge_sources")
    .select("id, source_type, name, scope_id, applies_to_all")
    .eq("organization_id", row.organization_id)
    .eq("agent_id", agentId)
    .eq("status", "ready");
  if (srcErr) return { type: "error", detail: `sources_query_failed: ${srcErr.message}` };

  const sources = (sourceRows ?? []) as {
    id: string;
    source_type: string;
    name: string;
    scope_id: string | null;
    applies_to_all: boolean;
  }[];
  if (sources.length === 0) return skip("no_sources");

  // `tags` e `locale` também: são do ITEM, não da fonte, e hoje morriam aqui — o trecho
  // ia para o banco sem nenhum dos dois, e nada os reconstrói depois da embedagem.
  const { data: itemRows, error: itemErr } = await admin
    .from("ai_faq_items")
    .select("knowledge_source_id, question, answer, position, tags, locale")
    .eq("organization_id", row.organization_id)
    .in("knowledge_source_id", sources.map((s) => s.id))
    .order("position", { ascending: true });
  if (itemErr) return { type: "error", detail: `items_query_failed: ${itemErr.message}` };

  const items = (itemRows ?? []) as {
    knowledge_source_id: string;
    question: string;
    answer: string;
    tags: string[] | null;
    locale: string | null;
  }[];
  if (items.length === 0) return skip("no_content_to_index");

  // Um chunk por par pergunta/resposta: a unidade de recuperação é a resposta
  // inteira. `chunkText` só entra quando a resposta é longa demais para um
  // chunk — assim uma FAQ curta nunca é picada no meio.
  const porFonte = new Map(sources.map((s) => [s.id, s]));
  const pedacos: {
    content: string;
    sourceId: string;
    sourceType: string;
    scopeId: string | null;
    appliesToAll: boolean;
    tags: string[];
    locale: string | null;
  }[] = [];
  // Quem PARTICIPOU desta rodada. É o conjunto que pode ter o estado reescrito no fim —
  // as demais fontes ficam intocadas (T097).
  const planejadosPorFonte = new Map<string, number>();
  for (const it of items) {
    const fonte = porFonte.get(it.knowledge_source_id);
    if (!fonte) continue;
    const texto = `Pergunta: ${it.question}\nResposta: ${it.answer}`;
    for (const c of chunkText(texto)) {
      pedacos.push({
        content: c,
        sourceId: fonte.id,
        sourceType: fonte.source_type,
        scopeId: fonte.scope_id,
        appliesToAll: fonte.applies_to_all,
        tags: it.tags ?? [],
        locale: it.locale,
      });
      planejadosPorFonte.set(fonte.id, (planejadosPorFonte.get(fonte.id) ?? 0) + 1);
    }
  }
  if (pedacos.length === 0) return skip("no_chunks_generated");

  const participantes = [...planejadosPorFonte.keys()];

  const { versionId, versionNumber } = await createKnowledgeVersion({
    agentId,
    organizationId: row.organization_id,
    sourceType: "knowledge_source",
  });
  logger.info("rag-indexer: reconstruindo base de conhecimento", {
    organization_id: row.organization_id,
    version_id: versionId,
    version_number: versionNumber,
    fontes: sources.length,
    trechos_planejados: pedacos.length,
  });

  let gravados = 0;
  const gravadosPorFonte = new Map<string, number>();
  for (let i = 0; i < pedacos.length; i++) {
    const p = pedacos[i]!;
    const contentHash = computeContentHash(p.content);
    let embedding: number[];
    try {
      const r = await embedText(p.content, { organizationId: row.organization_id });
      embedding = r.embedding;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // A versão nova morre aqui e NADA da anterior é tocado: os trechos já gravados
      // pertencem a `versionId`, que nunca é ativada. O acervo que o agente consulta
      // continua sendo o de antes, por inteiro (FR-006).
      await markVersionFailed(versionId, row.organization_id, `embed_failed@${i}: ${detail}`);
      await registrarEstadoDasFontes(row.organization_id, {
        tipo: "falha",
        fontes: participantes,
        motivo: `falha ao vetorizar o trecho ${i + 1} de ${pedacos.length}: ${detail}`,
      });
      return { type: "error", detail: `embed_failed at chunk ${i}: ${detail}` };
    }
    const { error: upErr } = await admin.from("ai_chunks").upsert(
      {
        organization_id: row.organization_id,
        kb_version_id: versionId,
        knowledge_source_id: p.sourceId,
        position: i,
        content: p.content,
        content_hash: contentHash,
        token_count: estimateTokens(p.content),
        embedding: embedding as unknown as string,
        // T085 · o eixo de escopo viaja da FONTE para o TRECHO. O banco também
        // sincroniza isto por trigger (`trg_ai_chunks_escopo`, migration 0118) e é ele o
        // dono da verdade; escrever aqui torna a propagação visível no worker em vez de
        // depender de um efeito invisível, e mantém o trecho correto se algum dia ele for
        // gravado por um caminho sem o trigger.
        scope_id: p.scopeId,
        applies_to_all: p.appliesToAll,
        // `tags` e `locale` não têm coluna própria em `ai_chunks` — `metadata` é o lugar
        // declarado (já tem índice GIN e já carrega `source_type`). Criar coluna exigiria
        // migration, e nada na busca filtra por elas hoje: o que se perde sem isto é a
        // capacidade de dizer DE ONDE o trecho veio e em que idioma foi escrito.
        metadata: {
          source_type: p.sourceType,
          tags: p.tags,
          locale: p.locale,
        },
      },
      // Ver comentario no caminho de produto: esta e a constraint que existe.
      { onConflict: "knowledge_source_id,kb_version_id,position", ignoreDuplicates: true },
    );
    if (upErr) {
      logger.warn("rag-indexer: falha ao gravar trecho", {
        organization_id: row.organization_id,
        version_id: versionId,
        position: i,
        erro: upErr.message,
      });
    } else {
      gravados++;
      gravadosPorFonte.set(p.sourceId, (gravadosPorFonte.get(p.sourceId) ?? 0) + 1);
    }
  }

  // FR-006 · A ATIVAÇÃO É TUDO-OU-NADA.
  //
  // `gravados > 0` não basta. Ativar uma versão com PARTE dos trechos troca uma base
  // íntegra por uma base pela metade — e o buraco não aparece como erro: aparece como
  // resposta errada com ar de certeza. Base velha recusa a pergunta que não sabe
  // responder; base pela metade a responde errado. Enquanto a versão nova não estiver
  // completa, a anterior continua ativa por inteiro.
  if (gravados < pedacos.length) {
    const motivo = `base parcial: ${gravados} de ${pedacos.length} trechos gravados`;
    await markVersionFailed(versionId, row.organization_id, motivo);
    await registrarEstadoDasFontes(row.organization_id, {
      tipo: "falha",
      fontes: participantes,
      motivo,
    });
    return { type: "error", detail: gravados === 0 ? "no_chunks_written" : "base_parcial" };
  }

  await markVersionReady(versionId, row.organization_id, gravados);
  await activateVersion({ agentId, versionId, organizationId: row.organization_id });

  // Estado por fonte: a tela mostra "Chunks indexados" e a última indexação. Só as fontes
  // que participaram (T097) — ver `registrarEstadoDasFontes`.
  await registrarEstadoDasFontes(row.organization_id, {
    tipo: "sucesso",
    porFonte: gravadosPorFonte,
  });

  return { type: "ok", versionId, chunkCount: gravados };
}

// ---------------------------------------------------------------------------
// Main processor — exported for handler adapter + unit tests
// ---------------------------------------------------------------------------

export async function processRagIndexer(row: EventRow): Promise<HandlerResult> {
  const consumerKey = "rag-indexer.v1";

  // Lag monitor (IA-11)
  const lagMs = Date.now() - new Date(row.payload["created_at"] as string ?? row.id).getTime();
  if (lagMs > LAG_WARN_MS) {
    logger.warn("rag-indexer: atraso acima de 5 min na fila de indexação", {
      organization_id: row.organization_id,
      event_id: row.id,
      event_type: row.event_type,
      lag_s: Math.round(lagMs / 1000),
    });
  }

  // Guard: embedding provider must be configured.
  if (!isEmbeddingProviderConfigured()) {
    return { consumer_key: consumerKey, status: "skipped", detail: "openai_key_missing" };
  }

  // Resolve the active agent for this org.
  let agentId: string;
  try {
    const agent = await resolveAgent(row.organization_id);
    if (!agent) {
      return { consumer_key: consumerKey, status: "skipped", detail: "agent_inactive_or_missing" };
    }
    agentId = agent.id;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("rag-indexer: falha ao resolver o agente ativo", {
      organization_id: row.organization_id,
      erro: detail,
    });
    return { consumer_key: consumerKey, status: "error", detail };
  }

  // Debounce key scoped to (org, agent, event_type) to coalesce bursts.
  const debounceKey = `rag:debounce:${row.organization_id}:${agentId}:${row.event_type}`;
  const acquired = await acquireDebounce(debounceKey, DEBOUNCE_TTL_SEC);
  if (!acquired) {
    return { consumer_key: consumerKey, status: "skipped", detail: "debounced" };
  }

  let versionId: string | undefined;

  try {
    let result: ProcessResult;

    switch (row.event_type) {
      case "nuvemshop.product_synced":
        result = await handleProductSynced(row, agentId);
        break;

      case "knowledge_source.updated":
        result = await handleKnowledgeSourceUpdated(row, agentId);
        break;

      default:
        return { consumer_key: consumerKey, status: "skipped", detail: `unhandled_event:${row.event_type}` };
    }

    if (result.type === "skip") {
      return { consumer_key: consumerKey, status: "skipped", detail: result.reason };
    }

    if (result.type === "error") {
      if (versionId) {
        await markVersionFailed(versionId, row.organization_id, result.detail).catch(() => {
          // best-effort
        });
      }
      return { consumer_key: consumerKey, status: "error", detail: result.detail };
    }

    // type === "ok"
    versionId = result.versionId;
    return {
      consumer_key: consumerKey,
      status: "ok",
      detail: `version=${result.versionId} chunks=${result.chunkCount}`,
    };
  } catch (err) {
    // Global catch — worker must NOT throw.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("rag-indexer: erro não tratado", {
      organization_id: row.organization_id,
      event_id: row.id,
      event_type: row.event_type,
      erro: detail,
    });

    if (versionId) {
      await markVersionFailed(versionId, row.organization_id, detail).catch(() => {
        // best-effort
      });
    }

    return { consumer_key: consumerKey, status: "error", detail };
  }
}
