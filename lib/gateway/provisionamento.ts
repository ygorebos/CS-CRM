/**
 * O CRM falando o contrato de provisionamento do gateway
 * (`specs/004-envio-pelo-gateway/contracts/gateway-provisioning-v1.md`).
 *
 * ## Quem é dono do quê (decisão T003)
 *
 * O gateway cria a INSTÂNCIA no provedor e devolve um `connection_id`. Quem grava
 * `channel_sessions` é o **CRM**, pelo caminho que ele já usa. Isso derrubou a
 * superfície de escrita do gateway de quatro funções para duas — e deu à
 * compensação **um dono só**.
 *
 * ## Tudo-ou-nada entre dois sistemas, sem transação distribuída
 *
 * Não há transação atravessando HTTP. O que existe é uma ordem com compensação:
 *
 *   1. CRM chama `POST /v1/connections` com `Idempotency-Key`;
 *   2. gateway cria a instância e devolve `connection_id` (repetir a mesma chave
 *      devolve a MESMA conexão — timeout do CRM não vira duas instâncias, e
 *      instância órfã custa dinheiro e some do inventário);
 *   3. CRM grava a linha dele. **Se falhar, o CRM chama `DELETE`** e a instância
 *      morre junto.
 *
 * Sem o passo 3 sobraria uma instância que nenhum dos dois lados reconhece como
 * sua: o gateway acha que o CRM está usando, o CRM não sabe que ela existe.
 *
 * ## Token ADMIN, não o interno
 *
 * Provisionar cria instância que custa dinheiro; desprovisionar é irreversível.
 * O gateway protege essas rotas com um token próprio e **recusa** o interno
 * (`internal/middleware/admin.go:21`) — vazar a credencial de envio não pode
 * significar poder de apagar a instância de todos.
 */
import { env } from "@/lib/env";

/** Vocabulário de estado NORMALIZADO pelo gateway (contrato §5.1). */
export type EstadoDaConexao =
  | "created"
  | "awaiting_scan"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

const ESTADOS: readonly EstadoDaConexao[] = [
  "created",
  "awaiting_scan",
  "connecting",
  "connected",
  "disconnected",
  "failed",
] as const;

/**
 * Estado que o CRM não reconhece cai em `failed` (contrato §5.1, FR-032).
 *
 * Fail-closed e LEGÍVEL: o valor cru continua disponível em `provider_status`
 * para o diagnóstico, mas nunca vira `status`. A alternativa — deixar passar o
 * desconhecido — produz tela vazia, que é o pior desfecho: o corretor não sabe
 * se está conectado, se precisa escanear, ou se o produto quebrou.
 */
export function estadoConhecido(cru: unknown): EstadoDaConexao {
  return typeof cru === "string" && (ESTADOS as readonly string[]).includes(cru)
    ? (cru as EstadoDaConexao)
    : "failed";
}

export interface ConexaoProvisionada {
  connectionId: string;
  platform: string;
  status: EstadoDaConexao;
}

export interface MaterialDePareamento {
  status: EstadoDaConexao;
  qrCode: string | null;
  pairCode: string | null;
  /** Quando o material perde validade (ISO-8601). A tela pede outro NA HORA. */
  expiresAt: string | null;
}

export interface EstadoObservado {
  connectionId: string;
  status: EstadoDaConexao;
  phoneNumber: string | null;
  /** Valor CRU do provedor — só diagnóstico, nunca decide comportamento. */
  providerStatus: string | null;
}

/** Falha do provisionamento, com o bastante para diagnosticar sem vazar segredo. */
export class ErroDoGateway extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "ErroDoGateway";
  }
}

function baseUrl(): string {
  return env.GATEWAY_BASE_URL.trim().replace(/\/+$/, "");
}

/** O provisionamento está configurado nesta instalação? */
export function provisionamentoConfigurado(): boolean {
  return baseUrl() !== "" && env.GATEWAY_ADMIN_TOKEN.trim() !== "";
}

async function chamar(
  caminho: string,
  init: { method: string; body?: unknown; idempotencyKey?: string },
): Promise<{ status: number; corpo: Record<string, unknown> }> {
  if (!provisionamentoConfigurado()) {
    throw new ErroDoGateway(
      503,
      "gateway_nao_configurado",
      "GATEWAY_BASE_URL e GATEWAY_ADMIN_TOKEN são necessárias para provisionar conexão.",
    );
  }

  const cabecalhos: Record<string, string> = {
    "Content-Type": "application/json",
    // Credencial SEMPRE em cabeçalho — query string vaza em log de proxy.
    Authorization: `Bearer ${env.GATEWAY_ADMIN_TOKEN}`,
  };
  if (init.idempotencyKey) cabecalhos["Idempotency-Key"] = init.idempotencyKey;

  let resposta: Response;
  try {
    resposta = await fetch(`${baseUrl()}${caminho}`, {
      method: init.method,
      headers: cabecalhos,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // Rede fora, DNS, timeout. 502 e não 500: o defeito não é nosso, e a
    // diferença importa para quem lê o alerta.
    throw new ErroDoGateway(
      502,
      "gateway_inalcancavel",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (resposta.status === 204) return { status: 204, corpo: {} };

  const corpo = (await resposta.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resposta.ok) {
    const erro = corpo.error;
    const codigo =
      typeof erro === "object" && erro !== null && typeof (erro as { code?: unknown }).code === "string"
        ? ((erro as { code: string }).code)
        : "erro_do_gateway";
    const mensagem =
      typeof erro === "object" && erro !== null && typeof (erro as { message?: unknown }).message === "string"
        ? ((erro as { message: string }).message)
        : `gateway respondeu ${resposta.status}`;
    throw new ErroDoGateway(resposta.status, codigo, mensagem);
  }
  return { status: resposta.status, corpo };
}

/**
 * `POST /v1/connections` — a instância nasce no provedor (contrato §3).
 *
 * `idempotencyKey` é OBRIGATÓRIA no contrato e por isso é parâmetro, não algo
 * gerado aqui dentro: a chave tem de sobreviver a uma retentativa do CHAMADOR
 * para cumprir seu papel. Gerada aqui, cada retentativa traria uma chave nova e
 * a proteção viraria enfeite.
 */
export async function criarConexaoNoGateway(pedido: {
  platform: string;
  label?: string | null;
  idempotencyKey: string;
}): Promise<ConexaoProvisionada> {
  const { corpo } = await chamar("/v1/connections", {
    method: "POST",
    idempotencyKey: pedido.idempotencyKey,
    // `delivery` NÃO viaja: nesta variante o gateway escreve pela função, e o
    // alvo de escrita é configuração do processo dele. Deixá-lo vir no corpo
    // permitiria a um chamador redirecionar a escrita para outro banco.
    body: { platform: pedido.platform, ...(pedido.label ? { label: pedido.label } : {}) },
  });

  const connectionId = typeof corpo.connection_id === "string" ? corpo.connection_id.trim() : "";
  if (!connectionId) {
    // Sem id não há o que gravar NEM o que compensar — e é o único caso em que
    // uma instância pode ficar órfã sem culpa do CRM. Falha alto para virar
    // alerta em vez de linha muda.
    throw new ErroDoGateway(502, "resposta_sem_connection_id", "o gateway aceitou mas não devolveu connection_id");
  }

  return {
    connectionId,
    platform: typeof corpo.platform === "string" ? corpo.platform : pedido.platform,
    status: estadoConhecido(corpo.status),
  };
}

/** `POST /v1/connections/{id}/pair` — material de pareamento (contrato §4). */
export async function parearNoGateway(
  connectionId: string,
  opts: { phone?: string | null; force?: boolean } = {},
): Promise<MaterialDePareamento> {
  const { corpo } = await chamar(`/v1/connections/${encodeURIComponent(connectionId)}/pair`, {
    method: "POST",
    body: {
      ...(opts.phone ? { phone: opts.phone } : {}),
      ...(opts.force ? { force: true } : {}),
    },
  });
  return {
    status: estadoConhecido(corpo.status),
    qrCode: typeof corpo.qr_code === "string" ? corpo.qr_code : null,
    pairCode: typeof corpo.pair_code === "string" ? corpo.pair_code : null,
    // A validade é a razão de esta rota não ser um proxy: sem ela a tela refaz o
    // QR a cada 15 s no escuro, e o corretor fica olhando um QR morto achando
    // que o celular dele é que está ruim.
    expiresAt: typeof corpo.expires_at === "string" ? corpo.expires_at : null,
  };
}

/** `GET /v1/connections/{id}` — observar (contrato §5). */
export async function observarNoGateway(connectionId: string): Promise<EstadoObservado> {
  const { corpo } = await chamar(`/v1/connections/${encodeURIComponent(connectionId)}`, {
    method: "GET",
  });
  return {
    connectionId: typeof corpo.connection_id === "string" ? corpo.connection_id : connectionId,
    status: estadoConhecido(corpo.status),
    phoneNumber: typeof corpo.phone_number === "string" ? corpo.phone_number : null,
    providerStatus: typeof corpo.provider_status === "string" ? corpo.provider_status : null,
  };
}

/** `POST /v1/connections/{id}/disconnect` — encerra a sessão, MANTÉM o registro (§6). */
export async function desconectarNoGateway(connectionId: string): Promise<EstadoDaConexao> {
  const { corpo } = await chamar(`/v1/connections/${encodeURIComponent(connectionId)}/disconnect`, {
    method: "POST",
  });
  return estadoConhecido(corpo.status ?? "disconnected");
}

/**
 * `DELETE /v1/connections/{id}` — desprovisiona, irreversível (§7).
 *
 * **É a compensação da criação**, e é idempotente por contrato: apagar o que já
 * não existe é 204. Por isso ela NUNCA lança — quem a chama está, quase sempre,
 * já tratando outra falha, e uma exceção aqui trocaria "não consegui criar" por
 * um erro sobre a limpeza. Devolve se conseguiu, para quem quiser alertar.
 */
export async function apagarNoGatewaySemLancar(connectionId: string): Promise<boolean> {
  try {
    await chamar(`/v1/connections/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}
