/**
 * Léxico de "afirmação de assistência" — spec 002 (RAG por operadora), FR-009/FR-010.
 *
 * Existe para que a classificação seja DETERMINÍSTICA e feita num lugar só. O
 * princípio IX separa as duas missões do agente: **vender** (qualificar, conduzir,
 * fechar) e **assistir** (explicar procedimento de operadora ao cliente que já tem
 * plano). Só a segunda exige lastro no acervo — a primeira continua livre (FR-020).
 *
 * **Por que não perguntar ao modelo.** FR-010: "instrução de prompt NÃO satisfaz este
 * requisito". Um classificador que é o próprio modelo herda a falha que o gate existe
 * para barrar — quem alucina o procedimento alucina também a classificação dele. Aqui é
 * casamento de termo, e o teste de sabotagem consegue provar que ele vigia.
 *
 * **Viés declarado (A-03): na dúvida, é assistência.** O erro de classificar conversão
 * como assistência custa uma recusa desnecessária, que o corretor vê na Central e
 * corrige. O erro contrário custa uma informação errada sobre carência ou cobertura
 * entregue a um cliente, que ninguém vê. Os dois erros não têm o mesmo peso, então o
 * desempate é sempre para o lado caro de desfazer, nunca para o caro de descobrir.
 *
 * **O que este arquivo NÃO é**: uma lista de palavras proibidas. Termo daqui numa
 * PERGUNTA do agente ("de qual operadora é o seu plano?") não é afirmação — quem decide
 * isso é `assistance-grounding.ts`, lendo a forma da frase. Aqui só vive o vocabulário.
 */

/** Categorias fechadas — vão ao trace de auditoria, os termos casados nunca vão (podem ser PII). */
export type CategoriaAssistencia =
  | 'cobranca'
  | 'acesso'
  | 'rede'
  | 'cobertura'
  | 'prazos'
  | 'canais'
  | 'regras';

/**
 * Termos por categoria, em minúsculas e SEM acento — a comparação normaliza os dois
 * lados. Cada entrada é casada com fronteira de palavra, então "guia" não casa em
 * "seguia" e "rede" não casa em "aprendendo".
 */
export const LEXICO_ASSISTENCIA: Readonly<Record<CategoriaAssistencia, readonly string[]>> = {
  // Cobrança e segunda via — o caso que abre a spec ("perdi meu boleto").
  cobranca: [
    'boleto',
    'segunda via',
    '2a via',
    'fatura',
    'mensalidade',
    'cobranca',
    'pagamento em atraso',
    'linha digitavel',
    'codigo de barras',
    'reembolso',
    'coparticipacao',
  ],
  // Acesso a documento e identificação do beneficiário.
  acesso: [
    'carteirinha',
    'cartao do plano',
    'numero da carteira',
    'login do beneficiario',
    'area do beneficiario',
    'portal do beneficiario',
    'aplicativo do plano',
  ],
  // Rede credenciada — onde ser atendido.
  rede: [
    'rede credenciada',
    'rede referenciada',
    'hospital credenciado',
    'clinica credenciada',
    'laboratorio credenciado',
    'medico credenciado',
    'esta credenciado',
    'atende pelo plano',
  ],
  // O que o plano cobre.
  cobertura: [
    'cobertura',
    'coberto pelo plano',
    'esta coberto',
    'rol da ans',
    'procedimento coberto',
    'exame coberto',
    'internacao',
    'urgencia e emergencia',
  ],
  // Tempo — carência é o campeão de dano quando errado.
  prazos: [
    'carencia',
    'prazo de carencia',
    'cpt',
    'cobertura parcial temporaria',
    'prazo de autorizacao',
    'prazo de analise',
    'vigencia',
  ],
  // Por onde o cliente resolve.
  canais: [
    'central de atendimento',
    'sac do plano',
    'telefone da operadora',
    'protocolo de atendimento',
    'ouvidoria',
    'canal de autorizacao',
  ],
  // Regras de uso do contrato.
  regras: [
    'autorizacao previa',
    'guia de autorizacao',
    'portabilidade',
    'portabilidade de carencia',
    'cancelamento do plano',
    'exclusao de dependente',
    'inclusao de dependente',
    'reajuste',
    'titular do plano',
    'dependente do plano',
  ],
} as const;

/** Normaliza para a comparação: minúsculas, sem acento, espaços colapsados. */
export function normalizarParaLexico(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Casa um termo com fronteira de palavra nos dois lados. `escapeRegExp` é necessário
 * porque termos futuros podem trazer ponto ou parêntese; hoje nenhum traz, e é
 * exatamente por isso que a proteção entra agora — depois ninguém lembra.
 */
function contemTermo(textoNormalizado: string, termo: string): boolean {
  const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapado}(?![\\p{L}\\p{N}])`, 'u').test(textoNormalizado);
}

export interface AchadoDeAssistencia {
  /** Alguma categoria bateu. */
  readonly achou: boolean;
  /** Categorias que bateram — fechadas, seguras para log e para o trace. */
  readonly categorias: readonly CategoriaAssistencia[];
  /** Quantos termos distintos bateram. Contagem, nunca os termos (podem ser PII). */
  readonly quantidade: number;
}

/**
 * Procura vocabulário de assistência no texto. **Não decide** se é afirmação — só diz
 * que o assunto está em jogo. A decisão é de `assistance-grounding.ts`, que soma isto
 * à forma da frase.
 */
export function detectarAssuntoDeAssistencia(texto: string): AchadoDeAssistencia {
  const normalizado = normalizarParaLexico(texto);
  const categorias: CategoriaAssistencia[] = [];
  let quantidade = 0;

  for (const [categoria, termos] of Object.entries(LEXICO_ASSISTENCIA) as [
    CategoriaAssistencia,
    readonly string[],
  ][]) {
    let bateuNaCategoria = false;
    for (const termo of termos) {
      if (contemTermo(normalizado, termo)) {
        quantidade += 1;
        bateuNaCategoria = true;
      }
    }
    if (bateuNaCategoria) categorias.push(categoria);
  }

  return { achou: categorias.length > 0, categorias, quantidade };
}
