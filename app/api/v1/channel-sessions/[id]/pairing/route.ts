/**
 * GET /api/v1/channel-sessions/[id]/pairing — o material de pareamento, em JSON,
 * para QUALQUER canal (spec 004, T040/T041 / FR-030, FR-031).
 *
 * ## Por que uma rota nova em vez de estender a de imagem
 *
 * A rota irmã (`/qr`) devolve **bytes de PNG** e existe para um `<img src>`. Isso
 * funcionava enquanto havia um canal só, e ele entregava imagem. O gateway
 * entrega um `data:` URL **mais a validade** — e a validade é justamente o que a
 * tela precisa saber. Empurrar isso num corpo de imagem significaria esconder a
 * validade num cabeçalho e fazer o browser adivinhar o resto.
 *
 * A rota de imagem continua, sem mudança: ela é o caminho do canal antigo, e
 * trocá-lo agora mexeria no passo mais frágil da instalação de quem já usa.
 *
 * ## O que `expires_at` conserta
 *
 * Hoje a tela recarrega o QR a cada 15 s **no escuro**, por cache-buster — um
 * número escolhido para ter folga sobre uma expiração que ninguém declara. Com a
 * validade vinda do canal, ela pede outro **quando expira**: acaba tanto o QR
 * morto na tela (o corretor escaneando algo inválido e achando que o celular
 * dele é que está ruim) quanto a requisição a cada 15 s que não precisava sair.
 *
 * `expires_at` pode voltar `null` — o canal antigo não a declara. Nesse caso quem
 * consome mantém o comportamento de hoje. Fingir uma validade que não foi
 * medida seria pior que não ter nenhuma.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  classificarRef,
  type ChannelSessionRef,
} from "@/lib/channels/session-ref";
import { ErroDoGateway, parearNoGateway, statusDeCanalPara } from "@/lib/gateway/provisionamento";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LinhaDeCanal = Partial<ChannelSessionRef> & { archived_at?: string | null };

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  // Parear é ato de admin, como nas duas portas de criação (T045/FR-035): o
  // material de pareamento é o que LIGA um número à organização.
  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const buscar = (colunas: string) =>
    supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", org.orgId)
      .eq("id", id)
      .maybeSingle();
  const { data: linhaRaw } = await queryTolerantToMissingArchived(
    () => buscar(`${CHANNEL_SESSION_REF_COLUMNS}, ${ARCHIVED_AT}`),
    () => buscar(CHANNEL_SESSION_REF_COLUMNS),
  );
  const linha = linhaRaw as LinhaDeCanal | null;
  if (!linha) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  // Mesma recusa da rota de imagem, e pela mesma razão: escanear é o ato que
  // RELIGA um número. Num canal excluído, o corretor pareia o aparelho e a linha
  // continua arquivada — "vivo e surdo", já consumado no celular dele.
  if (linha.archived_at) {
    return fail("channel_archived", "Este número foi excluído da Central de Conexões.", 409, {
      requestId,
    });
  }

  // Que NATUREZA de endereço esta conexão tem — a pergunta mora em
  // `lib/channels/`, para nenhuma feature nomear provider.
  const natureza = classificarRef(linha);

  if (natureza?.via !== "gateway") {
    // Canal antigo (ou oficial, que não pareia por QR). A imagem continua vindo
    // pela rota irmã; aqui só se diz onde buscá-la, para a tela ter UM caminho.
    return ok(
      {
        qr_code: null,
        pair_code: null,
        // Sem validade declarada: quem consome mantém o intervalo de hoje.
        expires_at: null,
        status: null,
        image_url: natureza ? `/api/v1/channel-sessions/${id}/qr` : null,
      },
      { requestId },
    );
  }

  const forcar = new URL(req.url).searchParams.get("force") === "1";
  try {
    const material = await parearNoGateway(natureza.ref, { force: forcar });
    return ok(
      {
        qr_code: material.qrCode,
        pair_code: material.pairCode,
        expires_at: material.expiresAt,
        // Traduzido para o vocabulário da tela ANTES de sair (T042/FR-032): a UI
        // não precisa aprender um segundo conjunto de estados.
        status: statusDeCanalPara(material.status),
        image_url: null,
      },
      { requestId },
    );
  } catch (err) {
    const e = err instanceof ErroDoGateway ? err : null;
    return fail(
      "gateway_error",
      e?.message ?? "não consegui obter o código de pareamento",
      e && e.status >= 500 ? 502 : 422,
      { requestId, details: { codigo: e?.codigo ?? "desconhecido" } },
    );
  }
}
