"use client";
/**
 * A lista de materiais curados, agrupada por assunto.
 *
 * Spec 002 (RAG por operadora), T066. Serve às duas listas — a de uma operadora e a dos
 * materiais que valem para todas —, porque a diferença entre elas é de ONDE o material
 * nasce, não de como ele é lido.
 *
 * ═══ POR QUE UM CARD POR ASSUNTO, E NÃO UMA LINHA POR REGISTRO ═══
 *
 * A rota devolve uma linha por VERSÃO. Numa tabela crua, um material corrigido três vezes
 * vira quatro linhas quase idênticas, e a pergunta que o curador realmente tem — "qual
 * texto está respondendo hoje?" — passa a depender de ele comparar números de versão a
 * olho. Agrupar por assunto responde isso antes de ele perguntar, e é o que sobra de
 * espaço para a versão que está esperando decisão aparecer com destaque em vez de virar
 * mais uma linha no meio.
 */
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CaretDown, Plus, Warning } from "@/lib/ui/icons";

import {
  agruparPorSlug,
  contarAguardando,
  formatarInstante,
  formatarTamanho,
  origemLegivel,
  papelDaVersao,
  plural,
  rotuloDeValidade,
  type GrupoDeMaterial,
  type PapelDaVersao,
} from "./_derivacao";
import { DialogAceitarVersao, DialogPublicarVersao, DialogVerVersao } from "./_dialogos";
import type { MaterialResumido } from "./_tipos";

function EtiquetaDeValidade({ validUntil }: { validUntil: string | null }) {
  const r = rotuloDeValidade(validUntil);
  if (r.estado === "sem-prazo") return null;
  const variante = r.estado === "vencido" ? "error" : r.estado === "vence-em-breve" ? "warning" : "neutral";
  return <Badge variant={variante}>{r.texto}</Badge>;
}

function LinhaDeVersao({
  versao,
  grupo,
  aoVer,
  aoDecidir,
}: {
  versao: MaterialResumido;
  grupo: GrupoDeMaterial;
  aoVer: (m: MaterialResumido, papel: PapelDaVersao) => void;
  aoDecidir: (m: MaterialResumido) => void;
}) {
  const papel = papelDaVersao(versao, grupo.versoes);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t py-2 text-sm first:border-t-0">
      <span className="w-20 shrink-0 font-medium">Versão {versao.version}</span>

      {papel === "vigente" ? <Badge variant="success">Responde hoje</Badge> : null}
      {papel === "aguardando" ? <Badge variant="warning">Esperando decisão</Badge> : null}
      {papel === "historico" ? <Badge variant="neutral">Histórico</Badge> : null}

      <span className="text-xs text-muted-foreground">{origemLegivel(versao.origin)}</span>
      <span className="text-xs text-muted-foreground">· {formatarInstante(versao.published_at)}</span>
      <span className="text-xs text-muted-foreground">· {formatarTamanho(versao.body_chars)}</span>

      <div className="ml-auto flex gap-1">
        <Button variant="ghost" size="sm" onClick={() => aoVer(versao, papel)}>
          Ver texto
        </Button>
        {papel === "aguardando" ? (
          <Button variant="secondary" size="sm" onClick={() => aoDecidir(versao)}>
            Comparar e decidir
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CardDoAssunto({
  grupo,
  aoVer,
  aoCorrigir,
  aoDecidir,
}: {
  grupo: GrupoDeMaterial;
  aoVer: (m: MaterialResumido, papel: PapelDaVersao) => void;
  aoCorrigir: (m: MaterialResumido) => void;
  aoDecidir: (m: MaterialResumido) => void;
}) {
  const [historicoAberto, setHistoricoAberto] = useState(false);
  const vigente = grupo.vigente;
  const esperando = grupo.aguardando[0] ?? null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate text-base font-medium">{grupo.titulo}</h3>
          <p className="text-xs text-muted-foreground">
            <code>{grupo.slug}</code> · {plural(grupo.versoes.length, "versão", "versões")}
            {vigente ? ` · responde hoje a versão ${vigente.version}` : " · nenhuma versão está respondendo"}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {vigente ? <Badge variant="neutral">{origemLegivel(vigente.origin)}</Badge> : null}
          <EtiquetaDeValidade validUntil={vigente?.valid_until ?? null} />
          {grupo.adotado ? <Badge variant="info">Corrigido nesta instalação</Badge> : null}
        </div>
      </div>

      {esperando ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-fg/25 bg-warning-bg p-3 text-sm text-warning-fg">
          <Warning size={18} weight="fill" aria-hidden className="shrink-0" />
          <p className="min-w-0 flex-1">
            A versão {esperando.version} chegou na atualização do produto e está esperando sua
            decisão. Ela não responde nada até você aceitá-la — foi assim que a sua correção
            sobreviveu à atualização.
          </p>
          <Button size="sm" onClick={() => aoDecidir(esperando)}>
            Comparar e decidir
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {vigente ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => aoVer(vigente, "vigente")}>
              Ver texto
            </Button>
            <Button variant="outline" size="sm" onClick={() => aoCorrigir(vigente)}>
              Corrigir (publica a versão {grupo.proximaVersao})
            </Button>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setHistoricoAberto((v) => !v)}
          aria-expanded={historicoAberto}
        >
          <CaretDown
            size={14}
            aria-hidden
            className={historicoAberto ? "rotate-180 transition-transform" : "transition-transform"}
          />
          {historicoAberto ? "Ocultar versões" : `Ver as ${grupo.versoes.length} versões`}
        </Button>
      </div>

      {historicoAberto ? (
        <div className="rounded-md border px-3">
          {grupo.versoes.map((v) => (
            <LinhaDeVersao key={v.id} versao={v} grupo={grupo} aoVer={aoVer} aoDecidir={aoDecidir} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function ListaDeMateriaisSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-32 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function ListaDeMateriais({
  materiais,
  carregando,
  erro,
  vazioTexto,
  aoPedirNovo,
}: {
  materiais: MaterialResumido[];
  carregando: boolean;
  erro: string | null;
  /** O que dizer quando não há nada — muda entre "esta operadora" e "vale para todas". */
  vazioTexto: string;
  /** Sem callback, a lista não mostra o botão de criar (usado quando não há onde criar). */
  aoPedirNovo?: () => void;
}) {
  const [vendo, setVendo] = useState<{ versao: MaterialResumido; papel: PapelDaVersao } | null>(null);
  const [corrigindo, setCorrigindo] = useState<GrupoDeMaterial | null>(null);
  const [decidindo, setDecidindo] = useState<GrupoDeMaterial | null>(null);
  const [inerteEmFoco, setInerteEmFoco] = useState<MaterialResumido | null>(null);

  const grupos = agruparPorSlug(materiais);
  const esperandoDecisao = contarAguardando(grupos);

  function abrirCorrecao(vigente: MaterialResumido) {
    setCorrigindo(grupos.find((g) => g.slug === vigente.slug) ?? null);
  }

  function abrirDecisao(inerte: MaterialResumido) {
    setInerteEmFoco(inerte);
    setDecidindo(grupos.find((g) => g.slug === inerte.slug) ?? null);
  }

  if (carregando) return <ListaDeMateriaisSkeleton />;

  if (erro) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Não consegui carregar os materiais.</p>
        <p className="mt-1">{erro}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {plural(grupos.length, "assunto", "assuntos")}
          {esperandoDecisao > 0 ? ` · ${esperandoDecisao} esperando sua decisão` : ""}
        </p>
        {aoPedirNovo ? (
          <Button size="sm" onClick={aoPedirNovo}>
            <Plus size={14} aria-hidden />
            Novo material
          </Button>
        ) : null}
      </div>

      {grupos.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">{vazioTexto}</Card>
      ) : (
        <div className="space-y-3">
          {grupos.map((g) => (
            <CardDoAssunto
              key={g.slug}
              grupo={g}
              aoVer={(versao, papel) => setVendo({ versao, papel })}
              aoCorrigir={abrirCorrecao}
              aoDecidir={abrirDecisao}
            />
          ))}
        </div>
      )}

      <DialogVerVersao
        versao={vendo?.versao ?? null}
        papel={vendo?.papel ?? "vigente"}
        aoFechar={() => setVendo(null)}
      />

      <DialogPublicarVersao
        base={corrigindo?.vigente ?? null}
        proxima={corrigindo?.proximaVersao ?? 1}
        aoFechar={() => setCorrigindo(null)}
      />

      <DialogAceitarVersao
        esperando={decidindo ? inerteEmFoco : null}
        vigente={decidindo?.vigente ?? null}
        proxima={decidindo?.proximaVersao ?? 1}
        aoFechar={() => {
          setDecidindo(null);
          setInerteEmFoco(null);
        }}
      />
    </div>
  );
}
