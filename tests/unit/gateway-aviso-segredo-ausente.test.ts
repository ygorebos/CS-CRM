/**
 * A conexão que não recebe nada precisa APARECER (T017e da spec 001).
 *
 * ## O defeito que este arquivo congela
 *
 * A entrega do gateway é fail-closed sem válvula: sem chave de verificação, a
 * rota recusa 100% das entregas daquela conexão. Isso é o comportamento certo —
 * o caminho legado tem válvula, e a válvula virou o estado PERMANENTE de toda
 * instalação. Foi assim que "fail-closed" virou teatro neste produto.
 *
 * O que faltava não era a recusa; era o que o operador VÊ quando ela acontece.
 * As mensagens param, o inbox fica vazio, e não há onde olhar. A cura das linhas
 * antigas roda fora do SQL (a chave de cifra só existe depois do baseline), então
 * um clone que atualize pela metade cai exatamente neste estado — em silêncio, o
 * que o Princípio II proíbe.
 *
 * ## Por que a deduplicação é testada junto
 *
 * Um aviso por entrega recusada não é "mais visível", é menos: a conexão
 * quebrada recusa TUDO, e um número movimentado encheria a Central com centenas
 * de linhas idênticas em minutos. Central inundada é tão ilegível quanto vazia.
 * Abrir e deduplicar são a mesma promessa vista de dois lados, e por isso os dois
 * casos vivem no mesmo arquivo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  KIND_SEGREDO_AUSENTE,
  avisarSegredoNaoProvisionado,
} from "@/lib/gateway/aviso-de-segredo";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSAO = "22222222-2222-4222-8222-222222222222";

/** Linha de aviso já aberta que a busca deve encontrar (null = não há nenhuma). */
let avisoAberto: { id: string } | null = null;
/** Erro devolvido pelo INSERT, para o caso de a Central estar indisponível. */
let erroDoInsert: { message: string } | null = null;

const inserts: Record<string, unknown>[] = [];
const filtrosDaBusca: Record<string, unknown>[] = [];

function clienteFalso() {
  return {
    from: (_tabela: string) => ({
      select: () => {
        const filtros: Record<string, unknown> = {};
        filtrosDaBusca.push(filtros);
        const proxy: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "maybeSingle") {
                return async () => ({ data: avisoAberto, error: null });
              }
              if (prop === "eq") {
                return (coluna: string, valor: unknown) => {
                  filtros[coluna] = valor;
                  return proxy;
                };
              }
              return () => proxy;
            },
          },
        );
        return proxy;
      },
      insert: async (linha: Record<string, unknown>) => {
        inserts.push(linha);
        return { error: erroDoInsert };
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  avisoAberto = null;
  erroDoInsert = null;
  inserts.length = 0;
  filtrosDaBusca.length = 0;
  vi.restoreAllMocks();
});

describe("aviso de conexão sem chave de verificação", () => {
  it("abre aviso na Central quando ainda não há um aberto para a conexão", async () => {
    const abriu = await avisarSegredoNaoProvisionado(clienteFalso(), {
      organizationId: ORG,
      channelSessionId: SESSAO,
      requestId: "req-1",
    });

    expect(abriu).toBe(true);
    expect(inserts).toHaveLength(1);

    const linha = inserts[0]!;
    expect(linha.kind).toBe(KIND_SEGREDO_AUSENTE);
    expect(linha.organization_id).toBe(ORG);
    // O aviso APONTA para a conexão: sem `ref_id`, o operador saberia que "uma
    // conexão" quebrou, sem descobrir qual — e uma instalação com três números
    // vira adivinhação.
    expect(linha.ref_kind).toBe("channel_session");
    expect(linha.ref_id).toBe(SESSAO);
    // `critical`, não `warn`: nenhuma mensagem está entrando por este canal.
    expect(linha.severity).toBe("critical");
    // O texto é para o CORRETOR, não para quem escreveu o código: ele diz o que
    // está acontecendo e o que fazer, sem citar coluna, função nem provedor.
    expect(String(linha.body)).toMatch(/update\.sh|recrie a conexão/i);
    expect(String(linha.body)).not.toMatch(/webhook_secret_encrypted|HMAC|fn_encrypt/i);
  });

  it("NÃO abre um segundo aviso enquanto o primeiro está aberto", async () => {
    avisoAberto = { id: "aviso-existente" };

    const abriu = await avisarSegredoNaoProvisionado(clienteFalso(), {
      organizationId: ORG,
      channelSessionId: SESSAO,
      requestId: "req-2",
    });

    // A conexão quebrada recusa TODA entrega. Sem esta trava, um número
    // movimentado enterraria a Central em minutos.
    expect(abriu).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it("a busca por aviso aberto é isolada por organização E por conexão", async () => {
    await avisarSegredoNaoProvisionado(clienteFalso(), {
      organizationId: ORG,
      channelSessionId: SESSAO,
      requestId: "req-3",
    });

    const filtros = filtrosDaBusca[0]!;
    // Sem `organization_id` no filtro, o aviso aberto de um tenant silenciaria o
    // aviso de outro — e a segunda instalação nunca saberia que está quebrada.
    expect(filtros.organization_id).toBe(ORG);
    expect(filtros.ref_id).toBe(SESSAO);
    expect(filtros.kind).toBe(KIND_SEGREDO_AUSENTE);
    // Aviso já resolvido não pode calar um aviso novo: o estado continua lá.
    expect(filtros.status).toBe("open");
  });

  it("falha ao gravar o aviso NÃO derruba a recusa", async () => {
    erroDoInsert = { message: "central indisponível" };

    // A recusa em si é o que protege o tenant; se esta função lançasse, a rota
    // devolveria 500 e o gateway retentaria para sempre uma entrega que nunca
    // passa. O aviso é importante, mas não é o mecanismo de segurança.
    await expect(
      avisarSegredoNaoProvisionado(clienteFalso(), {
        organizationId: ORG,
        channelSessionId: SESSAO,
        requestId: "req-4",
      }),
    ).resolves.toBe(false);
  });
});

/**
 * SABOTAGENS que devem deixar este arquivo VERMELHO:
 *
 *  1. Remover a checagem de aviso já aberto (inserir sempre)
 *     → "NÃO abre um segundo aviso" cai.
 *  2. Tirar `organization_id` do filtro da busca
 *     → "isolada por organização E por conexão" cai.
 *  3. Trocar o `catch`/`return false` por `throw`
 *     → "falha ao gravar o aviso NÃO derruba a recusa" cai.
 */
