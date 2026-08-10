-- 0136 — a lacuna passa a saber de QUAL operadora ela é
--
-- Spec 002, T110 / SC-013: "carregar o material que cobre uma lacuna a faz sumir da lista".
--
-- ═══ POR QUE ISTO NÃO DAVA PARA FAZER ANTES ═══
--
-- O aviso de recusa (`agent_inbox_items`, kind `assistance_without_grounding`) guardava a
-- operadora **só como texto dentro do corpo**: a linha "Operadora: Amil" no meio de um
-- parágrafo escrito para o corretor ler. Para fechar a lacuna quando o material chegasse,
-- a única saída seria casar aquele nome por string — que é o anti-pattern nº 1 do
-- `CLAUDE.md` (string que deveria ser FK), e quebraria no primeiro rename de escopo.
--
-- Por isso SC-013 estava descumprido sem ninguém notar: a lista de lacunas some quando o
-- corretor clica "Marcar resolvido", e carregar material não fechava nada. A própria cópia
-- da tela já dizia outra coisa — "faz o agente resolver sozinho da próxima vez" —, que é
-- verdade e é menos do que o critério promete.
--
-- ═══ O QUE ESTA MIGRATION FAZ ═══
--
-- Um PONTEIRO (DIRC: Referenciar). `knowledge_scope_id` no aviso, com `on delete set null`:
-- escopo removido não apaga o histórico de que a pergunta ficou sem resposta — o aviso
-- continua legível pelo corpo, só deixa de ser fechável automaticamente. É a mesma decisão
-- de `knowledge_divergences.scope_id`.
--
-- Nulo é estado LEGÍTIMO e frequente: quando o agente não identifica a operadora, o aviso
-- nasce sem escopo. Esses NUNCA são fechados por chegada de material — não há como saber
-- qual material os cobriria, e fechá-los "por perto" esconderia a pergunta que mais
-- precisa de gente olhando.

alter table public.agent_inbox_items
  add column if not exists knowledge_scope_id uuid references public.knowledge_scopes(id) on delete set null;

comment on column public.agent_inbox_items.knowledge_scope_id is
  'Spec 002, T110 / SC-013: de qual operadora é a lacuna. Preenchido pela escalação de '
  'recusa sem lastro quando o vínculo do contato resolve um escopo; NULO quando o agente '
  'não identificou a operadora — e nulo NUNCA é fechado por chegada de material, porque '
  'não há como saber qual material cobriria. Antes desta coluna a operadora vivia só como '
  'texto dentro de `body`, e fechar a lacuna exigiria casar nome por string.';

-- A leitura quente é "as lacunas abertas DESTA operadora", que é o que o fechamento
-- automático pergunta a cada material indexado.
create index if not exists agent_inbox_items_escopo_aberto_idx
  on public.agent_inbox_items (organization_id, knowledge_scope_id, status)
  where knowledge_scope_id is not null;
