/**
 * O que a tela de materiais DECIDE — separado do que ela desenha.
 *
 * Spec 002 (RAG por operadora), T090 e T118.
 *
 * ## Por que isto não mora dentro do JSX
 *
 * A pergunta que esta tela responde é uma só: **este material responde alguma coisa hoje?**
 * FR-004 e FR-005 dizem que ela precisa ser respondida sem ambiguidade, material por
 * material, e que "aceito e descartado em silêncio" é o pior desfecho possível — foi
 * medido: um PDF sobe, a tela devolve 201 e o conteúdo nunca vira trecho buscável
 * (spec, seção 5). Regra dessa importância dentro de um `map` no JSX não tem teste; aqui
 * tem, em `_regras.test.ts`, inclusive o caso que ninguém escreveria de propósito —
 * material `pronto` com **zero** trechos, que é exatamente o defeito que a spec descreve.
 *
 * ## As frases também moram aqui
 *
 * Mesma razão da tela vizinha (`../scopes/_regras.ts`): o teste varre TODO texto exportado
 * daqui atrás de jargão nosso ("trecho" pode, "chunk"/"indexar"/"embedding" não) e atrás de
 * adjetivo concordando com o rótulo configurável — "Operadora" é feminino, "Convênio" e
 * "Fornecedor" não são, e uma frase com "esta"/"desligada" vira erro de português na
 * instalação que trocou o rótulo (FR-033/FR-041).
 */
import { hojeLocal, rotuloDeValidade } from "@/app/admin/(protected)/catalogo/_derivacao";
import type { RotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

// ---------------------------------------------------------------------------
// Formas
// ---------------------------------------------------------------------------

/**
 * O material como a tela precisa dele — subconjunto das colunas de
 * `ai_knowledge_sources` (migrations 0118 e anteriores).
 *
 * Declarado aqui, e não importado da rota, porque `GET /api/v1/knowledge-scopes/{id}/materials`
 * é de outra fatia: a tela lê do banco na própria página (mesmo padrão de `../scopes/page.tsx`)
 * e não pode ficar de pé só quando aquela rota existir. Os nomes são os das colunas de
 * propósito — assim o dia em que a leitura passar pela rota é uma troca de origem, não de
 * vocabulário.
 */
export interface MaterialDoCorretor {
  id: string;
  name: string;
  /** A operadora a que ele se aplica. Nulo quando `applies_to_all`. */
  scope_id: string | null;
  applies_to_all: boolean;
  /** `ready | building | failed | archived` (CHECK em `ai_knowledge_sources_status_check`). */
  status: string;
  /** Quantos trechos buscáveis ele gerou. É a prova de FR-004. */
  chunks_count: number;
  /** `success | failed` — o que a última rodada do processamento gravou. */
  last_index_status: string | null;
  last_index_error: string | null;
  last_indexed_at: string | null;
  /** Validade opcional (FR-025). Nulo = não vence. */
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
}

/**
 * O escopo como a tela precisa dele. `EscopoDoTenant` (o objeto do contrato) satisfaz esta
 * forma inteira — o recorte existe só para a página não ter de inventar contagens que ela
 * já obtém agrupando os materiais que leu.
 */
export interface EscopoNaTela {
  id: string;
  display_name: string;
  origin: "catalogo" | "proprio";
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// O estado de um material (FR-004, FR-005)
// ---------------------------------------------------------------------------

export type SituacaoDoMaterial =
  /** Aceito, ainda virando trecho buscável. Normal, e passageiro. */
  | "processando"
  /** Aceito há tempo demais e ainda sem trecho nenhum. Não é normal. */
  | "parado"
  /** Tem trecho, está no prazo: o agente responde com ele. */
  | "pronto"
  /** Terminou o processamento e não gerou trecho nenhum. O defeito que FR-004 proíbe. */
  | "sem-trecho"
  /** Tem trecho, mas a validade passou — não ancora mais nada (FR-026). */
  | "vencido"
  /** O processamento falhou, com motivo. */
  | "falhou"
  /** Guardado pelo corretor: continua salvo e o agente não usa. */
  | "guardado";

export interface DiagnosticoDeMaterial {
  estado: SituacaoDoMaterial;
  /** O texto da etiqueta. */
  rotulo: string;
  /** A variante do `Badge` do design system. */
  tom: "success" | "warning" | "error" | "neutral" | "info";
  /** A frase de apoio — o que está acontecendo, em português de gente. */
  explicacao: string;
  /** O próximo passo, quando existe um. */
  oQueFazer: string | null;
  /**
   * Precisa da atenção do corretor. É o que faz a tela contar "2 precisam de atenção" e o
   * que impede um material sem conteúdo buscável de se passar por sucesso (FR-004).
   */
  ehProblema: boolean;
  /** O agente consegue responder com ele agora. */
  respondeHoje: boolean;
}

/**
 * Quanto tempo um material pode ficar "processando" antes de a tela parar de chamar isso
 * de normal.
 *
 * O processamento é assíncrono (worker + fila), então um material recém-carregado
 * legitimamente passa alguns instantes sem trecho. O que não pode é ficar assim para
 * sempre: sem este corte, um worker parado vira uma tela que diz "processando" por três
 * dias, e o corretor conclui que o produto é lento em vez de descobrir que algo quebrou.
 * Quinze minutos é folgado para uma fila saudável e curto para quem está esperando.
 */
export const MINUTOS_ATE_ESTRANHAR = 15;

function trechos(n: number): string {
  return n === 1 ? "1 trecho" : `${n} trechos`;
}

/**
 * O estado de um material, em uma função pura.
 *
 * A ORDEM das perguntas é a regra, e não é arbitrária:
 *
 * 1. **Guardado** vem antes de tudo: material desligado não é problema de ninguém, é uma
 *    decisão do corretor, e sinalizá-lo de vermelho ensinaria a ignorar o vermelho.
 * 2. **Falhou** vem antes de "sem trecho" porque, quando há motivo gravado, dizer o motivo
 *    é mais acionável do que dizer o sintoma.
 * 3. **Processando** só vale enquanto nada foi processado ainda E o material é recente.
 * 4. **Sem trecho** é o coração de FR-004: processou, não falhou, e mesmo assim não gerou
 *    nada buscável. Este é o estado que a tela antiga mostrava como "salvo".
 * 5. **Vencido** vem depois: só faz sentido para material que de fato tem conteúdo.
 */
export function situacaoDoMaterial(
  material: MaterialDoCorretor,
  agora: Date = new Date(),
): DiagnosticoDeMaterial {
  const nome = material.name;

  if (!material.is_active || material.status === "archived") {
    return {
      estado: "guardado",
      rotulo: "Guardado",
      tom: "neutral",
      explicacao: `Continua salvo, e o agente não usa ${nome} para responder.`,
      oQueFazer: null,
      ehProblema: false,
      respondeHoje: false,
    };
  }

  const falhou = material.status === "failed" || material.last_index_status === "failed";
  if (falhou) {
    return {
      estado: "falhou",
      rotulo: "Não deu certo",
      tom: "error",
      explicacao: motivoDaFalha(material),
      oQueFazer:
        "Tente de novo. Se repetir, revise o conteúdo — texto solto costuma passar melhor que tabela ou imagem colada.",
      ehProblema: true,
      respondeHoje: false,
    };
  }

  const nuncaProcessado = material.last_indexed_at === null && material.chunks_count === 0;
  if (nuncaProcessado) {
    const minutos = minutosDesde(material.created_at, agora);
    if (minutos !== null && minutos >= MINUTOS_ATE_ESTRANHAR) {
      return {
        estado: "parado",
        rotulo: "Parado na fila",
        tom: "warning",
        explicacao: `Faz mais de ${MINUTOS_ATE_ESTRANHAR} minutos que ${nome} espera para ficar pronto, e nada aconteceu.`,
        oQueFazer: "Tente de novo. Se continuar parado, avise o suporte — não é o esperado.",
        ehProblema: true,
        respondeHoje: false,
      };
    }
    return {
      estado: "processando",
      rotulo: "Preparando",
      tom: "info",
      explicacao: `Recebido. Em instantes o agente passa a encontrar o conteúdo de ${nome}.`,
      oQueFazer: null,
      ehProblema: false,
      respondeHoje: false,
    };
  }

  if (material.chunks_count === 0) {
    return {
      estado: "sem-trecho",
      rotulo: "Sem conteúdo aproveitável",
      tom: "error",
      explicacao: `Salvo, mas nada de ${nome} virou conteúdo que o agente consiga encontrar — hoje ele não responde nada com isto.`,
      oQueFazer:
        "Abra o material e confira se há texto de verdade. Arquivo que é só imagem, ou página em branco, não vira conteúdo.",
      ehProblema: true,
      respondeHoje: false,
    };
  }

  const validade = rotuloDeValidade(material.valid_until, hojeLocal(agora));
  if (validade.estado === "vencido") {
    return {
      estado: "vencido",
      rotulo: validade.texto,
      tom: "error",
      explicacao: `O prazo que você marcou passou, então o agente parou de usar ${nome} — melhor não responder do que responder com informação velha.`,
      oQueFazer: "Carregue a versão atualizada, ou marque um prazo novo.",
      ehProblema: true,
      respondeHoje: false,
    };
  }

  const contagem = trechos(material.chunks_count);
  const aviso =
    validade.estado === "vence-em-breve" ? ` ${validade.texto} — vale conferir se mudou algo.` : "";

  return {
    estado: "pronto",
    rotulo: "Respondendo",
    tom: "success",
    explicacao: `O agente responde com ${nome}: ${contagem} para consultar.${aviso}`,
    oQueFazer: null,
    ehProblema: false,
    respondeHoje: true,
  };
}

/**
 * Se oferecer "tentar de novo" faz sentido para este estado.
 *
 * Só onde repetir o processamento pode mudar o resultado. Em material **vencido** não pode:
 * o conteúdo está lá, inteiro, e o que o desqualifica é a data — botão de tentar de novo
 * ali seria um botão que não faz nada, e botão que não faz nada ensina a não clicar em
 * nenhum.
 */
export function podeTentarDeNovo(estado: SituacaoDoMaterial): boolean {
  return estado === "falhou" || estado === "sem-trecho" || estado === "parado";
}

/**
 * O motivo da falha, com o que o banco gravou quando ele gravou alguma coisa.
 *
 * O texto do erro vem do processamento e às vezes é técnico — ele entra como DETALHE,
 * nunca como a frase principal, para quem entende poder usá-lo sem que quem não entende
 * fique sem explicação.
 */
export function motivoDaFalha(material: MaterialDoCorretor): string {
  const base = `Não consegui transformar ${material.name} em conteúdo que o agente use.`;
  const detalhe = material.last_index_error?.trim();
  return detalhe ? `${base} Detalhe: ${detalhe}` : base;
}

/** Minutos entre um carimbo ISO e agora. `null` quando o carimbo não dá para ler. */
export function minutosDesde(iso: string, agora: Date): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((agora.getTime() - t) / 60_000);
}

// ---------------------------------------------------------------------------
// Agrupamento por operadora (FR-003, US4 cenário 3)
// ---------------------------------------------------------------------------

export interface MaterialNaTela {
  material: MaterialDoCorretor;
  diagnostico: DiagnosticoDeMaterial;
}

export interface GrupoDeMateriais {
  /** Identidade do grupo: o id do escopo, ou uma das duas chaves especiais. */
  chave: string;
  titulo: string;
  /** De onde a operadora veio, ou `null` nos grupos que não são operadora. */
  origem: EscopoNaTela["origin"] | null;
  /** O escopo está ligado. Grupo sem operadora é sempre "ligado" — não há o que desligar. */
  ligado: boolean;
  /** Onde carregar material novo. Nulo quando não há operadora a que anexar. */
  escopoId: string | null;
  materiais: MaterialNaTela[];
  /** Quantos precisam de atenção — é o número que a tela mostra no cabeçalho do grupo. */
  problemas: number;
  /** Quantos o agente consegue usar agora (zero quando a operadora está desligada). */
  respondemHoje: number;
}

/** Materiais marcados como válidos para qualquer operadora (US4 cenário 4). */
export const CHAVE_TODAS = "vale-para-qualquer";
/**
 * Rede de segurança: material cuja operadora não está na lista lida.
 *
 * O banco não deveria produzir esse estado (o CHECK `ai_knowledge_sources_scope_xor_all`
 * exige operadora OU "vale para todas"), mas se ele acontecer o material **não pode sumir
 * da tela** — sumir é a versão silenciosa do mesmo defeito que FR-004 proíbe.
 */
export const CHAVE_ORFA = "sem-operadora";

export function tituloDeTodas(rotulo: RotuloDoEscopo): string {
  return `Vale para qualquer ${rotulo.singular.toLowerCase()}`;
}

export function tituloDeOrfaos(rotulo: RotuloDoEscopo): string {
  return `Sem ${rotulo.singular.toLowerCase()}`;
}

/**
 * Junta materiais e operadoras nos cards da tela.
 *
 * **Nenhum material é descartado** — é a propriedade que o teste vigia. Um material que
 * não casa com nenhuma operadora conhecida cai no grupo de segurança em vez de sumir.
 *
 * Quais operadoras ganham card: as que têm material **ou** estão ligadas. Operadora
 * desligada e sem material nenhum não é acervo — é uma linha da tela vizinha, e listá-la
 * aqui encheria a tela de uma instalação nova com dezenas de cards vazios.
 *
 * A ordem coloca quem precisa de atenção primeiro. Diferente da tela de operadoras (que
 * não reordena de propósito, porque lá a lista se mexe a cada clique), aqui a ordem só
 * muda quando os dados mudam — e material quebrado enterrado no fim da página é material
 * que ninguém conserta.
 */
export function agruparPorEscopo(
  materiais: readonly MaterialDoCorretor[],
  escopos: readonly EscopoNaTela[],
  rotulo: RotuloDoEscopo,
  agora: Date = new Date(),
): GrupoDeMateriais[] {
  const porChave = new Map<string, GrupoDeMateriais>();

  function grupo(base: Omit<GrupoDeMateriais, "materiais" | "problemas" | "respondemHoje">) {
    const existente = porChave.get(base.chave);
    if (existente) return existente;
    const novo: GrupoDeMateriais = { ...base, materiais: [], problemas: 0, respondemHoje: 0 };
    porChave.set(base.chave, novo);
    return novo;
  }

  const escopoPorId = new Map(escopos.map((e) => [e.id, e]));

  for (const escopo of escopos) {
    if (!escopo.is_active) continue;
    grupo({
      chave: escopo.id,
      titulo: escopo.display_name,
      origem: escopo.origin,
      ligado: true,
      escopoId: escopo.id,
    });
  }

  for (const material of materiais) {
    const escopo = material.scope_id ? escopoPorId.get(material.scope_id) : undefined;
    const alvo = material.applies_to_all
      ? grupo({
          chave: CHAVE_TODAS,
          titulo: tituloDeTodas(rotulo),
          origem: null,
          ligado: true,
          escopoId: null,
        })
      : escopo
        ? grupo({
            chave: escopo.id,
            titulo: escopo.display_name,
            origem: escopo.origin,
            ligado: escopo.is_active,
            escopoId: escopo.id,
          })
        : grupo({
            chave: CHAVE_ORFA,
            titulo: tituloDeOrfaos(rotulo),
            origem: null,
            ligado: true,
            escopoId: null,
          });

    const diagnostico = situacaoDoMaterial(material, agora);
    alvo.materiais.push({ material, diagnostico });
    if (diagnostico.ehProblema) alvo.problemas += 1;
    if (diagnostico.respondeHoje && alvo.ligado) alvo.respondemHoje += 1;
  }

  return [...porChave.values()].sort((a, b) => {
    const pesoA = a.problemas > 0 ? 0 : 1;
    const pesoB = b.problemas > 0 ? 0 : 1;
    if (pesoA !== pesoB) return pesoA - pesoB;
    // Os dois grupos que não são operadora vão para o fim: são exceção, não o assunto.
    const especialA = a.escopoId === null ? 1 : 0;
    const especialB = b.escopoId === null ? 1 : 0;
    if (especialA !== especialB) return especialA - especialB;
    return a.titulo.localeCompare(b.titulo, "pt-BR");
  });
}

export interface ResumoDaTela {
  materiais: number;
  respondemHoje: number;
  problemas: number;
}

/** Os três números do topo da tela. */
export function resumoDaTela(grupos: readonly GrupoDeMateriais[]): ResumoDaTela {
  return grupos.reduce<ResumoDaTela>(
    (total, g) => ({
      materiais: total.materiais + g.materiais.length,
      respondemHoje: total.respondemHoje + g.respondemHoje,
      problemas: total.problemas + g.problemas,
    }),
    { materiais: 0, respondemHoje: 0, problemas: 0 },
  );
}

/**
 * A frase do topo. Ela diz o número que interessa primeiro — quantos precisam de atenção —
 * porque é o único que pede ação.
 */
export function fraseDoResumo(resumo: ResumoDaTela): string {
  if (resumo.materiais === 0) return VAZIO_TEXTO;
  // "0 respondem hoje" é número, não frase: quem lê precisa entender de primeira que o
  // agente está sem nada para dizer.
  const respondendo =
    resumo.respondemHoje === 0
      ? "Nenhum responde hoje"
      : resumo.respondemHoje === 1
        ? "1 responde hoje"
        : `${resumo.respondemHoje} respondem hoje`;
  if (resumo.problemas === 0) return `${respondendo}. Nada esperando por você.`;
  const pendentes =
    resumo.problemas === 1
      ? "1 precisa da sua atenção"
      : `${resumo.problemas} precisam da sua atenção`;
  return `${respondendo}, e ${pendentes}.`;
}

/** O estado de um grupo, em uma linha, embaixo do nome da operadora. */
export function explicacaoDoGrupo(grupo: GrupoDeMateriais): string {
  if (!grupo.ligado) {
    return grupo.materiais.length === 0
      ? "Desligado: o agente não responde sobre isto."
      : `Desligado: o agente não usa ${quantosMateriais(grupo.materiais.length)} daqui. Continua tudo salvo.`;
  }
  if (grupo.materiais.length === 0) {
    return "Ligado, e ainda sem material: o agente não tem o que responder aqui.";
  }
  if (grupo.respondemHoje === 0) {
    return `${quantosMateriais(grupo.materiais.length)}, e nenhum responde hoje.`;
  }
  return `${quantosMateriais(grupo.materiais.length)}, ${grupo.respondemHoje} respondendo hoje.`;
}

function quantosMateriais(n: number): string {
  return n === 1 ? "1 material" : `${n} materiais`;
}

// ---------------------------------------------------------------------------
// Material novo (FR-007, FR-025 / T118)
// ---------------------------------------------------------------------------

/**
 * Os tetos declarados ANTES do envio (FR-007), espelhados de `itemDeFaqSchema` e
 * `materialColadoSchema` em `app/api/v1/knowledge-scopes/_escopos.ts`.
 *
 * Espelhados, e não importados: aquele módulo carrega `node:crypto` e `zod` e é do
 * servidor; puxá-lo para o browser inteiro por causa de três números seria caro. O que
 * segura a cópia é o teste que a compara com o contrato — número diferente aqui vira
 * recusa do servidor depois do usuário já ter digitado, que é o oposto de FR-007.
 */
export const LIMITE_DO_NOME = 120;
export const LIMITE_DA_PERGUNTA = 2_000;
export const LIMITE_DA_RESPOSTA = 20_000;
/** Quantas perguntas cabem num material só. */
export const LIMITE_DE_PERGUNTAS = 500;

/**
 * Uma pergunta de cliente e a resposta que o agente deve dar.
 *
 * ## Por que a tela pede PERGUNTA e RESPOSTA, e não um texto solto
 *
 * Não é preferência de formulário: é o que o produto sabe transformar em conteúdo
 * buscável hoje. `parseFaqMarkdown` (`lib/ai/rag/ingest/faq.ts`) extrai exclusivamente
 * pares pergunta/resposta, e o indexador lê exclusivamente esses pares. Um campo de texto
 * livre aceitaria um manual inteiro e produziria **zero** trecho — o defeito medido na
 * spec, agora servido pela própria tela. Enquanto T083/T084 não ensinarem o indexador a
 * ler documento corrido, pedir o par é a única forma honesta de prometer que o que foi
 * digitado vira resposta.
 */
export interface ParDePerguntaEResposta {
  pergunta: string;
  resposta: string;
}

export interface DadosDoNovoMaterial {
  escopoId: string;
  nome: string;
  pares: readonly ParDePerguntaEResposta[];
  /** `AAAA-MM-DD` ou vazio. Vazio é o caminho normal (FR-025). */
  validade: string;
}

/** O corpo de `POST /api/v1/knowledge-scopes/{id}/materials` (`materialColadoSchema`). */
export interface CorpoDoNovoMaterial {
  agent_id: string;
  name: string;
  source_type: "faq";
  items: { question: string; answer: string }[];
  /** Nulo é o valor honesto de "não vence" — a coluna é `date` e aceita nulo. */
  valid_until: string | null;
}

export type Conferencia =
  | { ok: true; corpo: CorpoDoNovoMaterial }
  | { ok: false; erro: string };

const FORMATO_DE_DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * O corpo do pedido, conferido antes de sair.
 *
 * ⚠️ **Validade é opcional, e isto é requisito, não preferência** (FR-025): campo em branco
 * vira `null` e o material entra normalmente. Transformar isto em obrigatório — inclusive
 * por acidente, exigindo "ao menos um campo" — trava o corretor apressado, que é
 * exatamente o que o requisito proíbe.
 *
 * Par pela metade é RECUSA, não descarte: quem escreveu a pergunta e esqueceu a resposta
 * precisa saber disso agora. Salvar o resto em silêncio criaria um material que responde
 * menos do que quem o escreveu acredita — a versão pequena do defeito de FR-004.
 */
export function corpoDoNovoMaterial(dados: DadosDoNovoMaterial, agentId: string): Conferencia {
  const nome = dados.nome.trim();
  if (nome.length < 2) {
    return { ok: false, erro: "Dê um nome ao material para você reconhecê-lo depois." };
  }
  if (nome.length > LIMITE_DO_NOME) {
    return { ok: false, erro: `O nome passou de ${LIMITE_DO_NOME} caracteres. Encurte um pouco.` };
  }

  const items: { question: string; answer: string }[] = [];
  for (const par of dados.pares) {
    const pergunta = par.pergunta.trim();
    const resposta = par.resposta.trim();
    if (pergunta === "" && resposta === "") continue;
    if (pergunta === "") {
      return { ok: false, erro: "Uma das respostas está sem a pergunta correspondente." };
    }
    if (resposta === "") {
      return { ok: false, erro: `Falta a resposta de “${pergunta}”.` };
    }
    if (pergunta.length > LIMITE_DA_PERGUNTA) {
      return { ok: false, erro: `A pergunta passou de ${LIMITE_DA_PERGUNTA} caracteres.` };
    }
    if (resposta.length > LIMITE_DA_RESPOSTA) {
      return {
        ok: false,
        erro: `A resposta de “${pergunta}” passou de ${LIMITE_DA_RESPOSTA.toLocaleString("pt-BR")} caracteres. Divida em duas perguntas.`,
      };
    }
    items.push({ question: pergunta, answer: resposta });
  }

  if (items.length === 0) {
    return { ok: false, erro: "Escreva ao menos uma pergunta e a resposta dela." };
  }
  if (items.length > LIMITE_DE_PERGUNTAS) {
    return {
      ok: false,
      erro: `São ${LIMITE_DE_PERGUNTAS} perguntas por material, no máximo. Crie outro material com o resto.`,
    };
  }

  const validade = dados.validade.trim();
  if (validade !== "" && !FORMATO_DE_DATA.test(validade)) {
    return { ok: false, erro: "A data de validade precisa estar no formato dia/mês/ano." };
  }

  return {
    ok: true,
    corpo: {
      agent_id: agentId,
      name: nome,
      source_type: "faq",
      items,
      valid_until: validade === "" ? null : validade,
    },
  };
}

/** O caminho do contrato (`contracts/rotas-http.md`), num lugar só. */
export function caminhoDoNovoMaterial(escopoId: string): string {
  return `/api/v1/knowledge-scopes/${escopoId}/materials`;
}

/** O caminho que refaz o processamento de um material que não deu certo. */
export function caminhoDeNovaTentativa(materialId: string): string {
  return `/api/v1/ai/knowledge/sources/${materialId}/reindex`;
}

// ---------------------------------------------------------------------------
// Texto fixo da tela
// ---------------------------------------------------------------------------

export const TITULO = "Conhecimento";

export function subtitulo(rotulo: RotuloDoEscopo): string {
  return `Tudo que o agente consulta antes de responder, junto por ${rotulo.singular.toLowerCase()}. Só o que estiver respondendo aqui chega ao cliente.`;
}

export const VAZIO_TITULO = "O agente ainda não sabe nada seu";
export const VAZIO_TEXTO =
  "Nenhum material carregado por você até agora. Carregue o primeiro: o telefone do gerente da conta, como tirar a segunda via, o que a sua região faz diferente.";

export const SEM_OPERADORA_LIGADA_TITULO = "Nada ligado ainda";
export const SEM_OPERADORA_LIGADA_TEXTO =
  "Antes de carregar material, ligue o que você vende — o agente só responde sobre o que estiver ligado.";

export const AVISO_ORFAO =
  "Estes materiais não dizem a quem se aplicam, então o agente não usa nenhum deles. Carregue de novo escolhendo a quem eles pertencem.";

export const NOVO_MATERIAL_TITULO = "Novo material";
export const NOVO_MATERIAL_DESCRICAO =
  "Escreva o que os clientes costumam perguntar e o que o agente deve responder. Cada pergunta que você escrever aqui é uma a menos para você responder no WhatsApp.";
export const PERGUNTA_ROTULO = "O que o cliente pergunta";
export const RESPOSTA_ROTULO = "O que o agente responde";
export const PERGUNTA_EXEMPLO = "Ex.: como tiro a segunda via do boleto?";
export const RESPOSTA_EXEMPLO =
  "Ex.: pelo aplicativo, em Financeiro > Segunda via. Também dá para pedir pela central, no 0800…";
export const MAIS_UMA_PERGUNTA = "Adicionar outra pergunta";
export const VALIDADE_ROTULO = "Vale até (opcional)";
export const VALIDADE_AJUDA =
  "Deixe em branco se não vence. Se você marcar uma data, o agente para de usar o material depois dela — melhor calar do que responder com informação velha.";
export const NOVO_MATERIAL_SUCESSO =
  "Material recebido. Em instantes ele aparece aqui pronto para responder.";

/**
 * Toda frase fixa da tela num lugar só — é o que o teste de jargão e o de concordância
 * varrem. Frase nova que não entre aqui não é vigiada.
 */
export const TEXTO_FIXO_DA_TELA: readonly string[] = [
  TITULO,
  VAZIO_TITULO,
  VAZIO_TEXTO,
  SEM_OPERADORA_LIGADA_TITULO,
  SEM_OPERADORA_LIGADA_TEXTO,
  AVISO_ORFAO,
  NOVO_MATERIAL_TITULO,
  NOVO_MATERIAL_DESCRICAO,
  PERGUNTA_ROTULO,
  RESPOSTA_ROTULO,
  PERGUNTA_EXEMPLO,
  RESPOSTA_EXEMPLO,
  MAIS_UMA_PERGUNTA,
  VALIDADE_ROTULO,
  VALIDADE_AJUDA,
  NOVO_MATERIAL_SUCESSO,
];
