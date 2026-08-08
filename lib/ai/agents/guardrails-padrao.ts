/**
 * Os guardrails com que o agente padrão da instalação nasce — spec 002, FR-030.
 *
 * Vive em módulo próprio, e não dentro da server action que o usa, por uma razão
 * prática: a action é `"use server"` e arrasta o client de Supabase e o `next/navigation`
 * ao ser importada. O valor que define o comportamento de fábrica do produto precisa ser
 * testável sem subir nada disso.
 *
 * ## O que esta constante impede
 *
 * O gate `assistance_grounding` nasce **desarmado** na cadeia `before_send`, e com razão:
 * no caminho determinístico (follow-up por template) um veto seria drop silencioso, e
 * cliente mudo é pior que o defeito que o gate veio corrigir. Quem o arma é o caminho do
 * agente, e só quando o guardrail `rag_must_hit` está ligado.
 *
 * Sem esta constante, a instalação fresca teria o guarda instalado e desligado — o agente
 * voltaria a afirmar procedimento de operadora sem material nenhum, e a suíte inteira
 * ficaria verde enquanto isso. É exatamente a classe de defeito que o Princípio XI nomeia:
 * a configuração existe, a tela mostra, e nada acontece.
 *
 * "Recusar sem lastro" é comportamento de fábrica, não opção avançada escondida num menu.
 * Quem quiser desligar, desliga na tela — e aí a decisão é dele, tomada por escrito.
 */
import type { Guardrails } from '@/lib/ai/guardrails-schema';

export const GUARDRAILS_DO_AGENTE_PADRAO: Guardrails = [
  {
    kind: 'rag_must_hit',
    min_citations: 1,
    reason:
      'não afirmar procedimento, cobertura, carência ou rede sem material carregado que sustente',
  },
];
