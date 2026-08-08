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

/** O aviso do teto de leitura. Ver o comentário do `LIMITE_DA_TELA` em `page.tsx`. */
export const LISTA_TRUNCADA =
  "A lista está mostrando os primeiros itens em ordem alfabética. Use a busca para chegar aos demais.";

/**
 * Toda frase que esta tela mostra, num lugar só — é o que o teste de jargão varre.
 * Frase nova que não entre aqui não é vigiada; frase nova que entre e traga jargão nosso
 * reprova antes de chegar na tela do corretor.
 */
export const TEXTO_FIXO_DA_TELA: readonly string[] = [
  SUBTITULO,
  LEGENDA_DE_ORIGEM,
  VAZIO_TITULO,
  VAZIO_TEXTO,
  SEM_RESULTADO,
  LISTA_TRUNCADA,
];
