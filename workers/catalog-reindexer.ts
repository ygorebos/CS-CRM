/**
 * Reindexador do catálogo curado — spec 002 (RAG por operadora), T057.
 *
 * ═══ O PROBLEMA QUE ELE RESOLVE ═══
 *
 * `catalog_chunks.embedding` é `vector(1536)` **pré-computado**: os vetores viajam
 * prontos dentro do `baseline.sql` (research D6), porque uma instalação fresca não tem
 * chave de IA e o catálogo precisa nascer buscável. Ao lado do vetor mora
 * `embedding_model`, que registra COM QUE MODELO aquele vetor foi produzido.
 *
 * Vetor só é comparável com vetor do mesmo modelo. No dia em que a instalação passar a
 * usar outro modelo de embedding, a pergunta do cliente será vetorizada por um modelo e
 * o acervo continuará vetorizado por outro — e a busca de lastro (`fn_buscar_lastro`)
 * devolverá vizinhos sem sentido. O modo de falha é o pior possível: **não dá erro**. A
 * busca responde, com similaridade abaixo do corte, o portão de lastro recusa a
 * afirmação, e o corretor conclui que "a IA não sabe nada" — sem nada em log dizendo que
 * o acervo ficou incomparável.
 *
 * ═══ POR QUE SÓ O QUE DIVERGE ═══
 *
 * A rodada compara `embedding_model` de cada trecho com o modelo configurado hoje e
 * re-embeda **apenas** os que divergem. Re-embeddar tudo a cada tick transformaria uma
 * manutenção rara (troca de modelo, que acontece uma vez por ano se tanto) em custo
 * recorrente de API — e o catálogo é conteúdo do fabricante, compartilhado por toda a
 * instalação, então esse custo não teria dono.
 *
 * Isso também é o que torna o worker **idempotente**: depois que um trecho converge, ele
 * sai do conjunto divergente e a rodada seguinte não o enxerga. Numa instalação em dia, o
 * custo do tick é UMA contagem — nenhuma chamada de IA, nenhuma escrita.
 *
 * ═══ QUANDO TRAVA, TEM DONO ═══
 *
 * Sem chave de IA, com provedor fora do ar, ou com modelo de dimensão incompatível, a
 * re-embedagem não acontece. Isso NÃO pode virar linha de log: log é onde defeito de
 * self-host vai morrer. Vira aviso na Central (`agent_inbox_items`) das organizações que
 * de fato dependem do catálogo — ver `avisar()` para a definição de "dependem".
 *
 * ⚠️ O `kind` usado é `job_dead`, do vocabulário existente. Um `kind` próprio
 * (`catalog_reindex_stuck`) diria a coisa certa na lista da Central, mas exigiria
 * migration + apêndice no baseline, que estão fora do conjunto de escrita desta tarefa. O
 * título e o corpo do aviso carregam o significado inteiro; o rótulo genérico do `kind`
 * ("Uma tarefa do assistente falhou e parou de tentar") aparece como subtítulo e não
 * mente.
 *
 * Não tem `organization_id` em lugar nenhum do caminho de dados: o catálogo é a partição
 * curada (Princípio X, trava 2) e não pertence a tenant algum. O único lugar onde
 * organização aparece é o destinatário do aviso, e ele é **consultado** em
 * `knowledge_scopes`, nunca recebido de fora.
 */
import { embedText } from "@/lib/ai/embed";
import { DEFAULT_EMBEDDING_MODEL, isEmbeddingProviderConfigured } from "@/lib/ai/gateway";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * A dimensão da coluna `catalog_chunks.embedding` (migration 0117). Não é preferência:
 * é o tipo da coluna. Um modelo que produza vetor de outro tamanho não pode ser gravado
 * aqui, e tentar é como o worker descobriria — com erro do Postgres no meio do lote,
 * metade do acervo reescrito e metade não.
 */
export const DIMENSAO_DO_CATALOGO = 1536;

/**
 * Teto de trechos por rodada. Existe por dois motivos que puxam para o mesmo lado: o
 * `curl` do `scheduler` tem timeout, e a re-embedagem é sequencial (uma chamada de API
 * por trecho). A rodada seguinte pega o resto — o conjunto divergente só encolhe.
 */
export const LOTE_POR_RODADA = 50;

/** `kind` e `ref_kind` do aviso. Juntos são a chave de deduplicação e de auto-cura. */
export const KIND_DO_AVISO = "job_dead";
export const REF_KIND_DO_AVISO = "catalog_reindex";

/**
 * O que vai no header `X-AI-Gateway-Tenant-Id` das chamadas de embedding desta rodada.
 *
 * `embedText` pede um `organizationId` porque a esmagadora maioria das chamadas é de
 * tenant, e o gateway fatia uso por ele. O catálogo não é de tenant nenhum. Carimbar
 * aqui a organização de alguém faria o painel de custo cobrar de um corretor o
 * reprocessamento de conteúdo do fabricante — então o marcador é uma string que
 * declaradamente NÃO é um uuid de organização, e o custo aparece separado.
 */
export const MARCADOR_DE_CUSTO_DO_CATALOGO = "catalog";

export type MotivoDeTravamento =
  /** Nem gateway nem chave de OpenAI configurados — `embedText` recusaria. */
  | "embed_indisponivel"
  /** O modelo de hoje produz vetor de tamanho diferente do da coluna. */
  | "dimensao_incompativel"
  /** O provedor respondeu erro (rede, teto de custo, credencial inválida). */
  | "provedor_falhou";

export interface ResultadoDaReindexacao {
  modelo_atual: string;
  /** Quantos trechos divergiam no início da rodada. */
  divergentes: number;
  /** Quantos foram efetivamente regravados nesta rodada. */
  reembeddados: number;
  /** Quantos continuam divergindo depois dela (o resto vai na próxima). */
  restantes: number;
  travado: MotivoDeTravamento | null;
  /** Detalhe técnico do travamento, para quem for investigar. */
  detalhe: string | null;
  avisos_abertos: number;
  avisos_resolvidos: number;
}

export interface DependenciasDaReindexacao {
  /** Injetável para o teste exercitar a REGRA sem chamar provedor de verdade. */
  embedder?: (conteudo: string) => Promise<number[]>;
  provedorConfigurado?: () => boolean;
  /** O modelo configurado hoje. Default = o canônico do repositório. */
  modelo?: string;
  lote?: number;
  requestId?: string;
}

interface TrechoDivergente {
  id: string;
  content: string;
}

function detalharErro(err: unknown): string {
  const bruto = err instanceof Error ? err.message : String(err);
  // Corte curto de propósito: a mensagem vai para o corpo de um aviso que o corretor lê,
  // e resposta de provedor às vezes carrega payload inteiro.
  return bruto.slice(0, 300);
}

/**
 * As organizações que DEPENDEM do catálogo — as únicas que precisam ser avisadas.
 *
 * O vínculo tenant↔catálogo é `knowledge_scopes` com `catalog_scope_id` preenchido
 * (espelho do escopo curado) e `is_active = true` (trava 4). Espelho nasce **desligado**
 * (A-20), então uma instalação recém-feita, onde ninguém ligou operadora nenhuma, não
 * recebe aviso algum — e está certo: o acervo incomparável não prejudica quem não o
 * consulta. Avisar todo mundo faria a primeira impressão do produto ser um alarme sobre
 * uma coisa que o usuário ainda nem ligou.
 */
async function organizacoesQueDependemDoCatalogo(admin: Admin): Promise<string[]> {
  const { data, error } = await admin
    .from("knowledge_scopes")
    .select("organization_id")
    .eq("is_active", true)
    .not("catalog_scope_id", "is", null);

  if (error) throw new Error(`escopos_query_failed: ${error.message}`);

  const ids = (data ?? []).map((r) => (r as { organization_id: string }).organization_id);
  return [...new Set(ids)];
}

/**
 * Abre UM aviso por organização afetada, e só para quem ainda não tem um aberto.
 *
 * A deduplicação é o que impede o mecanismo anti-morte de morrer: sem ela, um tick a
 * cada 15 minutos com o provedor fora do ar encheria a Central de itens idênticos, o
 * corretor pararia de olhar a Central, e o próximo aviso — o que importava — chegaria a
 * uma tela que ninguém abre mais.
 *
 * Devolve quantos avisos nasceram.
 */
async function avisar(
  admin: Admin,
  motivo: MotivoDeTravamento,
  detalhe: string,
  divergentes: number,
  requestId: string,
): Promise<number> {
  const orgs = await organizacoesQueDependemDoCatalogo(admin);
  if (orgs.length === 0) return 0;

  const { data: jaAbertos, error: erroBusca } = await admin
    .from("agent_inbox_items")
    .select("organization_id")
    .eq("kind", KIND_DO_AVISO)
    .eq("ref_kind", REF_KIND_DO_AVISO)
    .eq("status", "open")
    .in("organization_id", orgs);

  if (erroBusca) throw new Error(`avisos_query_failed: ${erroBusca.message}`);

  const comAviso = new Set(
    (jaAbertos ?? []).map((r) => (r as { organization_id: string | null }).organization_id),
  );
  const faltando = orgs.filter((id) => !comAviso.has(id));
  if (faltando.length === 0) return 0;

  const linhas = faltando.map((organization_id) => ({
    organization_id,
    kind: KIND_DO_AVISO,
    severity: "warn",
    title: "O material das operadoras precisa ser reprocessado e não está conseguindo",
    body: CORPO_DO_AVISO[motivo](divergentes, detalhe),
    ref_kind: REF_KIND_DO_AVISO,
    ref_id: null,
  }));

  const { error: erroInsert } = await admin.from("agent_inbox_items").insert(linhas);
  if (erroInsert) {
    // O aviso é o que torna o travamento visível. Perdê-lo em silêncio recriaria
    // exatamente o defeito que este worker existe para não deixar acontecer.
    logger.error("[catalog-reindexer] aviso na Central falhou", {
      error: erroInsert.message,
      organizacoes: faltando.length,
      requestId,
    });
    return 0;
  }
  return linhas.length;
}

/**
 * Texto por motivo. Fala do EFEITO no atendimento primeiro — o corretor precisa entender
 * que respostas sobre operadora podem sair capadas — e só depois do detalhe técnico, que
 * é para quem for investigar.
 */
const CORPO_DO_AVISO: Record<
  MotivoDeTravamento,
  (divergentes: number, detalhe: string) => string
> = {
  embed_indisponivel: (n) =>
    `${n} trecho(s) do material das operadoras foram preparados com um modelo de IA diferente do que está configurado agora. ` +
    `Enquanto isso durar, o assistente pode não encontrar o material certo e vai preferir chamar você a arriscar uma resposta. ` +
    `O que fazer: configure a chave de IA (AI_GATEWAY_API_KEY ou OPENAI_API_KEY) — o reprocessamento roda sozinho depois disso.`,
  dimensao_incompativel: (n, detalhe) =>
    `${n} trecho(s) do material das operadoras precisam ser reprocessados, mas o modelo de IA configurado agora produz um formato ` +
    `incompatível com o do acervo. Nada foi reescrito, de propósito: reescrever pela metade deixaria o material inutilizável. ` +
    `Enquanto isso durar, o assistente pode não encontrar o material certo. ` +
    `O que fazer: volte para o modelo de embedding anterior, ou peça a migração do acervo ao suporte. (${detalhe})`,
  provedor_falhou: (n, detalhe) =>
    `${n} trecho(s) do material das operadoras precisam ser reprocessados e o provedor de IA recusou. ` +
    `Enquanto isso durar, o assistente pode não encontrar o material certo. ` +
    `O sistema continua tentando sozinho. Se o aviso persistir, verifique a chave e o limite de gastos de IA. (${detalhe})`,
};

/**
 * Fecha os avisos abertos quando o acervo volta a estar íntegro.
 *
 * Sem isto, o aviso viraria mentira permanente: o corretor configura a chave, o worker
 * reprocessa tudo, e a Central continua dizendo que algo está travado. Aviso que não
 * some sozinho quando o problema some é a forma mais rápida de ensinar alguém a ignorar
 * a Central inteira.
 */
async function resolverAvisos(admin: Admin, requestId: string): Promise<number> {
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("kind", KIND_DO_AVISO)
    .eq("ref_kind", REF_KIND_DO_AVISO)
    .eq("status", "open")
    .select("id");

  if (error) {
    logger.warn("[catalog-reindexer] auto-cura dos avisos falhou", {
      error: error.message,
      requestId,
    });
    return 0;
  }
  return (data ?? []).length;
}

/**
 * Uma rodada. Separada do handler HTTP para o teste exercitar a REGRA sem montar
 * request nem auth — e para o handler ficar sendo só borda.
 */
export async function reindexarCatalogo(
  admin: Admin,
  deps: DependenciasDaReindexacao = {},
): Promise<ResultadoDaReindexacao> {
  const requestId = deps.requestId ?? "sem-request-id";
  const lote = deps.lote ?? LOTE_POR_RODADA;
  // Hoje o modelo configurado é a constante canônica: não existe env que o troque, e o
  // catálogo é global, então não há modelo "por tenant" que pudesse valer aqui. Se um dia
  // existir override de instalação, este é o ÚNICO ponto a mudar.
  const modelo = deps.modelo ?? String(DEFAULT_EMBEDDING_MODEL);
  const provedorConfigurado = deps.provedorConfigurado ?? isEmbeddingProviderConfigured;
  const embedder =
    deps.embedder ??
    (async (conteudo: string) => {
      const r = await embedText(conteudo, {
        organizationId: MARCADOR_DE_CUSTO_DO_CATALOGO,
        model: modelo,
      });
      return r.embedding;
    });

  const vazio = (over: Partial<ResultadoDaReindexacao> = {}): ResultadoDaReindexacao => ({
    modelo_atual: modelo,
    divergentes: 0,
    reembeddados: 0,
    restantes: 0,
    travado: null,
    detalhe: null,
    avisos_abertos: 0,
    avisos_resolvidos: 0,
    ...over,
  });

  // A pergunta da rodada é "quantos trechos NÃO estão no modelo de hoje?". `head: true`
  // porque a resposta é um número: baixar os trechos (com `embedding` junto) para
  // contá-los pagaria o acervo inteiro em payload a cada 15 minutos.
  const { count, error: erroContagem } = await admin
    .from("catalog_chunks")
    .select("id", { count: "exact", head: true })
    .neq("embedding_model", modelo);

  if (erroContagem) throw new Error(`contagem_falhou: ${erroContagem.message}`);

  const divergentes = count ?? 0;
  if (divergentes === 0) {
    // Acervo íntegro. Esta é a rodada normal — e ela custa uma contagem, nada mais.
    const resolvidos = await resolverAvisos(admin, requestId);
    return vazio({ avisos_resolvidos: resolvidos });
  }

  if (!provedorConfigurado()) {
    const abertos = await avisar(admin, "embed_indisponivel", "sem chave de IA", divergentes, requestId);
    logger.warn("[catalog-reindexer] travado: sem provedor de embedding", {
      divergentes,
      modelo,
      avisos_abertos: abertos,
      requestId,
    });
    return vazio({
      divergentes,
      restantes: divergentes,
      travado: "embed_indisponivel",
      detalhe: "sem chave de IA configurada",
      avisos_abertos: abertos,
    });
  }

  const { data, error: erroBusca } = await admin
    .from("catalog_chunks")
    .select("id, content")
    .neq("embedding_model", modelo)
    .order("id", { ascending: true })
    .limit(lote);

  if (erroBusca) throw new Error(`busca_falhou: ${erroBusca.message}`);
  const trechos = (data ?? []) as TrechoDivergente[];

  let reembeddados = 0;
  let travado: MotivoDeTravamento | null = null;
  let detalhe: string | null = null;

  for (const trecho of trechos) {
    let vetor: number[];
    try {
      vetor = await embedder(trecho.content);
    } catch (err) {
      // Para a rodada no primeiro erro em vez de percorrer o lote inteiro: quando o
      // provedor está fora (ou o teto de custo estourou), as 49 chamadas seguintes vão
      // falhar igual — e cada uma delas custa tempo do tick e, dependendo do provedor,
      // dinheiro. O que já foi regravado permanece; o resto vai na próxima rodada.
      travado = "provedor_falhou";
      detalhe = detalharErro(err);
      break;
    }

    if (vetor.length !== DIMENSAO_DO_CATALOGO) {
      // NÃO tenta gravar. A coluna é `vector(1536)` e o Postgres recusaria — mas o ponto
      // não é evitar o erro, é evitar o acervo pela metade: parar aqui deixa todo trecho
      // ainda não tocado com o vetor ANTIGO, que ao menos é comparável entre si.
      travado = "dimensao_incompativel";
      detalhe = `o modelo ${modelo} devolveu vetor de ${vetor.length} dimensões; a coluna do catálogo tem ${DIMENSAO_DO_CATALOGO}`;
      break;
    }

    // `.neq("embedding_model", modelo)` no UPDATE É o claim atômico: se outra rodada
    // (ou a semeadura) converteu este trecho entre a busca e a escrita, a linha já não
    // está no conjunto divergente e não é tocada. Sem isso, dois ticks sobrepostos
    // pagariam duas vezes pela mesma re-embedagem.
    const { data: aplicados, error: erroUpdate } = await admin
      .from("catalog_chunks")
      .update({
        embedding: vetor as unknown as string,
        embedding_model: modelo,
      })
      .eq("id", trecho.id)
      .neq("embedding_model", modelo)
      .select("id");

    if (erroUpdate) {
      travado = "provedor_falhou";
      detalhe = `gravação falhou: ${detalharErro(erroUpdate.message)}`;
      break;
    }
    reembeddados += (aplicados ?? []).length;
  }

  const restantes = Math.max(divergentes - reembeddados, 0);

  let avisosAbertos = 0;
  let avisosResolvidos = 0;
  if (travado) {
    avisosAbertos = await avisar(admin, travado, detalhe ?? "", restantes, requestId);
    logger.error("[catalog-reindexer] rodada travada", {
      motivo: travado,
      detalhe,
      reembeddados,
      restantes,
      avisos_abertos: avisosAbertos,
      requestId,
    });
  } else if (restantes === 0) {
    // Só quando o acervo inteiro convergiu. Enquanto sobra lote para a próxima rodada, o
    // trabalho está ANDANDO, não pronto — fechar o aviso aqui anunciaria conclusão de
    // algo que ainda leva ticks para terminar.
    avisosResolvidos = await resolverAvisos(admin, requestId);
  }

  if (reembeddados > 0) {
    logger.info("[catalog-reindexer] trechos reprocessados", {
      modelo,
      reembeddados,
      restantes,
      requestId,
    });
  }

  return {
    modelo_atual: modelo,
    divergentes,
    reembeddados,
    restantes,
    travado,
    detalhe,
    avisos_abertos: avisosAbertos,
    avisos_resolvidos: avisosResolvidos,
  };
}
