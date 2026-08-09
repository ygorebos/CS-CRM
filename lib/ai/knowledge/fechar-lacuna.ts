/**
 * A lacuna se fecha sozinha quando o material chega — spec 002, T110, SC-013.
 *
 * ═══ O QUE ESTAVA DESCUMPRIDO, E COMO ISSO PASSOU DESPERCEBIDO ═══
 *
 * SC-013 diz: "carregar o material que cobre uma lacuna a faz sumir da lista". Medido em
 * 2026-08-09, não era o que acontecia: a lista de lacunas vem dos avisos EM ABERTO da
 * Central, e nada os fechava ao chegar material — sumiam quando o corretor clicava
 * "Marcar resolvido". A própria cópia da tela já prometia menos ("faz o agente resolver
 * sozinho da próxima vez"), e a diferença entre as duas frases é a feature inteira.
 *
 * Ninguém notou porque **as duas versões parecem funcionar**: a lista some, cedo ou tarde.
 * O que muda é quem faz o trabalho — o corretor que já carregou o material, e que agora
 * precisa lembrar de voltar na Central e fechar um aviso que o sistema poderia ter fechado.
 *
 * ═══ POR QUE FECHAR, E NÃO APAGAR ═══
 *
 * `status = 'resolved'`, nunca `delete`. O aviso resolvido continua consultável na aba
 * "Resolvidos" e no histórico — é ele que responde "por que esta operadora tinha lacuna
 * semana passada?". Apagar trocaria uma lista suja por uma memória vazia.
 *
 * ═══ O QUE NUNCA É FECHADO, E ISSO É A PARTE IMPORTANTE ═══
 *
 * Aviso com `knowledge_scope_id` NULO — o caso em que o agente não identificou a operadora
 * — **não** é tocado. Não há como saber qual material o cobriria, e fechá-lo junto por
 * proximidade esconderia exatamente a pergunta que mais precisa de gente olhando: a que o
 * sistema não soube nem classificar.
 *
 * Também não se fecha nada em cima de material que entrou VAZIO. Um PDF sem texto
 * extraível gera fonte com zero trechos: a lacuna continua real, e fechá-la faria o
 * corretor acreditar que resolveu.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** O kind do aviso que a lista de lacunas consome (`agent_inbox_items`, migration 0116). */
export const KIND_DA_LACUNA = "assistance_without_grounding";

export interface ResultadoDoFechamento {
  /** Quantos avisos deixaram de estar abertos. Zero é desfecho comum, não erro. */
  readonly fechados: number;
}

/**
 * Fecha as lacunas ABERTAS de um escopo, porque material dele passou a ser buscável.
 *
 * Nunca lança: o material já entrou, e a resposta ao corretor não pode depender de esta
 * limpeza dar certo. Mesmo contrato de `registrarDivergencias` e de `registrarGroundings`.
 */
export async function fecharLacunasDoEscopo(
  admin: SupabaseClient,
  args: {
    readonly organizationId: string;
    readonly scopeId: string | null;
    /** Quantos trechos buscáveis o material produziu. Zero não fecha nada. */
    readonly trechosGravados: number;
  },
  log?: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<ResultadoDoFechamento> {
  // Material sem balde não cobre lacuna de operadora nenhuma; material sem trecho não
  // cobre coisa alguma. As duas guardas existem para o fechamento nunca ser generoso.
  if (args.scopeId === null || args.trechosGravados <= 0) return { fechados: 0 };

  try {
    const { data, error } = await admin
      .from("agent_inbox_items")
      .update({ status: "resolved" })
      .eq("organization_id", args.organizationId)
      .eq("kind", KIND_DA_LACUNA)
      .eq("knowledge_scope_id", args.scopeId)
      .eq("status", "open")
      .select("id");
    if (error) throw new Error(error.message);
    return { fechados: (data ?? []).length };
  } catch (err) {
    log?.warn("lacuna não foi fechada depois de indexar o material", {
      scope_id: args.scopeId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return { fechados: 0 };
  }
}
