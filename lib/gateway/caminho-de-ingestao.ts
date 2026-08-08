/**
 * Por qual caminho uma conexão NOVA recebe (T058a).
 *
 * ## O default da coluna não serve para conexão nova
 *
 * `channel_sessions.ingest_path` nasce `'legacy'` por default, e isso está certo
 * para as linhas que **já existiam** quando a migration 0116 rodou: elas estavam
 * recebendo pelo caminho antigo naquele instante, e mudá-las em massa seria
 * virar a chave de todo mundo sem aviso.
 *
 * Para uma conexão criada DEPOIS, o mesmo default é um defeito silencioso: a
 * instalação sobe com o gateway ligado, o operador conecta um número, e esse
 * número recebe pelo caminho legado — o serviço novo está de pé e não é usado.
 * Ninguém percebe, porque as mensagens entram (pelo caminho antigo).
 *
 * ## Por que segue o interruptor, e não é fixo em `'gateway'`
 *
 * Nascer sempre `'gateway'` com `GATEWAY_INBOUND_ENABLED=false` criaria
 * exatamente a combinação que o aviso da migration 0119 existe para denunciar:
 * conexão apontada para uma rota desligada, que responde 404, e o gateway
 * descarta sem retentar. A conexão nasceria muda.
 *
 * Então a regra é uma frase: **a conexão nova nasce no caminho que a instalação
 * está usando de verdade.**
 */
import { env } from "@/lib/env";

export type CaminhoDeIngestao = "legacy" | "gateway";

/**
 * O valor de `ingest_path` para uma conexão que está sendo criada agora.
 *
 * `habilitado` é injetável para o teste medir a REGRA, não a variável de
 * ambiente do processo que roda a suíte.
 */
export function caminhoDeIngestaoParaConexaoNova(
  habilitado: boolean = env.GATEWAY_INBOUND_ENABLED,
): CaminhoDeIngestao {
  return habilitado ? "gateway" : "legacy";
}
