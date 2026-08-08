import { redirect } from "next/navigation";

import {
  COLUNAS_DO_ESCOPO,
  contarMateriais,
  projetarEscopo,
  type ContagemDeMateriais,
  type EscopoDoTenant,
  type LinhaDeEscopo,
} from "@/app/api/v1/knowledge-scopes/_escopos";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import { resolverRotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

import { EscoposClient } from "./_client";
import {
  TAMANHO_DA_LEITURA,
  TETO_DE_SEGURANCA,
  deveLerMais,
  faixaDaLeitura,
} from "./_regras";

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
 * ## T100 — por que esta página lê em lote até acabar
 *
 * Ela lia UMA vez, no máximo `LIMITE_MAXIMO` linhas, e avisava que tinha cortado. Isso é
 * um teto de tela, e FR-003/US4 cenário 3 dizem o contrário: o corretor vê **todas** as
 * operadoras, com o estado de cada uma, sem limite de quantas cabem. O corte era pior do
 * que parecia — a busca desta tela filtra o que já veio, então a operadora que ficou de
 * fora da leitura não era alcançável por caminho nenhum.
 *
 * O laço lê `TAMANHO_DA_LEITURA` por vez e continua enquanto vier lote cheio. O
 * `TETO_DE_SEGURANCA` que o encerra não é limite de produto: é a rede que impede um
 * defeito de paginação de virar página infinita — e, quando ele é atingido, a tela diz.
 */
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
  // — e clicar na errada em seguida. O desempate por `id` existe porque duas operadoras
  // podem ter o mesmo nome: sem ele, a ordem entre lotes não é estável e uma linha poderia
  // aparecer duas vezes enquanto outra some.
  const linhas: LinhaDeEscopo[] = [];
  let error: unknown = null;

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
      error = resposta.error;
      break;
    }

    const lote = (resposta.data ?? []) as unknown as LinhaDeEscopo[];
    linhas.push(...lote);
    if (!deveLerMais(lote.length, linhas.length)) break;
  }

  // Falha de leitura NÃO cai no estado vazio: "nada por aqui ainda" e "não consegui ler"
  // são a mesma tela para o corretor, e ele agiria em cima da primeira — concluindo que a
  // instalação não trouxe nada, quando o que houve foi um erro. Falha no meio da leitura
  // também cai aqui: mostrar meia lista sem dizer nada esconderia operadora que existe.
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

  // A leitura só para no teto de segurança — e aí, sim, a tela avisa.
  const truncado = linhas.length >= TETO_DE_SEGURANCA;

  // A contagem vai em lotes do mesmo tamanho da leitura: `contarMateriais` monta um
  // `in (...)` com os ids que recebe, e mandar milhares de uma vez estouraria o tamanho da
  // requisição — que é uma falha que só aparece na instalação com muitas operadoras.
  const contagens = new Map<string, ContagemDeMateriais>();
  for (let i = 0; i < linhas.length; i += TAMANHO_DA_LEITURA) {
    const lote = linhas.slice(i, i + TAMANHO_DA_LEITURA);
    for (const [id, contagem] of await contarMateriais(supabase, activeOrg.orgId, lote)) {
      contagens.set(id, contagem);
    }
  }

  const escopos: EscopoDoTenant[] = linhas.map((linha) =>
    projetarEscopo(linha, contagens.get(linha.id)),
  );

  return <EscoposClient rotulo={rotulo} escoposIniciais={escopos} truncado={truncado} />;
}
