-- 0131 — funde o contato `lid:<digitos>` no `phone:+<digitos>` da mesma organização.
--
-- ─── O defeito que criou estas linhas ───────────────────────────────────────
--
-- O gateway classificava `558592431936@s.whatsapp.net` como `lid` porque o JID
-- chega COM domínio e a régua exigia só dígitos (`classificarContato`, corrigido
-- no gateway em 2026-08-09). O resultado: o MESMO telefone passou a existir duas
-- vezes —
--
--     phone:+558592431936   phone_number = +558592431936   (criado pelo CRM)
--     lid:558592431936      phone_number = NULL            (criado pelo gateway)
--
-- — em duas conversas distintas. Medido na instância de desenvolvimento: as
-- RESPOSTAS DO CLIENTE pousavam na conversa duplicada e ficavam invisíveis na
-- conversa que o atendente tinha aberta. Seis mensagens de entrada estavam lá.
--
-- ─── Por que é migration, e genérica ────────────────────────────────────────
--
-- O banco é compartilhado por todas as organizações. Consertar "a conversa de
-- fulano" arrumaria uma e deixaria as outras — o anti-pattern que a doutrina de
-- migrations nomeia (nunca hardcode de organização). Esta migration procura o
-- PADRÃO: todo contato cuja `wa_identity` é `lid:<digitos>` e cuja organização
-- já tem um contato `phone:+<mesmos digitos>`.
--
-- Um `lid` que NÃO casa com nenhum telefone fica onde está: é identificador
-- interno legítimo do WhatsApp (o `@lid` de verdade), e fundi-lo inventaria um
-- parentesco que ninguém mediu.
--
-- ─── Sem temp table, de propósito ───────────────────────────────────────────
--
-- O `baseline.sql` é aplicado por `psql` puro no CI e no ambiente fresco, e a
-- doutrina de migrations proíbe temp table fora de transação explícita. Tudo
-- aqui é CTE.
--
-- ─── Caminho de volta ───────────────────────────────────────────────────────
--
-- Nada é apagado. O contato duplicado sobrevive com `is_merged_into` apontando
-- para o canônico — o mecanismo que o próprio schema já usa para fusão. A
-- conversa duplicada que fica sem mensagem é FECHADA, nunca removida: ela é
-- âncora de FK, e apagá-la levaria histórico junto.
--
-- Idempotente: depois da primeira aplicação o duplicado tem `is_merged_into`
-- preenchido e sai do conjunto `lids`, então re-aplicar não faz nada.

-- ── 1. Mensagens da conversa duplicada vão para a conversa GÊMEA do canônico ─
--    (`conversations` é única por (organization_id, contact_id,
--     channel_session_id) quando não é grupo — repontar o contato direto
--     colidiria com a gêmea.)
with pares as (
  select l.id as duplicado, t.id as canonico
    from public.contacts l
    join public.contacts t
      on t.organization_id = l.organization_id
     and t.wa_identity = 'phone:+' || substring(l.wa_identity from 5)
     and t.is_merged_into is null
   where l.wa_identity like 'lid:%'
     and l.is_merged_into is null
     and substring(l.wa_identity from 5) ~ '^\d{10,15}$'
     and t.id <> l.id
),
gemeas as (
  select cd.id as conversa_duplicada, cc.id as conversa_canonica, p.canonico
    from pares p
    join public.conversations cd on cd.contact_id = p.duplicado and cd.is_group = false
    join public.conversations cc on cc.organization_id = cd.organization_id
                                and cc.contact_id = p.canonico
                                and cc.channel_session_id = cd.channel_session_id
                                and cc.is_group = false
)
update public.messages m
   set conversation_id = g.conversa_canonica,
       contact_id      = g.canonico,
       updated_at      = now()
  from gemeas g
 where m.conversation_id = g.conversa_duplicada;

-- ── 2. Sem gêmea: a própria conversa duplicada passa a ser do canônico ──────
with pares as (
  select l.id as duplicado, t.id as canonico
    from public.contacts l
    join public.contacts t
      on t.organization_id = l.organization_id
     and t.wa_identity = 'phone:+' || substring(l.wa_identity from 5)
     and t.is_merged_into is null
   where l.wa_identity like 'lid:%'
     and l.is_merged_into is null
     and substring(l.wa_identity from 5) ~ '^\d{10,15}$'
     and t.id <> l.id
),
orfas as (
  select cd.id as conversa, p.canonico
    from pares p
    join public.conversations cd on cd.contact_id = p.duplicado and cd.is_group = false
   where not exists (
     select 1 from public.conversations cc
      where cc.organization_id = cd.organization_id
        and cc.contact_id = p.canonico
        and cc.channel_session_id = cd.channel_session_id
        and cc.is_group = false)
)
update public.conversations c
   set contact_id = o.canonico,
       updated_at = now()
  from orfas o
 where c.id = o.conversa;

-- ── 3. As mensagens dessas conversas acompanham o contato ───────────────────
update public.messages m
   set contact_id = c.contact_id,
       updated_at = now()
  from public.conversations c
 where m.conversation_id = c.id
   and m.contact_id <> c.contact_id;

-- ── 4. Atividades que apontam para o contato duplicado ──────────────────────
with pares as (
  select l.id as duplicado, t.id as canonico
    from public.contacts l
    join public.contacts t
      on t.organization_id = l.organization_id
     and t.wa_identity = 'phone:+' || substring(l.wa_identity from 5)
     and t.is_merged_into is null
   where l.wa_identity like 'lid:%'
     and l.is_merged_into is null
     and substring(l.wa_identity from 5) ~ '^\d{10,15}$'
     and t.id <> l.id
)
update public.crm_lead_activities a
   set contact_id = p.canonico
  from pares p
 where a.contact_id = p.duplicado;

-- ── 5. Conversa duplicada que ficou vazia é FECHADA, nunca apagada ──────────
with pares as (
  select l.id as duplicado
    from public.contacts l
    join public.contacts t
      on t.organization_id = l.organization_id
     and t.wa_identity = 'phone:+' || substring(l.wa_identity from 5)
     and t.is_merged_into is null
   where l.wa_identity like 'lid:%'
     and l.is_merged_into is null
     and substring(l.wa_identity from 5) ~ '^\d{10,15}$'
     and t.id <> l.id
)
update public.conversations c
   set status = 'closed', updated_at = now()
  from pares p
 where c.contact_id = p.duplicado
   and c.status <> 'closed'
   and not exists (select 1 from public.messages m where m.conversation_id = c.id);

-- ── 6. Por último: o contato duplicado aponta para o canônico ───────────────
--    Depois disto ele sai do conjunto `lids`, e é o que torna a migration
--    idempotente. Tem de ser o ÚLTIMO passo: os anteriores dependem de ele
--    ainda estar com `is_merged_into is null`.
with pares as (
  select l.id as duplicado, t.id as canonico
    from public.contacts l
    join public.contacts t
      on t.organization_id = l.organization_id
     and t.wa_identity = 'phone:+' || substring(l.wa_identity from 5)
     and t.is_merged_into is null
   where l.wa_identity like 'lid:%'
     and l.is_merged_into is null
     and substring(l.wa_identity from 5) ~ '^\d{10,15}$'
     and t.id <> l.id
)
update public.contacts c
   set is_merged_into = p.canonico,
       updated_at     = now()
  from pares p
 where c.id = p.duplicado;
