/**
 * Busca na base de conhecimento da organizacao — operacao unica, compartilhada.
 *
 * Existe porque a mesma pergunta ("o que a empresa ja sabe sobre isto?") passou
 * a ter dois chamadores: o turno do agente e a capacidade MCP que o humano liga
 * na tela. Duas implementacoes divergiriam em limiar, em top-K e em como tratam
 * "a base nao tem essa informacao" — e o sistema passaria a responder diferente
 * para a IA e para o humano sobre o MESMO acervo.
 *
 * O motor de similaridade continua sendo a RPC `retrieve_top_k_chunks`, que e
 * SECURITY DEFINER e filtra por organizacao dentro do banco. O contrato dela
 * exige que quem chama valide o tenant: aqui `organizationId` SEMPRE vem de
 * fonte confiavel (token/cookie), nunca do corpo da requisicao.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { embedText } from "@/lib/ai/embed";

export interface TrechoEncontrado {
  chunk_id: string;
  knowledge_source_id: string | null;
  content: string;
  similarity: number;
}

export interface ResultadoDaBusca {
  /** Trechos acima do limiar, do mais parecido para o menos. */
  trechos: TrechoEncontrado[];
  /**
   * Similaridade do MELHOR candidato, mesmo quando ele nao passou no limiar.
   *
   * Sem este numero, "a base nao tem essa informacao" e "a base tem algo perto,
   * mas nao o bastante" chegam iguais a quem pergunta — e sao situacoes que
   * pedem acoes opostas: uma manda buscar com humano, a outra manda reformular.
   */
  melhorSimilaridade: number | null;
}

export interface ParametrosDaBusca {
  organizationId: string;
  kbVersionId: string;
  pergunta: string;
  topK: number;
  limiar: number;
}

interface LinhaDaRpc {
  chunk_id: string;
  knowledge_source_id: string | null;
  content: string;
  similarity: number;
}

export async function buscarConhecimento(
  supabase: SupabaseClient,
  p: ParametrosDaBusca,
  deps?: { embed?: typeof embedText },
): Promise<ResultadoDaBusca> {
  const embed = deps?.embed ?? embedText;
  const { embedding } = await embed(p.pergunta, { organizationId: p.organizationId });

  // Piso real da similaridade de cosseno (1 - distancia, distancia em [0,2]).
  // Pedimos SEM limiar e cortamos aqui para conseguir enxergar o melhor
  // candidato reprovado — a RPC sozinha devolveria uma lista vazia sem dizer
  // se faltou pouco ou se nao ha nada parecido no acervo.
  const PISO = -1;

  const { data, error } = await supabase.rpc("retrieve_top_k_chunks", {
    p_organization_id: p.organizationId,
    p_kb_version_id: p.kbVersionId,
    p_embedding: `[${embedding.join(",")}]`,
    p_k: p.topK,
    p_threshold: PISO,
  });

  if (error) {
    throw new Error(`busca_de_conhecimento_falhou: ${error.message}`);
  }

  const linhas = (data ?? []) as LinhaDaRpc[];
  const melhor = linhas.length > 0 ? Math.max(...linhas.map((l) => l.similarity)) : null;

  return {
    trechos: linhas
      .filter((l) => l.similarity >= p.limiar)
      .map((l) => ({
        chunk_id: l.chunk_id,
        knowledge_source_id: l.knowledge_source_id,
        content: l.content,
        similarity: l.similarity,
      })),
    melhorSimilaridade: melhor,
  };
}

/**
 * Resolve qual acervo consultar.
 *
 * A base ativa e por AGENTE (`ai_agents.active_kb_version_id`), nao por
 * organizacao — dois agentes da mesma empresa podem responder por acervos
 * diferentes. Quando quem chama e o proprio agente, `ctx.actor.id` ja e o id
 * dele e nao ha o que perguntar; quando e uma pessoa (cliente MCP externo),
 * ela precisa dizer por qual assistente quer buscar.
 */
export async function resolverAcervoDoAgente(
  supabase: SupabaseClient,
  organizationId: string,
  agentId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("ai_agents")
    .select("active_kb_version_id")
    .eq("id", agentId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) throw new Error(`acervo_do_agente_falhou: ${error.message}`);
  return (data?.active_kb_version_id as string | null) ?? null;
}
