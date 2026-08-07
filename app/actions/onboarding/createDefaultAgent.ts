"use server";

/**
 * Server Action: create the tenant's first ai_agent (default) and stamp the
 * onboarding state. Uses canonical Spec 05 defaults baked into ai_agents.
 */
import { redirect } from "next/navigation";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { listSelectableChannels, type SelectableChannel } from "@/lib/channels/selectable";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiAgentDefaultSchema, type PromptTemplate } from "@/lib/schemas/onboarding";
import { requireOnboardingCtx, patchOnboardingState, OnboardingError } from "./_shared";

const PROMPT_BODIES: Record<PromptTemplate, string> = {
  ecommerce_friendly: `Você é um(a) atendente virtual amigável de uma loja online. Cumprimente, entenda a dúvida do cliente, ofereça opções claras e use linguagem calorosa. Confirme detalhes do pedido antes de agir.`,
  ecommerce_professional: `Você é um(a) atendente virtual profissional de e-commerce. Comunicação objetiva, formal e empática. Sempre cite o número do pedido quando relevante e ofereça próximos passos práticos.`,
  support_minimal: `Você é um(a) agente de suporte minimalista. Responda em frases curtas, peça apenas o necessário e direcione para um humano quando a confiança for baixa.`,
};

/** O agente padrão desta organização, do jeito que este passo precisa vê-lo. */
interface AgenteDoOnboarding {
  id: string;
  published_version_id: string | null;
}

/**
 * O que aconteceu com a 1ª versão — e por que "não há canal" e "não deu para
 * saber" são desfechos SEPARADOS.
 *
 * `no_channel` é um estado CONHECIDO do produto: quem pulou o WhatsApp não tem
 * número, a versão exige `channel_session_id`, e o agente fica rascunho de
 * propósito (a lista de agentes já mostra "Rascunho"). `failed` é o estado
 * DESCONHECIDO: a consulta não respondeu, então não se sabe se há canal.
 * Colapsar os dois no mesmo `return` seria engolir erro — e engolir erro aqui
 * significa terminar o onboarding com um agente mudo sem ninguém saber por quê.
 */
type PublishOutcome =
  | { published: true }
  | { published: false; reason: "no_channel" }
  | { published: false; reason: "failed"; message: string };

function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Publica a 1ª versão do agente criado no onboarding. **Nunca lança**: devolve
 * o desfecho para quem chama decidir o que a tela mostra.
 *
 * Sem isso, o passo "Configurar IA" gravava só a linha em `ai_agents` — formato
 * do `rag_bot` legado. Só que os dois runtimes atuais (o dispatcher do CRM e o
 * agent-engine) resolvem o agente por
 * `join ai_agent_versions on v.id = a.published_version_id`, então um agente
 * sem versão publicada é invisível para ambos: a pessoa terminava o onboarding
 * com um "Atendente IA" que nunca responderia uma única mensagem.
 */
async function publishFirstVersion(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  agent: AgenteDoOnboarding,
  systemPrompt: string,
  userId: string,
): Promise<PublishOutcome> {
  // Já publicado numa passagem anterior: republicar colidiria com
  // `ai_agent_versions_unique_number` sem ganhar nada.
  if (agent.published_version_id) return { published: true };

  // Mesma lista que os seletores das telas de IA: canal arquivado não é destino
  // válido de agente, e publicar uma versão apontando para um deixaria o
  // onboarding terminar com um agente que nunca receberia uma mensagem.
  //
  // Ela LANÇA em erro de banco, e isso é correto lá: um seletor que devolve
  // lista vazia quando a consulta falhou é indistinguível de "esta organização
  // não tem número", e convida a parear de novo um aparelho que já está no ar.
  // Aqui não é um seletor — é a decisão "publica ou fica rascunho", tomada
  // DEPOIS de a linha em `ai_agents` já existir. Deixar o throw subir furava o
  // `CreateAgentResult` (que trata todos os outros pontos de falha) e o passo
  // terminava sem gravar estado, sem audit, sem evento e sem dizer nada na tela.
  let canais: SelectableChannel[];
  try {
    canais = await listSelectableChannels(admin, orgId);
  } catch (err) {
    return { published: false, reason: "failed", message: mensagemDoErro(err) };
  }
  const [canal] = canais;
  if (!canal) return { published: false, reason: "no_channel" };

  const { data: model } = await admin
    .from("ai_models")
    .select("model_id")
    .eq("provider", "anthropic")
    .eq("is_default_for_provider", true)
    .limit(1)
    .maybeSingle();

  const { data: version, error: versionErr } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agent.id,
      version_number: 1,
      system_prompt: systemPrompt,
      provider: "anthropic",
      // Fallback do modelo vem da main (catálogo do 0104); o canal vem daqui
      // (listagem que exclui arquivado). O hunk pedia as DUAS metades: ficar com
      // um lado só perderia o modelo atual ou o filtro de canal excluído.
      model: (model?.model_id as string) ?? "claude-sonnet-5",
      channel_session_id: canal.id,
      status: "published",
      published_at: new Date().toISOString(),
      created_by: userId,
    })
    .select("id")
    .single();

  let versionId = version?.id ?? null;
  if (!versionId && versionErr?.code === "23505") {
    // A v1 já existe: uma passagem anterior gravou a versão e caiu antes de
    // apontar o agente para ela. Repetir o passo passou a ser o que o usuário
    // faz quando a tela pede — então ele não pode bater em "duplicate key"
    // para sempre. Repontar é o conserto, não um novo INSERT.
    const { data: existente } = await admin
      .from("ai_agent_versions")
      .select("id")
      .eq("organization_id", orgId)
      .eq("agent_id", agent.id)
      .eq("version_number", 1)
      .maybeSingle();
    versionId = existente?.id ?? null;
  }
  if (!versionId) {
    return {
      published: false,
      reason: "failed",
      message: versionErr?.message ?? "ai_agent_versions_insert_sem_id",
    };
  }

  const { error: pointErr } = await admin
    .from("ai_agents")
    .update({ published_version_id: versionId })
    .eq("id", agent.id)
    .eq("organization_id", orgId);
  if (pointErr) return { published: false, reason: "failed", message: pointErr.message };

  return { published: true };
}

export type CreateAgentResult =
  /**
   * O agente existe. `publish_error` presente = ficou RASCUNHO porque não deu
   * para decidir a publicação; ausente = publicado (ou rascunho deliberado por
   * ainda não haver número, caso em que o wizard já seguiu com um `redirect`).
   *
   * Mesmo contrato do passo de convites, que também recusa redirecionar quando
   * a parte que podia falhar falhou (`sendOnboardingInvites` → `undelivered`):
   * avançar calado seria a UI mentindo sobre o que o servidor conseguiu fazer.
   */
  | { ok: true; agent_id: string; publish_error?: string }
  | { ok: false; error: "auth_required" | "no_active_org" | "invalid_input" | "db_error"; details?: unknown };

export async function createDefaultAgent(formData: FormData): Promise<CreateAgentResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const raw = {
    name: String(formData.get("name") ?? "Atendente IA").trim(),
    prompt_template: String(formData.get("prompt_template") ?? "ecommerce_friendly"),
  };

  let input;
  try {
    input = aiAgentDefaultSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: "invalid_input", details: err.flatten() };
    }
    throw err;
  }

  const admin = createAdminClient();
  const systemPrompt = PROMPT_BODIES[input.prompt_template];

  // O agente padrão do onboarding é UM por organização, e o banco já garante
  // isso: `ai_agents_one_default_per_org` é índice único parcial em
  // (organization_id) where is_default. Nenhum outro caminho do produto grava
  // `is_default = true` (todos os outros INSERTs em `ai_agents` gravam false),
  // então "o default desta org" É "o agente que este passo criou" — chave de
  // reaproveitamento que não depende de nenhuma escrita anterior ter dado certo.
  //
  // O código antes fazia o oposto: rebaixava o default existente e inseria
  // outro. Enquanto o passo só terminava em redirect isso nunca aparecia; agora
  // que uma falha na publicação devolve o usuário para esta tela, o segundo
  // clique criaria um "Atendente IA" órfão por clique — todos invisíveis para o
  // runtime, e nenhum deles o padrão. Repetir o passo tem que ser inofensivo.
  const { data: reaproveitado, error: reuseErr } = await admin
    .from("ai_agents")
    .update({ name: input.name, system_prompt: systemPrompt, is_active: true })
    .eq("organization_id", ctx.orgId)
    .eq("is_default", true)
    .select("id, published_version_id")
    .maybeSingle();

  if (reuseErr) {
    return { ok: false, error: "db_error", details: reuseErr.message };
  }

  let agent: AgenteDoOnboarding | null = reaproveitado;
  if (!agent) {
    const { data, error } = await admin
      .from("ai_agents")
      .insert({
        organization_id: ctx.orgId,
        name: input.name,
        system_prompt: systemPrompt,
        is_default: true,
        is_active: true,
        created_by: ctx.userId,
      })
      .select("id, published_version_id")
      .single();

    if (error || !data) {
      return { ok: false, error: "db_error", details: error?.message };
    }
    agent = data;
  }

  const publicacao = await publishFirstVersion(admin, ctx.orgId, agent, systemPrompt, ctx.userId);

  // Estado, audit e evento saem em QUALQUER desfecho da publicação: o agente
  // existe, e o passo do onboarding é "configurar IA", não "publicar". Deixar
  // de gravá-los por causa da versão era o que fazia o wizard esquecer um passo
  // que na verdade aconteceu.
  try {
    await patchOnboardingState(ctx.orgId, {
      ai: { agent_id: agent.id, prompt_template: input.prompt_template },
    });
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: "db_error", details: err.message };
    throw err;
  }

  await audit({
    action: "onboarding.ai_configured",
    actorUserId: ctx.userId,
    organizationId: ctx.orgId,
    resourceType: "ai_agent",
    resourceId: agent.id,
    metadata: {
      prompt_template: input.prompt_template,
      name: input.name,
      published: publicacao.published,
      ...(publicacao.published ? {} : { publish_blocked_by: publicacao.reason }),
    },
  });

  // Emit a domain event for downstream listeners (Spec 01 §7 event log).
  await admin.from("event_log").insert({
    organization_id: ctx.orgId,
    event_type: "ai_agent.created",
    payload: { agent_id: agent.id, source: "onboarding", published: publicacao.published },
  });

  // Não deu para SABER se há canal: não publica (falha fechado na ação) e não
  // avança (falha aberto na informação) — a tela explica e oferece seguir. Um
  // redirect aqui deixaria como única pista um badge "Rascunho" numa tela que a
  // pessoa ainda não viu.
  if (!publicacao.published && publicacao.reason === "failed") {
    return { ok: true, agent_id: agent.id, publish_error: publicacao.message };
  }

  redirect("/onboarding/invite-team");
}

export async function skipAi(): Promise<void> {
  const ctx = await requireOnboardingCtx();
  await patchOnboardingState(ctx.orgId, {
    ai: { agent_id: "", prompt_template: "skipped", skipped: true },
  });
  redirect("/onboarding/invite-team");
}
