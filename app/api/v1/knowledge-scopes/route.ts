/**
 * GET  /api/v1/knowledge-scopes — os escopos que ESTE tenant enxerga: espelhos do catálogo
 *      curado e os que ele mesmo criou, na mesma lista, com `origin` explícito.
 * POST /api/v1/knowledge-scopes — cria escopo próprio do tenant (FR-002).
 *
 * Spec 002 (RAG por operadora), T067. Contrato em
 * `specs/002-rag-por-operadora/contracts/rotas-http.md`.
 *
 * ## Por que UMA lista, e não duas
 *
 * O corretor não tem dois problemas ("meu acervo" e "o catálogo"), tem um: de quais
 * operadoras o agente pode falar. Duas listas o obrigariam a cruzar nomes na cabeça para
 * descobrir se a operadora que ele ia cadastrar já veio pronta — e ele cadastraria a
 * duplicata, porque é o caminho mais curto. Uma lista só, com `origin` em cada linha,
 * responde as duas perguntas de FR-039 de uma vez: o que existe, e de quem é a
 * responsabilidade de corrigir.
 *
 * ## Papéis
 *
 * `viewer` lê, `manager` escreve (FR-032, A-07). A `organization_id` vem sempre de
 * `requireRole` — cookie de sessão validado com `getUser()` —, nunca do body: o schema é
 * `strictObject`, então mandá-la ali é 422, não é ignorada em silêncio.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import {
  ACAO_CRIADO,
  COLUNAS_DO_ESCOPO,
  ENDPOINT_DA_CRIACAO,
  TETO_DE_ESCRITA,
  acharColisaoDeNome,
  aplicarTetoDaOrganizacao,
  codificarCursor,
  contarMateriais,
  criarEscopoSchema,
  decodificarCursor,
  impressaoDoPedido,
  projetarEscopo,
  queryDaListaSchema,
  rotuloDoTenant,
  type EscopoDoTenant,
  type LinhaDeEscopo,
} from "./_escopos";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET — a lista
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "knowledge_scopes" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const url = new URL(req.url);
  const query = queryDaListaSchema.safeParse({
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!query.success) {
    return fail("validation_failed", "Query inválida.", 422, {
      requestId,
      details: query.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { cursor, limit } = query.data;

  const supabase = await createClient();
  let consulta = supabase
    .from("knowledge_scopes")
    .select(COLUNAS_DO_ESCOPO)
    // A RLS `tenant_isolation_knowledge_scopes_all` já isolaria; o filtro explícito é
    // doutrina (CLAUDE.md, "toda query que cruza tabelas tenant-aware filtra
    // organization_id") e é o que segura a linha caso a policy mude de forma.
    .eq("organization_id", org.orgId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    // +1 para saber que há próxima página sem um `count` que varre a tabela.
    .limit(limit + 1);

  if (cursor) {
    const c = decodificarCursor(cursor);
    if (!c) return fail("invalid_cursor", "Cursor inválido.", 400, { requestId });
    consulta = consulta.or(
      `created_at.gt.${c.created_at},and(created_at.eq.${c.created_at},id.gt.${c.id})`,
    );
  }

  const { data, error } = await consulta;
  if (error) {
    return fail("internal_error", "Erro ao listar os escopos de conhecimento.", 500, { requestId });
  }

  const linhas = (data ?? []) as unknown as LinhaDeEscopo[];
  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;
  const ultima = pagina[pagina.length - 1];

  const contagens = await contarMateriais(supabase, org.orgId, pagina);
  const corpo: EscopoDoTenant[] = pagina.map((linha) =>
    projetarEscopo(linha, contagens.get(linha.id)),
  );

  return ok(corpo, {
    requestId,
    meta: {
      cursor:
        temMais && ultima ? codificarCursor({ created_at: ultima.created_at, id: ultima.id }) : null,
      has_more: temMais,
    },
  });
}

// ---------------------------------------------------------------------------
// POST — escopo próprio
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "knowledge_scopes" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  // ── teto (item 6 do Definition of Done) ───────────────────────────────────
  // DEPOIS do papel, para que o 403 de quem não pode escrever não gaste orçamento de quem
  // pode; ANTES de ler o corpo, para que o pedido barrado não custe nem o parse.
  const teto = await aplicarTetoDaOrganizacao(org.orgId, TETO_DE_ESCRITA, requestId);
  if (teto.excedido) return teto.excedido;

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", "Body JSON inválido.", 400, {
      requestId,
      headers: teto.headers,
    });
  }

  const parsed = criarEscopoSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      headers: teto.headers,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { display_name, official_code } = parsed.data;

  const supabase = await createClient();

  // ── idempotência (Princípio V) ────────────────────────────────────────────
  // A tabela `idempotency_keys` tem RLS por organização e `unique (organization_id, key,
  // endpoint)`, então o client de sessão basta — não há motivo para service role aqui, e
  // usá-lo obrigaria a refazer à mão o isolamento que a policy já faz.
  const chave = req.headers.get("Idempotency-Key") ?? req.headers.get("idempotency-key");
  const impressao = impressaoDoPedido(parsed.data);
  if (chave) {
    const { data: guardada } = await supabase
      .from("idempotency_keys")
      .select("request_hash, response_body")
      .eq("organization_id", org.orgId)
      .eq("key", chave)
      .eq("endpoint", ENDPOINT_DA_CRIACAO)
      .maybeSingle();

    if (guardada) {
      // Mesma chave com corpo diferente é engano do cliente, não repetição: responder o
      // primeiro esconderia que o segundo pedido nunca aconteceu.
      if (guardada.request_hash !== impressao) {
        return fail(
          "idempotency_conflict",
          "Esta Idempotency-Key já foi usada com outro conteúdo.",
          409,
          { requestId, headers: teto.headers },
        );
      }
      return ok(guardada.response_body as EscopoDoTenant, {
        requestId,
        status: 201,
        headers: teto.headers,
      });
    }
  }

  // ── 409 de nome (FR-002) ──────────────────────────────────────────────────
  // Carrega os nomes que este tenant já enxerga — os próprios E os espelhos do catálogo.
  // Comparar no banco (`ilike`) não serviria: o que precisa ser barrado é a duplicata
  // humana, com acento e caixa diferentes, e o teto real desta lista é a quantidade de
  // operadoras de um corretor.
  const { data: existentes, error: erroDeLeitura } = await supabase
    .from("knowledge_scopes")
    .select("id, display_name, catalog_scope_id, is_active")
    .eq("organization_id", org.orgId);
  if (erroDeLeitura) {
    return fail("internal_error", "Erro ao verificar os escopos existentes.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const colisao = acharColisaoDeNome(
    (existentes ?? []) as { id: string; display_name: string; catalog_scope_id: string | null; is_active: boolean }[],
    display_name,
  );
  if (colisao) {
    const rotulo = await rotuloDoTenant(supabase, org.orgId);
    // A frase muda conforme a camada porque a AÇÃO seguinte é outra: o espelho do catálogo
    // já existe pronto e só precisa ser ligado (é o passo de SC-011); o escopo próprio já
    // é dele e não há nada a fazer. Dizer só "já existe" mandaria o corretor procurar na
    // lista uma linha que, no caso do catálogo, ele nem sabia que estava lá.
    const mensagem =
      colisao.catalog_scope_id !== null
        ? `${rotulo.singular} "${colisao.display_name}" já vem no catálogo desta instalação${
            colisao.is_active ? "" : ", com o interruptor ainda desligado"
          }. Use o interruptor na lista em vez de criar outro registro.`
        : `${rotulo.singular} "${colisao.display_name}" já existe nesta conta. Abra o registro existente ou escolha outro nome.`;
    return fail("escopo_ja_existe", mensagem, 409, {
      requestId,
      headers: teto.headers,
      details: { existing_id: colisao.id },
    });
  }

  // ── criação ───────────────────────────────────────────────────────────────
  const { data: criado, error: erroDeInsert } = await supabase
    .from("knowledge_scopes")
    .insert({
      organization_id: org.orgId,
      display_name,
      official_code: official_code ?? null,
      // `catalog_scope_id` fica NULO, e é isso que torna o escopo "próprio". Espelho só
      // nasce por `fn_sincronizar_escopos_do_catalogo` — se esta rota pudesse escrevê-lo,
      // um tenant conseguiria pendurar-se num escopo curado por caminho não previsto.
      // `is_active` não é passado: o default `true` da tabela serve o escopo que o
      // corretor acabou de digitar (o trigger A-20 só desliga espelho).
    })
    .select(COLUNAS_DO_ESCOPO)
    .single();

  if (erroDeInsert || !criado) {
    return fail("internal_error", "Erro ao criar o escopo de conhecimento.", 500, {
      requestId,
      headers: teto.headers,
    });
  }

  const linha = criado as unknown as LinhaDeEscopo;
  // Escopo recém-criado não tem material — as contagens são zero por construção, sem
  // precisar de consulta.
  const corpo = projetarEscopo(linha);

  void audit({
    action: ACAO_CRIADO,
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "knowledge_scope",
    resourceId: linha.id,
    requestId,
    metadata: {
      display_name: linha.display_name,
      official_code: linha.official_code,
      origin: corpo.origin,
    },
  });

  if (chave) {
    // Best-effort: a chave existe para evitar duplicata, e falhar em GRAVÁ-LA não pode
    // desfazer um escopo que já foi criado. `unique (organization_id, key, endpoint)`
    // resolve a corrida de dois pedidos simultâneos — o segundo bate 23505 aqui e é
    // engolido, exatamente como deve ser.
    await supabase
      .from("idempotency_keys")
      .insert({
        organization_id: org.orgId,
        key: chave,
        endpoint: ENDPOINT_DA_CRIACAO,
        request_hash: impressao,
        response_body: corpo,
        status_code: 201,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .then(() => undefined);
  }

  return ok(corpo, { requestId, status: 201, headers: teto.headers });
}
