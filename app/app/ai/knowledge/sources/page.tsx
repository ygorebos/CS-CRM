import Link from "next/link";
import { redirect } from "next/navigation";

import {
  COLUNAS_DO_ESCOPO,
  COLUNAS_DO_MATERIAL,
  projetarEscopo,
  type LinhaDeEscopo,
  type LinhaDeMaterial,
} from "@/app/api/v1/knowledge-scopes/_escopos";
import { Button } from "@/components/ui/button";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { resolverRotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

import { deveLerMais, faixaDaLeitura } from "../scopes/_regras";
import { KnowledgeSourcesClient } from "./_client";
import { TITULO, type EscopoNaTela, type MaterialDoCorretor } from "./_regras";

export const dynamic = "force-dynamic";

/**
 * `/app/ai/knowledge/sources` — o acervo do corretor (spec 002, T090 e T118).
 *
 * ## Quem lê é a página
 *
 * Mesmo padrão da tela vizinha de operadoras: a leitura acontece aqui, no servidor, com
 * `organization_id` explícito além da RLS, e o cliente recebe pronto. A rota
 * `GET /api/v1/knowledge-scopes/{id}/materials` existe para quem integra; usá-la aqui
 * significaria uma chamada por operadora só para desenhar a primeira tela.
 *
 * ## Os materiais continuam sendo do agente
 *
 * `ai_knowledge_sources.agent_id` é `not null` — todo material pertence a um agente. O
 * MVP tem um agente padrão por organização, então a tela usa o `is_default`. O eixo NOVO
 * é o `scope_id` (migration 0118), e é por ele que a tela agrupa: é a operadora que decide
 * o que ancora a resposta de um cliente, não o tipo do arquivo.
 *
 * ## `?escopo=` não é enfeite
 *
 * É o link "Carregar material" da tela de operadoras chegando aqui com a operadora já
 * escolhida no formulário. Sem ele, o corretor clica em "carregar material da Amil" e
 * aterrissa numa tela que não sabe de qual operadora ele estava falando.
 */
export default async function KnowledgeSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ escopo?: string }>;
}) {
  const { escopo: escopoInicial } = await searchParams;

  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data: agent } = await supabase
    .from("ai_agents")
    .select("id, name, is_default")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_default", true)
    .maybeSingle();

  if (!agent) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{TITULO}</h1>
          <p className="text-sm text-text-muted">
            O que o agente consulta antes de responder.
          </p>
        </header>
        <div className="rounded-lg border border-border bg-surface p-6 text-sm">
          <p className="mb-4">
            Nenhum agente ainda. Crie o seu primeiro para poder ensinar alguma coisa a ele.
          </p>
          <Button asChild variant="primary" size="sm">
            <Link href="/app/ai/agents">Criar agente</Link>
          </Button>
        </div>
      </div>
    );
  }

  const { data: organizacao } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const rotulo = resolverRotuloDoEscopo((organizacao as { settings?: unknown } | null)?.settings);

  // As operadoras vêm todas (T100): agrupar material por operadora que a leitura cortou
  // faria o material dela cair no card de segurança, como se não tivesse dono.
  const linhas: LinhaDeEscopo[] = [];
  let falhou = false;

  for (let pagina = 0; ; pagina++) {
    const { de, ate } = faixaDaLeitura(pagina);
    const resposta = await supabase
      .from("knowledge_scopes")
      .select(COLUNAS_DO_ESCOPO)
      .eq("organization_id", activeOrg.orgId)
      .order("display_name", { ascending: true })
      .order("id", { ascending: true })
      .range(de, ate);

    if (resposta.error) {
      falhou = true;
      break;
    }
    const lote = (resposta.data ?? []) as unknown as LinhaDeEscopo[];
    linhas.push(...lote);
    if (!deveLerMais(lote.length, linhas.length)) break;
  }

  const materiais: MaterialDoCorretor[] = [];

  for (let pagina = 0; !falhou; pagina++) {
    const { de, ate } = faixaDaLeitura(pagina);
    // As colunas são as da própria superfície de materiais (`COLUNAS_DO_MATERIAL`), e não
    // uma segunda lista escrita aqui: `MaterialDoCorretor` é um recorte de
    // `LinhaDeMaterial`, então duas listas divergiriam no dia em que uma coluna entrasse
    // só de um lado — e a tela mostraria estado calculado com dado velho.
    const resposta = await supabase
      .from("ai_knowledge_sources")
      .select(COLUNAS_DO_MATERIAL)
      .eq("organization_id", activeOrg.orgId)
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(de, ate);

    if (resposta.error) {
      falhou = true;
      break;
    }
    const lote = (resposta.data ?? []) as unknown as LinhaDeMaterial[];
    materiais.push(...lote);
    if (!deveLerMais(lote.length, materiais.length)) break;
  }

  // Falha de leitura NÃO vira estado vazio. "Você ainda não carregou nada" e "não consegui
  // ler" são a mesma tela para quem olha, e a primeira convida a carregar de novo o que já
  // existe — que é como se cria material duplicado.
  if (falhou) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{TITULO}</h1>
        </header>
        <div className="rounded-lg border border-border bg-surface p-6 text-sm">
          Não foi possível carregar seus materiais agora. Recarregue a página em alguns
          instantes.
        </div>
      </div>
    );
  }

  const escopos: EscopoNaTela[] = linhas.map((linha) => projetarEscopo(linha));

  return (
    <KnowledgeSourcesClient
      agentId={agent.id}
      rotulo={rotulo}
      escopos={escopos}
      materiais={materiais}
      escopoInicial={escopoInicial ?? null}
    />
  );
}
