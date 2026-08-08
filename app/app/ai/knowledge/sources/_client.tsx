"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { NovoMaterialDialog } from "@/components/knowledge/NovoMaterialDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import { ArrowsClockwise, Plus, Warning } from "@/lib/ui/icons";
import type { RotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

// A origem é a MESMA coisa nas duas telas — quem corrige o material é outra pessoa em
// cada camada (FR-039). Reusar o rótulo daqui é o que impede o corretor de ler "Já vem no
// sistema" numa tela e outra coisa qualquer na vizinha.
import { ORIGEM_CATALOGO, rotuloDaOrigem } from "../scopes/_regras";
import {
  AVISO_ORFAO,
  CHAVE_ORFA,
  NOVO_MATERIAL_SUCESSO,
  SEM_OPERADORA_LIGADA_TEXTO,
  SEM_OPERADORA_LIGADA_TITULO,
  TITULO,
  VAZIO_TEXTO,
  VAZIO_TITULO,
  agruparPorEscopo,
  caminhoDeNovaTentativa,
  caminhoDoNovoMaterial,
  corpoDoNovoMaterial,
  explicacaoDoGrupo,
  fraseDoResumo,
  podeTentarDeNovo,
  resumoDaTela,
  subtitulo,
  type DadosDoNovoMaterial,
  type EscopoNaTela,
  type GrupoDeMateriais,
  type MaterialDoCorretor,
  type MaterialNaTela,
} from "./_regras";

/**
 * A tela do acervo do corretor (spec 002, T090 e T118).
 *
 * ## O que mudou, e por que os quatro slots tinham de morrer
 *
 * Até aqui esta tela desenhava **quatro caixas fixas** — FAQ, política, conversas,
 * catálogo — com no máximo um material em cada (o `SLOTS` que vivia na linha 22). Não era
 * escolha de layout: o banco impunha o mesmo limite, com um índice único por
 * `(agent_id, source_type)`. Com ele, o corretor que carregasse o manual da segunda
 * operadora recebia violação de unicidade. O produto agora é **N materiais por operadora**
 * (FR-003), então a tela passa a ser uma lista agrupada, sem número mágico em lugar nenhum.
 *
 * ## O estado de cada material é a razão de existir da tela
 *
 * FR-005 pede estado inequívoco por material, e FR-004 proíbe que material aceito fique
 * sem virar conteúdo buscável **em silêncio**. É por isso que cada linha carrega uma
 * etiqueta, uma frase e — quando é problema — o que fazer em seguida, e é por isso que o
 * topo conta quantos precisam de atenção. A regra que decide tudo isso está em
 * `_regras.ts`, testada; aqui só se desenha o que ela decidiu.
 *
 * ## Os dados chegam prontos da página
 *
 * Mesmo padrão da tela vizinha (`../scopes/page.tsx`): quem lê é o servidor. Depois de
 * qualquer mutação — e a cada mudança que o Realtime anuncia — a atualização é
 * `router.refresh()`, que refaz a leitura pelo mesmo caminho. Uma segunda fonte de leitura
 * no cliente seria uma segunda chance de a tela e o banco discordarem sobre o estado de um
 * material, que é justamente o que FR-004 proíbe.
 */

interface Props {
  agentId: string;
  rotulo: RotuloDoEscopo;
  escopos: EscopoNaTela[];
  materiais: MaterialDoCorretor[];
  /** Operadora que veio no link da tela vizinha, já escolhida no formulário. */
  escopoInicial: string | null;
}

export function KnowledgeSourcesClient({
  agentId,
  rotulo,
  escopos,
  materiais,
  escopoInicial,
}: Props) {
  const router = useRouter();
  const [dialogoAberto, setDialogoAberto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [tentando, setTentando] = useState<ReadonlySet<string>>(new Set());
  const [escopoEmFoco, setEscopoEmFoco] = useState<string | null>(escopoInicial);

  const grupos = useMemo(
    () => agruparPorEscopo(materiais, escopos, rotulo),
    [materiais, escopos, rotulo],
  );
  const resumo = useMemo(() => resumoDaTela(grupos), [grupos]);
  const ligados = useMemo(() => escopos.filter((e) => e.is_active), [escopos]);

  const recarregar = useCallback(() => router.refresh(), [router]);

  // Pelo hook compartilhado: `.channel()` cru assina como ANÔNIMO (cookie de sessão
  // httpOnly) — recebe "ok" e nunca entrega. Aqui o efeito seria o material ficar
  // "preparando" na tela depois de já estar pronto no banco.
  useRealtimeChannel({
    name: `ai-knowledge-sources-${agentId}`,
    postgresChanges: {
      event: "*",
      schema: "public",
      table: "ai_knowledge_sources",
      filter: `agent_id=eq.${agentId}`,
    },
    onChange: recarregar,
  });

  function abrirFormulario(escopoId: string | null) {
    setEscopoEmFoco(escopoId);
    setDialogoAberto(true);
  }

  async function salvar(dados: DadosDoNovoMaterial) {
    const conferido = corpoDoNovoMaterial(dados, agentId);
    if (!conferido.ok) {
      toast.error(conferido.erro);
      return;
    }
    setEnviando(true);
    try {
      await apiClient.post(caminhoDoNovoMaterial(dados.escopoId), conferido.corpo);
      toast.success(NOVO_MATERIAL_SUCESSO);
      setDialogoAberto(false);
      recarregar();
    } catch (erro) {
      // Falha na carga aparece inteira: aceitar em silêncio é o defeito que FR-004 proíbe.
      showApiError(erro);
    } finally {
      setEnviando(false);
    }
  }

  async function tentarDeNovo(material: MaterialDoCorretor) {
    if (tentando.has(material.id)) return;
    setTentando((atual) => new Set(atual).add(material.id));
    try {
      await apiClient.post(caminhoDeNovaTentativa(material.id), {});
      toast.success(`Estou preparando ${material.name} de novo. Acompanhe por aqui.`);
      recarregar();
    } catch (erro) {
      showApiError(erro);
    } finally {
      setTentando((atual) => {
        const proximo = new Set(atual);
        proximo.delete(material.id);
        return proximo;
      });
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{TITULO}</h1>
          <p className="mt-1 max-w-3xl text-sm text-text-muted">{subtitulo(rotulo)}</p>
          {/*
            O número que pede ação vem primeiro e fica no alto: com dezenas de materiais,
            um que não responde nada some no meio da lista, e ninguém rola a página atrás
            de um problema que não sabe que existe (FR-004).
          */}
          {resumo.materiais > 0 && (
            <p className="mt-1 text-sm font-medium text-text">{fraseDoResumo(resumo)}</p>
          )}
        </div>
        {ligados.length > 0 && (
          // Sem `abrirFormulario` aqui de propósito: o botão do topo mantém a operadora
          // que já estava em foco — a que veio no link da tela vizinha, ou a do último
          // material salvo. Zerá-la faria quem chegou por "carregar material da Amil"
          // ter de escolher Amil de novo.
          <Button onClick={() => setDialogoAberto(true)}>
            <Plus size={14} aria-hidden />
            Novo material
          </Button>
        )}
      </header>

      {ligados.length === 0 ? (
        <Card className="p-6">
          <p className="text-base font-medium">{SEM_OPERADORA_LIGADA_TITULO}</p>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">{SEM_OPERADORA_LIGADA_TEXTO}</p>
          <Link
            href="/app/ai/knowledge/scopes"
            className="mt-4 inline-block text-sm font-medium text-accent underline underline-offset-4"
          >
            Ligar o que eu vendo
          </Link>
        </Card>
      ) : grupos.length === 0 ? (
        <Card className="p-6">
          <p className="text-base font-medium">{VAZIO_TITULO}</p>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">{VAZIO_TEXTO}</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {grupos.map((grupo) => (
            <CardDoGrupo
              key={grupo.chave}
              grupo={grupo}
              tentando={tentando}
              aoAdicionar={abrirFormulario}
              aoTentarDeNovo={tentarDeNovo}
            />
          ))}
        </div>
      )}

      {/*
        O `key` é o que zera o formulário: cada abertura (e cada operadora escolhida pelo
        botão do card) monta um diálogo novo, em vez de um `useEffect` que apaga campo por
        campo depois de já ter desenhado o rascunho anterior.
      */}
      <NovoMaterialDialog
        key={`${dialogoAberto ? "aberto" : "fechado"}-${escopoEmFoco ?? ""}`}
        aberto={dialogoAberto}
        escopos={ligados}
        escopoInicial={escopoEmFoco}
        rotulo={rotulo}
        enviando={enviando}
        aoFechar={() => setDialogoAberto(false)}
        aoEnviar={(dados) => void salvar(dados)}
      />
    </div>
  );
}

function CardDoGrupo({
  grupo,
  tentando,
  aoAdicionar,
  aoTentarDeNovo,
}: {
  grupo: GrupoDeMateriais;
  tentando: ReadonlySet<string>;
  aoAdicionar: (escopoId: string | null) => void;
  aoTentarDeNovo: (material: MaterialDoCorretor) => void;
}) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-medium text-text">{grupo.titulo}</h2>
            {grupo.origem && (
              <Badge variant={grupo.origem === ORIGEM_CATALOGO ? "neutral" : "default"}>
                {rotuloDaOrigem(grupo.origem)}
              </Badge>
            )}
            {grupo.problemas > 0 && (
              <Badge variant="warning">
                {grupo.problemas === 1
                  ? "1 precisa de atenção"
                  : `${grupo.problemas} precisam de atenção`}
              </Badge>
            )}
          </div>
          <p className="text-sm text-text-muted">{explicacaoDoGrupo(grupo)}</p>
        </div>
        {grupo.escopoId && (
          <Button variant="outline" size="sm" onClick={() => aoAdicionar(grupo.escopoId)}>
            <Plus size={14} aria-hidden />
            Adicionar material
          </Button>
        )}
      </div>

      {grupo.chave === CHAVE_ORFA && (
        <p className="flex items-start gap-2 rounded-lg border border-warning-fg/25 bg-warning-bg p-3 text-sm text-warning-fg">
          <Warning size={18} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          <span>{AVISO_ORFAO}</span>
        </p>
      )}

      {grupo.materiais.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {grupo.materiais.map((item) => (
            <LinhaDeMaterial
              key={item.material.id}
              item={item}
              tentando={tentando.has(item.material.id)}
              aoTentarDeNovo={aoTentarDeNovo}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function LinhaDeMaterial({
  item,
  tentando,
  aoTentarDeNovo,
}: {
  item: MaterialNaTela;
  tentando: boolean;
  aoTentarDeNovo: (material: MaterialDoCorretor) => void;
}) {
  const { material, diagnostico } = item;

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{material.name}</span>
          <Badge variant={diagnostico.tom}>{diagnostico.rotulo}</Badge>
        </div>
        <p className="text-sm text-text-muted">{diagnostico.explicacao}</p>
        {diagnostico.oQueFazer && (
          <p className="text-sm font-medium text-text">{diagnostico.oQueFazer}</p>
        )}
      </div>

      {podeTentarDeNovo(diagnostico.estado) && (
        <Button
          variant="secondary"
          size="sm"
          disabled={tentando}
          onClick={() => aoTentarDeNovo(material)}
          aria-label={`Tentar de novo ${material.name}`}
        >
          <ArrowsClockwise size={14} aria-hidden />
          {tentando ? "Preparando…" : "Tentar de novo"}
        </Button>
      )}
    </li>
  );
}
