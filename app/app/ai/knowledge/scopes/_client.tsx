"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import type { RotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

import {
  ADICIONAR_ACAO,
  ADICIONAR_AJUDA,
  ADICIONAR_CANCELAR,
  ADICIONAR_TITULO,
  CAMINHOS_DO_CATALOGO,
  CANCELAR_REMOCAO,
  CODIGO_ROTULO,
  CONFIRMAR_REMOCAO,
  LEGENDA_DE_ORIGEM,
  LIMIAR_DA_BUSCA,
  LISTA_TRUNCADA,
  NOME_REPETIDO,
  NOME_ROTULO,
  ORIGEM_CATALOGO,
  SEM_RESULTADO,
  SUBTITULO,
  VAZIO_TEXTO,
  VAZIO_TITULO,
  acaoDeMaterial,
  avisoDeAlternancia,
  avisoDeCriacao,
  avisoDeRemocao,
  explicacaoDoEstado,
  filtrarEscopos,
  nomeJaExiste,
  perguntaDeRemocao,
  podeAdicionar,
  podeRemover,
  rotuloDaOrigem,
  rotuloDeRemocao,
  rotuloDoInterruptor,
} from "./_regras";

/**
 * A tela onde o corretor liga o que ele vende (spec 002, T068).
 *
 * ## O interruptor é a tela inteira, e ele custa UM passo
 *
 * Um clique no `Switch` faz **um** `PATCH /api/v1/knowledge-scopes/{id}` com
 * `{ is_active }` e acabou: não há diálogo de confirmação, não há botão "Salvar" no rodapé,
 * não há tela intermediária. Isso não é preferência de desenho — é SC-011, que cronometra
 * esse gesto dentro do teto de 10 minutos do Princípio VIII. Qualquer passo a mais aqui
 * (um "tem certeza?", um formulário, um salvar em lote) **quebra o critério**, e o que
 * teria de ser redesenhado é a tela, não o critério.
 *
 * A consequência de DESLIGAR — o material fica inerte para este tenant e o agente para de
 * afirmar coisas sobre aquele nome (FR-008) — é dita em duas camadas: a linha de apoio de
 * cada item, que fica permanentemente na tela, e o aviso depois do clique. Nenhuma das duas
 * é um portão; ambas são texto. Ver `_regras.ts`.
 *
 * ## Otimista, com volta atrás
 *
 * O estado local vira na hora do clique, antes da resposta: esperar a rede para o
 * interruptor se mexer faria o corretor clicar duas vezes. Se a chamada falhar, a linha
 * volta exatamente ao que era e o erro aparece — mentir que ligou é pior que demorar.
 * Quando dá certo, a linha é substituída pelo objeto que a rota devolveu (já projetado, já
 * com as contagens), então nenhum GET extra é preciso.
 */

interface Props {
  /** "Operadora"/"Operadoras" por padrão, ou o que esta instalação configurou (FR-033). */
  rotulo: RotuloDoEscopo;
  escoposIniciais: EscopoDoTenant[];
  /** A leitura bateu no teto da página. Ver `LIMITE_DA_TELA` em `page.tsx`. */
  truncado: boolean;
}

export function EscoposClient({ rotulo, escoposIniciais, truncado }: Props) {
  const [escopos, setEscopos] = useState<EscopoDoTenant[]>(escoposIniciais);
  const [termo, setTermo] = useState("");
  const [pendentes, setPendentes] = useState<ReadonlySet<string>>(new Set());
  /** Qual linha está pedindo confirmação de remoção. Uma por vez, e some ao trocar. */
  const [confirmando, setConfirmando] = useState<string | null>(null);
  /** O formulário de adicionar está aberto? Fechado por padrão — a lista é o assunto. */
  const [adicionando, setAdicionando] = useState(false);
  const [nome, setNome] = useState("");
  const [codigo, setCodigo] = useState("");
  const [salvando, setSalvando] = useState(false);

  const visiveis = useMemo(() => filtrarEscopos(escopos, termo), [escopos, termo]);
  const ligados = escopos.filter((e) => e.is_active).length;

  async function alternar(escopo: EscopoDoTenant, ligado: boolean) {
    if (pendentes.has(escopo.id)) return;
    const anterior = escopo;

    setEscopos((atual) =>
      atual.map((e) => (e.id === escopo.id ? { ...e, is_active: ligado } : e)),
    );
    setPendentes((atual) => new Set(atual).add(escopo.id));

    try {
      const resposta = await apiClient.patch<{ data: EscopoDoTenant }>(
        `/api/v1/knowledge-scopes/${escopo.id}`,
        { is_active: ligado },
      );
      setEscopos((atual) => atual.map((e) => (e.id === escopo.id ? resposta.data : e)));
      const aviso = avisoDeAlternancia(anterior.display_name, ligado);
      if (ligado) toast.success(aviso);
      else toast.info(aviso);
    } catch (erro) {
      setEscopos((atual) => atual.map((e) => (e.id === escopo.id ? anterior : e)));
      showApiError(erro);
    } finally {
      setPendentes((atual) => {
        const proximo = new Set(atual);
        proximo.delete(escopo.id);
        return proximo;
      });
    }
  }

  /**
   * Adicionar pelo nome (FR-002).
   *
   * Nasce LIGADA, e é o contrário do espelho do catálogo (que nasce desligado por A-20).
   * Os dois casos não são iguais: o espelho aparece sem ninguém pedir, e ligá-lo é uma
   * escolha; este nome o corretor acabou de digitar, e criá-lo desligado seria pedir dois
   * gestos para uma decisão que ele já tomou.
   *
   * Não é otimista: a linha só entra na lista depois do 200. Aqui o custo de mentir é
   * maior que no interruptor — o corretor vai carregar material para um nome que pode não
   * existir, e descobriria isso na tela seguinte.
   */
  async function adicionar() {
    const limpo = nome.trim();
    if (!podeAdicionar(limpo) || salvando) return;
    if (nomeJaExiste(escopos, limpo)) {
      toast.error(NOME_REPETIDO);
      return;
    }
    setSalvando(true);
    try {
      const resposta = await apiClient.post<{ data: EscopoDoTenant }>(
        "/api/v1/knowledge-scopes",
        { display_name: limpo, official_code: codigo.trim() || null },
      );
      setEscopos((atual) => [resposta.data, ...atual]);
      setNome("");
      setCodigo("");
      setAdicionando(false);
      toast.success(avisoDeCriacao(resposta.data.display_name));
    } catch (erro) {
      showApiError(erro);
    } finally {
      setSalvando(false);
    }
  }

  /**
   * Remover (T099). Ao contrário do interruptor, aqui NÃO é otimista: a linha só sai da
   * lista depois do 200. Sumir antes e voltar em caso de erro faria o corretor achar que
   * removeu — e a próxima coisa que ele faz é fechar a tela.
   */
  async function remover(escopo: EscopoDoTenant) {
    if (pendentes.has(escopo.id)) return;
    setPendentes((atual) => new Set(atual).add(escopo.id));
    try {
      const resposta = await apiClient.delete<{
        data: { id: string; deleted: boolean; materials_archived: number };
      }>(`/api/v1/knowledge-scopes/${escopo.id}`);
      setEscopos((atual) => atual.filter((e) => e.id !== escopo.id));
      setConfirmando(null);
      toast.success(avisoDeRemocao(escopo.display_name, resposta.data.materials_archived));
    } catch (erro) {
      showApiError(erro);
    } finally {
      setPendentes((atual) => {
        const proximo = new Set(atual);
        proximo.delete(escopo.id);
        return proximo;
      });
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">{rotulo.plural}</h1>
          {!adicionando && (
            <Button onClick={() => setAdicionando(true)}>
              {ADICIONAR_ACAO} {rotulo.singular.toLocaleLowerCase("pt-BR")}
            </Button>
          )}
        </div>
        <p className="max-w-3xl text-sm text-text-muted">{SUBTITULO}</p>
        {escopos.length > 0 && (
          <p className="text-sm text-text-muted">
            <span className="font-medium text-text">
              {ligados} de {escopos.length}
            </span>{" "}
            {ligados === 1 ? "ligado" : "ligados"}.
          </p>
        )}
      </header>

      {/*
        O formulário é INLINE, e não um diálogo, pelo mesmo motivo que o interruptor não
        tem confirmação: SC-003 cronometra do login ao primeiro material buscável. Um modal
        acrescenta abrir, esperar a animação e fechar a cada nome — e o corretor que está
        cadastrando o que vende cadastra vários seguidos.
      */}
      {adicionando && (
        <form
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void adicionar();
          }}
        >
          <div>
            <p className="text-base font-medium">{ADICIONAR_TITULO}</p>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">{ADICIONAR_AJUDA}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 text-sm">
              <span className="mb-1 block font-medium">{NOME_ROTULO}</span>
              <Input
                id="escopo-nome"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                maxLength={120}
                autoFocus
              />
            </label>
            <label className="flex-1 text-sm">
              <span className="mb-1 block font-medium">{CODIGO_ROTULO}</span>
              <Input
                id="escopo-codigo"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                maxLength={40}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={!podeAdicionar(nome) || salvando}>
              {salvando ? "Adicionando…" : ADICIONAR_ACAO}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={salvando}
              onClick={() => {
                setAdicionando(false);
                setNome("");
                setCodigo("");
              }}
            >
              {ADICIONAR_CANCELAR}
            </Button>
          </div>
        </form>
      )}

      {escopos.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6">
          <p className="text-base font-medium">{VAZIO_TITULO}</p>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">{VAZIO_TEXTO}</p>
          {/*
            O primeiro passo é AQUI, e por isso o botão vem antes do link. A versão
            anterior só mandava para Conhecimento — que, sem nenhum nome cadastrado, é
            uma tela que devolve o corretor para cá.
          */}
          <div className="mt-4 flex flex-wrap items-center gap-4">
            {!adicionando && (
              <Button onClick={() => setAdicionando(true)}>
                {ADICIONAR_ACAO} {rotulo.singular.toLocaleLowerCase("pt-BR")}
              </Button>
            )}
            <Link
              href="/app/ai/knowledge/sources"
              className="text-sm font-medium text-accent underline underline-offset-4"
            >
              Ir para Conhecimento
            </Link>
          </div>
        </div>
      ) : (
        <>
          {escopos.length > LIMIAR_DA_BUSCA && (
            <Input
              type="search"
              value={termo}
              onChange={(e) => setTermo(e.target.value)}
              placeholder={`Buscar ${rotulo.plural.toLowerCase()}…`}
              aria-label={`Buscar ${rotulo.plural.toLowerCase()}`}
              className="max-w-sm"
            />
          )}

          {truncado && <p className="text-sm text-text-muted">{LISTA_TRUNCADA}</p>}

          {visiveis.length === 0 ? (
            <p className="text-sm text-text-muted">{SEM_RESULTADO}</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
              {visiveis.map((escopo) => (
                <li
                  key={escopo.id}
                  className="flex items-start justify-between gap-4 p-4 sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">{escopo.display_name}</span>
                      {escopo.official_code && (
                        <span className="font-mono text-xs text-text-muted">
                          {escopo.official_code}
                        </span>
                      )}
                      <Badge
                        variant={escopo.origin === ORIGEM_CATALOGO ? "neutral" : "default"}
                      >
                        {rotuloDaOrigem(escopo.origin)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-text-muted">{explicacaoDoEstado(escopo)}</p>
                    {/*
                      T091 — a recusa dita ANTES do clique. Quem veio do catálogo não é
                      editável (a rota responde `403 escopo_do_catalogo_nao_editavel`), e
                      descobrir isso por erro é descobrir tarde. A frase vem com as duas
                      saídas; o link abaixo é a porta da segunda.
                    */}
                    {escopo.origin === ORIGEM_CATALOGO && (
                      <p className="mt-1 text-sm text-text-muted">{CAMINHOS_DO_CATALOGO}</p>
                    )}
                    <Link
                      href={acaoDeMaterial(escopo).href}
                      className="mt-1 inline-block text-sm font-medium text-accent underline underline-offset-4"
                    >
                      {acaoDeMaterial(escopo).texto}
                    </Link>

                    {/*
                      T099 — a confirmação é INLINE, e não um `dialog`: a tela toda é uma
                      lista, e um modal esconderia justamente o item sobre o qual a pergunta
                      é feita. Ela também diz o que acontece com o material antes de o
                      corretor decidir, não depois.
                    */}
                    {confirmando === escopo.id && (
                      <div className="mt-3 rounded-md border border-border bg-surface-muted p-3">
                        <p className="text-sm text-text">{perguntaDeRemocao(escopo.display_name)}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            disabled={pendentes.has(escopo.id)}
                            onClick={() => void remover(escopo)}
                          >
                            {CONFIRMAR_REMOCAO}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirmando(null)}
                          >
                            {CANCELAR_REMOCAO}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/*
                    Um clique aqui é a operação inteira. `disabled` só enquanto a chamada
                    daquela linha está no ar — para o segundo clique impaciente não virar
                    dois PATCH em sentidos opostos.
                  */}
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={escopo.is_active}
                      disabled={pendentes.has(escopo.id)}
                      onCheckedChange={(ligado) => void alternar(escopo, ligado)}
                      aria-label={rotuloDoInterruptor(escopo)}
                    />
                    {/*
                      Só no que o corretor criou: o espelho do catálogo volta na próxima
                      sincronização, e a rota o recusa com 403. Botão que sempre falha
                      ensina um caminho inexistente.
                    */}
                    {podeRemover(escopo) && (
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmando((atual) => (atual === escopo.id ? null : escopo.id))
                        }
                        aria-label={rotuloDeRemocao(escopo)}
                        className="text-sm font-medium text-text-muted underline underline-offset-4 hover:text-text"
                      >
                        Remover
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <p className="max-w-3xl text-xs text-text-muted">{LEGENDA_DE_ORIGEM}</p>
        </>
      )}
    </div>
  );
}
