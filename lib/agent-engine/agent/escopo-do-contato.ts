/**
 * De qual operadora é o plano deste cliente — spec 002 (RAG por operadora), T060/T061.
 *
 * "Escopo de conhecimento" é o nome estrutural; "operadora" é o rótulo que o nicho de
 * validação exibe. Aqui dentro os dois aparecem: o tipo fala escopo, o texto que sai para
 * pessoa fala operadora.
 *
 * ## A regra inteira, porque ela é curta e cada metade é um requisito
 *
 * 1. **Cadastro vence conversa, e nunca é rebaixado** (FR-017). Quem registrou a operadora
 *    na ficha do contato decidiu; o que o cliente disser no meio de uma conversa não
 *    apaga isso. A trava é do banco para cima: `gravarEscopoDaConversa` tem a condição no
 *    `where`, não num `if` que alguém inverte numa refatoração.
 * 2. **O sistema NÃO INFERE** (FR-017, T061). Nem por ser a única operadora cadastrada,
 *    nem pela mais usada, nem por semelhança de texto. Só existe um caminho para o vínculo
 *    nascer na conversa: o cliente **escrever o nome** que está cadastrado. Escopo
 *    desconhecido é estado tratado — a busca devolve só material "vale para todos" —, não
 *    um convite a adivinhar.
 * 3. **Pergunta-se uma única vez por conversa** (A-05). Repetir irrita e não converge.
 *
 * ## Por que reconhecer o nome NÃO é "inferir por semelhança de texto"
 *
 * A fronteira é fina e vale escrevê-la: aqui só casa **ocorrência literal** do nome (ou do
 * código oficial) que o corretor cadastrou, com fronteira de palavra nos dois lados, sobre
 * texto normalizado (minúsculas, sem acento). Não há distância de edição, não há radical,
 * não há "o mais parecido". Se dois nomes cadastrados casarem ao mesmo tempo e nenhum for
 * pedaço do outro, o resultado é **ambíguo e nada é gravado** — escolher um seria a
 * inferência que FR-017 proíbe.
 *
 * ## Por que o "já perguntei" mora em `conversations.metadata`
 *
 * Dívida declarada, e pequena: o estado natural seria uma coluna, e coluna exige migration
 * — que é outro conjunto de escrita. `metadata` já existe, já é `jsonb not null default
 * '{}'`, e a chave é escrita e lida **só por este módulo** (a constante abaixo é o schema
 * central que o anti-pattern nº 6 cobra). Quando a coluna existir, muda-se aqui e mais
 * nenhum lugar.
 */
import type pg from 'pg';

import { normalizarParaLexico } from '../guardrails/lexico-assistencia';
import type { Logger } from '../obs/logger';

/** Um escopo como AQUELE tenant o vê (`knowledge_scopes`, migration 0118). */
export interface EscopoConhecido {
  readonly id: string;
  readonly displayName: string;
  readonly officialCode: string | null;
  /** Trava 4 (FR-008): desligado não ancora nada, nem do catálogo nem do acervo. */
  readonly isActive: boolean;
  /** Preenchido = espelho do catálogo curado (nasce desligado, A-20); nulo = do corretor. */
  readonly catalogScopeId: string | null;
}

export type OrigemDoEscopo = 'cadastro' | 'conversa';

/** O vínculo cliente↔operadora, como está gravado agora. */
export interface VinculoDeEscopo {
  readonly scopeId: string | null;
  readonly displayName: string | null;
  readonly source: OrigemDoEscopo | null;
  readonly confirmedAt: Date | null;
}

export const VINCULO_DESCONHECIDO: VinculoDeEscopo = {
  scopeId: null,
  displayName: null,
  source: null,
  confirmedAt: null,
};

/**
 * A chave, e o único lugar do sistema que a conhece.
 *
 * Guarda o instante em que a pergunta de operadora foi feita nesta conversa. Presença =
 * já foi perguntada; ausência = nunca. Não guarda a resposta — a resposta é o vínculo em
 * `contacts`, que é dado, não estado de conversa.
 */
export const CHAVE_ESCOPO_PERGUNTADO = 'escopo_perguntado_em';

/**
 * A pergunta, em linguagem natural, sem uma palavra de vocabulário interno.
 *
 * Ela é **sugerida** ao modelo, não imposta: o agente escreve com o tom dele e encaixa a
 * pergunta na resposta que já ia dar, que é o que faz a conversa parecer conversa. O que
 * o sistema garante não é a redação — é que ela aconteça **uma vez só** (A-05) e que,
 * enquanto não houver resposta, nada seja adivinhado.
 */
export const PERGUNTA_DE_ESCOPO_SUGERIDA =
  'Pra eu te passar a informação certinha: seu plano é de qual operadora?';

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

interface LinhaDeEscopo {
  id: string;
  display_name: string;
  official_code: string | null;
  is_active: boolean;
  catalog_scope_id: string | null;
}

/**
 * Os escopos que este tenant enxerga — ligados e desligados.
 *
 * Os desligados vêm junto de propósito: eles são o insumo de FR-042 (a recusa que diz "a
 * resposta existe no produto e está a um clique") e o cliente pode nomear um deles. Filtrar
 * aqui por `is_active` esconderia exatamente o caso que A-20 criou.
 */
export async function carregarEscoposDoTenant(
  db: pg.Pool,
  tenantId: string,
): Promise<EscopoConhecido[]> {
  const { rows } = await db.query<LinhaDeEscopo>(
    `select id, display_name, official_code, is_active, catalog_scope_id
       from knowledge_scopes
      where organization_id = $1
      order by display_name`,
    [tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    officialCode: r.official_code,
    isActive: r.is_active,
    catalogScopeId: r.catalog_scope_id,
  }));
}

/** O vínculo do contato, com o nome do escopo já resolvido para o que vai à tela. */
export async function carregarVinculoDoContato(
  db: pg.Pool,
  tenantId: string,
  contactId: string,
): Promise<VinculoDeEscopo> {
  const { rows } = await db.query<{
    knowledge_scope_id: string | null;
    knowledge_scope_source: string | null;
    knowledge_scope_confirmed_at: Date | null;
    display_name: string | null;
  }>(
    `select c.knowledge_scope_id,
            c.knowledge_scope_source,
            c.knowledge_scope_confirmed_at,
            ks.display_name
       from contacts c
       left join knowledge_scopes ks
         on ks.id = c.knowledge_scope_id
        and ks.organization_id = c.organization_id
      where c.organization_id = $1 and c.id = $2`,
    [tenantId, contactId],
  );
  const r = rows[0];
  if (r === undefined) return VINCULO_DESCONHECIDO;
  const source = r.knowledge_scope_source;
  return {
    scopeId: r.knowledge_scope_id,
    displayName: r.display_name,
    // Valor fora do vocabulário (clone com dado torto) vira `null`, nunca explode: a
    // direção segura é "origem desconhecida", que só custa a precedência daquele contato.
    source: source === 'cadastro' || source === 'conversa' ? source : null,
    confirmedAt: r.knowledge_scope_confirmed_at,
  };
}

// ---------------------------------------------------------------------------
// Reconhecimento (o único caminho pelo qual a conversa cria vínculo)
// ---------------------------------------------------------------------------

/** Casa um nome com fronteira de palavra nos dois lados, sobre texto já normalizado. */
function contemNome(textoNormalizado: string, nome: string): boolean {
  const alvo = normalizarParaLexico(nome);
  if (alvo.length < 3) return false; // nome de duas letras casaria em qualquer lugar
  const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapado}(?![\\p{L}\\p{N}])`, 'u').test(textoNormalizado);
}

/**
 * Quais escopos cadastrados o texto NOMEIA — zero, um ou vários.
 *
 * Devolve todos os que casaram, sem escolher. Quem chama decide o que fazer com dois; a
 * escolha nunca acontece aqui, porque é aqui que ela viraria inferência.
 *
 * O único descarte é o de nome CONTIDO em outro que também casou ("Unimed" quando "Unimed
 * Nacional" casou na mesma frase). Isso não é escolher entre candidatos: o curto só casou
 * por ser pedaço do longo, e mantê-lo criaria uma ambiguidade que o cliente não criou.
 */
export function reconhecerEscoposNoTexto(
  texto: string,
  escopos: readonly EscopoConhecido[],
): EscopoConhecido[] {
  if (texto.trim() === '' || escopos.length === 0) return [];
  const normalizado = normalizarParaLexico(texto);

  const casados = escopos.filter(
    (e) =>
      contemNome(normalizado, e.displayName) ||
      (e.officialCode !== null && contemNome(normalizado, e.officialCode)),
  );
  if (casados.length < 2) return casados;

  const nomes = casados.map((e) => normalizarParaLexico(e.displayName));
  return casados.filter((e, i) => {
    const meu = nomes[i] ?? '';
    return !nomes.some((outro, j) => j !== i && outro.length > meu.length && outro.includes(meu));
  });
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * Grava o vínculo que o cliente declarou na conversa (FR-017, A-05).
 *
 * A precedência do cadastro é conferida **duas vezes**, e as duas são necessárias: aqui em
 * TypeScript, contra o vínculo que o turno já leu — é a camada que um teste consegue
 * exercitar sem banco —, e de novo na condição do `where`, que é a única que ganha a
 * corrida com uma edição de ficha acontecendo no mesmo instante. Tirar qualquer uma das
 * duas deixa a regra de pé no papel e frágil na prática.
 *
 * Devolve `true` quando o vínculo passou a existir/mudou; `false` quando o cadastro venceu
 * (ou o contato sumiu). O `false` não é erro — é a precedência funcionando.
 */
export async function gravarEscopoDaConversa(
  db: pg.Pool,
  tenantId: string,
  contactId: string,
  scopeId: string,
  vinculoAtual: VinculoDeEscopo,
): Promise<boolean> {
  // `cadastro` nunca é rebaixado — nem quando ele diz "sem operadora", que também é uma
  // decisão de cadastro e não uma lacuna a preencher.
  if (vinculoAtual.source === 'cadastro') return false;

  const { rowCount } = await db.query(
    `update contacts
        set knowledge_scope_id = $3,
            knowledge_scope_source = 'conversa',
            knowledge_scope_confirmed_at = now()
      where organization_id = $1
        and id = $2
        -- Cadastro NUNCA é rebaixado. Inclui o caso em que a ficha diz "sem operadora":
        -- isso também é uma decisão de cadastro, e não uma lacuna a preencher.
        and coalesce(knowledge_scope_source, '') <> 'cadastro'
        and knowledge_scope_id is distinct from $3`,
    [tenantId, contactId, scopeId],
  );
  return (rowCount ?? 0) > 0;
}

/** A pergunta de operadora já foi feita nesta conversa? (A-05) */
export async function escopoJaFoiPerguntado(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ em: string | null }>(
    `select metadata->>'${CHAVE_ESCOPO_PERGUNTADO}' as em
       from conversations
      where organization_id = $1 and id = $2`,
    [tenantId, conversationId],
  );
  return (rows[0]?.em ?? null) !== null;
}

/**
 * Marca que a pergunta foi feita. Idempotente: a segunda chamada não sobrescreve o
 * instante da primeira, para que "quando perguntamos" continue verdadeiro.
 */
export async function marcarEscopoPerguntado(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
): Promise<void> {
  await db.query(
    `update conversations
        set metadata = coalesce(metadata, '{}'::jsonb)
                       || jsonb_build_object('${CHAVE_ESCOPO_PERGUNTADO}', to_jsonb(now()))
      where organization_id = $1
        and id = $2
        and metadata->>'${CHAVE_ESCOPO_PERGUNTADO}' is null`,
    [tenantId, conversationId],
  );
}

// ---------------------------------------------------------------------------
// FR-042 · a resposta existe no produto e está desligada
// ---------------------------------------------------------------------------

/**
 * Operadoras do catálogo que **cobririam** o assunto e estão desligadas para este corretor.
 *
 * É o insumo de FR-042 (T137). Sem isto, a decisão A-20 ("tudo nasce desligado") produz o
 * pior desfecho possível da feature: o corretor conclui que o sistema não sabe, quando ele
 * sabe e ninguém o ligou.
 *
 * Dois caminhos, e a diferença entre eles é o que o turno tinha em mãos:
 *
 * - **Com o vetor da pergunta** (o caso normal — a busca já rodou e devolveu o embedding):
 *   pergunta ao catálogo quais trechos passariam do limiar, restrito a escopos que ESTE
 *   tenant espelha e mantém desligados. É a resposta literal de "cobriria o assunto".
 * - **Sem vetor** (o modelo afirmou sem buscar): resta o que o cliente NOMEOU. Honesto e
 *   estreito — nunca lista "todas as desligadas", que seria ruído disfarçado de ajuda.
 *
 * A leitura cruza a partição compartilhada (catálogo, sem tenant) com `knowledge_scopes`
 * filtrada por `organization_id` da ROW do job. Nenhum dado de outra organização entra ou
 * sai; o catálogo é legível por todas por desenho (trava 1 do Princípio X).
 */
export async function escoposDesligadosQueCobririam(
  db: pg.Pool,
  args: {
    tenantId: string;
    /** Vetor da pergunta, como `fn_buscar_lastro` o recebe. `null` = o turno não buscou. */
    embedding: string | null;
    threshold: number;
    /** Escopos que o cliente nomeou na mensagem — o caminho sem vetor. */
    mencionados?: readonly EscopoConhecido[];
    limite?: number;
  },
  log?: Logger,
): Promise<string[]> {
  const limite = args.limite ?? 3;
  const nomes: string[] = [];

  for (const e of args.mencionados ?? []) {
    if (e.catalogScopeId !== null && !e.isActive) nomes.push(e.displayName);
  }

  if (args.embedding !== null) {
    try {
      const { rows } = await db.query<{ display_name: string }>(
        `select distinct ks.display_name
           from catalog_chunks cc
           join catalog_materials cm
             on cm.id = cc.catalog_material_id
            and not cm.inert
            and (cm.valid_until is null or cm.valid_until >= current_date)
           join catalog_scopes cs
             on cs.id = cc.catalog_scope_id
            and cs.is_active
           join knowledge_scopes ks
             on ks.catalog_scope_id = cs.id
            and ks.organization_id = $1
          where not ks.is_active
            and (1 - (cc.embedding <=> $2::vector)) >= $3
          limit $4`,
        [args.tenantId, args.embedding, args.threshold, limite],
      );
      nomes.push(...rows.map((r) => r.display_name));
    } catch (err) {
      // Best-effort: o aviso ao corretor sai de qualquer jeito, só sem a linha do FR-042.
      // Derrubar a escalação para enriquecer o aviso seria trocar o essencial pelo útil.
      log?.warn('checagem de operadora desligada que cobriria o assunto falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  return [...new Set(nomes)].slice(0, limite);
}

// ---------------------------------------------------------------------------
// O bloco de prompt
// ---------------------------------------------------------------------------

/**
 * O que entra no sufixo do turno quando a operadora é desconhecida e ainda não foi
 * perguntada.
 *
 * Traz a lista de operadoras que o corretor atende porque, sem ela, o agente pergunta no
 * escuro e o cliente responde um nome que não existe no cadastro — e aí o vínculo não
 * nasce, a busca segue cega e ninguém entende por quê.
 *
 * A proibição de supor está escrita aqui **além** de estar no código. As duas camadas não
 * são redundância: o código impede o vínculo errado de ser gravado; o prompt impede o
 * modelo de AFIRMAR algo específico de uma operadora que ele supôs. A segunda é a que o
 * cliente sentiria.
 */
export function blocoDePerguntaDeEscopo(escopos: readonly EscopoConhecido[]): string {
  const ligados = escopos.filter((e) => e.isActive).map((e) => e.displayName);
  const listaLinha =
    ligados.length > 0
      ? `Operadoras que este corretor atende: ${ligados.join(', ')}.`
      : 'Este corretor ainda não marcou nenhuma operadora como atendida.';

  return [
    '## Você ainda não sabe de qual operadora é o plano deste cliente',
    `Pergunte UMA única vez, com naturalidade, dentro da mensagem que você já ia enviar — por exemplo: "${PERGUNTA_DE_ESCOPO_SUGERIDA}"`,
    'Não repita a pergunta em turnos seguintes. Se ele não responder, siga o atendimento sem insistir.',
    listaLinha,
    'NUNCA suponha a operadora: nem por ser a única da lista, nem por ser a mais comum, nem porque o que ele escreveu parece com um dos nomes. Enquanto ele não disser, você só pode afirmar o que vale para qualquer plano.',
  ].join('\n');
}
