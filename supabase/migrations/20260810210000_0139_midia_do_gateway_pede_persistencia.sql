-- 0139: a mídia que entra pela quarta superfície pede a própria persistência
--
-- Medido em 2026-08-10, no gateway de dev: toda imagem recebida entrava como
-- mensagem sem anexo. A causa tinha duas metades, e esta é a do banco.
--
-- O CRM guarda o binário de mídia no bucket PRIVADO `whatsapp-media`, e quem o
-- coloca lá é `workers/media-persist-worker.ts`, acordado pelo evento
-- `media.persist_requested`. O caminho de ingestão por HTTP
-- (`lib/gateway/ingest.ts`) emite esse evento desde sempre. A escrita direta
-- pela função versionada — a quarta superfície do Princípio VII — nunca emitiu:
-- ela grava a mensagem, o anexo fica descrito em `metadata.media_ref`, e
-- ninguém nunca vai buscá-lo.
--
-- A outra metade é do gateway (`gateway_crm`, commit 1e45177): ele passou a
-- gravar a referência em vez de tentar subir o arquivo no Storage do Cotador.
--
-- `create or replace` da função inteira: o corpo é o da migration 0128 com o
-- bloco novo antes do dispatch do agente. A assinatura NÃO muda — ela é
-- contrato versionado (trava nº 4), e mudá-la exigiria uma função nova.

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
  -- O ANEXO. Sem este evento o arquivo nunca é buscado, e o sintoma na tela é
  -- anexo eternamente "carregando" — sinal de progresso para algo que não vai
  -- acontecer. Quem baixa é `workers/media-persist-worker.ts`, que resolve
  -- `metadata.media_ref` contra `GATEWAY_BASE_URL` (configuração NOSSA, nunca
  -- host vindo do payload) e grava no bucket privado `whatsapp-media`.
  --
  -- O caminho por HTTP (`lib/gateway/ingest.ts`) já emitia isto; a escrita
  -- direta pela quarta superfície não, então TODA mídia que entrava por ela
  -- ficava sem arquivo — mensagem na conversa, anexo nenhum.
  --
  -- Na MESMA transação do insert, pelo mesmo motivo do dispatch logo abaixo:
  -- morrer entre um e outro deixaria mensagem com anexo que ninguém vai buscar.
  if coalesce(btrim(p_metadata->>'media_ref'), '') <> '' and p_media_storage_path is null then
    perform public.emit_event(
      'media.persist_requested', 'message', v_id,
      jsonb_build_object('message_id', v_id, 'organization_id', v_org),
      jsonb_build_object('source', 'gateway_funcao'),
      v_org);
  end if;

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


-- A assinatura não mudou, então os grants da 0128 continuam valendo. Repetidos
-- assim mesmo: `create or replace` preserva as permissões, mas o apêndice do
-- baseline pode ser aplicado num banco onde a função nasce agora — e ali ela
-- nasceria EXPOSTA, pelos dois caminhos que a doutrina manda revogar (o
-- ALTER DEFAULT PRIVILEGES para anon, e o grant a PUBLIC que o Postgres dá a
-- toda função nova).
revoke execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) from public;
revoke execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) from anon;
revoke execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) from authenticated;
grant  execute on function public.fn_gateway_ingest_message(text,text,text,text,text,boolean,text,text,text,text,text,timestamptz,boolean,text,text,text,text,bigint,text,jsonb) to gateway_writer, service_role;
