import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { redirect } from "next/navigation";
import { transporteDaInstalacao } from "@/lib/channels/transporte";
import { ConnectWhatsappClient } from "./_client";

export const dynamic = "force-dynamic";

export default async function ConnectWhatsappPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/login");

  // T002 da spec 005. Esta linha perguntava `getWahaClient() !== null`, e era a
  // terceira forma da mesma pergunta — a que ficou para trás quando o gateway
  // entrou. Numa instalação com gateway ligado e WAHA ausente, a primeira tela
  // de quem acabou de se cadastrar dizia que o serviço estava indisponível e não
  // mostrava QR nenhum. O cadastro morria ali.
  const transporte = transporteDaInstalacao();

  // T005: `null` é estado legítimo, e quem OPERA precisa saber qual variável
  // falta. Vai para o log do servidor, não para a tela: o texto que o usuário lê
  // não pode nomear provedor nem mandá-lo configurar coisa nossa (SC-003/SC-007).
  if (transporte === null) {
    console.warn(
      "[onboarding] nenhum transporte configurado — o cadastro não consegue conectar canal. " +
        "Configure GATEWAY_BASE_URL + GATEWAY_ADMIN_TOKEN (caminho novo) " +
        "ou WAHA_API_BASE_URL + WAHA_API_KEY (legado).",
    );
  }

  // A sessão não é iniciada no SSR — quem dispara é o cliente, que também mostra
  // o aviso quando não há transporte.

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Conectar WhatsApp</h2>
        <p className="text-sm text-muted-foreground">
          Escaneie o QR Code com o WhatsApp Business para conectar seu número à plataforma.
        </p>
      </header>
      <ConnectWhatsappClient
        transporte={transporte}
        sessionName={`org_${activeOrg.orgId.slice(0, 8)}`}
      />
    </div>
  );
}
