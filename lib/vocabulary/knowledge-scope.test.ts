import { describe, expect, it } from 'vitest';

import { ROTULO_PADRAO, resolverRotuloDoEscopo } from './knowledge-scope';

/**
 * FR-033/FR-041: o rótulo é configurável, e a estrutura não assume o nicho.
 *
 * O que estes casos protegem é a promessa de multi-nicho. Um dia alguém vai instalar isto
 * para uma clínica com convênios; se o rótulo estiver cravado, a descoberta acontece na
 * tela do cliente e o conserto é uma migration.
 */
describe('rótulo do escopo de conhecimento', () => {
  it('sem configuração, o nicho de validação manda', () => {
    expect(resolverRotuloDoEscopo({})).toEqual(ROTULO_PADRAO);
    expect(resolverRotuloDoEscopo(null)).toEqual(ROTULO_PADRAO);
  });

  it('string simples vira singular e plural derivado — a forma mais provável de configurar', () => {
    expect(resolverRotuloDoEscopo({ knowledge_scope_label: 'Convênio' })).toEqual({
      singular: 'Convênio',
      plural: 'Convênios',
    });
  });

  it('objeto com os dois vence a derivação — plural irregular existe', () => {
    expect(
      resolverRotuloDoEscopo({ knowledge_scope_label: { singular: 'Fabricante', plural: 'Fabricantes' } }),
    ).toEqual({ singular: 'Fabricante', plural: 'Fabricantes' });
  });

  it('jsonb torto cai no padrão em vez de quebrar a tela', () => {
    // A coluna é jsonb e o produto é self-host: qualquer coisa pode estar ali.
    for (const torto of [42, 'x', [], { knowledge_scope_label: 7 }, { knowledge_scope_label: '   ' }]) {
      expect(resolverRotuloDoEscopo(torto), JSON.stringify(torto)).toEqual(ROTULO_PADRAO);
    }
  });

  it('nada em `lib/` decide o nicho por conta própria — o padrão é dado, não regra', () => {
    // Guarda de intenção: se alguém trocar ROTULO_PADRAO por uma constante espalhada em
    // várias telas, este teste continua passando — mas o revisor vê aqui que o contrato
    // é "uma fonte, configurável", e não "o texto que estiver mais perto".
    expect(ROTULO_PADRAO.singular).toBe('Operadora');
    expect(resolverRotuloDoEscopo({ knowledge_scope_label: 'Fornecedor' }).singular).not.toBe(
      ROTULO_PADRAO.singular,
    );
  });
});
