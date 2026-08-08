-- 0129 — o agente nasce com o guarda de lastro ligado
--
-- Spec 002 (RAG por operadora), FR-014 + FR-030. Fecha um buraco achado na revisão da
-- spec, que NENHUMA tarefa cobria.
--
-- ═══ O DEFEITO ═══
--
-- `ai_agents.guardrails` é `jsonb not null default '[]'`. E `resolverExigenciaDeLastro`
-- (lib/agent-engine/guardrails/assistance-grounding.ts) devolve `enforce: false` para lista
-- vazia — corretamente: lista vazia é lista sem `rag_must_hit`.
--
-- Junte os dois e o resultado é: **todo agente nasce com o gate `assistance_grounding`
-- desarmado**. Só o onboarding (`app/actions/onboarding/createDefaultAgent.ts`) escrevia o
-- guardrail à mão. Agente criado por `POST /api/v1/ai/agents`, por duplicação, por script de
-- seed ou por qualquer rota futura afirma procedimento, cobertura, carência ou rede **sem
-- nenhum material que sustente** — exatamente o defeito que esta spec inteira existe para
-- matar —, e a suíte fica verde enquanto isso.
--
-- ═══ POR QUE NO DEFAULT DA COLUNA, E NÃO EM CADA `insert` ═══
--
-- Porque a forma como o buraco nasceu é a prova do que o conserta. Ele não nasceu de
-- ninguém decidir desarmar: nasceu de UM caminho de criação lembrar e os outros não. Repetir
-- a constante em cada `insert` conserta os caminhos de hoje e deixa o próximo repetir o erro,
-- com o mesmo silêncio. O default da coluna é o único lugar por onde TODOS passam — inclusive
-- `psql` na mão e seed em script.
--
-- A constante de verdade continua em `lib/ai/agents/guardrails-padrao.ts`; este default é
-- cópia declarada dela, e `tests/invariants/agente-nasce-com-lastro.test.ts` reprova se as
-- duas discordarem. Não é duplicação sem dono: é duplicação com vigia.
--
-- ═══ O BACKFILL, E POR QUE ELE NÃO ATROPELA DECISÃO DE NINGUÉM ═══
--
-- Fica a dúvida óbvia: `guardrails = []` num agente que já existe significa "nunca
-- configurado" ou "o admin apagou de propósito"? A resposta é do histórico, não do palpite:
-- **até esta spec, nenhum runtime avaliava `rag_must_hit`** — está escrito no cabeçalho de
-- `resolverExigenciaDeLastro`, e é o defeito que originou o Princípio XI. Apagar o guardrail
-- da tela antes de agora era apagar um enfeite. Ninguém pôde optar por sair de uma garantia
-- que não existia, então não há decisão a preservar.
--
-- O backfill **acrescenta** em vez de substituir: `regex_output_block`, `window_check` e
-- companhia que o admin tenha configurado sobrevivem. E só mexe em quem não tem
-- `rag_must_hit` — reaplicar não duplica nada.
--
-- ═══ CAMINHO DE VOLTA (doutrina de migrations, instância única) ═══
--
-- `alter column guardrails set default '[]'::jsonb` volta o default; o backfill se desfaz
-- removendo os itens `rag_must_hit` do array. Nada é apagado nem renomeado — só acrescentado.
-- Daqui pra frente, quem quiser o agente sem o guarda desliga na tela: aí a decisão é dele,
-- tomada por escrito, depois de o guarda existir de verdade.

alter table public.ai_agents
  alter column guardrails set default
    '[{"kind": "rag_must_hit", "min_citations": 1, "reason": "não afirmar procedimento, cobertura, carência ou rede sem material carregado que sustente"}]'::jsonb;

-- `@>` não explode se a coluna tiver um objeto em vez de array (clone antigo, jsonb torto):
-- devolve false, e o `case` abaixo troca o valor por um array bem-formado. `jsonb_array_elements`
-- num não-array levantaria erro e derrubaria a re-aplicação do baseline.
update public.ai_agents
   set guardrails = case
         when jsonb_typeof(guardrails) = 'array'
           then guardrails || '{"kind": "rag_must_hit", "min_citations": 1, "reason": "não afirmar procedimento, cobertura, carência ou rede sem material carregado que sustente"}'::jsonb
         else '[{"kind": "rag_must_hit", "min_citations": 1, "reason": "não afirmar procedimento, cobertura, carência ou rede sem material carregado que sustente"}]'::jsonb
       end
 where jsonb_typeof(guardrails) is distinct from 'array'
    or not (guardrails @> '[{"kind": "rag_must_hit"}]'::jsonb);

comment on column public.ai_agents.guardrails is
  'Guardrails do agente (lib/ai/guardrails-schema.ts). O DEFAULT carrega rag_must_hit '
  '(migration 0129, spec 002 · FR-014/FR-030): recusar afirmação de assistência sem material '
  'que a sustente é comportamento de FÁBRICA, não opção avançada. O default é cópia declarada '
  'de GUARDRAILS_DO_AGENTE_PADRAO (lib/ai/agents/guardrails-padrao.ts), vigiada por '
  'tests/invariants/agente-nasce-com-lastro.test.ts. Lista vazia desarma o gate '
  'assistance_grounding — o que agora só acontece por decisão explícita na tela.';
