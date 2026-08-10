/**
 * A âncora como REGISTRO permanente — spec 002 (RAG por operadora), FR-021 e FR-023, T105.
 *
 * ═══ POR QUE ISTO EXISTE SE A ÂNCORA JÁ ESTÁ NA MENSAGEM ═══
 *
 * A T026 já grava as citações em `messages.metadata`, e isso basta para a TELA: o painel
 * mostra a origem, e a cópia viaja embutida na mensagem, então sobrevive à reindexação.
 * O que `jsonb` não dá, e FR-021 pede:
 *
 *   · consultar âncora sem varrer mensagem ("que material ancorou respostas este mês?");
 *   · filtrar por camada ou material num `where` que use índice;
 *   · garantir que o campo existe — `jsonb` não tem `not null` por chave, e uma resposta
 *     gravada sem citação é hoje indistinguível de uma que nunca deveria ter tido.
 *
 * É a diferença entre "a tela consegue mostrar" e "o sistema consegue provar".
 *
 * ═══ O QUE ACONTECE QUANDO A GRAVAÇÃO FALHA ═══
 *
 * FR-024 diz "ou a resposta é rastreável, ou não é enviada". Literalmente, isso exigiria
 * gravar ANTES de enviar — e é impossível: a linha em `message_groundings` referencia
 * `messages.id`, que só existe depois que o envio criou a mensagem.
 *
 * O que cumpre o requisito de verdade já está feito, e não é isto: a âncora nasce ATÔMICA
 * com a mensagem, dentro do mesmo insert, porque viaja em `metadata` (`inbound-turn.ts`, no
 * `send`). Uma mensagem sem âncora não chega a existir. Este registro é a projeção
 * consultável daquilo — e por isso a falha dele **não** pode derrubar o turno nem
 * transformar-se em não-envio: a resposta já saiu, e o cliente já a leu.
 *
 * Mas também não pode sumir calada (Princípio II): falha aqui vira aviso no log, no mesmo
 * contrato da telemetria de busca.
 */
import type pg from 'pg';

import type { Citation } from '@/lib/ai/citations/types';
import type { Logger } from '../obs/logger';

export interface LinhaDeGrounding {
  readonly chunkId: string | null;
  readonly layer: 'tenant' | 'catalog';
  readonly materialId: string | null;
  readonly similarity: number | null;
  /** A cópia congelada: título, escopo e data como estavam quando a resposta saiu. */
  readonly sourceRef: Record<string, unknown>;
}

/**
 * Citação → linha de registro.
 *
 * Citação sem camada reconhecida é **descartada**, e isso é decisão, não descuido: `layer`
 * tem CHECK no banco, e uma linha com camada inventada faria o insert inteiro falhar,
 * levando junto as âncoras boas da mesma resposta. Perder uma âncora malformada é melhor
 * que perder todas.
 */
export function linhasDeGrounding(citations: readonly Citation[]): LinhaDeGrounding[] {
  const out: LinhaDeGrounding[] = [];
  for (const c of citations) {
    const meta = (c.metadata ?? {}) as Record<string, unknown>;
    const layer = meta.layer;
    if (layer !== 'tenant' && layer !== 'catalog') continue;
    out.push({
      chunkId: c.chunk_id ?? null,
      layer,
      materialId: typeof meta.material_id === 'string' ? meta.material_id : null,
      similarity: typeof c.score === 'number' ? c.score : null,
      sourceRef: meta,
    });
  }
  return out;
}

/**
 * Grava, sem nunca derrubar o turno (ver o docblock do arquivo).
 *
 * `on conflict do nothing` na chave `(message_id, chunk_id)`: reprocessar o mesmo turno
 * depois de um crash não pode dobrar a contagem de "quantas vezes este material respondeu"
 * — é número que vira decisão de curadoria.
 */
export async function registrarGroundings(
  pool: pg.Pool,
  args: {
    organizationId: string;
    messageId: string;
    citations: readonly Citation[];
  },
  log?: Logger,
): Promise<void> {
  const linhas = linhasDeGrounding(args.citations);
  if (linhas.length === 0) return;
  try {
    await pool.query(
      `insert into message_groundings
         (organization_id, message_id, layer, chunk_id, material_id, similarity, source_ref)
       select $1, $2, l, c, m, s, r
         from unnest($3::text[], $4::uuid[], $5::uuid[], $6::real[], $7::jsonb[])
              as t(l, c, m, s, r)
       on conflict (message_id, chunk_id) where chunk_id is not null do nothing`,
      [
        args.organizationId,
        args.messageId,
        linhas.map((l) => l.layer),
        linhas.map((l) => l.chunkId),
        linhas.map((l) => l.materialId),
        linhas.map((l) => l.similarity),
        linhas.map((l) => JSON.stringify(l.sourceRef)),
      ],
    );
  } catch (err) {
    log?.warn('âncora da resposta não registrada', {
      messageId: args.messageId,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}
