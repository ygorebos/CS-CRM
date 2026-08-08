-- 0128 — a superfície de escrita do gateway: duas funções, e o motivo de cada trava.
--
-- Contexto (spec 004, decisão de escrita direta; constituição v2.3.0 Princípio
-- VII). O fork do `gateway_go` apontado para o CRM grava por AQUI, e só por aqui.
-- O papel `gateway_writer` (migration 0127) não tem grant de tabela nenhum, então
-- estas funções são literalmente tudo que ele consegue fazer.
--
-- ═══ LEIA ISTO ANTES DE COPIAR A FUNÇÃO ═══
--
-- A linha `set constraints public.messages_org_external_id_unique immediate` NÃO
-- é otimização nem zelo. Sem ela a função NÃO FUNCIONA, e falha do jeito pior:
-- silenciosa no teste feliz, fatal na primeira redelivery. Medido em pg17:
--
--   * `messages_org_external_id_unique` é DEFERRABLE INITIALLY DEFERRED
--     (baseline.sql:2116), então a violação só existe no COMMIT;
--   * a essa altura o bloco `exception when unique_violation` JÁ PASSOU — ele
--     nunca dispara, e a transação inteira morre no commit;
--   * `on conflict (organization_id, external_id)` também não serve:
--     "ON CONFLICT does not support deferrable unique constraints as arbiters";
--   * criar um índice único imediato adicional sobre as mesmas colunas **não
--     resolve** — testado, o Postgres continua recusando o árbitro.
--
-- Tornar a constraint imediata dentro da transação foi o ÚNICO caminho que
-- funcionou. Toda função nova que inserir em `messages` precisa da linha.
--
-- ═══ Taxonomia de erro (FR-005) ═══
--
-- Duas classes, e o contrato não admite uma terceira:
--
--   * DEFINITIVO  — SQLSTATE começando em 'GW'. Conexão desconhecida, arquivada,
--                   de outro dono; argumento inválido. O gateway descarta e
--                   registra. Retentar nunca vai passar.
--   * TRANSITÓRIO — qualquer outro SQLSTATE (40001 serialization_failure, 08006
--                   connection_failure, 57014 query_canceled…). O gateway
--                   retenta com recuo.
--
-- Erro sem classe declarada é TRANSITÓRIO do lado do gateway. A assimetria é
-- deliberada: mensagem descartada por engano é invisível, mensagem retentada por
-- engano é barulhenta.

-- ══════════════════════════════════════════════════════════════════════════════
-- 1 · fn_gateway_ingest_message — mensagem recebida ou eco de envio
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.fn_gateway_ingest_message(
  p_gateway_connection_id text,
  p_external_id           text,
  p_direction             text,
  p_type                  text,
  p_contact_kind          text,
  p_eh_grupo              boolean default false,
  p_contact_phone         text    default null,
  p_contact_lid           text    default null,
  p_contact_chat_id       text    default null,
  p_contact_notify        text    default null,
  p_body                  text    default null,
  p_sent_at               timestamptz default now(),
  p_eh_eco                boolean default false,
  p_status                text    default null,
  p_sent_via              text    default null,
  p_media_url             text    default null,
  p_media_mime            text    default null,
  p_media_size_bytes      bigint  default null,
  p_media_storage_path    text    default null,
  p_metadata              jsonb   default '{}'::jsonb
)
returns table (message_id uuid, duplicada boolean, motivo text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org       uuid;
  v_session   uuid;
  v_contact   uuid;
  v_conv      uuid;
  v_id        uuid;
  v_status    text;
  v_sent_via  text;
begin
  -- ── 1. Tenant, resolvido DENTRO do banco pela conexão de origem ──
  -- Trava nº 3 do Princípio VII. `organization_id` não é parâmetro e não pode
  -- ser: quem chama escolhe qual conexão usar, nunca de quem é o dado.
  select cs.organization_id, cs.id
    into v_org, v_session
    from public.channel_sessions cs
   where cs.gateway_connection_id = p_gateway_connection_id
     and cs.archived_at is null
   limit 1;

  if v_org is null then
    -- DEFINITIVO: conexão inexistente ou arquivada. Retentar não vai criar a
    -- linha; o gateway tem de descartar e abrir aviso, não insistir para sempre.
    raise exception 'gateway: conexao desconhecida ou arquivada (%)', p_gateway_connection_id
      using errcode = 'GW001';
  end if;

  if p_direction is null or p_direction not in ('inbound', 'outbound') then
    raise exception 'gateway: direction invalida (%)', p_direction using errcode = 'GW003';
  end if;

  if p_external_id is null or length(btrim(p_external_id)) = 0 then
    -- Sem referência externa não há idempotência possível, e uma redelivery
    -- viraria mensagem duplicada na conversa do cliente.
    raise exception 'gateway: external_id obrigatorio' using errcode = 'GW003';
  end if;

  -- ── Grupo: doutrina vigente, e a razão de ela existir aqui também ──
  -- Conversa de grupo não vira vínculo no CRM (`CLAUDE.md`, seção WAHA). O
  -- caminho por HTTP já descarta em `lib/gateway/ingest.ts:99-107`; sem esta
  -- guarda, trocar o escritor **mudaria o comportamento em silêncio** — grupos
  -- passariam a criar contato e conversa, e o agente responderia em grupo.
  -- Ignorar é decisão, não descarte mudo: o motivo volta para quem chamou.
  if coalesce(p_eh_grupo, false) then
    return query select null::uuid, false, 'grupo_nao_vinculado'::text;
    return;
  end if;

  -- ── 2. A linha sem a qual nada abaixo funciona. Ver o cabeçalho. ──
  set constraints public.messages_org_external_id_unique immediate;

  -- ── 3. Contato e conversa, pelas funções que já existem ──
  v_contact := public.fn_upsert_wa_contact(
    v_org, p_contact_kind, p_contact_phone, p_contact_lid, p_contact_chat_id, p_contact_notify);
  v_conv := public.fn_upsert_wa_conversation(v_org, v_contact, v_session);

  v_status   := coalesce(p_status, case when p_direction = 'inbound' then 'received' else 'sent' end);
  -- `sent_via` responde "quem colocou esta mensagem aqui", e a resposta NÃO é
  -- 'crm' fora do envio feito por nós. Mensagem RECEBIDA veio do aparelho do
  -- cliente; eco veio do aparelho do corretor. Só o envio que passou pela nossa
  -- API é 'crm' — marcar recebida como 'crm' faria a conversa exibir mensagem do
  -- cliente como se o sistema a tivesse mandado. Espelha
  -- `lib/gateway/ingest.ts:157`.
  v_sent_via := coalesce(
    p_sent_via,
    case when p_direction = 'outbound' and not coalesce(p_eh_eco, false) then 'crm'
         else 'external_device' end);

  -- ── 4. A mensagem. Duplicata é SUCESSO, não erro (FR-006). ──
  begin
    insert into public.messages (
      organization_id, conversation_id, channel_session_id, contact_id,
      external_id, type, direction, status, body, sent_via, sent_at,
      media_url, media_mime, media_size_bytes, media_storage_path, metadata)
    values (
      v_org, v_conv, v_session, v_contact,
      p_external_id, p_type, p_direction, v_status, p_body, v_sent_via, p_sent_at,
      p_media_url, p_media_mime, p_media_size_bytes, p_media_storage_path,
      coalesce(p_metadata, '{}'::jsonb))
    returning id into v_id;
  exception when unique_violation then
    select m.id into v_id
      from public.messages m
     where m.organization_id = v_org and m.external_id = p_external_id
     limit 1;
    -- Sai cedo de propósito: reprocessar contato/conversa/dispatch numa
    -- redelivery acordaria o agente duas vezes para a mesma mensagem.
    return query select v_id, true, null::text;
    return;
  end;

  -- ── 5. A cadeia viva, na MESMA transação do insert (FR-008) ──
  -- O trigger `trg_messages_emit_event` já emite `message.received`, mas ele NÃO
  -- acorda o agente. Quem acorda é este evento, e até aqui ele só era emitido por
  -- código de aplicação, numa viagem separada — morrer entre o insert e a emissão
  -- deixava mensagem sem atendimento, sem ninguém perceber. Aqui: os dois ou
  -- nenhum.
  if p_direction = 'inbound' and not coalesce(p_eh_eco, false) then
    perform public.emit_event(
      'ai_agent.dispatch_requested', 'message', v_id,
      jsonb_build_object(
        'organization_id',    v_org,
        'conversation_id',    v_conv,
        'contact_id',         v_contact,
        'channel_session_id', v_session,
        'inbound_message_id', v_id),
      jsonb_build_object('source', 'gateway_funcao'),
      v_org);
  end if;

  perform public.fn_mark_conversation_message(v_conv, p_direction, left(coalesce(p_body, ''), 200), p_sent_at);

  return query select v_id, false, null::text;
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2 · fn_gateway_update_message_status — o ACK
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Porta a guarda de não-regressão de `lib/gateway/ingest.ts:279-322`, sem mudar
-- regra nenhuma. Ela existe porque ACK chega fora de ordem: sem a guarda, um
-- `sent` atrasado sobrescreve um `read` e o visto azul some da tela do corretor.
-- Note que o caminho do WAHA (`lib/waha/ingest.ts:657-677`) NÃO tem essa guarda —
-- migrar para o gateway herda um ACK melhor que o atual, de graça.
create or replace function public.fn_gateway_update_message_status(
  p_gateway_connection_id text,
  p_external_id           text,
  p_status                text,
  p_at                    timestamptz default now(),
  p_error_code            text default null,
  p_error_message         text default null
)
returns table (efeito text, motivo text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org    uuid;
  v_id     uuid;
  v_atual  text;
  v_antes  int;
  v_depois int;
begin
  select cs.organization_id into v_org
    from public.channel_sessions cs
   where cs.gateway_connection_id = p_gateway_connection_id
     and cs.archived_at is null
   limit 1;

  if v_org is null then
    raise exception 'gateway: conexao desconhecida ou arquivada (%)', p_gateway_connection_id
      using errcode = 'GW001';
  end if;

  select m.id, m.status into v_id, v_atual
    from public.messages m
   where m.organization_id = v_org and m.external_id = p_external_id
   limit 1;

  if v_id is null then
    -- Confirmação para mensagem que o CRM ainda não conhece. Acontece com
    -- entrega fora de ordem. Criar mensagem fantasma seria PIOR que não fazer
    -- nada: ela apareceria na conversa sem corpo e sem autor.
    return query select 'ignorado'::text, 'mensagem_desconhecida'::text;
    return;
  end if;

  -- Ordem dos estados. Espelha ORDEM_DO_ESTADO do TypeScript; mudar um lado sem
  -- o outro faz os dois caminhos discordarem sobre o que é regressão.
  v_antes  := case v_atual  when 'queued' then 0 when 'sending' then 1
                            when 'sent' then 2 when 'received' then 2
                            when 'delivered' then 3 when 'read' then 4
                            when 'failed' then 5 else -1 end;
  v_depois := case p_status when 'queued' then 0 when 'sending' then 1
                            when 'sent' then 2 when 'received' then 2
                            when 'delivered' then 3 when 'read' then 4
                            when 'failed' then 5 else -1 end;

  -- `failed` sempre entra: é informação nova mesmo depois de `read` (mensagem que
  -- falhou numa segunda tentativa). Os demais só avançam.
  if p_status <> 'failed' and v_depois <= v_antes then
    return query select 'ignorado'::text, 'estado_nao_regride'::text;
    return;
  end if;

  update public.messages m
     set status        = p_status,
         delivered_at  = case when p_status = 'delivered' then coalesce(m.delivered_at, p_at) else m.delivered_at end,
         read_at       = case when p_status = 'read'      then coalesce(m.read_at, p_at)      else m.read_at end,
         error_code    = coalesce(p_error_code, m.error_code),
         error_message = coalesce(p_error_message, m.error_message),
         updated_at    = now()
   where m.id = v_id;

  return query select 'aplicado'::text, null::text;
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3 · Grants — as DUAS origens de EXECUTE, e por que revogar só uma não basta
-- ══════════════════════════════════════════════════════════════════════════════
--
-- (A) O baseline tem `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO
--     anon`, que alcança TODA função criada depois dele — isto é, todo apêndice
--     novo. `revoke from public` NÃO remove esse grant.
-- (B) O Postgres concede EXECUTE a PUBLIC em qualquer função ao criá-la.
--     `revoke from anon` NÃO remove esse.
--
-- Tratar só uma das duas deixa a função exposta como RPC alcançável pela anon
-- key — que vai para o browser — com o gate verde. Vigiado por
-- `tests/invariants/hardening-definer-varredura.test.ts`.
revoke execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) from public;
revoke execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) from anon;
revoke execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) from authenticated;
grant  execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) to gateway_writer, service_role;

revoke execute on function public.fn_gateway_update_message_status(text,text,text,timestamptz,text,text) from public;
revoke execute on function public.fn_gateway_update_message_status(text,text,text,timestamptz,text,text) from anon;
revoke execute on function public.fn_gateway_update_message_status(text,text,text,timestamptz,text,text) from authenticated;
grant  execute on function public.fn_gateway_update_message_status(text,text,text,timestamptz,text,text) to gateway_writer, service_role;

notify pgrst, 'reload schema';
