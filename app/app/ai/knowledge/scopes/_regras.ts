/**
 * O que a tela de escopos DECIDE — separado do que ela desenha.
 *
 * Spec 002 (RAG por operadora), T068. Aqui moram o filtro da busca, os rótulos de origem e,
 * principalmente, **as frases**. Elas estão num módulo próprio por dois motivos:
 *
 * 1. São testáveis sem montar a árvore de componentes — `tests/unit/escopos-tela-regras.test.ts`
 *    varre TODO texto exportado daqui atrás de jargão nosso ("lastro", "chunk", "embedding",
 *    "escopo", "RAG"). O corretor não sabe o que é nenhuma dessas palavras, e uma tela que as
 *    usa não é uma tela difícil: é uma tela que ele fecha.
 * 2. O texto é onde a consequência de desligar aparece (FR-008). Deixá-lo espalhado em JSX
 *    faria a próxima pessoa "melhorar a cópia" sem saber que estava mexendo num requisito.
 *
 * ## A armadilha de gênero, e por que nenhuma frase daqui tem adjetivo concordando
 *
 * O rótulo da entidade é configurável (FR-033/FR-041): "Operadora" no nicho de validação,
 * "Convênio" numa clínica, "Fornecedor" numa distribuidora. Uma frase como "esta operadora
 * está desligada" vira erro de português na instalação que trocou o rótulo. Por isso as
 * frases falam do **nome próprio** ("Amil"), nunca do rótulo com artigo, pronome ou
 * adjetivo colado. É a mesma regra que o cabeçalho de `app/api/v1/knowledge-scopes/
 * _escopos.ts` impõe às mensagens de erro.
 */
import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";

// ---------------------------------------------------------------------------
// Vocabulário do contrato, ancorado no tipo
// ---------------------------------------------------------------------------

/**
 * Os dois valores de `origin`, anotados com o tipo do contrato em vez de escritos soltos.
 *
 * A constante de verdade é `ORIGEM`, em `_escopos.ts` — mas ela é valor de runtime num
 * módulo que importa `node:crypto` e `zod`, e puxá-lo para dentro do bundle do browser só
 * para comparar duas strings seria caro e desnecessário. A anotação é o que segura o
 * contrato: trocar por `"catálogo"` (com acento) ou `"catalog"` reprova o `typecheck` aqui,
 * no lugar de virar um badge errado que ninguém nota.
 */
export const ORIGEM_CATALOGO: EscopoDoTenant["origin"] = "catalogo";
export const ORIGEM_PROPRIA: EscopoDoTenant["origin"] = "proprio";

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * A partir de quantas linhas a caixa de busca aparece.
 *
 * Abaixo disso a lista inteira cabe na tela e um campo de busca é só mais uma coisa para
 * ler antes de achar o interruptor — que é o gesto que SC-011 cronometra.
 */
export const LIMIAR_DA_BUSCA = 8;

/**
 * Forma comparável de um texto, só para a busca da tela.
 *
 * Parece `nomeComparavel()` de `_escopos.ts` e NÃO é a mesma coisa: lá o objetivo é
 * **recusar duplicata** no contrato (e por isso vive no servidor, junto do 409); aqui é
 * deixar quem digita "sao" achar "São Francisco". Fundir as duas puxaria o módulo do
 * contrato inteiro para o browser e amarraria uma regra de negócio a um campo de filtro.
 */
function paraBusca(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Filtra por nome **e** por código oficial: num catálogo de saúde o corretor às vezes
 * conhece o registro na ANS e não o nome comercial exato.
 */
export function filtrarEscopos(
  escopos: readonly EscopoDoTenant[],
  termo: string,
): EscopoDoTenant[] {
  const alvo = paraBusca(termo);
  if (alvo === "") return [...escopos];
  return escopos.filter((e) => {
    const nome = paraBusca(e.display_name);
    const codigo = e.official_code ? paraBusca(e.official_code) : "";
    return nome.includes(alvo) || (codigo !== "" && codigo.includes(alvo));
  });
}

// ---------------------------------------------------------------------------
// Origem (FR-039)
// ---------------------------------------------------------------------------

/**
 * O badge de origem. FR-039 pede que o corretor saiba **a quem cobrar a correção** de um
 * material — e são pessoas diferentes nas duas camadas. "Catálogo curado" não diria isso a
 * ninguém; "Já vem no sistema" e "Você adicionou" dizem, e nenhum dos dois concorda em
 * gênero com o rótulo configurável.
 */
export function rotuloDaOrigem(origem: EscopoDoTenant["origin"]): string {
  return origem === ORIGEM_CATALOGO ? "Já vem no sistema" : "Você adicionou";
}

/**
 * Os DOIS caminhos que o corretor tem sobre o que veio pronto (T091, FR-008 e FR-035).
 *
 * O contrato responde `403 escopo_do_catalogo_nao_editavel` a quem tenta mudar o que é do
 * fabricante. Um 403 é a hora errada de descobrir isso: quem já clicou já formou a
 * expectativa, e a recusa depois do gesto é o que faz o usuário achar que o produto está
 * quebrado. Então a tela **diz antes**, permanentemente, na linha do próprio item — e diz
 * as duas saídas que existem, porque "não pode editar" sozinho é um beco:
 *
 *  1. **desligar** — o material fica inerte só para este tenant (FR-008);
 *  2. **sobrepor** — carregar material próprio, que **vence** o do catálogo quando os dois
 *     falam do mesmo assunto (FR-035, desempate por camada).
 *
 * A segunda é a que quase ninguém adivinharia sozinho, e é a que resolve o caso real:
 * "o telefone que veio aqui está errado para a minha regional".
 */
export const CAMINHOS_DO_CATALOGO =
  "O que já vem no sistema você não altera nem apaga. Tem dois caminhos: desligar aqui, ou carregar material seu — quando os dois falarem do mesmo assunto, vale o seu.";

/**
 * O link de ação da linha, e o texto dele.
 *
 * Três casos, em ordem de urgência:
 *
 *  - **ligado e sem material nenhum**: o pior estado da tela (o interruptor está certo e o
 *    agente continua sem ter o que dizer). O convite é seco: "Carregar material".
 *  - **veio do catálogo**: o caminho de sobreposição de `CAMINHOS_DO_CATALOGO` precisa de
 *    uma porta, senão continua sendo uma frase que ninguém sabe onde executar.
 *  - **próprio, já com material**: acrescentar mais é o gesto natural, e o link o encurta.
 *
 * O destino leva a operadora no endereço para o formulário do outro lado já vir com ela
 * escolhida — a alternativa é o corretor chegar lá e ter de lembrar de onde veio.
 */
export function acaoDeMaterial(escopo: EscopoDoTenant): { texto: string; href: string } {
  const href = `/app/ai/knowledge/sources?escopo=${escopo.id}`;
  if (escopo.is_active && escopo.materials_count === 0) {
    return { texto: "Carregar material", href };
  }
  if (escopo.origin === ORIGEM_CATALOGO) {
    return { texto: `Carregar material seu sobre ${escopo.display_name}`, href };
  }
  return { texto: `Carregar mais material sobre ${escopo.display_name}`, href };
}

// ---------------------------------------------------------------------------
// As frases
// ---------------------------------------------------------------------------

function materiais(n: number): string {
  return n === 1 ? "1 material" : `${n} materiais`;
}

/**
 * A linha de apoio de cada item — o lugar onde a consequência de desligar aparece de forma
 * permanente, e não só num aviso que some em 4 segundos (FR-008).
 *
 * Os quatro estados são frases diferentes de propósito. "Ligado, mas sem material" é o mais
 * importante deles: é o único em que o interruptor está do jeito certo e o agente ainda
 * assim não vai responder — e sem dizê-lo o corretor conclui que o produto não funciona.
 */
export function explicacaoDoEstado(escopo: EscopoDoTenant): string {
  const nome = escopo.display_name;
  const n = escopo.materials_count;

  if (escopo.is_active) {
    return n === 0
      ? `Ligado, mas ainda sem material: o agente não tem o que responder sobre ${nome}.`
      : `O agente responde sobre ${nome} usando ${materiais(n)}.`;
  }
  return n === 0
    ? `Desligado: o agente não responde sobre ${nome}.`
    : `Desligado: o agente não responde sobre ${nome}. ${
        n === 1 ? "O material continua salvo" : `Os ${n} materiais continuam salvos`
      }.`;
}

/**
 * O aviso depois do clique. Ele existe porque desligar tem consequência de atendimento e o
 * interruptor sozinho não a comunica — mas é AVISO, não confirmação: pedir "tem certeza?"
 * transformaria um passo em dois, e é justamente o passo que SC-011 mede.
 */
export function avisoDeAlternancia(nome: string, ligado: boolean): string {
  return ligado
    ? `Pronto. O agente já pode responder sobre ${nome}.`
    : `O agente parou de responder sobre ${nome}. O material continua salvo — é só ligar de novo quando quiser.`;
}

/** O nome acessível do interruptor. É por ele que o teste e o leitor de tela o encontram. */
export function rotuloDoInterruptor(escopo: EscopoDoTenant): string {
  return escopo.is_active ? `Desligar ${escopo.display_name}` : `Ligar ${escopo.display_name}`;
}

// ---------------------------------------------------------------------------
// Texto fixo da tela
// ---------------------------------------------------------------------------

/**
 * A instrução de uma linha. É a tradução de A-20 ("todos inativos, ele liga o que vende")
 * para quem chega numa instalação nova e vê tudo desligado sem saber por quê.
 */
export const SUBTITULO =
  "Ligue o que você vende. O agente só responde sobre o que estiver ligado aqui — o resto continua salvo, e ele não usa.";

/** A legenda que fecha FR-039: os dois badges, e de quem é a responsabilidade em cada um. */
export const LEGENDA_DE_ORIGEM =
  "“Já vem no sistema” é o conteúdo que acompanha o produto, mantido por quem cuida dele. “Você adicionou” é o seu material, e quem corrige é você.";

export const VAZIO_TITULO = "Nada por aqui ainda";

export const VAZIO_TEXTO =
  "A instalação não trouxe nada pronto, e você também não adicionou nada. Comece carregando um material em Conhecimento — o que você carregar aparece aqui para ligar e desligar.";

export const SEM_RESULTADO = "Nenhum resultado para o que você digitou.";

/**
 * O aviso do teto de SEGURANÇA — não de um limite de produto. Ver `TETO_DE_SEGURANCA`.
 *
 * A frase anterior mandava usar a busca para chegar aos demais, e isso era mentira: a
 * busca filtra o que já veio, então o que ficou de fora da leitura não aparecia por
 * nenhum caminho. Aviso que aponta uma saída inexistente é pior que aviso nenhum.
 */
export const LISTA_TRUNCADA =
  "A lista ficou grande demais para mostrar de uma vez. O que está aqui são os primeiros, em ordem alfabética — avise o suporte se faltar algum.";

/**
 * Toda frase que esta tela mostra, num lugar só — é o que o teste de jargão varre.
 * Frase nova que não entre aqui não é vigiada; frase nova que entre e traga jargão nosso
 * reprova antes de chegar na tela do corretor.
 */
export const TEXTO_FIXO_DA_TELA: readonly string[] = [
  SUBTITULO,
  LEGENDA_DE_ORIGEM,
  CAMINHOS_DO_CATALOGO,
  VAZIO_TITULO,
  VAZIO_TEXTO,
  SEM_RESULTADO,
  LISTA_TRUNCADA,
];

// ---------------------------------------------------------------------------
// Leitura da lista (T100 — N operadoras, sem teto de tela)
// ---------------------------------------------------------------------------

/**
 * Quantas linhas cada leitura traz. Não é o teto da tela: é o tamanho do balde.
 *
 * A página lê em lotes e **continua lendo enquanto vier lote cheio**, de modo que o
 * número de operadoras que cabem na tela é o número que existe no banco (FR-003, US4
 * cenário 3). Até T100 a página fazia UMA leitura de 200 e avisava que tinha cortado —
 * o corretor com a operadora 201 simplesmente não a via, e a busca não a alcançava porque
 * ela nunca tinha chegado ao browser.
 */
export const TAMANHO_DA_LEITURA = 200;

/**
 * Onde a leitura para, aconteça o que acontecer.
 *
 * Não é limite de produto — é o que impede um defeito de paginação (ou uma tabela que
 * cresceu sem ninguém olhar) de virar uma página que nunca termina de carregar. Quando
 * ele é atingido a tela **diz** (`LISTA_TRUNCADA`); silêncio aqui seria a mesma falha
 * silenciosa que a feature inteira existe para eliminar.
 */
export const TETO_DE_SEGURANCA = 5_000;

/** A faixa (`.range()`) de uma leitura, contando de zero. */
export function faixaDaLeitura(pagina: number): { de: number; ate: number } {
  const de = pagina * TAMANHO_DA_LEITURA;
  return { de, ate: de + TAMANHO_DA_LEITURA - 1 };
}

/**
 * Continua lendo? Sim enquanto o último lote veio CHEIO — lote cheio significa que pode
 * haver mais — e enquanto o teto de segurança não foi alcançado.
 */
export function deveLerMais(recebidosNaUltimaLeitura: number, totalLido: number): boolean {
  if (recebidosNaUltimaLeitura < TAMANHO_DA_LEITURA) return false;
  return totalLido < TETO_DE_SEGURANCA;
}
