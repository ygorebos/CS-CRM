"use client";
/**
 * A conversa da tela de curadoria com `/api/v1/catalog/*`.
 *
 * Spec 002 (RAG por operadora), T066. As rotas são T063/T064/T065 — nada aqui reimplementa
 * regra delas; este arquivo só busca, invalida cache e traduz erro para frase.
 *
 * ═══ POR QUE TODA MUTAÇÃO INVALIDA A LISTA INTEIRA ═══
 *
 * Publicar uma versão nova muda mais coisa do que a linha publicada: o assunto passa a ter
 * uma versão a mais, a contagem do escopo pode mudar, e — a parte que não é óbvia — o slug
 * fica ADOTADO, o que muda o destino de toda versão futura que a atualização do produto
 * trouxer. Atualizar só a linha editada deixaria a tela contando uma história menor do que
 * a que o banco passou a contar.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

import type {
  EscopoDoCatalogo,
  LacunasDoCatalogo,
  MaterialCompleto,
  MaterialPublicado,
  MaterialResumido,
  RespostaDaApi,
} from "./_tipos";

const RAIZ = ["admin", "catalogo"] as const;

export const chaves = {
  escopos: () => [...RAIZ, "escopos"] as const,
  materiaisDoEscopo: (escopoId: string) => [...RAIZ, "materiais", "escopo", escopoId] as const,
  materiaisGerais: () => [...RAIZ, "materiais", "todas"] as const,
  material: (id: string) => [...RAIZ, "material", id] as const,
  lacunas: (dias: number) => [...RAIZ, "lacunas", dias] as const,
};

/**
 * A frase que o curador lê quando algo falha.
 *
 * A API já responde em português e já distingue conflito de estado de erro de infra
 * (`escopo_ja_existe`, `state_conflict`, `rate_limited`). Reescrever isso aqui produziria
 * duas versões da mesma mensagem, e a da tela seria sempre a mais pobre — ela não sabe
 * qual slug colidiu. Só o caso sem mensagem nenhuma ganha texto próprio.
 */
export function mensagemDoErro(erro: unknown): string {
  if (erro instanceof ApiError) {
    if (erro.message && erro.message !== erro.code) return erro.message;
    if (erro.status === 403) {
      return "O catálogo é da plataforma. Só o administrador do servidor edita este conteúdo.";
    }
    if (erro.status === 429) return "Muitas ações seguidas. Espere alguns segundos e tente de novo.";
    return "Não consegui concluir. Tente de novo em instantes.";
  }
  if (erro instanceof Error && erro.message) return erro.message;
  return "Não consegui concluir. Tente de novo em instantes.";
}

// ---------------------------------------------------------------------------
// Escopos
// ---------------------------------------------------------------------------

export function useEscopos() {
  return useQuery({
    queryKey: chaves.escopos(),
    queryFn: () =>
      apiClient
        .get<RespostaDaApi<EscopoDoCatalogo[]>>("/api/v1/catalog/scopes")
        .then((r) => r.data ?? []),
    staleTime: 60_000,
  });
}

export interface NovoEscopo {
  slug: string;
  display_name: string;
  official_code?: string | null;
}

export function useCriarEscopo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entrada: NovoEscopo) =>
      apiClient
        .post<RespostaDaApi<EscopoDoCatalogo>>("/api/v1/catalog/scopes", {
          slug: entrada.slug,
          display_name: entrada.display_name,
          official_code: entrada.official_code?.trim() ? entrada.official_code.trim() : null,
        })
        .then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: chaves.escopos() }),
  });
}

/**
 * Liga e desliga a operadora para a instalação INTEIRA.
 *
 * Não existe apagar, e isso é do desenho da rota: material aponta para o escopo com
 * `on delete restrict`, e apagar um escopo semeado só o traria de volta na próxima
 * atualização. Desligar é reversível e sobrevive à atualização.
 */
export function useAlternarEscopo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ativo }: { id: string; ativo: boolean }) =>
      apiClient
        .patch<RespostaDaApi<EscopoDoCatalogo>>(`/api/v1/catalog/scopes/${id}`, { is_active: ativo })
        .then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: chaves.escopos() }),
  });
}

// ---------------------------------------------------------------------------
// Materiais
// ---------------------------------------------------------------------------

export function useMateriaisDoEscopo(escopoId: string | null) {
  return useQuery({
    queryKey: chaves.materiaisDoEscopo(escopoId ?? "—"),
    queryFn: () =>
      apiClient
        .get<RespostaDaApi<MaterialResumido[]>>(`/api/v1/catalog/scopes/${escopoId}/materials`)
        .then((r) => r.data ?? []),
    enabled: Boolean(escopoId),
    staleTime: 30_000,
  });
}

export function useMateriaisGerais() {
  return useQuery({
    queryKey: chaves.materiaisGerais(),
    queryFn: () =>
      apiClient
        .get<RespostaDaApi<MaterialResumido[]>>("/api/v1/catalog/materials?applies_to_all=true")
        .then((r) => r.data ?? []),
    staleTime: 30_000,
  });
}

/** O material aberto, com o texto. Só busca quando há um id — o diálogo monta fechado. */
export function useMaterial(id: string | null) {
  return useQuery({
    queryKey: chaves.material(id ?? "—"),
    queryFn: () =>
      apiClient
        .get<RespostaDaApi<MaterialCompleto>>(`/api/v1/catalog/materials/${id}`)
        .then((r) => r.data),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export interface NovoMaterial {
  slug: string;
  title: string;
  body: string;
  valid_until?: string | null;
}

/** Cria o PRIMEIRO material de um assunto dentro de uma operadora. */
export function useCriarMaterialNoEscopo(escopoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entrada: NovoMaterial) =>
      apiClient
        .post<RespostaDaApi<MaterialResumido>>(`/api/v1/catalog/scopes/${escopoId}/materials`, {
          slug: entrada.slug,
          title: entrada.title,
          body: entrada.body,
          valid_until: entrada.valid_until || null,
        })
        .then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaves.materiaisDoEscopo(escopoId) });
      void qc.invalidateQueries({ queryKey: chaves.escopos() });
    },
  });
}

/**
 * Cria material que vale para TODAS as operadoras.
 *
 * Rota diferente da anterior, e não é duplicação: o banco exige exatamente um dos dois —
 * ou o material é de uma operadora, ou vale para todas. Material "para todas" não tem
 * escopo em que se pendurar, então não cabe numa rota cujo escopo vem do endereço.
 */
export function useCriarMaterialGeral() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entrada: NovoMaterial) =>
      apiClient
        .post<RespostaDaApi<MaterialResumido>>("/api/v1/catalog/materials", {
          slug: entrada.slug,
          title: entrada.title,
          body: entrada.body,
          valid_until: entrada.valid_until || null,
          applies_to_all: true,
        })
        .then((r) => r.data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: chaves.materiaisGerais() }),
  });
}

export interface PublicacaoDeVersao {
  /** A versão de onde a correção parte. O conteúdo dela é a base; o número, não. */
  baseId: string;
  title?: string;
  body?: string;
  valid_until?: string | null;
}

/**
 * Publica uma versão NOVA do material. Não sobrescreve nada.
 *
 * O verbo da rota é `PATCH` e a gravação é um `INSERT`: nasce `version + 1`, a anterior
 * continua no banco, e o slug fica adotado por esta instalação — é a adoção que faz a
 * versão que a próxima atualização trouxer chegar sem valer, em vez de apagar esta
 * correção sem tocar em uma linha.
 */
export function usePublicarVersao(aoTerminar?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ baseId, ...campos }: PublicacaoDeVersao) =>
      apiClient
        .patch<RespostaDaApi<MaterialPublicado>>(`/api/v1/catalog/materials/${baseId}`, campos)
        .then((r) => r.data),
    onSuccess: () => {
      // Lista larga de propósito: ver o comentário do topo do arquivo.
      void qc.invalidateQueries({ queryKey: RAIZ });
      aoTerminar?.();
    },
  });
}

// ---------------------------------------------------------------------------
// Lacunas
// ---------------------------------------------------------------------------

export function useLacunas(dias: number) {
  return useQuery({
    queryKey: chaves.lacunas(dias),
    queryFn: () =>
      apiClient
        .get<RespostaDaApi<LacunasDoCatalogo>>(`/api/v1/catalog/gaps?days=${dias}`)
        .then((r) => r),
    staleTime: 60_000,
  });
}
