import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";

/** Normaliza o nome da empresa para um slug candidato (citext unique no DB). */
function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "org";
}

type ProvisionUser = {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

/**
 * Provisiona o tenant de um usuário recém-confirmado via signup self-service:
 * cria a organização (status `active`, `onboarded_at` null → cai no onboarding)
 * e a membership `admin` do usuário.
 *
 * Idempotente: se o usuário já tem membership ativa (link de confirmação
 * clicado duas vezes, ou usuário que entrou antes por convite), não faz nada.
 *
 * Service role é intencional aqui — o usuário ainda não pertence a nenhuma org,
 * então RLS bloquearia os INSERTs. A fonte confiável é o JWT já validado por
 * `verifyOtp` no caller (nunca o body).
 */
export async function ensureTenantForUser(
  user: ProvisionUser,
): Promise<{ provisioned: boolean; organizationId?: string }> {
  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", user.id)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (existing) return { provisioned: false, organizationId: existing.organization_id };

  const orgName =
    (user.user_metadata?.org_name as string | undefined)?.trim() ||
    user.email?.split("@")[0] ||
    "Minha empresa";
  const base = slugify(orgName);

  // ponytail: check-then-insert tem janela de corrida se o mesmo link for
  // confirmado 2x em paralelo (pior caso: org duplicada órfã). Advisory lock
  // por user_id se isso aparecer na prática.
  let org: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 3 && !org; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug,
        display_name: orgName,
        legal_name: orgName,
        status: "active",
        created_by: user.id,
      })
      .select("id, slug")
      .single();
    if (data) {
      org = data;
    } else if (error && error.code !== "23505") {
      throw new Error(`signup provisioning: org insert failed: ${error.message}`);
    }
  }
  if (!org) throw new Error("signup provisioning: slug exhausted after 3 attempts");

  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    throw new Error(`signup provisioning: membership insert failed: ${memberError.message}`);
  }

  // T056 — o tenant novo tem de ENXERGAR o catálogo curado.
  //
  // A semeadura do `baseline.sql` termina sincronizando os espelhos para as organizações
  // que existiam NAQUELE momento (T055). Toda organização criada depois — que é toda
  // organização de usuário self-service — nasceria sem espelho nenhum, e o sintoma não
  // seria um erro: seria a tela de Operadoras vazia numa instalação que tem catálogo. O
  // corretor conclui que o produto não sabe nada, quando ele sabe e ninguém ligou o fio.
  //
  // A função é idempotente por construção, então chamá-la aqui também cura tenant que
  // por qualquer motivo tenha ficado para trás.
  const { error: syncError } = await admin.rpc("fn_sincronizar_escopos_do_catalogo", {
    p_organization_id: org.id,
  });
  if (syncError) {
    // NÃO bloqueia o cadastro: quem não consegue entrar não liga escopo nenhum, e os
    // espelhos nascem inativos de qualquer forma (A-20). Mas também não é silêncio —
    // Princípio II: falta de funcionamento não vira `return` mudo.
    void audit({
      action: "tenant.catalog_sync_failed",
      actorUserId: user.id,
      organizationId: org.id,
      resourceType: "organization",
      resourceId: org.id,
      bypassedRls: true,
      metadata: { error: syncError.message.slice(0, 160) },
    });
  }

  void audit({
    action: "tenant.created_by_signup",
    actorUserId: user.id,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug: org.slug },
  });

  return { provisioned: true, organizationId: org.id };
}
