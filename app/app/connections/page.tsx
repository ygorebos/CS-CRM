import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { provisionamentoConfigurado } from "@/lib/gateway/provisionamento";
import { ROLE_RANK } from "@/lib/auth/types";
import { ConexoesShell } from "@/components/connections/ConexoesShell";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  // ── T063/FR-030: conectar não podia depender do transporte ANTIGO ──────────
  //
  // Encontrado ao executar a spec de tela: o botão "Conectar novo WhatsApp"
  // ficava `disabled` quando o transporte legado não estava configurado — e numa
  // instalação que provisiona **pelo gateway** ele não precisa estar. O corretor
  // via a tela certa, com o botão certo, e não conseguia clicar.
  //
  // O nome da flag mentia junto: `wahaConfigured` decidia se dá para CONECTAR,
  // que é uma pergunta sobre haver ALGUM caminho de provisionamento — não sobre
  // um provedor específico. Vira `podeConectar`, e passa a ser a união dos dois.
  const key = process.env.WAHA_API_KEY;
  const transporteLegadoPronto = Boolean(
    process.env.WAHA_API_BASE_URL && key && key !== "dev_plaintext_change_me",
  );
  const podeConectar = transporteLegadoPronto || provisionamentoConfigurado();

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Conexões</h1>
        <p className="text-sm text-muted-foreground">
          Por onde seu negócio fala com o cliente. Conecte números por QR ou o número oficial
          da Meta, e acompanhe a saúde de cada um.
        </p>
      </header>
      <ConexoesShell wahaConfigured={podeConectar} />
    </div>
  );
}
