import { EscopoClient } from "./_client";

export const metadata = { title: "Operadora — Catálogo — Admin Plataforma" };

/**
 * `/admin/catalogo/{escopoId}` — os materiais de uma operadora (spec 002, T066).
 *
 * Guarda de papel em `app/admin/(protected)/layout.tsx`, como todo o resto do admin.
 */
export default async function AdminCatalogoEscopoPage({
  params,
}: {
  params: Promise<{ escopoId: string }>;
}) {
  const { escopoId } = await params;
  return <EscopoClient escopoId={escopoId} />;
}
