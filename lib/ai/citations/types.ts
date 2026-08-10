export interface Citation {
  chunk_id?: string;
  knowledge_source_id?: string | null;
  source_type?:
    | "faq"
    | "policy"
    | "conversation"
    | "conversations"
    | "catalog"
    | "nuvemshop_catalog"
    | string;
  source_anchor?: string | null;
  score?: number; // 0..1 cosine similarity
  snippet?: string;
  text?: string; // fallback if snippet absent
  metadata?: Record<string, unknown>;
}

export function extractCitations(messageMetadata: unknown): Citation[] {
  if (!messageMetadata || typeof messageMetadata !== "object") return [];
  const m = messageMetadata as Record<string, unknown>;
  const raw = m.citations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is Citation => !!c && typeof c === "object");
}

export function isAiGeneratedMessage(messageMetadata: unknown): boolean {
  if (!messageMetadata || typeof messageMetadata !== "object") return false;
  return (messageMetadata as Record<string, unknown>).ai_generated === true;
}

/**
 * A origem de uma resposta, como o corretor precisa lê-la (spec 002, FR-022 e FR-039).
 *
 * Vive aqui, e não dentro do componente, porque é REGRA: qual camada respondeu decide a
 * quem o corretor cobra a correção — material dele, ele mesmo; material do catálogo, quem
 * o cura. Regra dentro de JSX não tem teste, e esta precisa ter.
 */
export interface OrigemDaCitacao {
  /** `tenant` = material do próprio corretor · `catalog` = veio com o produto. */
  readonly camada: "tenant" | "catalog" | null;
  /** Rótulo em português da camada — o corretor não conhece a palavra "tenant". */
  readonly camadaRotulo: string | null;
  readonly titulo: string | null;
  /** O escopo (no nicho de validação, a operadora). */
  readonly escopo: string | null;
  /** Data da última atualização DAQUELE material, não da resposta. */
  readonly atualizadoEm: string | null;
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function descreverOrigem(citation: Citation): OrigemDaCitacao {
  const meta = (citation.metadata ?? {}) as Record<string, unknown>;
  const camadaCrua = meta.layer;
  const camada =
    camadaCrua === "tenant" || camadaCrua === "catalog" ? camadaCrua : null;
  return {
    camada,
    camadaRotulo:
      camada === "tenant"
        ? "Material seu"
        : camada === "catalog"
          ? "Veio com o produto"
          : null,
    titulo: texto(meta.title),
    escopo: texto(meta.scope),
    atualizadoEm: texto(meta.updated_at),
  };
}

/**
 * A origem aparece? (FR-022 · SC-008)
 *
 * **Sem modo de depuração.** Até aqui a citação vivia atrás de `useDebugToggle`, e o
 * requisito é explícito: o corretor chega ao trecho "sem ativar nenhum modo de depuração".
 * Uma trava de rastreabilidade que depende de alguém descobrir um interruptor é a mesma
 * classe de defeito do `rag_must_hit` que ninguém avaliava — existe na tela e não vale.
 *
 * Ausência de citação numa resposta que NÃO é de assistência é normal e não sinaliza nada
 * (US3, cenário 4): uma saudação não tem o que citar. Por isso a regra é "há citação?", e
 * não "deveria haver?" — quem decide se deveria é o gate de lastro, antes do envio.
 */
export function deveMostrarOrigem(args: {
  isOutbound: boolean;
  metadata: unknown;
}): boolean {
  if (!args.isOutbound) return false;
  if (!isAiGeneratedMessage(args.metadata)) return false;
  return extractCitations(args.metadata).length > 0;
}
