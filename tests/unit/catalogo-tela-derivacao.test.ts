/**
 * As contas da tela de curadoria do catálogo (spec 002, T066).
 *
 * ═══ O QUE ESTE ARQUIVO EXISTE PARA PEGAR ═══
 *
 * Duas funções de `app/admin/(protected)/catalogo/_derivacao.ts` repetem em TypeScript
 * regras que o Postgres já aplica, e é a divergência entre as duas cópias que este arquivo
 * vigia — não a existência delas:
 *
 *  · `versaoVigente` tem de dar a MESMA resposta que `fn_buscar_lastro` (migration 0124),
 *    que ancora, por slug, apenas a maior versão NÃO inerte. Se a tela usasse "a mais
 *    recente por data" ou "a última da lista", ela apontaria como vigente uma versão que o
 *    agente não usa — e o curador corrigiria o texto errado, com tudo verde.
 *  · `proximaVersao` tem de dar o mesmo número que `maiorVersao`
 *    (`app/api/v1/catalog/_materiais.ts`), que conta as inertes. Errar aqui faz o botão
 *    prometer "publicar versão 3" e a rota gravar a 4 — ou colidir com o índice único.
 *
 * O resto (validade, ordenação dos cards) é o que decide o que o curador vê primeiro.
 */
import { describe, expect, it } from "vitest";

import {
  agruparPorSlug,
  contarAguardando,
  diasEntre,
  formatarDia,
  formatarInstante,
  formatarTamanho,
  hojeLocal,
  origemLegivel,
  papelDaVersao,
  plural,
  proximaVersao,
  rotuloDeValidade,
  versaoVigente,
} from "@/app/admin/(protected)/catalogo/_derivacao";
import type { MaterialResumido } from "@/app/admin/(protected)/catalogo/_tipos";

/** Uma linha de material, com o mínimo variável e o resto plausível. */
function material(p: Partial<MaterialResumido> & { slug: string; version: number }): MaterialResumido {
  return {
    id: p.id ?? `${p.slug}-v${p.version}`,
    catalog_scope_id: p.catalog_scope_id ?? "11111111-1111-4111-8111-111111111111",
    applies_to_all: p.applies_to_all ?? false,
    slug: p.slug,
    version: p.version,
    title: p.title ?? `Título v${p.version}`,
    body_chars: p.body_chars ?? 1200,
    valid_until: p.valid_until ?? null,
    published_at: p.published_at ?? "2026-01-01T12:00:00.000Z",
    origin: p.origin ?? "seed",
    inert: p.inert ?? false,
    adopted_at: p.adopted_at ?? null,
    adopted_by: p.adopted_by ?? null,
    created_at: p.created_at ?? "2026-01-01T12:00:00.000Z",
    updated_at: p.updated_at ?? "2026-01-01T12:00:00.000Z",
  };
}

describe("qual versão responde hoje", () => {
  it("é a maior versão, quando nenhuma é inerte", () => {
    const versoes = [material({ slug: "carencia", version: 1 }), material({ slug: "carencia", version: 2 })];
    expect(versaoVigente(versoes)?.version).toBe(2);
  });

  it("IGNORA a versão inerte, mesmo sendo a maior — é o recorte de fn_buscar_lastro", () => {
    // O caso real: a instalação corrigiu (v2, local) e a atualização trouxe a v3, que
    // chegou inerte justamente para não apagar a correção. Quem responde continua sendo a
    // v2. Uma tela que apontasse a v3 mandaria o curador corrigir um texto que não está no
    // ar — e a correção dele nasceria em cima do conteúdo errado.
    const versoes = [
      material({ slug: "carencia", version: 1 }),
      material({ slug: "carencia", version: 2, origin: "local", adopted_at: "2026-02-01T10:00:00Z" }),
      material({ slug: "carencia", version: 3, inert: true }),
    ];
    expect(versaoVigente(versoes)?.version).toBe(2);
  });

  it("não se deixa enganar pela ordem da lista nem pela data de publicação", () => {
    // A rota devolve versão decrescente, mas nada garante isso depois de um filtro na
    // tela. E `published_at` da semeada pode ser mais novo com `version` menor.
    const versoes = [
      material({ slug: "boleto", version: 1, published_at: "2026-05-01T00:00:00Z" }),
      material({ slug: "boleto", version: 3, published_at: "2026-01-01T00:00:00Z" }),
      material({ slug: "boleto", version: 2, published_at: "2026-04-01T00:00:00Z" }),
    ];
    expect(versaoVigente(versoes)?.version).toBe(3);
  });

  it("devolve nulo quando todas as versões são inertes, em vez de apontar uma que não vale", () => {
    const versoes = [material({ slug: "x", version: 1, inert: true })];
    expect(versaoVigente(versoes)).toBeNull();
  });

  it("papelDaVersao separa vigente, esperando decisão e histórico", () => {
    const v1 = material({ slug: "rede", version: 1 });
    const v2 = material({ slug: "rede", version: 2, origin: "local" });
    const v3 = material({ slug: "rede", version: 3, inert: true });
    const todas = [v1, v2, v3];
    expect(papelDaVersao(v2, todas)).toBe("vigente");
    expect(papelDaVersao(v3, todas)).toBe("aguardando");
    expect(papelDaVersao(v1, todas)).toBe("historico");
  });
});

describe("número da próxima versão", () => {
  it("é a maior + 1", () => {
    expect(proximaVersao([material({ slug: "a", version: 1 }), material({ slug: "a", version: 2 })])).toBe(3);
  });

  it("CONTA a versão inerte — é o que o INSERT da rota faz", () => {
    // `unique (slug, version)` não sabe o que é inércia. Ignorar a v3 inerte faria a tela
    // anunciar "publicar versão 3" e a gravação bater no índice único.
    const versoes = [
      material({ slug: "a", version: 1 }),
      material({ slug: "a", version: 2, origin: "local" }),
      material({ slug: "a", version: 3, inert: true }),
    ];
    expect(proximaVersao(versoes)).toBe(4);
  });

  it("começa em 1 quando não há versão nenhuma", () => {
    expect(proximaVersao([])).toBe(1);
  });
});

describe("agrupamento por assunto", () => {
  const linhas = [
    material({ slug: "carencia", version: 1 }),
    material({ slug: "carencia", version: 2, origin: "local", adopted_at: "2026-02-01T10:00:00Z" }),
    material({ slug: "carencia", version: 3, inert: true, title: "Carência (atualizado)" }),
    material({ slug: "boleto", version: 1, title: "Segunda via de boleto" }),
  ];

  it("junta as versões de um slug num grupo só, da mais nova para a mais antiga", () => {
    const grupos = agruparPorSlug(linhas);
    const carencia = grupos.find((g) => g.slug === "carencia");
    expect(carencia?.versoes.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(grupos).toHaveLength(2);
  });

  it("põe na frente o assunto que tem versão esperando decisão", () => {
    // Ordem alfabética colocaria "boleto" antes. Versão inerte enterrada no fim da lista é
    // release perdida em silêncio — a coluna `inert` só se paga se a tela a mostrar.
    const grupos = agruparPorSlug(linhas);
    expect(grupos[0]?.slug).toBe("carencia");
    expect(grupos[0]?.aguardando.map((v) => v.version)).toEqual([3]);
    expect(grupos[1]?.slug).toBe("boleto");
  });

  it("o título do grupo é o da versão vigente, não o da inerte", () => {
    // O curador reconhece o assunto pelo que está no ar. Mostrar o título da versão que
    // ainda não vale faria a lista descrever um estado que não existe.
    const carencia = agruparPorSlug(linhas).find((g) => g.slug === "carencia");
    expect(carencia?.titulo).toBe("Título v2");
  });

  it("marca o assunto como corrigido nesta instalação quando alguma versão foi adotada", () => {
    const grupos = agruparPorSlug(linhas);
    expect(grupos.find((g) => g.slug === "carencia")?.adotado).toBe(true);
    expect(grupos.find((g) => g.slug === "boleto")?.adotado).toBe(false);
  });

  it("ordena alfabeticamente os assuntos que não precisam de decisão", () => {
    const grupos = agruparPorSlug([
      material({ slug: "rede-credenciada", version: 1 }),
      material({ slug: "boleto", version: 1 }),
      material({ slug: "carteirinha", version: 1 }),
    ]);
    expect(grupos.map((g) => g.slug)).toEqual(["boleto", "carteirinha", "rede-credenciada"]);
  });

  it("conta quantos assuntos esperam decisão, não quantas versões", () => {
    const grupos = agruparPorSlug([
      ...linhas,
      material({ slug: "carencia", version: 4, inert: true }),
      material({ slug: "carteirinha", version: 1, inert: true }),
    ]);
    // "carencia" tem DUAS versões inertes e continua sendo UM assunto a decidir.
    expect(contarAguardando(grupos)).toBe(2);
  });

  it("sobrevive a lista vazia", () => {
    expect(agruparPorSlug([])).toEqual([]);
    expect(contarAguardando([])).toBe(0);
  });
});

describe("validade", () => {
  it("sem data é sem prazo, nunca 'vencido'", () => {
    expect(rotuloDeValidade(null, "2026-08-08")).toEqual({
      estado: "sem-prazo",
      texto: "Sem prazo de validade",
    });
  });

  it("data anterior a hoje é vencida", () => {
    const r = rotuloDeValidade("2026-08-07", "2026-08-08");
    expect(r.estado).toBe("vencido");
    expect(r.texto).toBe("Venceu em 07/08/2026");
  });

  it("o dia do vencimento ainda vale — o corte do banco é `valid_until >= current_date`", () => {
    expect(rotuloDeValidade("2026-08-08", "2026-08-08").estado).toBe("vence-em-breve");
    expect(rotuloDeValidade("2026-08-08", "2026-08-08").texto).toBe("Vence hoje");
  });

  it("avisa quando falta pouco, e só informa quando falta muito", () => {
    expect(rotuloDeValidade("2026-08-20", "2026-08-08").estado).toBe("vence-em-breve");
    expect(rotuloDeValidade("2026-08-20", "2026-08-08").texto).toBe("Vence em 12 dias");
    expect(rotuloDeValidade("2027-01-01", "2026-08-08")).toEqual({
      estado: "vigente",
      texto: "Vale até 01/01/2027",
    });
  });

  it("um dia de diferença sai no singular", () => {
    expect(rotuloDeValidade("2026-08-09", "2026-08-08").texto).toBe("Vence em 1 dia");
  });

  it("atravessa a virada do mês e do ano sem errar a conta", () => {
    expect(diasEntre("2026-12-28", "2027-01-04")).toBe(7);
    expect(diasEntre("2026-02-27", "2026-03-01")).toBe(2); // 2026 não é bissexto
  });

  it("`hojeLocal` usa o calendário de quem olha, não o UTC", () => {
    // 31/12 às 21h no fuso de Brasília já é 1º de janeiro em UTC. Se a tela usasse
    // `toISOString()`, um material que vence em 31/12 apareceria vencido três horas antes.
    const vespera = new Date(2026, 11, 31, 21, 0, 0);
    expect(hojeLocal(vespera)).toBe("2026-12-31");
  });

  it("`hojeLocal` preenche mês e dia com zero à esquerda", () => {
    expect(hojeLocal(new Date(2026, 0, 5, 10, 0, 0))).toBe("2026-01-05");
  });
});

describe("rótulos", () => {
  it("formata data ISO curta sem passar por Date", () => {
    expect(formatarDia("2026-02-03")).toBe("03/02/2026");
    // Entrada fora do formato volta como veio, em vez de virar "NaN/NaN/NaN" na tela.
    expect(formatarDia("qualquer coisa")).toBe("qualquer coisa");
  });

  it("carimbo ausente ou inválido vira travessão, não 'Invalid Date'", () => {
    expect(formatarInstante(null)).toBe("—");
    expect(formatarInstante(undefined)).toBe("—");
    expect(formatarInstante("não é data")).toBe("—");
  });

  it("traduz a origem para português, sem jargão de banco", () => {
    expect(origemLegivel("seed")).toBe("Veio com o produto");
    expect(origemLegivel("local")).toBe("Escrito nesta instalação");
    // Valor novo que a API passe a mandar aparece cru em vez de sumir da tela.
    expect(origemLegivel("importado")).toBe("importado");
  });

  it("descreve o tamanho do texto, e diz quando não há texto", () => {
    expect(formatarTamanho(0)).toBe("sem texto");
    expect(formatarTamanho(940)).toBe("940 caracteres");
    expect(formatarTamanho(2600)).toBe("2,6 mil caracteres");
  });

  it("plural sem gambiarra", () => {
    expect(plural(1, "assunto", "assuntos")).toBe("1 assunto");
    expect(plural(0, "assunto", "assuntos")).toBe("0 assuntos");
    expect(plural(3, "versão", "versões")).toBe("3 versões");
  });
});
