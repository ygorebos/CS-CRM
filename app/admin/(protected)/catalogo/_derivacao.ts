/**
 * As contas que a tela de curadoria faz — todas puras, todas testáveis sem browser.
 *
 * Spec 002 (RAG por operadora), T066.
 *
 * ═══ POR QUE ISTO NÃO MORA DENTRO DO COMPONENTE ═══
 *
 * Duas das contas aqui repetem, em TypeScript, regras que o banco já aplica:
 *
 *  · `versaoVigente` repete o recorte de `fn_buscar_lastro` (migration 0120): por slug,
 *    apenas a MAIOR versão não-inerte responde. Se a tela usasse outro critério (a mais
 *    recente por data, por exemplo), ela mostraria como "valendo" uma versão que o agente
 *    não usa — e o curador corrigiria o material errado, sem nada ficar vermelho.
 *  · `proximaVersao` repete `maiorVersao` (`app/api/v1/catalog/_materiais.ts`): a versão
 *    nova sai do TOPO da pilha, inertes inclusive, e não da versão que o curador abriu.
 *    O rótulo do botão diz o número; errá-lo faria a tela prometer uma coisa e a rota
 *    gravar outra.
 *
 * Duplicação de regra é sempre uma dívida; esta é declarada e vigiada por
 * `tests/unit/catalogo-tela-derivacao.test.ts`, que é a única razão de estas funções serem
 * um módulo em vez de três `map` dentro do JSX.
 */
import type { MaterialResumido } from "./_tipos";

// ---------------------------------------------------------------------------
// Versões de um mesmo assunto
// ---------------------------------------------------------------------------

/** O papel de uma versão dentro do assunto dela. É o que vira etiqueta na tela. */
export type PapelDaVersao =
  /** É esta que o agente usa para responder hoje. */
  | "vigente"
  /** Chegou na atualização depois da adoção local e espera a decisão do curador. */
  | "aguardando"
  /** Já foi vigente; ficou guardada. */
  | "historico";

export interface GrupoDeMaterial {
  slug: string;
  /** Título da versão vigente — é por ele que o curador reconhece o assunto na lista. */
  titulo: string;
  /** Todas as versões, da mais nova para a mais antiga. */
  versoes: MaterialResumido[];
  /**
   * A versão que responde hoje. `null` no caso extremo em que TODAS as versões do slug
   * são inertes — que o banco não produz sozinho, mas a tela não pode explodir se vier.
   */
  vigente: MaterialResumido | null;
  /** Versões inertes: chegaram na atualização e ainda não foram aceitas nem descartadas. */
  aguardando: MaterialResumido[];
  /** Esta instalação já escreveu alguma versão deste assunto. */
  adotado: boolean;
  /** Número que a PRÓXIMA versão publicada vai receber. */
  proximaVersao: number;
}

/**
 * A versão que o agente usa: maior `version` entre as NÃO inertes.
 *
 * Espelha `fn_buscar_lastro` (0120): `where not inert ... distinct on (slug) order by
 * version desc`. Data de publicação não entra — o desempate é por número de versão, e uma
 * versão semeada pode chegar com `published_at` mais novo e `version` menor.
 */
export function versaoVigente(versoes: readonly MaterialResumido[]): MaterialResumido | null {
  let melhor: MaterialResumido | null = null;
  for (const v of versoes) {
    if (v.inert) continue;
    if (!melhor || v.version > melhor.version) melhor = v;
  }
  return melhor;
}

/**
 * O número que a próxima versão vai receber: maior versão + 1, contando as inertes.
 *
 * Inertes contam porque `unique (slug, version)` não sabe o que é inércia — ignorá-las
 * faria a tela anunciar um número que o INSERT recusaria justamente na instalação que já
 * recebeu versão nova depois de adotar o slug.
 */
export function proximaVersao(versoes: readonly MaterialResumido[]): number {
  let maior = 0;
  for (const v of versoes) if (v.version > maior) maior = v.version;
  return maior + 1;
}

/** O papel de uma versão específica dentro do grupo dela. */
export function papelDaVersao(
  versao: MaterialResumido,
  versoes: readonly MaterialResumido[],
): PapelDaVersao {
  if (versao.inert) return "aguardando";
  const vigente = versaoVigente(versoes);
  return vigente && vigente.id === versao.id ? "vigente" : "historico";
}

/**
 * Junta as linhas soltas que a API devolve em um card por assunto.
 *
 * Ordem dos grupos: quem PRECISA DE DECISÃO primeiro (tem versão esperando), depois em
 * ordem alfabética de slug. Uma versão inerte que ninguém vê é release perdida em
 * silêncio — se ela ficasse enterrada na ordem alfabética, a coluna `inert` teria sido
 * gravada à toa.
 */
export function agruparPorSlug(materiais: readonly MaterialResumido[]): GrupoDeMaterial[] {
  const porSlug = new Map<string, MaterialResumido[]>();
  for (const m of materiais) {
    const lista = porSlug.get(m.slug);
    if (lista) lista.push(m);
    else porSlug.set(m.slug, [m]);
  }

  const grupos: GrupoDeMaterial[] = [];
  for (const [slug, lista] of porSlug) {
    const versoes = [...lista].sort((a, b) => b.version - a.version);
    const vigente = versaoVigente(versoes);
    grupos.push({
      slug,
      titulo: vigente?.title ?? versoes[0]?.title ?? slug,
      versoes,
      vigente,
      aguardando: versoes.filter((v) => v.inert),
      adotado: versoes.some((v) => v.adopted_at !== null),
      proximaVersao: proximaVersao(versoes),
    });
  }

  return grupos.sort((a, b) => {
    const pesoA = a.aguardando.length > 0 ? 0 : 1;
    const pesoB = b.aguardando.length > 0 ? 0 : 1;
    if (pesoA !== pesoB) return pesoA - pesoB;
    return a.slug.localeCompare(b.slug, "pt-BR");
  });
}

/** Quantos assuntos têm versão esperando decisão. Vira o aviso do topo da tela. */
export function contarAguardando(grupos: readonly GrupoDeMaterial[]): number {
  return grupos.reduce((total, g) => total + (g.aguardando.length > 0 ? 1 : 0), 0);
}

// ---------------------------------------------------------------------------
// Datas e validade
// ---------------------------------------------------------------------------

/**
 * Hoje em `AAAA-MM-DD`, no fuso de quem está olhando.
 *
 * `toISOString().slice(0, 10)` daria a data em UTC — no Brasil isso faz um material
 * vencer três horas antes da meia-noite, na tela de quem está trabalhando.
 */
export function hojeLocal(agora: Date = new Date()): string {
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const dia = String(agora.getDate()).padStart(2, "0");
  return `${agora.getFullYear()}-${mes}-${dia}`;
}

export type EstadoDeValidade = "sem-prazo" | "vigente" | "vence-em-breve" | "vencido";

export interface RotuloDeValidade {
  estado: EstadoDeValidade;
  texto: string;
}

/** A partir de quantos dias do vencimento a tela começa a avisar. */
export const DIAS_DE_AVISO_DE_VALIDADE = 30;

/**
 * "Vale até", "vence em breve" ou "venceu" — em texto, para o card.
 *
 * A comparação é entre STRINGS `AAAA-MM-DD`, que ordenam lexicograficamente igual a
 * cronologicamente. Virar `Date` aqui reintroduziria o fuso pela porta dos fundos:
 * `new Date("2026-02-03")` é meia-noite em UTC, não no fuso de quem lê.
 */
export function rotuloDeValidade(
  validUntil: string | null,
  hoje: string = hojeLocal(),
): RotuloDeValidade {
  if (!validUntil) return { estado: "sem-prazo", texto: "Sem prazo de validade" };
  if (validUntil < hoje) return { estado: "vencido", texto: `Venceu em ${formatarDia(validUntil)}` };

  const dias = diasEntre(hoje, validUntil);
  if (dias <= DIAS_DE_AVISO_DE_VALIDADE) {
    return {
      estado: "vence-em-breve",
      texto: dias === 0 ? "Vence hoje" : `Vence em ${dias} dia${dias === 1 ? "" : "s"}`,
    };
  }
  return { estado: "vigente", texto: `Vale até ${formatarDia(validUntil)}` };
}

/** Dias inteiros entre duas datas `AAAA-MM-DD`. Ambas tratadas como UTC — o fuso se cancela. */
export function diasEntre(de: string, ate: string): number {
  const MS_DIA = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / MS_DIA);
}

/** `2026-02-03` → `03/02/2026`. Sem `Date` no meio, sem fuso para errar. */
export function formatarDia(data: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data);
  if (!partes) return data;
  return `${partes[3]}/${partes[2]}/${partes[1]}`;
}

/** Carimbo ISO → `03/02/2026 às 14:30`. Devolve traço quando não há data. */
export function formatarInstante(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const data = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${data} às ${hora}`;
}

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------

/** De onde a versão veio, em português de gente. */
export function origemLegivel(origin: string): string {
  if (origin === "local") return "Escrito nesta instalação";
  if (origin === "seed") return "Veio com o produto";
  return origin;
}

/** Tamanho do texto do material, para a lista dizer "material vazio" sem baixar o texto. */
export function formatarTamanho(caracteres: number): string {
  if (caracteres <= 0) return "sem texto";
  if (caracteres < 1000) return `${caracteres} caracteres`;
  return `${(caracteres / 1000).toFixed(1).replace(".", ",")} mil caracteres`;
}

/** Plural sem gambiarra de template no meio do JSX. */
export function plural(n: number, singular: string, pluralForma: string): string {
  return `${n} ${n === 1 ? singular : pluralForma}`;
}
