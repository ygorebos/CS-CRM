-- 0133 — Tipos interativos de mensagem (spec 006, T061 / FR-016)
--
-- `messages_type_check` passa a aceitar três formas que o canal já entrega e que
-- o CRM não tinha como registrar:
--
--   menu             — opções clicáveis (botões até 3, lista acima disso)
--   cta_url          — botão que abre uma URL
--   location_request — botão que pede a localização do contato
--
-- # Por que tipo próprio, e não `text`
--
-- O tipo é a coluna que diz o que o contato DE FATO viu. Gravar um menu como
-- `text` apagaria a diferença entre "mandei uma pergunta" e "mandei três botões",
-- e com ela a única forma de responder "quantos menus eu disparei?" sem varrer
-- jsonb. É o mesmo racional da 0091, que acrescentou `template`.
--
-- # Natureza: ADITIVA, expand puro
--
-- O conjunto antigo é subconjunto do novo, então **backfill é zero por
-- construção** e a re-aplicação num banco com dado antigo não quebra. Não há
-- contract a declarar: nada deixa de ser aceito.
--
-- # Forma
--
-- `drop constraint if exists` + `add constraint` com a lista INTEIRA — o mesmo
-- molde da 0091. Alterar constraint em Postgres não tem `alter ... add value`
-- como enum tem; e é por isso que `type` é `text` + CHECK neste schema, e não
-- enum: estender é reescrever uma linha, não migrar um tipo.

do $$ begin
  alter table public.messages drop constraint if exists messages_type_check;
  alter table public.messages add constraint messages_type_check
    check (type = any (array[
      'text', 'image', 'video', 'audio', 'document', 'sticker',
      'location', 'contact', 'reaction', 'system', 'template',
      -- novos: formas interativas que o canal entrega e o CRM passa a registrar
      'menu', 'cta_url', 'location_request'
    ]));
end $$;
