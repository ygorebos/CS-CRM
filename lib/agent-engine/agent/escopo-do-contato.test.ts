import { describe, expect, it, vi } from 'vitest';

import {
  blocoDePerguntaDeEscopo,
  carregarVinculoDoContato,
  escopoJaFoiPerguntado,
  escoposDesligadosQueCobririam,
  gravarEscopoDaConversa,
  marcarEscopoPerguntado,
  reconhecerEscoposNoTexto,
  VINCULO_DESCONHECIDO,
  type EscopoConhecido,
  type VinculoDeEscopo,
} from './escopo-do-contato';

/**
 * De qual operadora é o plano do cliente — spec 002, T060/T061.
 *
 * O teste que mais importa aqui é o **negativo**: FR-017 proíbe o sistema de inferir a
 * operadora por ser a única cadastrada, pela mais usada ou por semelhança de texto. Um
 * requisito de NÃO-comportamento passa sozinho enquanto ninguém escreve o comportamento —
 * por isso ele tem um teste que ficaria vermelho no dia em que alguém "melhorar" o
 * reconhecimento com distância de edição achando que está ajudando.
 */

const AMIL: EscopoConhecido = {
  id: 'a0000000-0000-4000-8000-000000000001',
  displayName: 'Amil',
  officialCode: '326305',
  isActive: true,
  catalogScopeId: 'c0000000-0000-4000-8000-000000000001',
};
const UNIMED: EscopoConhecido = {
  id: 'a0000000-0000-4000-8000-000000000002',
  displayName: 'Unimed',
  officialCode: null,
  isActive: true,
  catalogScopeId: null,
};
const UNIMED_NACIONAL: EscopoConhecido = {
  id: 'a0000000-0000-4000-8000-000000000003',
  displayName: 'Unimed Nacional',
  officialCode: null,
  isActive: true,
  catalogScopeId: null,
};
const SULAMERICA_DESLIGADA: EscopoConhecido = {
  id: 'a0000000-0000-4000-8000-000000000004',
  displayName: 'SulAmérica',
  officialCode: null,
  isActive: false,
  catalogScopeId: 'c0000000-0000-4000-8000-000000000004',
};

function poolFalso(resposta: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const r = resposta(sql, params);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  });
  return { pool: { query } as never, query };
}

describe('T061 · o sistema NÃO INFERE a operadora (FR-017)', () => {
  it('com UMA única operadora cadastrada, a mensagem que não a nomeia não cria vínculo', () => {
    // O caso exato que o requisito nomeia: "por ser a única cadastrada". É a inferência
    // mais tentadora de todas, porque acerta quase sempre — e quando erra, entrega o
    // procedimento errado a um cliente e ninguém fica sabendo.
    const achados = reconhecerEscoposNoTexto('como tiro a segunda via do boleto?', [AMIL]);
    expect(achados).toEqual([]);
  });

  it('não casa por semelhança de texto — "unimede", "uni med" e "amil card" não são a operadora', () => {
    for (const texto of ['meu plano é unimede', 'tenho uni med', 'uso o amilcard']) {
      expect(reconhecerEscoposNoTexto(texto, [AMIL, UNIMED])).toEqual([]);
    }
  });

  it('duas operadoras nomeadas na mesma mensagem ficam AMBÍGUAS — nenhuma é escolhida', () => {
    const achados = reconhecerEscoposNoTexto('meu plano é Amil e o da minha mãe é Unimed', [AMIL, UNIMED]);
    // Devolver as duas é o ponto: quem chama grava só quando há exatamente uma, e a
    // resposta a duas é buscar cada uma separadamente (FR-018), nunca escolher uma.
    expect(achados.map((e) => e.displayName).sort()).toEqual(['Amil', 'Unimed']);
  });

  it('mensagem vazia ou tenant sem operadora cadastrada não produzem nada', () => {
    expect(reconhecerEscoposNoTexto('   ', [AMIL])).toEqual([]);
    expect(reconhecerEscoposNoTexto('meu plano é Amil', [])).toEqual([]);
  });
});

describe('reconhecimento por nome literal', () => {
  it('casa o nome cadastrado, sem acento e sem caixa', () => {
    expect(reconhecerEscoposNoTexto('meu plano é SULAMERICA', [SULAMERICA_DESLIGADA]).map((e) => e.id)).toEqual([
      SULAMERICA_DESLIGADA.id,
    ]);
  });

  it('casa também pelo código oficial', () => {
    expect(reconhecerEscoposNoTexto('o registro é 326305', [AMIL, UNIMED])).toEqual([AMIL]);
  });

  it('nome CONTIDO em outro que casou é descartado — "Unimed Nacional" não vira ambiguidade', () => {
    const achados = reconhecerEscoposNoTexto('tenho Unimed Nacional', [UNIMED, UNIMED_NACIONAL]);
    expect(achados.map((e) => e.displayName)).toEqual(['Unimed Nacional']);
  });

  it('reconhece a operadora DESLIGADA — o vínculo é do cliente, o interruptor é do corretor', () => {
    // Ela não vai ancorar nada (trava 4), mas precisa ser reconhecida: é dela que sai a
    // linha de FR-042 dizendo ao corretor que a resposta existe e está desligada.
    expect(reconhecerEscoposNoTexto('sou da SulAmérica', [SULAMERICA_DESLIGADA])).toEqual([SULAMERICA_DESLIGADA]);
  });
});

describe('precedência: cadastro vence conversa e nunca é rebaixado (FR-017)', () => {
  const cadastro: VinculoDeEscopo = {
    scopeId: UNIMED.id,
    displayName: 'Unimed',
    source: 'cadastro',
    confirmedAt: new Date('2026-08-01T00:00:00Z'),
  };

  it('não escreve nada quando a ficha já decidiu', async () => {
    const { pool, query } = poolFalso(() => ({ rows: [], rowCount: 1 }));
    const gravou = await gravarEscopoDaConversa(pool, 'org', 'contato', AMIL.id, cadastro);
    expect(gravou).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('escreve quando não há vínculo, marcando a origem como conversa', async () => {
    const { pool, query } = poolFalso(() => ({ rows: [], rowCount: 1 }));
    const gravou = await gravarEscopoDaConversa(pool, 'org', 'contato', AMIL.id, VINCULO_DESCONHECIDO);
    expect(gravou).toBe(true);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain("knowledge_scope_source = 'conversa'");
    expect(String(sql)).toContain('knowledge_scope_confirmed_at = now()');
    // A segunda camada da precedência, que é a única que ganha a corrida com uma edição
    // de ficha no mesmo instante. Textual porque é a condição do `where`, e é ela que
    // some numa refatoração desatenta.
    expect(String(sql)).toContain("<> 'cadastro'");
    expect(params).toEqual(['org', 'contato', AMIL.id]);
  });

  it('rowCount 0 (contato sumiu ou nada mudou) devolve false, sem erro', async () => {
    const { pool } = poolFalso(() => ({ rows: [], rowCount: 0 }));
    expect(await gravarEscopoDaConversa(pool, 'org', 'contato', AMIL.id, VINCULO_DESCONHECIDO)).toBe(false);
  });
});

describe('leitura do vínculo do contato', () => {
  it('traduz a linha do banco, e valor fora do vocabulário vira origem nula', async () => {
    const { pool } = poolFalso(() => ({
      rows: [
        {
          knowledge_scope_id: AMIL.id,
          knowledge_scope_source: 'importado_do_excel',
          knowledge_scope_confirmed_at: null,
          display_name: 'Amil',
        },
      ],
    }));
    const v = await carregarVinculoDoContato(pool, 'org', 'contato');
    expect(v.scopeId).toBe(AMIL.id);
    expect(v.displayName).toBe('Amil');
    // Origem desconhecida, nunca exceção: um clone com dado torto perde só a precedência
    // daquele contato, não o atendimento dele.
    expect(v.source).toBeNull();
  });

  it('contato inexistente devolve o vínculo desconhecido', async () => {
    const { pool } = poolFalso(() => ({ rows: [] }));
    expect(await carregarVinculoDoContato(pool, 'org', 'sumido')).toEqual(VINCULO_DESCONHECIDO);
  });
});

describe('A-05 · uma pergunta, uma operadora', () => {
  it('a marca em conversations.metadata é o que diz se já perguntamos', async () => {
    const semMarca = poolFalso(() => ({ rows: [{ em: null }] }));
    expect(await escopoJaFoiPerguntado(semMarca.pool, 'org', 'conversa')).toBe(false);

    const comMarca = poolFalso(() => ({ rows: [{ em: '2026-08-08T10:00:00Z' }] }));
    expect(await escopoJaFoiPerguntado(comMarca.pool, 'org', 'conversa')).toBe(true);
  });

  it('marcar é idempotente: não sobrescreve o instante da primeira pergunta', async () => {
    const { pool, query } = poolFalso(() => ({ rows: [], rowCount: 1 }));
    await marcarEscopoPerguntado(pool, 'org', 'conversa');
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('is null');
    expect(sql).toContain('escopo_perguntado_em');
  });
});

describe('FR-042 · a resposta existe no produto e está desligada (T137)', () => {
  it('a operadora que o cliente nomeou e está desligada entra na lista', async () => {
    const { pool } = poolFalso(() => ({ rows: [] }));
    const nomes = await escoposDesligadosQueCobririam(pool, {
      tenantId: 'org',
      embedding: null,
      threshold: 0.72,
      mencionados: [SULAMERICA_DESLIGADA],
    });
    expect(nomes).toEqual(['SulAmérica']);
  });

  it('operadora LIGADA não entra — a recusa ali é falta de material, não de configuração', async () => {
    const { pool } = poolFalso(() => ({ rows: [] }));
    const nomes = await escoposDesligadosQueCobririam(pool, {
      tenantId: 'org',
      embedding: null,
      threshold: 0.72,
      mencionados: [AMIL],
    });
    expect(nomes).toEqual([]);
  });

  it('operadora do próprio corretor (fora do catálogo) não entra, nem desligada', async () => {
    const { pool } = poolFalso(() => ({ rows: [] }));
    const propriaDesligada: EscopoConhecido = { ...UNIMED, isActive: false, catalogScopeId: null };
    const nomes = await escoposDesligadosQueCobririam(pool, {
      tenantId: 'org',
      embedding: null,
      threshold: 0.72,
      mencionados: [propriaDesligada],
    });
    // Ligá-la não faria material aparecer: não há material curado por trás dela. Sugerir
    // isso seria mandar o corretor clicar num botão que não resolve nada.
    expect(nomes).toEqual([]);
  });

  it('com o vetor da pergunta, consulta o catálogo restrito às desligadas DESTE tenant', async () => {
    const { pool, query } = poolFalso((sql) =>
      sql.includes('catalog_chunks') ? { rows: [{ display_name: 'Bradesco Saúde' }] } : { rows: [] },
    );
    const nomes = await escoposDesligadosQueCobririam(pool, {
      tenantId: 'org',
      embedding: '[0.1,0.2]',
      threshold: 0.72,
    });
    expect(nomes).toEqual(['Bradesco Saúde']);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('not ks.is_active');
    // O recorte por organização é o que impede a leitura da partição compartilhada de
    // virar uma janela para o estado de outro tenant.
    expect(sql).toContain('ks.organization_id = $1');
  });

  it('falha na consulta do catálogo não derruba a escalação — devolve o que já tinha', async () => {
    const query = vi.fn().mockRejectedValue(new Error('relation "catalog_chunks" does not exist'));
    const nomes = await escoposDesligadosQueCobririam({ query } as never, {
      tenantId: 'org',
      embedding: '[0.1]',
      threshold: 0.72,
      mencionados: [SULAMERICA_DESLIGADA],
    });
    expect(nomes).toEqual(['SulAmérica']);
  });
});

describe('o bloco de prompt da pergunta', () => {
  it('lista só as operadoras ligadas e proíbe supor', () => {
    const bloco = blocoDePerguntaDeEscopo([AMIL, SULAMERICA_DESLIGADA]);
    expect(bloco).toContain('Amil');
    expect(bloco).not.toContain('SulAmérica');
    expect(bloco).toContain('NUNCA suponha');
    // As três inferências que FR-017 proíbe, nomeadas para o modelo — a regra vale
    // também para a metade dele, não só para a do código.
    expect(bloco).toContain('única da lista');
    expect(bloco).toContain('mais comum');
    expect(bloco).toContain('parece com');
  });

  it('sem operadora ligada, diz isso em vez de listar vazio', () => {
    expect(blocoDePerguntaDeEscopo([SULAMERICA_DESLIGADA])).toContain('ainda não marcou nenhuma operadora');
  });

  it('não usa vocabulário interno do produto na frase que o agente vai repetir', () => {
    const bloco = blocoDePerguntaDeEscopo([AMIL]);
    for (const jargao of ['escopo', 'lastro', 'chunk', 'embedding', 'RAG', 'guardrail']) {
      expect(bloco.toLowerCase()).not.toContain(jargao.toLowerCase());
    }
  });
});
