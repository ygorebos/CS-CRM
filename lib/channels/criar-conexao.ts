/**
 * O caminho ÚNICO de nascimento de uma conexão de canal (spec 004, T044 / FR-034).
 *
 * ## O que divergia, e o que isso custava
 *
 * Havia duas portas para criar conexão — a Central de Conexões e o onboarding —
 * e elas gravavam linhas **diferentes**. Medido em 2026-08-08:
 *
 * | | onboarding | Central |
 * |---|---|---|
 * | `ingest_path` | não definia → default `legacy` | `caminhoDeIngestaoParaConexaoNova()` |
 * | `display_name` | não gravava | gravava |
 * | auditoria `channel.connected` | não emitia | emitia |
 *
 * A primeira linha é a cara. O onboarding é **a** porta do usuário novo: quem se
 * cadastra hoje passa por ela, e só por ela. Nascer `legacy` significa que a
 * conexão do corretor recém-chegado **não recebe pelo gateway** — a instalação
 * inteira pode ter virado a chave e ele continua no caminho antigo, sem nada na
 * tela dizendo isso. É o "gateway de pé e sem uso" contra o qual o comentário da
 * outra rota já avisava, acontecendo exatamente com quem mais importa.
 *
 * A auditoria ausente é a segunda: um número entrava no ar sem deixar quem o
 * ligou, na porta usada por 100% dos usuários novos.
 *
 * ## O que NÃO converge, e por quê
 *
 * O **formato do nome** continua diferente, de propósito:
 *
 * - o onboarding usa `org_<8>`, **fixo**: a linha dele é sempre a mesma, e é
 *   isso que faz o corretor que fechou a aba e voltou cair na conexão que já
 *   começou em vez de criar outra. Trocar por nome aleatório faria cada tentativa
 *   de pareamento nascer uma conexão órfã;
 * - a Central usa `org_<8>_<aleatório>`, porque lá o usuário está **acrescentando**
 *   um número aos que já tem, e um nome fixo limitaria a organização a um.
 *
 * São identidades diferentes porque as intenções são diferentes. O que converge
 * é tudo o mais — e é por isso que o nome é PARÂMETRO desta função, não decisão
 * dela.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { caminhoDeIngestaoParaConexaoNova } from "@/lib/gateway/caminho-de-ingestao";
import { provisionarSegredoDeWebhook } from "@/lib/webhooks/provisionar-segredo";

/** Teto diário de mensagens de uma conexão nova (anti-banimento). */
export const LIMITE_DIARIO_PADRAO = 250;

export interface PedidoDeConexao {
  organizationId: string;
  /**
   * Identidade da sessão no transporte. Vem de FORA porque as duas portas têm
   * intenções diferentes — ver o cabeçalho.
   */
  sessionName: string;
  displayName?: string | null;
  /** Quem pediu — a auditoria de `channel.connected` não pode nascer sem dono. */
  actorUserId: string;
  requestId: string;
  /** Qual porta chamou. Vai para o audit; é o que responde "por onde entrou?". */
  origem: "onboarding" | "central";
  /** Colunas devolvidas pelo insert (cada porta mostra o que a tela dela precisa). */
  colunas?: string;
}

export type ResultadoDaCriacao =
  | { ok: true; conexao: Record<string, unknown> }
  /** Cifra indisponível: conexão que não sabe verificar entrega não pode nascer. */
  | { ok: false; motivo: "sem_cifra" }
  | { ok: false; motivo: "insert_falhou"; detalhe: string };

/**
 * Grava a linha de `channel_sessions` de uma conexão NOVA, igual para as duas
 * portas, e audita.
 *
 * Não fala com transporte nenhum: subir a sessão (e o rollback se isso falhar) é
 * de quem chamou, porque só a porta sabe o que fazer com o desfecho.
 */
export async function criarConexaoDeCanal(
  supabase: SupabaseClient,
  pedido: PedidoDeConexao,
): Promise<ResultadoDaCriacao> {
  // Segredo REAL por conexão, cifrado at-rest. Antes daqui já se gravou
  // `Buffer.from([0])` — um byte de enfeite —, e a rota de entrega do gateway é
  // fail-closed sem válvula: com o placeholder ela recusaria 100% das entregas
  // desta conexão. Sem cifra disponível não se grava: conexão que nasce incapaz
  // de verificar entrega é defeito que só aparece na primeira mensagem, longe
  // daqui, onde ninguém liga uma coisa à outra.
  const segredoCifrado = await provisionarSegredoDeWebhook(supabase);
  if (!segredoCifrado) return { ok: false, motivo: "sem_cifra" };

  const { data, error } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: pedido.organizationId,
      waha_session_name: pedido.sessionName,
      display_name: pedido.displayName ?? null,
      engine: "NOWEB",
      webhook_path_token: randomUUID().replace(/-/g, ""),
      webhook_secret_encrypted: segredoCifrado,
      // Conexão nova nasce no caminho que a instalação usa de verdade. O default
      // `legacy` da coluna vale para as linhas que já existiam quando a 0119
      // rodou; herdá-lo aqui deixaria o gateway de pé e sem uso.
      ingest_path: caminhoDeIngestaoParaConexaoNova(),
      status: "STARTING",
      last_status_change_at: new Date().toISOString(),
      consecutive_health_fails: 0,
      daily_message_limit: LIMITE_DIARIO_PADRAO,
      metadata: {},
    })
    .select(pedido.colunas ?? "id")
    .single();

  if (error || !data) {
    return { ok: false, motivo: "insert_falhou", detalhe: error?.message ?? "insert_sem_linha" };
  }

  const conexao = data as unknown as Record<string, unknown>;

  void audit({
    action: "channel.connected",
    actorUserId: pedido.actorUserId,
    organizationId: pedido.organizationId,
    resourceType: "channel_session",
    resourceId: conexao.id as string,
    requestId: pedido.requestId,
    metadata: { waha_session_name: pedido.sessionName, origem: pedido.origem },
  });

  return { ok: true, conexao };
}
