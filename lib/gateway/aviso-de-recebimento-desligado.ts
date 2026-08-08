/**
 * O aviso que impede "o recebimento está desligado" de virar "hoje foi devagar"
 * (T059 / FR-027).
 *
 * ## O defeito, e por que ele é invisível por construção
 *
 * Duas chaves controlam o recebimento pelo gateway, e cada uma existe por um
 * motivo bom:
 *
 *   - `channel_sessions.ingest_path` é **por conexão**, para a virada ser
 *     gradual e reversível sem release;
 *   - `GATEWAY_INBOUND_ENABLED` é **global**, para a instalação inteira poder
 *     ficar no caminho legado enquanto a rota nova não está provada.
 *
 * Juntas, na combinação errada, produzem o pior silêncio da feature: a conexão
 * diz "eu recebo pela rota nova", a rota está desligada e responde **404**, e o
 * gateway — corretamente, pelo contrato §5 — **descarta sem retentar**, porque
 * 404 é defeito de configuração. Resultado: nenhuma mensagem entra, nenhuma fica
 * guardada para depois, e a tela fica idêntica a um dia de pouco movimento.
 *
 * Nenhum dos dois lados está errado sozinho. É a combinação que é, e é por isso
 * que só alguém olhando as duas ao mesmo tempo percebe — que é exatamente o que
 * esta função faz, uma vez por minuto, no dreno.
 *
 * ## Por que no dreno, e não num cron próprio
 *
 * O dreno já roda a cada minuto, já tem o cliente de serviço na mão e já é o
 * dono declarado da fila de entrada. Um cron novo para uma checagem de duas
 * colunas seria mais uma peça para agendar, monitorar e esquecer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { logger } from "@/lib/logger";

/** Vocabulário de `agent_inbox_items.kind` (migration 0119). */
export const KIND_RECEBIMENTO_DESLIGADO: InboxKind = "gateway_inbound_down";

interface LinhaDeConexao {
  organization_id: string;
}

/**
 * Abre um aviso por ORGANIZAÇÃO que tenha conexão apontada para o gateway,
 * quando o recebimento está desligado. Devolve quantos avisos abriu agora.
 *
 * Por organização, e não por conexão: o interruptor é global, então todas as
 * conexões da instalação estão no mesmo estado — um aviso por conexão diria N
 * vezes a mesma coisa, com o mesmo conserto.
 *
 * Nunca lança. Roda dentro do dreno, e explodir aqui pararia o recolhimento das
 * mensagens que ainda dá para salvar.
 */
export async function avisarRecebimentoDesligado(
  admin: SupabaseClient,
  opts: { habilitado: boolean; requestId: string },
): Promise<number> {
  // Ligado: não há o que avisar. A checagem barata vem primeiro de propósito —
  // no caminho normal esta função não toca o banco.
  if (opts.habilitado) return 0;

  try {
    const { data, error } = await admin
      .from("channel_sessions")
      .select("organization_id")
      .eq("ingest_path", "gateway")
      .is("archived_at", null)
      .limit(500);

    if (error) {
      logger.warn("[gateway.desligado] busca de conexões falhou", {
        requestId: opts.requestId,
        erro: error.message,
      });
      return 0;
    }

    const linhas = (data ?? []) as LinhaDeConexao[];
    // Nenhuma conexão migrada: o interruptor desligado é o estado NORMAL de uma
    // instalação que ainda não virou a chave. Avisar aqui seria alarme falso em
    // 100% das instalações — e alarme falso é o que ensina a ignorar a Central.
    if (linhas.length === 0) return 0;

    const orgs = [...new Set(linhas.map((l) => l.organization_id))];
    let abertos = 0;

    for (const org of orgs) {
      const { data: jaAberto } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", org)
        .eq("kind", KIND_RECEBIMENTO_DESLIGADO)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();

      if (jaAberto) continue;

      const { error: insErr } = await admin.from("agent_inbox_items").insert({
        organization_id: org,
        kind: KIND_RECEBIMENTO_DESLIGADO,
        severity: "critical",
        title: "O recebimento de mensagens está desligado",
        body:
          "Este canal está configurado para receber pela via nova, mas ela está " +
          "desligada na instalação — então as mensagens que chegam são recusadas e " +
          "NÃO ficam guardadas para depois. Quem escreveu não vai aparecer aqui. " +
          "Para religar: defina GATEWAY_INBOUND_ENABLED=true e reinicie o aplicativo. " +
          "Enquanto isso, responda pelo aparelho para não deixar ninguém sem resposta.",
        ref_kind: "organization",
        ref_id: org,
      });

      if (insErr) {
        logger.error("[gateway.desligado] abrir aviso falhou", {
          requestId: opts.requestId,
          organization_id: org,
          erro: insErr.message,
        });
        continue;
      }
      abertos += 1;
    }

    return abertos;
  } catch (err) {
    logger.error("[gateway.desligado] exceção ao avisar", {
      requestId: opts.requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
