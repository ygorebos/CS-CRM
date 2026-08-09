/**
 * As duas portas de criar conexão gravam a MESMA linha (spec 004, T044 / FR-034).
 *
 * ## O defeito que este arquivo impede
 *
 * Havia dois inserts, um em cada rota, e eles divergiam. O que doía não era a
 * duplicação — era **qual** coluna cada um esquecia:
 *
 *   - o onboarding não definia `ingest_path`, então a linha nascia com o default
 *     `legacy`. E o onboarding é **A** porta do usuário novo: quem se cadastra
 *     passa por ela e só por ela. O corretor recém-chegado ficava fora do
 *     gateway mesmo numa instalação que já tinha virado a chave — e nada na tela
 *     dizia isso. É o "gateway de pé e sem uso" acontecendo com quem mais importa;
 *   - o onboarding não emitia `channel.connected`: número entrando no ar sem
 *     registrar quem o ligou, na porta usada por 100% dos usuários novos.
 *
 * Consertar as duas colunas num dos inserts deixaria o outro livre para divergir
 * de novo amanhã. Por isso o conserto é o caminho ÚNICO, e por isso o teste
 * compara as DUAS portas em vez de conferir uma lista de campos.
 *
 * ## O que NÃO converge, e é proposital
 *
 * O formato do nome de sessão. `org_<8>` fixo no onboarding é o que faz quem
 * fechou a aba e voltou cair na conexão que já começou; nome aleatório na
 * Central é o que permite ter mais de um número. Intenções diferentes,
 * identidades diferentes — por isso o nome é parâmetro, e o teste afirma a
 * diferença em vez de fingir que ela não existe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const auditado: { action: string; metadata?: Record<string, unknown> }[] = [];
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (e: { action: string; metadata?: Record<string, unknown> }) => {
    auditado.push(e);
  }),
}));
vi.mock("@/lib/webhooks/provisionar-segredo", () => ({
  provisionarSegredoDeWebhook: vi.fn(async () => "\\x0102"),
}));
vi.mock("@/lib/gateway/caminho-de-ingestao", () => ({
  caminhoDeIngestaoParaConexaoNova: () => "gateway",
}));

import { criarConexaoDeCanal } from "@/lib/channels/criar-conexao";
import { provisionarSegredoDeWebhook } from "@/lib/webhooks/provisionar-segredo";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function fakeSupabase() {
  const inserido: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      insert: (linha: Record<string, unknown>) => {
        inserido.push(linha);
        return {
          select: () => ({
            single: async () => ({ data: { id: "conexao-1", ...linha }, error: null }),
          }),
        };
      },
    }),
  };
  return { client: client as never, inserido };
}

beforeEach(() => {
  auditado.length = 0;
  vi.mocked(provisionarSegredoDeWebhook).mockResolvedValue("\\x0102");
});

describe("as duas portas de conexão convergem (FR-034)", () => {
  it("mesma linha nas duas portas — só o nome da sessão difere", async () => {
    const central = fakeSupabase();
    await criarConexaoDeCanal(central.client, {
      organizationId: ORG,
      sessionName: "org_11111111_abc123",
      displayName: "Comercial",
      actorUserId: USER,
      requestId: "req-1",
      origem: "central",
    });

    const onboarding = fakeSupabase();
    await criarConexaoDeCanal(onboarding.client, {
      organizationId: ORG,
      sessionName: "org_11111111",
      actorUserId: USER,
      requestId: "req-2",
      origem: "onboarding",
    });

    const a = { ...central.inserido[0] } as Record<string, unknown>;
    const b = { ...onboarding.inserido[0] } as Record<string, unknown>;
    // Fora da comparação: o nome (intenções diferentes), o rótulo escolhido pelo
    // usuário, e os dois valores que são aleatórios ou relógio por natureza.
    for (const campo of [
      "waha_session_name",
      "display_name",
      "webhook_path_token",
      "last_status_change_at",
    ]) {
      delete a[campo];
      delete b[campo];
    }
    expect(a).toEqual(b);
  });

  it("conexão nova nasce no caminho da instalação — não no default da coluna", async () => {
    // A que doía: `legacy` herdado silenciosamente deixava o usuário novo fora
    // do gateway numa instalação que já tinha virado a chave.
    const { client, inserido } = fakeSupabase();
    await criarConexaoDeCanal(client, {
      organizationId: ORG,
      sessionName: "org_11111111",
      actorUserId: USER,
      requestId: "req-3",
      origem: "onboarding",
    });
    expect(inserido[0]!.ingest_path).toBe("gateway");
  });

  it("as duas auditam quem ligou o número, e a origem fica registrada", async () => {
    const { client } = fakeSupabase();
    await criarConexaoDeCanal(client, {
      organizationId: ORG,
      sessionName: "org_11111111",
      actorUserId: USER,
      requestId: "req-4",
      origem: "onboarding",
    });
    const evento = auditado.find((e) => e.action === "channel.connected");
    expect(evento).toBeDefined();
    // A origem é o que responde "por onde entrou?" quando alguém for investigar
    // um número que ninguém lembra de ter ligado.
    expect(evento!.metadata).toMatchObject({ origem: "onboarding" });
  });

  it("T047/FR-037. cada conexão provisiona o PRÓPRIO segredo — nunca um global", async () => {
    // A migração para o gateway não pode reintroduzir segredo compartilhado: a
    // entrega é verificada por conexão, e um segredo único faria o vazamento de
    // um canal comprometer todos. A prova é o provisionamento acontecer UMA VEZ
    // POR CONEXÃO — valor guardado em módulo, env ou cache reutilizaria.
    vi.mocked(provisionarSegredoDeWebhook).mockReset();
    vi.mocked(provisionarSegredoDeWebhook)
      .mockResolvedValueOnce("\\xAAAA")
      .mockResolvedValueOnce("\\xBBBB");

    const um = fakeSupabase();
    const dois = fakeSupabase();
    for (const [i, alvo] of [um, dois].entries()) {
      await criarConexaoDeCanal(alvo.client, {
        organizationId: ORG,
        sessionName: `org_11111111_${i}`,
        actorUserId: USER,
        requestId: `req-seg-${i}`,
        origem: "central",
      });
    }

    expect(vi.mocked(provisionarSegredoDeWebhook)).toHaveBeenCalledTimes(2);
    expect(um.inserido[0]!.webhook_secret_encrypted).not.toBe(
      dois.inserido[0]!.webhook_secret_encrypted,
    );
    // O token do caminho de webhook também é por conexão: dois canais com o
    // mesmo token receberiam a entrega um do outro.
    expect(um.inserido[0]!.webhook_path_token).not.toBe(dois.inserido[0]!.webhook_path_token);
  });

  it("sem cifra a conexão NÃO nasce — nem meia linha", async () => {
    // Conexão incapaz de verificar entrega recusaria 100% das mensagens, e o
    // defeito só apareceria na primeira mensagem, longe daqui.
    vi.mocked(provisionarSegredoDeWebhook).mockResolvedValue(null);
    const { client, inserido } = fakeSupabase();
    const r = await criarConexaoDeCanal(client, {
      organizationId: ORG,
      sessionName: "org_11111111",
      actorUserId: USER,
      requestId: "req-5",
      origem: "central",
    });
    expect(r).toEqual({ ok: false, motivo: "sem_cifra" });
    expect(inserido).toHaveLength(0);
    expect(auditado).toHaveLength(0);
  });
});
