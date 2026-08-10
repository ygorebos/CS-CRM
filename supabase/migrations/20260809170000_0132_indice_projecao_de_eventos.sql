-- 0132 — Índice da projeção de eventos sobre mensagens (spec 006, T017 / FR-001..FR-005)
--
-- # O que este índice serve
--
-- Citação, reação e apagamento chegam pelo MESMO campo do envelope
-- (`message.reply_to_external_id`), e o ingest já os grava em
-- `messages.metadata->>'reply_to_external_id'` (`lib/gateway/ingest.ts`). Nada
-- disso era exibido: a citação ficava invisível, a reação virava uma bolha solta
-- com um emoji, e a mensagem apagada virava bolha em branco.
--
-- A leitura passa a projetar os três. Para cada página de conversa (50 mensagens)
-- ela pergunta UMA vez: "quem aponta para estes external_id?". Sem índice, essa
-- pergunta é varredura de `messages` — e o defeito não aparece em teste pequeno,
-- só na conversa grande de um cliente real. Por isso o índice entra na MESMA
-- migration que a projeção, e não como otimização depois.
--
-- # Por que parcial
--
-- A esmagadora maioria das mensagens não aponta para nenhuma outra. Indexar as
-- linhas com o campo nulo gastaria disco e escrita a cada INSERT do caminho mais
-- quente do sistema (recebimento de mensagem) sem servir a nenhuma consulta.
--
-- # Por que `organization_id` na frente
--
-- `external_id` é único POR ORGANIZAÇÃO (`messages_org_external_id_unique`), não
-- globalmente. A projeção filtra a organização da sessão, e a coluna precisa
-- liderar o índice para que o filtro seja seek, não recheck. Sem isso, um
-- `external_id` colidindo entre dois tenants faria o planejador varrer as linhas
-- do outro — e a segurança viria só do WHERE, o que é frágil demais para a Lei
-- Zero.
--
-- Natureza: ADITIVA. Nada é reescrito, nada é apagado. Reverter é dropar o
-- índice, sem perda de dado — por isso não há expand/contract a declarar.

create index if not exists idx_messages_reply_to_external_id
  on public.messages (organization_id, ((metadata ->> 'reply_to_external_id')))
  where metadata ->> 'reply_to_external_id' is not null;
