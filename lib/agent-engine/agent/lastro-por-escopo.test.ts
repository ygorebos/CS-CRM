import { describe, expect, it } from 'vitest';

import { fraseDeRecusaParcial, particionarPorEscopo, type LastroDeEscopo } from './lastro-por-escopo';
import type { EscopoConhecido } from './escopo-do-contato';
import type { Grounding } from '../guardrails/assistance-grounding';

/**
 * FR-018 — o veto é por AFIRMAÇÃO, não por mensagem (spec 002, T062).
 *
 * O caso que a spec descreve: *"meu plano é o Amil e o da minha mãe é Unimed"*. Se a
 * resposta inteira cai porque falta material de uma das duas, o cliente perde a metade que
 * estava certa. Se ela sai inteira porque uma das duas tinha material, ele recebe o
 * procedimento de uma operadora atribuído à outra — que é o dano que a feature existe para
 * impedir. As duas saídas erradas são vizinhas; o que separa é conferir **frase a frase**.
 */

const AMIL: EscopoConhecido = {
  id: 'a1',
  displayName: 'Amil',
  officialCode: null,
  isActive: true,
  catalogScopeId: null,
};
const UNIMED: EscopoConhecido = {
  id: 'u1',
  displayName: 'Unimed',
  officialCode: null,
  isActive: true,
  catalogScopeId: null,
};

const ancora = (id: string): Grounding => ({
  chunk_id: id,
  material_id: `${id}-m`,
  layer: 'tenant',
  similarity: 0.9,
  // Âncora do assunto por construção: este arquivo exercita OUTRO eixo, e a pertinência
  // (T138) tem suíte própria em assistance-grounding.test.ts.
  categorias: ['cobranca', 'acesso', 'rede', 'cobertura', 'prazos', 'canais', 'regras'],
  aprendidoDeConversa: false,
});

const lastro = (scopeId: string | null, scopeName: string | null, ids: string[]): LastroDeEscopo => ({
  scopeId,
  scopeName,
  groundings: ids.map(ancora),
});

const base = {
  escopoPadrao: { scopeId: null, scopeName: null },
  escoposConhecidos: [AMIL, UNIMED],
  minCitations: 1,
};

describe('mensagem que não afirma nada de assistência', () => {
  it('sai intacta, byte a byte, sem exigir âncora nenhuma (FR-020)', () => {
    const corpo = 'Oi, João! Que bom te ver por aqui. Posso te ajudar a escolher um plano?';
    const p = particionarPorEscopo({ ...base, corpo, lastros: [] });
    expect(p.corpoAprovado).toBe(corpo);
    expect(p.recusados).toEqual([]);
    expect(p.houveAfirmacao).toBe(false);
  });
});

describe('uma operadora só', () => {
  const corpo = 'Oi! No Amil a segunda via do boleto sai pelo aplicativo.';

  it('com material, a resposta sai intacta e carrega as âncoras daquela operadora', () => {
    const p = particionarPorEscopo({ ...base, corpo, lastros: [lastro(AMIL.id, 'Amil', ['c1'])] });
    expect(p.corpoAprovado).toBe(corpo);
    expect(p.recusados).toEqual([]);
    expect(p.groundings.map((g) => g.chunk_id)).toEqual(['c1']);
  });

  it('sem material, a afirmação cai e a operadora é nomeada na recusa', () => {
    const p = particionarPorEscopo({ ...base, corpo, lastros: [] });
    expect(p.recusados).toEqual([{ scopeId: AMIL.id, scopeName: 'Amil' }]);
    expect(p.corpoAprovado).toBe('Oi!');
    expect(p.groundings).toEqual([]);
    // Uma operadora só: quem chama NÃO recorta a mensagem por isto — cai no caminho de
    // recusa total da fatia F1, e é esta contagem que o diz.
    expect(p.escoposTocados).toHaveLength(1);
  });

  it('o piso de âncoras é o do guardrail: 2 exigidas, 1 âncora não basta', () => {
    const p = particionarPorEscopo({
      ...base,
      minCitations: 2,
      corpo,
      lastros: [lastro(AMIL.id, 'Amil', ['c1'])],
    });
    expect(p.recusados).toHaveLength(1);
  });
});

describe('a pergunta que cruza duas operadoras', () => {
  const corpo =
    'Claro, vamos por partes! No Amil a segunda via do boleto sai pelo aplicativo. ' +
    'Na Unimed a carência para internação é de 180 dias.';

  it('recusa isoladamente a parte sem material e mantém a que tem', () => {
    const p = particionarPorEscopo({ ...base, corpo, lastros: [lastro(AMIL.id, 'Amil', ['c1'])] });

    expect(p.escoposTocados).toHaveLength(2);
    expect(p.recusados).toEqual([{ scopeId: UNIMED.id, scopeName: 'Unimed' }]);
    expect(p.corpoAprovado).toContain('No Amil a segunda via do boleto sai pelo aplicativo.');
    expect(p.corpoAprovado).not.toContain('Unimed');
    expect(p.corpoAprovado).toContain('Claro, vamos por partes!');
  });

  it('as âncoras que sobem são SÓ as da operadora que ficou — nunca as das duas', () => {
    // A fusão que este teste vigia é silenciosa: entregar ao gate as âncoras dos dois
    // baldes faria uma afirmação sobre a Unimed passar sustentada por material do Amil.
    const p = particionarPorEscopo({
      ...base,
      corpo,
      lastros: [lastro(AMIL.id, 'Amil', ['c1']), lastro(UNIMED.id, 'Unimed', [])],
    });
    expect(p.groundings.map((g) => g.chunk_id)).toEqual(['c1']);
  });

  it('com material das duas, nada é recusado e as âncoras somam', () => {
    const p = particionarPorEscopo({
      ...base,
      corpo,
      lastros: [lastro(AMIL.id, 'Amil', ['c1']), lastro(UNIMED.id, 'Unimed', ['c2', 'c3'])],
    });
    expect(p.recusados).toEqual([]);
    expect(p.corpoAprovado).toBe(corpo);
    expect(p.groundings.map((g) => g.chunk_id).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('a quem pertence a frase que não nomeia ninguém', () => {
  it('arrasta a última operadora nomeada — é como se escreve de verdade', () => {
    const corpo =
      'No Amil a segunda via sai pelo aplicativo. Na Unimed é pelo portal. O prazo de carência é de 24 horas.';
    const p = particionarPorEscopo({ ...base, corpo, lastros: [lastro(AMIL.id, 'Amil', ['c1'])] });
    // A última frase fala da Unimed, mesmo sem repetir o nome. Amarrá-la ao escopo padrão
    // (ou ao Amil, que foi o primeiro) deixaria passar uma afirmação sem material.
    expect(p.recusados).toEqual([{ scopeId: UNIMED.id, scopeName: 'Unimed' }]);
    expect(p.corpoAprovado).toBe('No Amil a segunda via sai pelo aplicativo.');
  });

  it('a frase sem termo do léxico que CONTINUA a afirmação também é afirmação', () => {
    // Sem este arrasto o veto é contornável por pontuação: basta o modelo deixar o sujeito
    // na frase anterior ("a segunda via") e afirmar o resto numa frase limpa.
    const corpo = 'No Amil a segunda via sai pelo aplicativo. Na Unimed é pelo portal.';
    const p = particionarPorEscopo({ ...base, corpo, lastros: [lastro(AMIL.id, 'Amil', ['c1'])] });
    expect(p.recusados).toEqual([{ scopeId: UNIMED.id, scopeName: 'Unimed' }]);
    expect(p.corpoAprovado).toBe('No Amil a segunda via sai pelo aplicativo.');
  });

  it('a PERGUNTA nunca é arrastada — é assim que o agente descobre a operadora', () => {
    const corpo = 'No Amil a segunda via sai pelo aplicativo. E o plano da sua mãe, é de qual operadora?';
    const p = particionarPorEscopo({ ...base, corpo, lastros: [lastro(AMIL.id, 'Amil', ['c1'])] });
    expect(p.recusados).toEqual([]);
    expect(p.corpoAprovado).toBe(corpo);
  });

  it('o que vem ANTES da primeira afirmação não é arrastado', () => {
    const corpo = 'Oi, João! Tudo bem? No Amil a segunda via sai pelo aplicativo.';
    const p = particionarPorEscopo({ ...base, corpo, lastros: [] });
    expect(p.corpoAprovado).toBe('Oi, João!\nTudo bem?');
  });

  it('antes de qualquer nome, vale o escopo padrão do turno (o vínculo do contato)', () => {
    const p = particionarPorEscopo({
      ...base,
      escopoPadrao: { scopeId: AMIL.id, scopeName: 'Amil' },
      corpo: 'A segunda via do boleto sai pelo aplicativo.',
      lastros: [lastro(AMIL.id, 'Amil', ['c1'])],
    });
    expect(p.recusados).toEqual([]);
    expect(p.groundings.map((g) => g.chunk_id)).toEqual(['c1']);
  });
});

describe('frase que funde duas operadoras numa afirmação só', () => {
  const corpo = 'O boleto do Amil e da Unimed sai pelo mesmo portal.';

  it('cai quando falta material de qualquer uma das duas', () => {
    const p = particionarPorEscopo({ ...base, corpo, lastros: [lastro(AMIL.id, 'Amil', ['c1'])] });
    expect(p.recusados).toEqual([{ scopeId: UNIMED.id, scopeName: 'Unimed' }]);
    expect(p.corpoAprovado).toBe('');
  });

  it('só sai quando as duas têm material', () => {
    const p = particionarPorEscopo({
      ...base,
      corpo,
      lastros: [lastro(AMIL.id, 'Amil', ['c1']), lastro(UNIMED.id, 'Unimed', ['c2'])],
    });
    expect(p.recusados).toEqual([]);
    expect(p.corpoAprovado).toBe(corpo);
  });
});

describe('a frase de recusa parcial', () => {
  it('nomeia a operadora que ficou faltando', () => {
    const f = fraseDeRecusaParcial([{ scopeId: 'u1', scopeName: 'Unimed' }]);
    expect(f).toContain('Unimed');
    expect(f).toContain('uma pessoa da equipe');
  });

  it('junta duas com "e"', () => {
    const f = fraseDeRecusaParcial([
      { scopeId: 'u1', scopeName: 'Unimed' },
      { scopeId: 's1', scopeName: 'SulAmérica' },
    ]);
    expect(f).toContain('Unimed e SulAmérica');
  });

  it('sem nome, fala da dúvida — nunca de um campo vazio', () => {
    expect(fraseDeRecusaParcial([{ scopeId: null, scopeName: null }])).toContain('Sobre essa dúvida');
  });

  it('não carrega vocabulário interno do produto (FR-011)', () => {
    const f = fraseDeRecusaParcial([{ scopeId: 'u1', scopeName: 'Unimed' }]).toLowerCase();
    for (const jargao of ['base de conhecimento', 'acervo', 'lastro', 'similaridade', 'guardrail', 'escopo']) {
      expect(f).not.toContain(jargao);
    }
  });
});
