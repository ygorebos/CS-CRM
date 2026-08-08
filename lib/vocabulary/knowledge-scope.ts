/**
 * O rótulo do **escopo de conhecimento** — spec 002, FR-033 e FR-041.
 *
 * ## A regra que este módulo existe para sustentar
 *
 * O nome estrutural é *escopo de conhecimento*. "Operadora" é o rótulo que o nicho de
 * validação (corretor de plano de saúde) exibe na tela. **Schema e contrato de API são
 * neutros de nicho; tela e rótulo carregam o vocabulário.** Uma clínica com convênios e
 * uma distribuidora com fornecedores usam o mesmo mecanismo com outro nome, sem tocar em
 * schema, migration ou rota — FR-041 diz que a estrutura NÃO PODE assumir o recorte.
 *
 * A revisão de brechas do plano já tinha achado a versão anterior deste erro: a entidade
 * ia se chamar `operadoras` no banco. Barato de consertar antes do código escrito, caro
 * depois — e é o mesmo raciocínio que faz este módulo existir agora, antes da primeira
 * tela.
 *
 * ## Por que não reusar `pipelines.vocabulary`
 *
 * O produto já tem vocabulário configurável, e a doutrina manda procurar antes de
 * escrever ("Reusar antes de escrever", Papéis, Ritmo e Método). Foi procurado:
 * `PipelineVocabulary` (`lib/kanban/types.ts`) renomeia **lead/deal/won/lost** e vive
 * **por pipeline**, porque um mesmo tenant pode ter um funil de vendas e outro de
 * pós-venda com nomes diferentes.
 *
 * O escopo de conhecimento não é dessa família: ele é da **instalação**, não do funil. Um
 * corretor com três pipelines chama "operadora" de operadora nos três. Pendurá-lo no
 * pipeline obrigaria a escolher um pipeline arbitrário para responder "como este produto
 * chama isso?" — e faria a tela de conhecimento depender de uma entidade com a qual ela
 * não tem relação nenhuma. Duas fontes, dois escopos de vida, e nenhuma duplicação: são
 * vocabulários de coisas diferentes.
 */

/** O rótulo, nas formas que a tela precisa. */
export interface RotuloDoEscopo {
  /** Singular, como em "Operadora". */
  readonly singular: string;
  /** Plural, como em "Operadoras". */
  readonly plural: string;
}

/**
 * O padrão do nicho de validação. É valor de fábrica, não constante gravada: quem instala
 * para outro nicho troca sem release.
 */
export const ROTULO_PADRAO: RotuloDoEscopo = {
  singular: 'Operadora',
  plural: 'Operadoras',
};

/** Onde o rótulo vive dentro de `organizations.settings` (jsonb). */
export const CHAVE_DE_SETTINGS = 'knowledge_scope_label';

/**
 * Resolve o rótulo a partir de `organizations.settings`.
 *
 * Recebe `unknown` porque a origem é jsonb: settings de um clone antigo pode ter qualquer
 * coisa nesta chave, e o modo de falha certo é **cair no padrão**, nunca quebrar a tela
 * de conhecimento por causa de um valor torto.
 *
 * Plural ausente com singular presente é o caso comum de quem configurou pela metade:
 * derivar `${singular}s` acerta em português para "Convênio", "Fornecedor" e
 * "Operadora", e quem tiver um plural irregular declara os dois.
 */
export function resolverRotuloDoEscopo(settings: unknown): RotuloDoEscopo {
  if (typeof settings !== 'object' || settings === null) return ROTULO_PADRAO;
  const bruto = (settings as Record<string, unknown>)[CHAVE_DE_SETTINGS];
  if (typeof bruto === 'string') {
    const singular = bruto.trim();
    return singular === '' ? ROTULO_PADRAO : { singular, plural: `${singular}s` };
  }
  if (typeof bruto !== 'object' || bruto === null) return ROTULO_PADRAO;

  const obj = bruto as Record<string, unknown>;
  const singular = typeof obj.singular === 'string' ? obj.singular.trim() : '';
  const plural = typeof obj.plural === 'string' ? obj.plural.trim() : '';
  if (singular === '' && plural === '') return ROTULO_PADRAO;
  if (singular === '') return { singular: ROTULO_PADRAO.singular, plural };
  return { singular, plural: plural === '' ? `${singular}s` : plural };
}
