/**
 * A lista de canais que uma tela pode OFERECER como destino.
 *
 * ─── Por que é uma função só, e não um `select` por tela ─────────────────────
 * O filtro de canal arquivado nasceu espalhado: cada tela com seletor de número
 * escrevia o próprio `select` em `channel_sessions`, e três ficaram sem o
 * `archived_at is null`. O efeito não é cosmético — o canal que o usuário acabou
 * de excluir continuava no dropdown, e salvar um roteador com ele devolvia 404
 * "Número de WhatsApp não encontrado nesta organização": mensagem falsa, porque
 * ele ESTÁ na organização, arquivado. Com uma função só, o próximo seletor nasce
 * filtrado sem ninguém precisar lembrar do filtro.
 *
 * ─── Por que erro SOBE ───────────────────────────────────────────────────────
 * Devolver lista vazia quando a consulta falhou é indistinguível de "esta
 * organização não tem número" — e é assim que se convida alguém a parear de novo
 * um número que já está no ar. A única falha tolerada é a coluna `archived_at`
 * não existir (código novo, banco sem a migration 0106): aí nada está arquivado,
 * e a lista sem o filtro é a lista exata (ver `./archived`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";

/** Um canal oferecível como destino, já com o rótulo resolvido para a tela. */
export interface SelectableChannel {
  id: string;
  display_name: string;
  status: string;
  phone_number: string | null;
}

const COLUNAS = "id, display_name, status, phone_number, waha_session_name";

interface LinhaCanal {
  id: string;
  display_name: string | null;
  status: string;
  phone_number: string | null;
  waha_session_name: string | null;
}

/**
 * Canais ativos da organização, do mais antigo para o mais novo (ordem estável:
 * um dropdown que embaralha a cada render faz o operador clicar no item errado).
 *
 * `db` aceita tanto o client do usuário (RLS) quanto o admin — quem chama com o
 * admin já é responsável pelo `organization_id`, que aqui é sempre explícito.
 */
export async function listSelectableChannels(
  db: SupabaseClient,
  organizationId: string,
): Promise<SelectableChannel[]> {
  const base = () =>
    db.from("channel_sessions").select(COLUNAS).eq("organization_id", organizationId);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null).order("created_at", { ascending: true }),
    () => base().order("created_at", { ascending: true }),
  );
  if (error) throw new Error(`channel_sessions_list_failed: ${error.message ?? "unknown"}`);

  return ((data ?? []) as LinhaCanal[]).map((c) => ({
    id: c.id,
    // O nome da sessão no transporte só existe no ramo pareado por QR (é o que
    // `channel_sessions_provider_ref_check` exige lá); o canal oficial nasce sem
    // ele. Sem o último degrau, um oficial sem apelido viraria opção em branco.
    display_name: c.display_name ?? c.waha_session_name ?? c.phone_number ?? "Número sem nome",
    status: c.status,
    phone_number: c.phone_number ?? null,
  }));
}
