"use client";
/**
 * A lista de operadoras curadas: criar, abrir, e tirar de circulação.
 *
 * Spec 002 (RAG por operadora), T066.
 *
 * ═══ NÃO EXISTE BOTÃO DE APAGAR, E ISSO É DECISÃO ═══
 *
 * Apagar uma operadora do catálogo é impossível por dois motivos que se somam: os materiais
 * apontam para ela e o banco recusa a remoção, e — mesmo que aceitasse — a operadora
 * voltaria na próxima atualização do produto, porque a semeadura reinsere o que falta.
 * Desligar é o que realmente tira de circulação, é reversível, e sobrevive à atualização.
 * Um botão "excluir" aqui seria um botão que ora falha, ora desfaz sozinho.
 */
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus } from "@/lib/ui/icons";

import { mensagemDoErro, useAlternarEscopo, useCriarEscopo, useEscopos } from "./_dados";
import { plural } from "./_derivacao";
import type { EscopoDoCatalogo } from "./_tipos";

function DialogNovoEscopo({ aberto, aoFechar }: { aberto: boolean; aoFechar: () => void }) {
  const [slug, setSlug] = useState("");
  const [nome, setNome] = useState("");
  const [registro, setRegistro] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const criar = useCriarEscopo();

  async function enviar() {
    setErro(null);
    try {
      await criar.mutateAsync({
        slug: slug.trim(),
        display_name: nome.trim(),
        official_code: registro.trim() || null,
      });
      toast.success(`Operadora "${nome.trim()}" criada.`);
      setSlug("");
      setNome("");
      setRegistro("");
      aoFechar();
    } catch (e) {
      setErro(mensagemDoErro(e));
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova operadora</DialogTitle>
          <DialogDescription>
            Cadastrar a operadora não cria conteúdo. Ela passa a existir como assunto, e os
            materiais vêm depois.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="escopo-nome">Nome</Label>
            <Input
              id="escopo-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Unimed Nacional"
              disabled={criar.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="escopo-slug">Identificador</Label>
            <Input
              id="escopo-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="unimed-nacional"
              autoComplete="off"
              disabled={criar.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Minúsculas, números e hífen. É por ele que as atualizações do produto reconhecem esta
              operadora — depois de criado, ele não muda.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="escopo-registro">Registro oficial (opcional)</Label>
            <Input
              id="escopo-registro"
              value={registro}
              onChange={(e) => setRegistro(e.target.value)}
              placeholder="Registro na ANS"
              disabled={criar.isPending}
            />
          </div>

          {erro ? (
            <div className="rounded-lg border border-warning-fg/25 bg-warning-bg p-3 text-sm text-warning-fg">
              {erro}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={aoFechar} disabled={criar.isPending}>
            Cancelar
          </Button>
          <Button
            onClick={() => void enviar()}
            disabled={!slug.trim() || !nome.trim() || criar.isPending}
          >
            {criar.isPending ? "Criando…" : "Criar operadora"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinhaDeEscopo({
  escopo,
  aoDesligar,
}: {
  escopo: EscopoDoCatalogo;
  aoDesligar: (e: EscopoDoCatalogo) => void;
}) {
  const alternar = useAlternarEscopo();

  async function ligar() {
    try {
      await alternar.mutateAsync({ id: escopo.id, ativo: true });
      toast.success(`${escopo.display_name} voltou a circular.`);
    } catch (e) {
      toast.error(mensagemDoErro(e));
    }
  }

  return (
    <TableRow>
      <TableCell>
        <Link href={`/admin/catalogo/${escopo.id}`} className="font-medium hover:underline">
          {escopo.display_name}
        </Link>
        <p className="text-xs text-muted-foreground">
          <code>{escopo.slug}</code>
          {escopo.official_code ? ` · registro ${escopo.official_code}` : ""}
        </p>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
        {typeof escopo.materials_count === "number"
          ? plural(escopo.materials_count, "assunto", "assuntos")
          : "—"}
      </TableCell>
      <TableCell>
        {escopo.is_active ? (
          <Badge variant="success">Em circulação</Badge>
        ) : (
          <Badge variant="neutral">Fora de circulação</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-3">
          <Switch
            checked={escopo.is_active}
            disabled={alternar.isPending}
            aria-label={
              escopo.is_active
                ? `Tirar ${escopo.display_name} de circulação`
                : `Colocar ${escopo.display_name} em circulação`
            }
            onCheckedChange={(v) => {
              // Ligar é inofensivo e vai direto. Desligar tira a operadora do ar para a
              // instalação inteira, então passa por confirmação — o custo de um clique
              // errado aqui é o agente parar de responder sobre ela para todo mundo.
              if (v) void ligar();
              else aoDesligar(escopo);
            }}
          />
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/admin/catalogo/${escopo.id}`}>Abrir</Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function PainelDeEscopos() {
  const { data, isLoading, isError, error } = useEscopos();
  const [criando, setCriando] = useState(false);
  const [desligando, setDesligando] = useState<EscopoDoCatalogo | null>(null);
  const alternar = useAlternarEscopo();

  async function confirmarDesligar() {
    if (!desligando) return;
    const alvo = desligando;
    setDesligando(null);
    try {
      await alternar.mutateAsync({ id: alvo.id, ativo: false });
      toast.success(`${alvo.display_name} saiu de circulação. Nada foi apagado.`);
    } catch (e) {
      toast.error(mensagemDoErro(e));
    }
  }

  const escopos = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {isLoading ? "Carregando…" : plural(escopos.length, "operadora", "operadoras")}
        </p>
        <Button size="sm" onClick={() => setCriando(true)}>
          <Plus size={14} aria-hidden />
          Nova operadora
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : isError ? (
        <Card className="p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Não consegui carregar as operadoras.</p>
          <p className="mt-1">{mensagemDoErro(error)}</p>
        </Card>
      ) : escopos.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          Nenhuma operadora cadastrada ainda. Crie a primeira para começar a escrever material.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Operadora</TableHead>
                <TableHead>Conteúdo</TableHead>
                <TableHead>Situação</TableHead>
                <TableHead className="text-right">Circulação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {escopos.map((e) => (
                <LinhaDeEscopo key={e.id} escopo={e} aoDesligar={setDesligando} />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <DialogNovoEscopo aberto={criando} aoFechar={() => setCriando(false)} />

      <AlertDialog open={desligando !== null} onOpenChange={(v) => !v && setDesligando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Tirar {desligando?.display_name ?? ""} de circulação?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Vale para esta instalação inteira: o material desta operadora deixa de ser usado nas
              respostas de todas as contas. Nada é apagado, e dá para religar aqui mesmo quando
              quiser.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmarDesligar()}>
              Tirar de circulação
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
