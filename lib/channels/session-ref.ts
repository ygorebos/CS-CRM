/**
 * De onde sai o identificador da sessão/número no provider.
 *
 * Esta é a pergunta que NÃO pode viver numa feature: com dois providers o
 * `sessionRef` vem de `waha_session_name` **ou** de `meta_phone_number_id`, e
 * quem escolher isso fora daqui vira o `if (provider === ...)` que o invariante
 * 1 da doutrina existe para proibir. O chamador pede o ref; a coluna é detalhe.
 *
 * O tipo é a tagged union que a migration 0087 já enforça no banco
 * (`channel_sessions_provider_ref_check`): a coluna do provider da vez é NOT
 * NULL, a das outras é NULL. Os canais do gateway entraram na constraint pela
 * migration 0119, com `gateway_connection_id` — e entram aqui pelo mesmo motivo:
 * é a coluna que o CHECK exige deles.
 *
 * ─── Por que o `undefined` do switch não é aceitável ────────────────────────
 *
 * O `switch` exaustivo do TypeScript garante o retorno `string` **para os casos
 * da união** — e cala sobre qualquer linha vinda do banco que não caiba nela.
 * Medido em 2026-08-08 (spec 004): com o adapter do gateway já ligado, uma
 * sessão `whatsapp_uazapi` produzia `sessionRef: undefined`, `JSON.stringify`
 * apagava a chave, e o gateway recebia um envio SEM saber por qual número
 * mandar. Por isso a ausência da referência agora **lança**: o handler de envio
 * chama esta função dentro do try e transforma o throw em mensagem `failed` com
 * erro legível. Mandar para lugar nenhum em silêncio é o desfecho pior.
 */
export type ChannelSessionRef =
  | { provider: "waha"; waha_session_name: string }
  | { provider: "meta_cloud"; meta_phone_number_id: string }
  | {
      provider: "whatsapp_uazapi" | "whatsapp_cloud" | "instagram" | "messenger";
      gateway_connection_id: string;
    };

/**
 * Colunas que um `select` do PostgREST precisa trazer para `resolveSessionRef`
 * funcionar. Fica aqui pelo mesmo motivo da função: a string do `select` também
 * nomeia coluna de provider, e ela some da feature junto com a decisão.
 *
 * Coluna que falta aqui reproduz o defeito um nível acima do `switch`: o ramo
 * certo executa e lê `undefined` do objeto que o banco devolveu.
 */
export const CHANNEL_SESSION_REF_COLUMNS =
  "provider, waha_session_name, meta_phone_number_id, gateway_connection_id";

function exigir(valor: string | null | undefined, provider: string, coluna: string): string {
  if (!valor) {
    throw new Error(
      `missing_session_ref: sessão '${provider}' sem referência em '${coluna}'. ` +
        "O CHECK channel_sessions_provider_ref_check proíbe esta linha — " +
        "quase sempre a coluna ficou de fora do select (use CHANNEL_SESSION_REF_COLUMNS).",
    );
  }
  return valor;
}

export function resolveSessionRef(session: ChannelSessionRef): string {
  switch (session.provider) {
    case "meta_cloud":
      return exigir(session.meta_phone_number_id, session.provider, "meta_phone_number_id");
    case "waha":
      return exigir(session.waha_session_name, session.provider, "waha_session_name");
    default:
      // Todos os canais do gateway se endereçam pela conexão — é ela que o
      // gateway usa para resolver o tenant e o número de saída (FR-017).
      return exigir(
        (session as { gateway_connection_id?: string | null }).gateway_connection_id,
        (session as { provider: string }).provider,
        "gateway_connection_id",
      );
  }
}

/**
 * O ref da sessão E de que NATUREZA ele é — sem que quem pergunta precise
 * nomear provider (invariante 1 da doutrina de restrição de canal).
 *
 * Existe porque há decisões que dependem do TIPO de endereço e não do valor: a
 * tela de pareamento, por exemplo, busca imagem no transporte antigo e material
 * completo no gateway. Perguntar isso fora daqui viraria o
 * `if (provider === ...)` que o invariante proíbe; perguntar "tem
 * `gateway_connection_id`?" seria o mesmo `if` escrito com outra palavra.
 *
 * `null` quando a linha não tem referência nenhuma — estado que o CHECK do banco
 * proíbe, mas que aparece quando alguém esquece a coluna no `select`.
 */
export type NaturezaDoRef =
  | { via: "gateway"; ref: string }
  | { via: "transporte"; ref: string }
  | null;

export function classificarRef(session: Partial<ChannelSessionRef> | null): NaturezaDoRef {
  if (!session) return null;
  const s = session as {
    gateway_connection_id?: string | null;
    waha_session_name?: string | null;
    meta_phone_number_id?: string | null;
  };
  if (s.gateway_connection_id) return { via: "gateway", ref: s.gateway_connection_id };
  const transporte = s.waha_session_name ?? s.meta_phone_number_id ?? null;
  return transporte ? { via: "transporte", ref: transporte } : null;
}
