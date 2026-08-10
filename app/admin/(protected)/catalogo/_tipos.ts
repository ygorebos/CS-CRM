/**
 * O que as rotas de `/api/v1/catalog/*` devolvem, do jeito que a tela consome.
 *
 * Spec 002 (RAG por operadora), T066. As rotas são T063/T064/T065 e já existem — estes
 * tipos são o espelho delas, não uma segunda definição do contrato. Quem mudar a projeção
 * de lá (`app/api/v1/catalog/_materiais.ts`, `resumirMaterial`) precisa mudar aqui, e o
 * `typecheck` reclama no ponto de uso em vez de a tela quebrar em produção com `undefined`.
 */

/** Escopo curado = uma operadora, do jeito que o fabricante a mantém. */
export interface EscopoDoCatalogo {
  id: string;
  slug: string;
  display_name: string;
  official_code: string | null;
  /** Desativação GLOBAL, da instalação inteira — não é a do tenant. */
  is_active: boolean;
  /**
   * Quantos assuntos (slugs distintos, sem contar versão nem inerte) o escopo tem.
   * Só a LISTA traz — `GET /scopes/{id}` e o `PATCH` devolvem o escopo sem a contagem.
   */
  materials_count?: number;
  created_at: string;
  updated_at: string;
}

/**
 * Material como aparece na LISTA: sem o texto, com o tamanho dele.
 *
 * O corpo não vem de propósito (a rota não o manda em lista) — quem precisa do texto abre
 * o material.
 */
export interface MaterialResumido {
  id: string;
  catalog_scope_id: string | null;
  applies_to_all: boolean;
  /** A chave do assunto. Todas as versões de um material compartilham o mesmo slug. */
  slug: string;
  version: number;
  title: string;
  body_chars: number;
  /** `AAAA-MM-DD` ou nulo (não vence). */
  valid_until: string | null;
  published_at: string;
  /** `seed` veio com o produto; `local` foi escrito nesta instalação. */
  origin: string;
  /**
   * Versão que chegou na atualização DEPOIS de esta instalação já ter corrigido o
   * material. Não responde nada e espera decisão do curador.
   */
  inert: boolean;
  /** Preenchido quando esta instalação escreveu esta versão. */
  adopted_at: string | null;
  adopted_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Material aberto: o resumo mais o texto e o estado de indexação. */
export interface MaterialCompleto extends MaterialResumido {
  body: string;
  /** Zero = ainda não indexado, portanto ainda não é usado para responder. */
  chunks_count: number;
}

/** Resposta do `PATCH` — versão NOVA, e a que ela passa a substituir. */
export interface MaterialPublicado extends MaterialCompleto {
  replaces?: { id: string; version: number };
}

/** Um agrupamento de recusas por operadora, como `GET /catalog/gaps` devolve. */
export interface LacunaPorEscopo {
  /** Nulo quando o aviso não identificou a operadora. Nunca um rótulo inventado. */
  scope: string | null;
  count: number;
  example_question: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface LacunasDoCatalogo {
  window: { from: string; to: string; days: number };
  refusals: {
    total: number;
    analyzed: number;
    open: number;
    by_scope: LacunaPorEscopo[];
    examples: Array<{ question: string; scope: string | null; seen_at: string }>;
  };
  searches: {
    total: number;
    /** Buscas que não trouxeram nada. */
    empty: number;
    /** Buscas vazias cujo melhor candidato ficou logo abaixo do corte. */
    near_miss: number;
  };
}

/** Envelope de sucesso da API (`lib/api/wrappers.ts`). */
export interface RespostaDaApi<T> {
  data: T;
  meta?: { has_more?: boolean; total?: number; truncated?: boolean; generated_at?: string };
}
