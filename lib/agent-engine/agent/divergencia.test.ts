import { describe, expect, it, vi } from 'vitest';

import {
  assuntoDaDivergencia,
  divergenciasDe,
  registrarDivergencias,
  type LinhaPreterida,
} from './divergencia';

/**
 * A segunda metade de FR-035 (spec 002) — a divergência que o desempate produz.
 *
 * ## O que estes casos vigiam
 *
 * O desempate de camada silencia o material do catálogo quando o do corretor vence no mesmo
 * balde. Isso é certo para a resposta e cego para o corretor: dois textos discordam sobre o
 * mesmo assunto, um está errado, e sem registro ele descobre pelo cliente.
 *
 * Os dois defeitos que estes casos existem para pegar são de omissão, e passariam verdes
 * numa implementação "que funciona": registrar par sem os dois lados (o corretor abre a
 * lista e não tem o que comparar), e registrar o assunto do material errado (ele relê o
 * texto que não estava em disputa e conclui que o aviso é ruído).
 */

const TEXTO_BOLETO = 'A segunda via do boleto sai pelo aplicativo, em Financeiro.';
const TEXTO_BOLETO_OUTRO = 'O boleto em atraso é reemitido com juros pela central.';
const TEXTO_REDE = 'A rede credenciada de hospitais inclui atendimento de urgência.';

const preterida = (over: Partial<LinhaPreterida> = {}): LinhaPreterida => ({
  material_id: 'cat-1',
  content: TEXTO_BOLETO_OUTRO,
  preterido_por_material: 'src-1',
  ...over,
});

describe('assuntoDaDivergencia · sobre o que os dois discordam', () => {
  it('usa o assunto que os DOIS materiais tocam, não o primeiro do perdedor', () => {
    // O perdedor toca dois assuntos, e o léxico devolve `rede` antes de `prazos`. Se a
    // interseção sumir, isto vira 'rede' e o corretor é mandado reler o parágrafo de
    // hospitais quando a discordância está na carência. O caso é montado assim de
    // propósito: com um perdedor de assunto único, remover a interseção não muda nada e
    // o teste passaria verde vigiando coisa nenhuma.
    const perdedor = 'A rede credenciada atende urgência, e a carência para parto é de 300 dias.';
    const vencedor = 'A carência para parto no nosso contrato é de 180 dias.';
    expect(assuntoDaDivergencia(perdedor, null)).toBe('rede');
    expect(assuntoDaDivergencia(perdedor, vencedor)).toBe('prazos');
  });

  it('sem assunto em comum, cai no do perdedor — melhor um aviso impreciso que nenhum', () => {
    // Semanticamente vizinhos o bastante para a busca trazer os dois, falando de coisas
    // diferentes. O corretor ainda precisa saber que houve desempate.
    expect(assuntoDaDivergencia(TEXTO_REDE, TEXTO_BOLETO)).toBe('rede');
  });

  it('texto que o léxico não classifica devolve vazio, e vazio NÃO é falha', () => {
    // É o caso mais suspeito de todos: material sobre assunto que ninguém previu. Engolir
    // a divergência aqui esconderia exatamente o que não temos vocabulário para ver.
    expect(assuntoDaDivergencia('Bom dia, tudo bem por aí?', null)).toBe('');
  });
});

describe('divergenciasDe · que pares chegam ao corretor', () => {
  it('registra o par com os dois lados e o balde onde o desempate aconteceu', () => {
    const d = divergenciasDe({
      scopeId: 'escopo-a',
      preteridas: [preterida()],
      vencedoras: [{ material_id: 'src-1', content: TEXTO_BOLETO }],
    });
    expect(d).toEqual([
      {
        winnerSourceId: 'src-1',
        loserMaterialId: 'cat-1',
        scopeId: 'escopo-a',
        subject: 'cobranca',
      },
    ]);
  });

  it('linha sem um dos lados não vira registro pela metade', () => {
    // Divergência é a comparação entre DOIS materiais. Gravar só um deixaria na tela do
    // corretor um aviso sem o que conferir — pior que não avisar.
    const d = divergenciasDe({
      scopeId: null,
      preteridas: [preterida({ preterido_por_material: null }), preterida({ material_id: null })],
      vencedoras: [],
    });
    expect(d).toEqual([]);
  });

  it('vários trechos do mesmo material viram UM registro', () => {
    // Não é economia: `on conflict do update` do Postgres recusa afetar a mesma linha duas
    // vezes na mesma instrução, e material longo sempre traz vários trechos. Sem o dedupe,
    // o registro falha justamente no caso mais comum.
    const d = divergenciasDe({
      scopeId: 'escopo-a',
      preteridas: [
        preterida({ content: TEXTO_BOLETO_OUTRO }),
        preterida({ content: 'Boleto vencido: pague pelo código de barras do app.' }),
      ],
      vencedoras: [{ material_id: 'src-1', content: TEXTO_BOLETO }],
    });
    expect(d).toHaveLength(1);
    expect(d[0]?.subject).toBe('cobranca');
  });

  it('assuntos diferentes entre os mesmos materiais são divergências distintas', () => {
    // Mesmo par, dois assuntos: são dois problemas separados, e colapsá-los faria o
    // segundo sumir da lista quando o corretor resolvesse o primeiro.
    const d = divergenciasDe({
      scopeId: 'escopo-a',
      preteridas: [
        preterida({ content: TEXTO_BOLETO_OUTRO }),
        preterida({ content: TEXTO_REDE }),
      ],
      vencedoras: [{ material_id: 'src-1', content: `${TEXTO_BOLETO} ${TEXTO_REDE}` }],
    });
    expect(d.map((x) => x.subject).sort()).toEqual(['cobranca', 'rede']);
  });

  it('escopo desconhecido registra com balde nulo, e não deixa de registrar', () => {
    const d = divergenciasDe({
      scopeId: null,
      preteridas: [preterida()],
      vencedoras: [{ material_id: 'src-1', content: TEXTO_BOLETO }],
    });
    expect(d[0]?.scopeId).toBeNull();
  });
});

describe('registrarDivergencias · nunca derruba a resposta', () => {
  const pool = (query: ReturnType<typeof vi.fn>) => ({ query }) as never;

  it('falha de escrita vira aviso no log, não exceção', async () => {
    // Mesmo contrato da telemetria de `knowledge_searches`: deixar a exceção subir
    // transformaria isto em `knowledge_unavailable`, e o agente diria ao cliente que a
    // base caiu por causa de uma linha de diagnóstico.
    const query = vi.fn().mockRejectedValue(new Error('deadlock detected'));
    const warn = vi.fn();
    await expect(
      registrarDivergencias(
        pool(query),
        'org-1',
        [{ winnerSourceId: 'src-1', loserMaterialId: 'cat-1', scopeId: null, subject: 'cobranca' }],
        { warn } as never,
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('lista vazia não vai ao banco', async () => {
    const query = vi.fn();
    await registrarDivergencias(pool(query), 'org-1', []);
    expect(query).not.toHaveBeenCalled();
  });
});
