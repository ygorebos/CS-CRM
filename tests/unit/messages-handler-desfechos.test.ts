/**
 * Task 4a do seam de canais — rede de caracterização do caminho de envio.
 *
 * Fixa os 6 desfechos que `sendMessageHandler` produz DEPOIS de inserir a linha
 * (`_handler.ts:219-318`), escrita contra o código ATUAL, antes de qualquer
 * refactor. As Tasks 4b–4d trocam `getWahaClient`/`resolveWahaChatId`/`sendMedia`
 * por `ChannelAdapter` — por isso aqui se asserta o **estado final da linha de
 * mensagem**, nunca a sequência de chamadas internas: teste que asserta chamada
 * travaria exatamente o refactor que ele deveria proteger.
 *
 * Fake próprio de propósito: `tests/invariants/automation-send-whatsapp.test.ts`
 * é o único outro teste que exercita este handler, mas arrasta `gov-helpers` e
 * exige Postgres real — e a pasta `tests/invariants/` está fora do `test:unit` e
 * do CI. Duplicar scaffolding é o preço de uma rede que gateia PR em segundos.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';
// O adapter do gateway lê a config a cada chamada, do singleton de `lib/env` —
// `vi.stubEnv` não o alcança. Mutar o objeto é o caminho; restaurado no afterEach.
import { env as envDoApp } from '@/lib/env';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const WAHA_BASE = 'http://localhost:3030';

// A URL assinada do Storage é montada com o admin client; ele valida env no
// import, e o desfecho de mídia precisa controlar sucesso E falha da assinatura.
const signedUrl = vi.fn<() => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>>(
  async () => ({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null }),
);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    storage: { from: () => ({ createSignedUrl: signedUrl }) },
    // O adapter da Meta procura a credencial DA SESSÃO antes de cair no env
    // (`resolveMetaCreds`). Antes de 2026-08-08 a linha falsa não trazia
    // `meta_phone_number_id`, a busca era pulada por ref vazio, e o dublê nunca
    // precisava de `.from` — um caminho de produção inteiro ficava sem exercício.
    // Sem token na sessão o retorno é `null`, e o adapter cai no env: é o
    // fallback que as instalações de número único usam de verdade.
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}));
// Audit é fire-and-forget e escreve em outra tabela; fora do escopo dos desfechos.
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

type Row = Record<string, unknown>;

interface ConversationShape {
  isGroup?: boolean;
  groupChatId?: string | null;
  phoneNumber?: string | null;
  waIdentity?: string | null;
  isBlocked?: boolean;
  sessionStatus?: string | null;
  provider?: string;
  /** Canal excluído pelo usuário (migration 0106) — a linha sobrevive, o canal não. */
  archivedAt?: string | null;
}

/**
 * Referência da sessão POR PROVIDER, espelhando o CHECK
 * `channel_sessions_provider_ref_check` do banco: a coluna do canal da vez é NOT
 * NULL, as outras são NULL.
 *
 * Até 2026-08-08 a linha falsa gravava `waha_session_name: 'default'` para
 * QUALQUER provider — uma linha que o banco recusaria. Uma sessão `meta_cloud`
 * assim chegava ao adapter com `sessionRef: undefined` e o teste passava, porque
 * o adapter da Meta se endereça por env. Fixture que modela linha impossível não
 * prova o caminho de produção — prova o dublê.
 */
function refDoProvider(provider: string): Row {
  const vazio = {
    waha_session_name: null,
    meta_phone_number_id: null,
    gateway_connection_id: null,
  };
  switch (provider) {
    case 'waha':
      return { ...vazio, waha_session_name: 'default' };
    case 'meta_cloud':
      return { ...vazio, meta_phone_number_id: '1103328999528818' };
    case 'whatsapp_uazapi':
    case 'whatsapp_cloud':
    case 'instagram':
    case 'messenger':
      return { ...vazio, gateway_connection_id: 'conn-do-gateway' };
    default:
      // Provider fora do vocabulário: o caso 7 exige que o handler falhe fechado
      // ANTES de olhar a referência, então a linha vai sem nenhuma.
      return vazio;
  }
}

function conversationRow(shape: ConversationShape = {}): Row {
  const provider = shape.provider ?? 'waha';
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: shape.isGroup ?? false,
    group_chat_id: shape.groupChatId ?? null,
    contacts: {
      phone_number: shape.phoneNumber === undefined ? '+5531999998888' : shape.phoneNumber,
      wa_identity: shape.waIdentity ?? null,
      is_blocked: shape.isBlocked ?? false,
    },
    channel_sessions:
      shape.sessionStatus === null
        ? null
        : {
            // `provider` sai do banco desde a migration 0087 — o handler não
            // supõe mais o canal, então a linha falsa também não pode supor.
            provider,
            ...refDoProvider(provider),
            status: shape.sessionStatus ?? 'WORKING',
            archived_at: shape.archivedAt ?? null,
          },
  };
}

/**
 * Fake de `SupabaseClient` com o mínimo que o handler encadeia:
 *   conversations: select().eq().maybeSingle() · update().eq()
 *   messages:      insert().select().single() · update().eq().select().maybeSingle()
 *   rpc('emit_event')
 * O update é merge raso — igual ao que o Postgres faz com um SET de colunas.
 */
function makeSupabase(
  conversation: Row,
  templateRow: Row | null = null,
  /**
   * `semColunaArquivada`: banco em que a migration 0106 ainda não rodou.
   * `canaisVivos`: as sessões não-arquivadas e WORKING da organização — o que
   * decide se a conversa órfã é adotada, fica onde está, ou é ambígua demais.
   */
  opts: { semColunaArquivada?: boolean; canaisVivos?: Row[] } = {},
) {
  const state: { message: Row | null } = { message: null };

  const client = {
    from(table: string) {
      if (table === 'conversations') {
        return {
          select: (cols?: string) => ({
            eq: () => ({
              maybeSingle: async () =>
                opts.semColunaArquivada === true && (cols ?? '').includes('archived_at')
                  ? {
                      data: null,
                      error: {
                        code: '42703',
                        message: 'column channel_sessions_1.archived_at does not exist',
                      },
                    }
                  : { data: conversation, error: null },
            }),
          }),
          // Encadeável E aguardável: o UPDATE do preview usa um `.eq`, o da
          // adoção usa dois (`id` + `organization_id` — service role não é
          // protegido pela RLS e filtra o tenant na mão). Um `.eq` que já
          // resolve obrigaria a escolher qual dos dois caminhos o dublê modela.
          update: () => {
            const alvo: { eq: () => typeof alvo; then: (r: (v: { error: null }) => void) => void } = {
              eq: () => alvo,
              then: (resolver) => resolver({ error: null }),
            };
            return alvo;
          },
        };
      }
      if (table === 'meta_templates') {
        // O espelho local do template. `templateRow` é injetado por caso; null
        // simula template que não existe (ou WABA errada).
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: templateRow, error: null }) }),
              }),
            }),
          }),
        };
      }
      if (table === 'messages') {
        return {
          insert: (row: Row) => {
            state.message = {
              id: 'msg-1',
              external_id: null,
              ack: null,
              error_code: null,
              error_message: null,
              ...row,
            };
            return { select: () => ({ single: async () => ({ data: { ...state.message }, error: null }) }) };
          },
          update: (patch: Row) => {
            state.message = { ...state.message, ...patch };
            return {
              eq: () => ({
                select: () => ({ maybeSingle: async () => ({ data: { ...state.message }, error: null }) }),
              }),
            };
          },
        };
      }
      if (table === 'channel_sessions') {
        // A busca por canal VIVO da organização (`lib/channels/adocao.ts`), que
        // só roda quando o canal da conversa está arquivado. Default: nenhum —
        // assim o caso 8 continua medindo a recusa, e não a adoção.
        const linhas = opts.canaisVivos ?? [];
        const builder = {
          eq: () => builder,
          is: () => builder,
          limit: async () => ({ data: linhas, error: null }),
        };
        return { select: () => builder };
      }
      throw new Error(`fake_supabase: tabela inesperada '${table}'`);
    },
    rpc: async () => ({ error: null }),
  };

  return client as unknown as SupabaseClient;
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };

function textInput(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return { conversation_id: CONV, type: 'text', body: 'oi', ...over } as SendMessageInput;
}

function wahaConfigured(configured: boolean) {
  vi.stubEnv('WAHA_API_BASE_URL', configured ? WAHA_BASE : '');
  vi.stubEnv('WAHA_API_KEY', configured ? 'hash123' : '');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  signedUrl.mockResolvedValue({ data: { signedUrl: 'https://signed.example/a.jpg' }, error: null });
});

describe('sendMessageHandler — os 6 desfechos do envio', () => {
  it('1. WAHA não configurado: fica queued com queued_reason, nada sai pela rede', async () => {
    wahaConfigured(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('waha_not_configured');
    expect(msg.error_code).toBeNull();
    expect(msg.external_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('2. sem destinatário resolvível: failed/missing_phone_number', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ phoneNumber: null, waIdentity: null })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('missing_phone_number');
    expect(msg.error_message).toBe('Contato sem telefone para envio WhatsApp.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('3. sessão fora de WORKING: fica queued com channel_session_not_working', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ sessionStatus: 'SCAN_QR_CODE' })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('channel_session_not_working');
    expect(msg.error_code).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Os desfechos 4 e 5 gravam a MESMA linha final. O que os separa é o efeito
  // externo — por qual endpoint a mensagem saiu. Isso não é "sequência de
  // chamadas internas": é o que de fato deixa o processo, e o refactor das
  // Tasks 4b–4d tem que preservá-lo (o adapter WAHA fala com o mesmo WAHA).
  it('4. com media_storage_path: sent + external_id + ack 0, pelo endpoint de mídia', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ id: { _serialized: 'MEDIA1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      ctx,
      textInput({ type: 'image', body: undefined, media_storage_path: `${ORG}/${CONV}/a.jpg`, media_mime: 'image/jpeg' }),
    );

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('MEDIA1');
    expect(msg.ack).toBe(0);
    expect(msg.error_code).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${WAHA_BASE}/api/sendImage`);
  });

  it('5. texto puro: sent + external_id + ack 0, pelo endpoint de texto', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'TEXT1' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('TEXT1');
    expect(msg.ack).toBe(0);
    expect(msg.error_code).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${WAHA_BASE}/api/sendText`);
    // Task 7: a sessão que chega ao fio sai de `resolveSessionRef` (que escolhe a
    // COLUNA conforme o provider), não mais de um acesso direto à coluna do
    // provider legado. Sem esta linha, um resolvedor que devolva a coluna errada
    // manda `session: undefined` e a rede inteira continua verde — medido.
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      session: string;
    };
    expect(body.session).toBe('default');
  });

  it('6. envio lança: failed/waha_error com a mensagem do erro', async () => {
    wahaConfigured(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('waha_error');
    expect(msg.error_message).toBe('waha_500');
    expect(msg.external_id).toBeNull();
  });

  // Task 7: o fallback de `error_message` quando o throw NÃO é um `Error`. O
  // valor vai para o banco, então trocá-lo é mudança de comportamento — ele saiu
  // do literal no handler para `adapter.codes`, com o mesmo texto.
  it('6c. throw que não é Error: error_message vem de adapter.codes.unknownError', async () => {
    wahaConfigured(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw 'nao-sou-um-Error';
      }),
    );

    const msg = await sendMessageHandler(makeSupabase(conversationRow()), ctx, textInput());

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('waha_error');
    expect(msg.error_message).toBe('waha_unknown');
  });

  // Task 6: o canal sai do banco (`channel_sessions.provider`, migration 0087) e
  // não de um literal. Esta é a sabotagem que reprova o retorno do `getAdapter("waha")`
  // fixo: com o literal de volta, a sessão enviaria pelo canal errado e o teste ficaria
  // vermelho por não ter lançado.
  //
  // ⚠️ Este caso usava `meta_cloud` como "provider sem adapter". Na Fase 3b o adapter
  // da Meta nasceu, e ele deixou de servir — a rede pegou a mudança, que é o trabalho
  // dela. Trocado por um provider que NÃO existe: o que se testa aqui é o fail-closed,
  // não qual canal está pronto. Amarrar o caso a um canal específico o faria expirar de
  // novo na próxima fase.
  it('7. o canal vem da sessão: provider desconhecido falha fechado, não cai em nenhum canal', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendMessageHandler(
        makeSupabase(conversationRow({ provider: 'canal_inexistente' })),
        ctx,
        textInput(),
      ),
    ).rejects.toThrow(/unknown_channel_provider: canal_inexistente/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('7b. sessão meta_cloud agora RESOLVE adapter — a Fase 3b o criou', async () => {
    // O par com o caso 7 é o que dá sentido aos dois: um prova que provider
    // desconhecido não vaza para canal nenhum; este prova que o canal oficial
    // deixou de ser desconhecido.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.META' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' })),
      ctx,
      textInput(),
    );
    expect((msg as { status: string }).status).toBe('sent');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('graph.facebook.com');
  });

  it('6b. assinatura do Storage falha: failed/storage_sign_failed, não waha_error', async () => {
    wahaConfigured(true);
    signedUrl.mockResolvedValue({ data: null, error: { message: 'no_object' } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow()),
      ctx,
      textInput({ type: 'image', body: undefined, media_storage_path: `${ORG}/${CONV}/a.jpg`, media_mime: 'image/jpeg' }),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('storage_sign_failed');
    expect(msg.error_message).toContain('no_object');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A ORDEM entre os desfechos é comportamento, não detalhe: se o pre-check de
  // configuração descer para depois da resolução do destinatário, uma instalação
  // sem WAHA passa a marcar a mensagem como `failed` em vez de deixá-la em fila.
  it('ordem: sem WAHA E sem telefone → waha_not_configured, nunca missing_phone_number', async () => {
    wahaConfigured(false);
    vi.stubGlobal('fetch', vi.fn());

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ phoneNumber: null, waIdentity: null })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('queued');
    expect((msg.metadata as Record<string, unknown>).queued_reason).toBe('waha_not_configured');
    expect(msg.error_code).toBeNull();
  });

  it('8. type=template envia pelo caminho do template e grava nome e idioma', async () => {
    // O ramo NOVO. Grava `template_name`/`template_language` porque o tipo sozinho
    // não responde "qual template custou o quê" — e template é cobrado por entrega.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.TPL' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' }), {
        name: 'pedido_confirmado',
        language: 'pt_BR',
        status: 'APPROVED',
        contract_hash: 'h',
        components: [{ type: 'BODY', text: 'Ola {{1}}' }],
      }),
      ctx,
      {
        conversation_id: 'conv-1',
        type: 'template',
        template_name: 'pedido_confirmado',
        template_language: 'pt_BR',
        template_values: { '1': 'Rafael' },
      } as Parameters<typeof sendMessageHandler>[2],
    );

    const linha = msg as unknown as { status: string; external_id: string; template_name: string };
    expect(linha.status).toBe('sent');
    expect(linha.external_id).toBe('wamid.TPL');
    expect(linha.template_name).toBe('pedido_confirmado');
    expect(String(fetchMock.mock.calls[0]![0])).toContain('graph.facebook.com');
  });

  it('8b. template ausente do espelho FALHA, não envia às cegas', async () => {
    // Sem esta guarda, um nome errado viraria 132000 na Meta — cobrado e tarde.
    wahaConfigured(true);
    vi.stubEnv('META_PHONE_NUMBER_ID', '1103328999528818');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'tok');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'meta_cloud' }), null),
      ctx,
      {
        conversation_id: 'conv-1',
        type: 'template',
        template_name: 'nao_existe',
        template_language: 'pt_BR',
        template_values: {},
      } as Parameters<typeof sendMessageHandler>[2],
    );

    const linha = msg as unknown as { status: string; error_message: string };
    expect(linha.status).toBe('failed');
    expect(linha.error_message).toMatch(/template_missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ A promessa do `comment on column` de 0100 ("não é mais elegível para envio")
   * virando comportamento. `failed` e não `queued` porque fila implica "sai depois",
   * e por este canal não sai nunca: o número já foi deslogado no transporte, e o
   * ledger do agente lê `queued` como algo a reconciliar mais tarde.
   */
  it('8. canal ARQUIVADO: failed/channel_archived, nada sai pela rede', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ archivedAt: '2026-08-05T10:00:00.000Z' })),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('channel_archived');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ O corretor trocou de número: a conversa vai junto (`lib/channels/adocao.ts`).
   *
   * Medido em 2026-08-09 na instância de desenvolvimento: excluir o número antigo
   * deixou 16 conversas apontando para a sessão arquivada, e TODAS passaram a
   * recusar envio — a caixa de entrada inteira virou somente-leitura, sem caminho
   * de volta pela tela, contrariando a frase que o próprio produto mostra ao
   * reconectar ("Conecte um número para voltar a atender").
   *
   * A asserção que importa não é "não falhou": é que a mensagem nasceu com o
   * `channel_session_id` do canal VIVO. Só isso separa adoção de um `failed`
   * silenciosamente reclassificado.
   */
  it('8b. canal arquivado + UM canal vivo: adota a conversa e envia pelo número novo', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'wamid.novo' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const VIVO = '66666666-6666-4666-8666-666666666666';
    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ archivedAt: '2026-08-05T10:00:00.000Z' }), null, {
        canaisVivos: [
          {
            id: VIVO,
            status: 'WORKING',
            provider: 'waha',
            ...refDoProvider('waha'),
            archived_at: null,
          },
        ],
      }),
      ctx,
      textInput(),
    );

    const linha = msg as unknown as { status: string; error_code: string | null; channel_session_id: string };
    expect(linha.error_code).not.toBe('channel_archived');
    expect(linha.channel_session_id).toBe(VIVO);
    expect(fetchMock).toHaveBeenCalled();
  });

  /**
   * ⭐ Dois números vivos: escolher um é adivinhar por qual identidade o corretor
   * quer falar com aquele cliente, e a escolha errada manda o histórico pelo
   * número errado. Recusar é o desfecho honesto — e é o de hoje.
   */
  it('8c. canal arquivado + DOIS canais vivos: não adivinha, recusa como antes', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const vivo = (id: string): Row => ({
      id,
      status: 'WORKING',
      provider: 'waha',
      ...refDoProvider('waha'),
      archived_at: null,
    });
    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ archivedAt: '2026-08-05T10:00:00.000Z' }), null, {
        canaisVivos: [vivo('66666666-6666-4666-8666-666666666666'), vivo('77777777-7777-4777-8777-777777777777')],
      }),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('failed');
    expect(msg.error_code).toBe('channel_archived');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * ⭐ Este é O caminho de saída do sistema (UI, automação, MCP e agente passam
   * por aqui). Num clone que subiu o CÓDIGO sem aplicar a migration 0106 — cenário
   * medido neste projeto —, pedir `archived_at` direto derrubaria TODO envio com
   * 42703. Sem a coluna nada está arquivado, então repetir sem ela é o resultado
   * exato, não um paliativo.
   */
  it('9. banco sem a coluna archived_at (migration não aplicada): o envio segue normalmente', async () => {
    wahaConfigured(true);
    const fetchMock = vi.fn(async (..._args: unknown[]) => Response.json({ key: { id: 'TEXT9' } }));
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow(), null, { semColunaArquivada: true }),
      ctx,
      textInput(),
    );

    expect(msg.status).toBe('sent');
    expect(msg.external_id).toBe('TEXT9');
  });
});

/**
 * Spec 004 — os desfechos do envio PELO GATEWAY (T036, T038, T039).
 *
 * Mesma rede da de cima, mesmo handler; o que muda é o canal da sessão. Os três
 * casos aqui são requisitos que só têm sentido com o gateway no caminho — e o de
 * grupo conserta, de quebra, uma mentira que o canal oficial já contava.
 */
describe('sendMessageHandler — envio pelo gateway (spec 004)', () => {
  const baseUrlOriginal = envDoApp.GATEWAY_BASE_URL;
  const tokenOriginal = envDoApp.GATEWAY_INTERNAL_TOKEN;

  function gatewayConfigurado() {
    // `lib/env` é singleton parseado no import — `vi.stubEnv` não o alcança.
    envDoApp.GATEWAY_BASE_URL = 'https://gw.exemplo';
    envDoApp.GATEWAY_INTERNAL_TOKEN = 'tok-interno';
  }

  afterEach(() => {
    envDoApp.GATEWAY_BASE_URL = baseUrlOriginal;
    envDoApp.GATEWAY_INTERNAL_TOKEN = tokenOriginal;
  });

  it('T036/FR-021. a resposta do gateway é ACEITE PROVISÓRIO: sent com ack 0, nunca delivered', async () => {
    gatewayConfigurado();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message_id: 'wamid.GW' }),
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'whatsapp_uazapi' })),
      ctx,
      textInput(),
    );

    const linha = msg as unknown as { status: string; ack: number; external_id: string };
    // `sent` + `ack: 0` É o aceite provisório: o gateway disse "recebi", não
    // "chegou". Quem promove para delivered/read é a confirmação assíncrona
    // (`fn_gateway_update_message_status`), com a guarda de não-regressão de
    // estado. Gravar delivered aqui mostraria dois tiques para uma mensagem que
    // ainda pode falhar no provedor.
    expect(linha.status).toBe('sent');
    expect(linha.ack).toBe(0);
    expect(linha.status).not.toBe('delivered');
    expect(linha.status).not.toBe('read');
    // O id do aceite tem de ser guardado: é por ele que a confirmação assíncrona
    // acha esta linha depois. Sem ele o estado definitivo nunca chega.
    expect(linha.external_id).toBe('wamid.GW');
  });

  it('T038/FR-024. a referência de mídia vale ao menos 1 hora', async () => {
    gatewayConfigurado();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message_id: 'wamid.GWM' }),
      text: async () => '{}',
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendMessageHandler(
      makeSupabase(conversationRow({ provider: 'whatsapp_uazapi' })),
      ctx,
      textInput({
        type: 'image',
        body: undefined,
        media_storage_path: `${ORG}/${CONV}/a.jpg`,
        media_mime: 'image/jpeg',
      }),
    );

    const ttl = (signedUrl.mock.calls[0] as unknown as [string, number])[1];
    expect(
      ttl,
      'A referência era assinada por 600 s. Com o gateway no caminho a mensagem pode\n' +
        'esperar na fila em disco antes de o provedor buscar o arquivo — referência\n' +
        'vencida vira anexo que não abre, e o CRM acha que o envio deu certo (FR-024).',
    ).toBeGreaterThanOrEqual(3600);
  });

  it('T039/FR-025. grupo segue impedido, e o motivo deixa de ser "sem telefone"', async () => {
    gatewayConfigurado();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(
        conversationRow({
          provider: 'whatsapp_uazapi',
          isGroup: true,
          groupChatId: '120363000000000000@g.us',
        }),
      ),
      ctx,
      textInput(),
    );

    const linha = msg as unknown as { status: string; error_code: string; error_message: string };
    // Desfecho IGUAL ao de hoje — `failed`, nada sai. Só o motivo mudou: um
    // grupo não tem telefone e nunca vai ter, e "contato sem telefone" mandava
    // quem lê procurar um cadastro para consertar.
    expect(linha.status).toBe('failed');
    expect(linha.error_code).toBe('group_send_unsupported');
    expect(linha.error_message).toMatch(/grupo/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T039. o canal que ENDEREÇA grupo continua enviando — o desfecho de hoje não mudou', async () => {
    // O par do caso acima. Sem ele, "impedir grupo" poderia ter virado uma
    // proibição geral, e o WAHA — que resolve `group_chat_id` e envia — perderia
    // uma capacidade que tem hoje.
    wahaConfigured(true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: { id: '3EB0GRUPO' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const msg = await sendMessageHandler(
      makeSupabase(
        conversationRow({ isGroup: true, groupChatId: '120363000000000000@g.us' }),
      ),
      ctx,
      textInput(),
    );

    expect((msg as unknown as { status: string }).status).toBe('sent');
    expect(fetchMock).toHaveBeenCalled();
  });
});
