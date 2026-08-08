/**
 * MediaSource do gateway: baixa o anexo referenciado pelo envelope.
 *
 * ## A garantia vem da CONSTRUÇÃO, não da confiança
 *
 * `media.ref` chega dentro de um envelope que — mesmo assinado — descreve um
 * acontecimento do mundo externo. Se o download usasse o host que vem ali, um
 * envelope forjado (ou um provedor comprometido) faria o CRM buscar arquivo em
 * endereço arbitrário, de dentro da rede onde ele roda. É SSRF com o servidor
 * fazendo o trabalho.
 *
 * Então o host **nunca** vem do payload: sobrevive apenas caminho e query, e a
 * URL é remontada sobre `GATEWAY_BASE_URL`, que é configuração nossa. É a mesma
 * técnica da fonte de mídia do caminho legado (o arquivo irmão neste diretório),
 * e é deliberado que sejam duas funções e não uma genérica: cada origem tem
 * credencial e vocabulário de erro próprios, e uma função "genérica" com
 * `if (origem === ...)` acabaria aceitando base vinda do chamador — que é o
 * buraco que as duas existem para fechar.
 *
 * ## Por que o teto é `GATEWAY_MAX_MEDIA_BYTES` e não `MAX_MEDIA_BYTES`
 *
 * O teto do caminho legado (50 MiB) foi dimensionado para um único canal. Aqui
 * entram documento do WhatsApp Cloud (100 MiB), Instagram e o que vier — usar o
 * teto antigo recusaria anexo legítimo. Acima do teto a mensagem **entra assim
 * mesmo**, marcada como anexo indisponível (FR-025): perder o arquivo é ruim,
 * perder a conversa é pior.
 */
import { env } from "@/lib/env";
import { MediaTooLargeError, type FetchedMedia } from "@/lib/messaging/media/types";

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Baixa o anexo de `ref`.
 *
 * `ref` é tratado como CAMINHO. Se vier URL absoluta, host e porta são jogados
 * fora — sobra `pathname + search`. Os erros são strings estáveis porque quem as
 * lê é o worker, que decide entre retentar e marcar indisponível; mensagem de
 * erro livre viraria comparação de texto na próxima refatoração.
 */
export async function fetchGatewayMedia(
  ref: string,
  hintMime?: string | null,
): Promise<FetchedMedia> {
  const base = env.GATEWAY_BASE_URL.trim();
  if (!base) throw new Error("gateway_media_base_missing");

  const caminho = caminhoDe(ref);
  if (caminho === null) throw new Error("gateway_media_ref_invalida");

  let url: URL;
  try {
    url = new URL(caminho, base.endsWith("/") ? base : `${base}/`);
  } catch {
    throw new Error("gateway_media_base_invalida");
  }

  // Cinto e suspensório: se por qualquer motivo a resolução acima escapar do
  // host da base, para aqui. `new URL(rel, base)` não deveria trocar de host —
  // mas "não deveria" é fraco demais para a única defesa de um SSRF.
  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  if (url.host !== baseUrl.host || url.protocol !== baseUrl.protocol) {
    throw new Error("gateway_media_host_recusado");
  }

  const headers: Record<string, string> = {};
  if (env.GATEWAY_INTERNAL_TOKEN) {
    headers.Authorization = `Bearer ${env.GATEWAY_INTERNAL_TOKEN}`;
  }

  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway_media_${res.status}`);

  const declarado = Number(res.headers.get("content-length") ?? 0);
  if (declarado > env.GATEWAY_MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const buffer = Buffer.from(await res.arrayBuffer());
  // O `content-length` é declaração do outro lado; o tamanho real é o que
  // chegou. Conferir só o cabeçalho deixaria passar quem mente.
  if (buffer.byteLength > env.GATEWAY_MAX_MEDIA_BYTES) throw new MediaTooLargeError();

  const mime = res.headers.get("content-type") || hintMime || "application/octet-stream";
  return { buffer, mime };
}

/**
 * Extrai o caminho de uma `ref`, aceitando as três formas que o gateway pode
 * emitir hoje ou amanhã: caminho relativo (`media/abc`), caminho absoluto
 * (`/media/abc`) e URL completa (cujo host é descartado).
 *
 * Devolve `null` quando não sobra caminho nenhum — `ref` vazia, ou só barras.
 * Nesse caso a URL final seria a própria base, e baixar "a raiz do gateway"
 * como se fosse anexo é o tipo de defeito que aparece como arquivo corrompido
 * no inbox do cliente, sem explicação.
 */
function caminhoDe(ref: string): string | null {
  const cru = (ref ?? "").trim();
  if (!cru) return null;

  let caminho = cru;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cru)) {
    try {
      const absoluta = new URL(cru);
      caminho = absoluta.pathname + absoluta.search;
    } catch {
      return null;
    }
  }

  // Barra inicial faria `new URL` ignorar o caminho da base (ex.: base
  // `http://gw/api/` + `/media/x` viraria `http://gw/media/x`). Tirar a barra
  // mantém a resolução RELATIVA à base, que é a que o operador configurou.
  const semBarraInicial = caminho.replace(/^\/+/, "");
  return semBarraInicial.length > 0 ? semBarraInicial : null;
}
