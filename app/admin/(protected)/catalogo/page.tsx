import { CatalogoClient } from "./_client";

export const metadata = { title: "Catálogo de conhecimento — Admin Plataforma" };

/**
 * `/admin/catalogo` — curadoria do catálogo curado (spec 002, T066).
 *
 * A guarda de papel mora em `app/admin/(protected)/layout.tsx`
 * (`requirePlatformAdmin`): quem não é administrador de plataforma é levado a
 * `/admin/forbidden`, que explica a negação em vez de mostrar uma tela vazia.
 */
export default function AdminCatalogoPage() {
  return <CatalogoClient />;
}
