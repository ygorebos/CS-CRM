import { redirect } from "next/navigation";

import {
  COLUNAS_DO_ESCOPO,
  LIMITE_MAXIMO,
  contarMateriais,
  projetarEscopo,
  type EscopoDoTenant,
  type LinhaDeEscopo,
} from "@/app/api/v1/knowledge-scopes/_escopos";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { resolverRotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

import { EscoposClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * `/app/ai/knowledge/scopes` — a tela do tenant para ligar e desligar o que o agente pode
 * falar a respeito (spec 002, T068).
 *
 * ## Por que a URL não diz "operadoras"
 *
 * O caminho é neutro e em inglês, ao lado de `knowledge/sources`, porque URL é estrutura e
 * estrutura não pode assumir o nicho (FR-041). "Operadora" é o rótulo do corretor de plano
 * de saúde; uma clínica configura "Convênio" e uma distribuidora "Fornecedor", e nenhuma
 * das duas deveria navegar por um endereço que fala de um negócio que não é o dela. É o
 * mesmo erro que a revisão de brechas tirou do schema antes de a primeira migration ser
 * escrita. Quem carrega vocabulário é o TEXTO — daí o rótulo ser resolvido aqui, por
 * organização, e descer como prop.
 *
 * ## Papel: gestor
 *
 * A tela existe para o interruptor, e o interruptor é `PATCH /api/v1/knowledge-scopes/{id}`,
 * que exige `manager` (FR-032, A-07). Mostrá-la a um `agent` ou `viewer` seria oferecer uma
 * fila de botões que respondem 403 — por isso o redirect aqui e o `minRole: "manager"` no
 * registro de navegação apontam para o mesmo papel.
 *
 * ## Os dados vêm daqui, não de um fetch depois da hidratação
 *
 * Mesmo padrão da tela vizinha (`knowledge/sources`): a página lê e o cliente recebe pronto.
 * A projeção reusa `projetarEscopo`/`contarMateriais` da própria rota — repetir a regra de
 * `origin` aqui criaria uma segunda fonte para o mesmo dado, que é o dia em que a tela e a
 * API passam a discordar sobre de quem é a responsabilidade de corrigir um material.
 */

/**
 * Teto de leitura da página, igual ao máximo que a rota aceita numa chamada.
 *
 * O recorte editorial do catálogo é deliberadamente pequeno — poucas operadoras, produtos
 * de uma região (FR-041) —, então paginar esta tela seria construir uma engrenagem para um
 * caso que o desenho não prevê. O que NÃO se faz é esconder o corte: quando ele acontece, a
 * tela diz que está mostrando os primeiros e oferece a busca.
 */
const LIMITE_DA_TELA = LIMITE_MAXIMO;

export default async function EscoposDeConhecimentoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();

  const { data: organizacao } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const rotulo = resolverRotuloDoEscopo((organizacao as { settings?: unknown } | null)?.settings);

  // A RLS `tenant_isolation_knowledge_scopes_all` já isolaria; o filtro explícito é doutrina
  // e é o que segura a linha caso a policy mude de forma.
  //
  // A ordem é alfabética e NÃO leva `is_active` em conta de propósito: uma lista que se
  // reordena a cada clique faria o corretor perder de vista a linha que ele acabou de mexer
  // — e clicar na errada em seguida.
  const { data, error } = await supabase
    .from("knowledge_scopes")
    .select(COLUNAS_DO_ESCOPO)
    .eq("organization_id", activeOrg.orgId)
    .order("display_name", { ascending: true })
    // +1 só para saber que houve corte, sem um `count` que varre a tabela.
    .limit(LIMITE_DA_TELA + 1);

  // Falha de leitura NÃO cai no estado vazio: "nada por aqui ainda" e "não consegui ler"
  // são a mesma tela para o corretor, e ele agiria em cima da primeira — concluindo que a
  // instalação não trouxe nada, quando o que houve foi um erro.
  if (error) {
    return (
      <div className="flex h-full flex-col gap-6 p-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{rotulo.plural}</h1>
        </header>
        <div className="rounded-lg border border-border bg-surface p-6 text-sm">
          Não foi possível carregar a lista agora. Recarregue a página em alguns instantes.
        </div>
      </div>
    );
  }

  const linhas = (data ?? []) as unknown as LinhaDeEscopo[];
  const truncado = linhas.length > LIMITE_DA_TELA;
  const pagina = truncado ? linhas.slice(0, LIMITE_DA_TELA) : linhas;

  const contagens = await contarMateriais(supabase, activeOrg.orgId, pagina);
  const escopos: EscopoDoTenant[] = pagina.map((linha) =>
    projetarEscopo(linha, contagens.get(linha.id)),
  );

  return <EscoposClient rotulo={rotulo} escoposIniciais={escopos} truncado={truncado} />;
}
