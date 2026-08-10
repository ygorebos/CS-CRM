import { NextResponse } from "next/server";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { parearNoGateway } from "@/lib/gateway/provisionamento";
import { createClient } from "@/lib/supabase/server";

/**
 * Proxy WAHA's QR endpoint so the browser can <img src="..." /> without
 * exposing the API key.
 *
 * WAHA Plus exposes: GET /api/{session}/auth/qr?format=image → image/png bytes.
 *
 * ## Por que esta rota também atende o gateway
 *
 * A tela do onboarding pede o QR com `<img src>`, e trocar isso mexeria no passo
 * mais frágil da primeira impressão. Então o CONTRATO daqui não muda — bytes de
 * PNG — e só a FONTE muda quando a conexão é do gateway, que entrega o QR como
 * `data:` URL. A rota irmã `/channel-sessions/[id]/pairing` continua sendo o
 * caminho rico (traz `expires_at`); esta é a que o `<img>` consegue consumir.
 */
/**
 * Os bytes do PNG dentro de um `data:` URL, ou `null` se não houver QR.
 *
 * Só `image/png` em base64 é aceito. Um `data:` de outro tipo — ou um QR em
 * texto puro, que o provedor também sabe devolver — viraria `<img>` quebrado se
 * eu repassasse os bytes assim mesmo; recusar aqui deixa a tela dizer "ainda não
 * há QR" em vez de mostrar imagem morta.
 */
export function pngDeDataUrl(dataUrl: string | null): Buffer | null {
  if (!dataUrl) return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  return Buffer.from(m[1] ?? "", "base64");
}

export async function GET() {
  const user = await loadAuthUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return new NextResponse(null, { status: 404 });

  const sessionName = `org_${activeOrg.orgId.slice(0, 8)}`;

  // Conexão do gateway: o QR vem de lá. Perguntar ao WAHA devolveria 404 e a
  // tela mostraria imagem quebrada num pareamento que está funcionando.
  const supabase = await createClient();
  const { data: conexao } = await supabase
    .from("channel_sessions")
    .select("gateway_connection_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("waha_session_name", sessionName)
    .maybeSingle();
  const gatewayConnectionId = (conexao?.gateway_connection_id as string) ?? null;
  if (gatewayConnectionId) {
    try {
      const material = await parearNoGateway(gatewayConnectionId);
      const png = pngDeDataUrl(material.qrCode);
      // Sem QR não é erro do servidor: é conexão que não está na fase de
      // escanear (já pareada, ou ainda subindo). 404 deixa a tela distinguir.
      if (!png) return new NextResponse(null, { status: 404 });
      return new NextResponse(png as unknown as BodyInit, {
        status: 200,
        headers: { "content-type": "image/png", "cache-control": "no-store, max-age=0" },
      });
    } catch {
      return new NextResponse(null, { status: 502 });
    }
  }

  const baseUrl = process.env.WAHA_API_BASE_URL;
  const apiKey = process.env.WAHA_API_KEY;
  if (!baseUrl || !apiKey || apiKey === "dev_plaintext_change_me") {
    return new NextResponse(null, { status: 503 });
  }

  const upstream = await fetch(
    `${baseUrl}/api/${encodeURIComponent(sessionName)}/auth/qr?format=image`,
    { headers: { "X-Api-Key": apiKey }, cache: "no-store" },
  );
  if (!upstream.ok) {
    return new NextResponse(null, {
      status: upstream.status,
      headers: { "x-waha-status": String(upstream.status) },
    });
  }

  const ct = upstream.headers.get("content-type") ?? "image/png";
  const buf = await upstream.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      "content-type": ct,
      "cache-control": "no-store, max-age=0",
    },
  });
}
