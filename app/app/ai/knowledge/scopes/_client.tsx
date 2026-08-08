"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import type { EscopoDoTenant } from "@/app/api/v1/knowledge-scopes/_escopos";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import type { RotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

import {
  CAMINHOS_DO_CATALOGO,
  LEGENDA_DE_ORIGEM,
  LIMIAR_DA_BUSCA,
  LISTA_TRUNCADA,
  ORIGEM_CATALOGO,
  SEM_RESULTADO,
  SUBTITULO,
  VAZIO_TEXTO,
  VAZIO_TITULO,
  acaoDeMaterial,
  avisoDeAlternancia,
  explicacaoDoEstado,
  filtrarEscopos,
  rotuloDaOrigem,
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

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{rotulo.plural}</h1>
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

      {escopos.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-6">
          <p className="text-base font-medium">{VAZIO_TITULO}</p>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">{VAZIO_TEXTO}</p>
          <Link
            href="/app/ai/knowledge/sources"
            className="mt-4 inline-block text-sm font-medium text-accent underline underline-offset-4"
          >
            Ir para Conhecimento
          </Link>
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
                  </div>

                  {/*
                    Um clique aqui é a operação inteira. `disabled` só enquanto a chamada
                    daquela linha está no ar — para o segundo clique impaciente não virar
                    dois PATCH em sentidos opostos.
                  */}
                  <Switch
                    checked={escopo.is_active}
                    disabled={pendentes.has(escopo.id)}
                    onCheckedChange={(ligado) => void alternar(escopo, ligado)}
                    aria-label={rotuloDoInterruptor(escopo)}
                  />
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
