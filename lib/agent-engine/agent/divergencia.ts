/**
 * A divergência que o desempate produz — spec 002 (RAG por operadora), FR-035, T080.
 *
 * ═══ O QUE ESTE ARQUIVO EXISTE PARA IMPEDIR ═══
 *
 * Quando o material do corretor vence o do catálogo no mesmo balde, os dois textos dizem
 * coisas diferentes sobre o mesmo assunto e **um deles está errado**. O desempate escolhe
 * um e silencia o outro: certo para a resposta, e cego para o corretor — que nunca fica
 * sabendo que o próprio material contradiz a operadora, e descobre pelo cliente.
 *
 * FR-035 tem duas metades, e só a do desempate existia. Esta é a outra.
 *
 * ═══ POR QUE AS FUNÇÕES AQUI SÃO PURAS ═══
 *
 * "Qual assunto está em disputa" e "que pares registrar" são REGRA, e regra enterrada
 * dentro de um `pool.query` não tem teste. O I/O fica em `registrarDivergencias`, que é
 * uma linha de SQL; a decisão fica em `divergenciasDe`, que é o que os casos exercitam.
 */
import type pg from 'pg';

import {
  detectarAssuntoDeAssistencia,
  type CategoriaAssistencia,
} from '../guardrails/lexico-assistencia';
import type { Logger } from '../obs/logger';

/** Uma linha que o desempate rejeitou (`preterido = true` em `fn_buscar_lastro`). */
export interface LinhaPreterida {
  /** `catalog_materials.id` — o perdedor é sempre da camada do catálogo. */
  readonly material_id: string | null;
  readonly content: string;
  /** `ai_knowledge_sources.id` do material do tenant que a venceu naquele balde. */
  readonly preterido_por_material: string | null;
}

/** Uma linha que o desempate manteve, usada só para achar o assunto em comum. */
export interface LinhaVencedora {
  readonly material_id: string | null;
  readonly content: string;
}

export interface DivergenciaARegistrar {
  readonly winnerSourceId: string;
  readonly loserMaterialId: string;
  readonly scopeId: string | null;
  /** Categoria do léxico fechado, ou `''` quando nenhuma reconhece o texto. */
  readonly subject: CategoriaAssistencia | '';
}

/**
 * Sobre O QUE os dois materiais discordam.
 *
 * A resposta útil ao corretor é o assunto que os DOIS tocam: se o material dele fala de
 * boleto e o do catálogo, na mesma vizinhança semântica, fala de rede credenciada, mandá-lo
 * conferir "rede" o faz reler o texto errado. Por isso a interseção vem primeiro, e o
 * assunto do perdedor é só o desempate quando não há interseção.
 *
 * Vazio (`''`) é resposta legítima, não falha: divergência cujo texto o léxico não
 * classifica continua sendo divergência, e engoli-la seria perder o caso mais suspeito —
 * material sobre assunto que ninguém previu.
 */
export function assuntoDaDivergencia(
  textoPerdedor: string,
  textoVencedor: string | null,
): CategoriaAssistencia | '' {
  const doPerdedor = detectarAssuntoDeAssistencia(textoPerdedor).categorias;
  if (textoVencedor !== null) {
    const doVencedor = new Set(detectarAssuntoDeAssistencia(textoVencedor).categorias);
    const comum = doPerdedor.find((c) => doVencedor.has(c));
    if (comum !== undefined) return comum;
  }
  return doPerdedor[0] ?? '';
}

/**
 * Que pares registrar, já deduplicados.
 *
 * O dedupe não é economia: o `insert ... on conflict do update` do Postgres recusa afetar
 * a MESMA linha duas vezes na mesma instrução, e uma pergunta que traz dois trechos do
 * mesmo material do catálogo produz exatamente isso. Sem dedupe aqui, o registro falharia
 * justamente no caso mais comum — material longo, vários trechos.
 */
export function divergenciasDe(args: {
  readonly scopeId: string | null;
  readonly preteridas: readonly LinhaPreterida[];
  readonly vencedoras: readonly LinhaVencedora[];
}): DivergenciaARegistrar[] {
  const porChave = new Map<string, DivergenciaARegistrar>();

  for (const p of args.preteridas) {
    // Sem os dois lados não há o que o corretor compare. Linha assim não é registrada em
    // silêncio nem vira linha pela metade: ela simplesmente não é divergência.
    if (p.material_id === null || p.preterido_por_material === null) continue;

    const vencedora = args.vencedoras.find((v) => v.material_id === p.preterido_por_material);
    const subject = assuntoDaDivergencia(p.content, vencedora?.content ?? null);
    // A chave É o dedupe — `Map.set` sobrescreve, e é por isso que não há um `if (já
    // existe) continue` aqui: medido por sabotagem em 2026-08-08, esse guard passava verde
    // ao ser removido, porque não fazia nada. Guard que não vigia nada é pior que ausente:
    // parece proteção.
    const chave = `${p.preterido_por_material}|${p.material_id}|${subject}`;
    porChave.set(chave, {
      winnerSourceId: p.preterido_por_material,
      loserMaterialId: p.material_id,
      scopeId: args.scopeId,
      subject,
    });
  }

  return [...porChave.values()];
}

/**
 * Grava, sem nunca derrubar a resposta.
 *
 * Mesmo contrato da telemetria de `knowledge_searches`: perder o registro é perder uma
 * linha de painel; deixar a exceção subir seria transformar isto em `knowledge_unavailable`
 * e dizer ao cliente que a base caiu por causa de uma escrita de diagnóstico.
 *
 * `occurrences` sobe a cada aparição e `last_seen_at` avança **mesmo em divergência já
 * resolvida** — é assim que "resolvi e continua acontecendo" fica visível sem reabrir
 * sozinha o que o corretor fechou de propósito.
 */
export async function registrarDivergencias(
  pool: pg.Pool,
  organizationId: string,
  divergencias: readonly DivergenciaARegistrar[],
  log?: Logger,
): Promise<void> {
  if (divergencias.length === 0) return;
  try {
    await pool.query(
      `insert into knowledge_divergences
         (organization_id, winner_source_id, loser_material_id, scope_id, subject)
       select $1, w, l, s, sub
         from unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[]) as t(w, l, s, sub)
       on conflict (organization_id, winner_source_id, loser_material_id, subject)
       do update set occurrences  = knowledge_divergences.occurrences + 1,
                     last_seen_at = now()`,
      [
        organizationId,
        divergencias.map((d) => d.winnerSourceId),
        divergencias.map((d) => d.loserMaterialId),
        divergencias.map((d) => d.scopeId),
        divergencias.map((d) => d.subject),
      ],
    );
  } catch (err) {
    log?.warn('divergência entre camadas não registrada', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}
