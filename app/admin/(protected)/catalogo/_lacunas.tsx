"use client";
/**
 * O que os clientes perguntaram e o catálogo não cobria — o insumo da curadoria.
 *
 * Spec 002 (RAG por operadora), T066. Consome `GET /api/v1/catalog/gaps` (T064).
 *
 * ═══ ESTA TELA É O FIM DA LINHA DESSE DADO ═══
 *
 * Lacuna, pergunta de cliente e métrica de uso não atravessam a fronteira da instalação:
 * quem instalou herda o papel de curador e é a única pessoa que vê isto. A rota lê o banco
 * local e devolve para quem já é administrador dele — não existe caminho de saída, e a
 * tela diz isso em voz alta porque é o tipo de garantia que só vale se quem opera souber
 * que ela existe.
 *
 * A rota também não devolve de quem é a pergunta: nem organização, nem contato, nem
 * conversa. O curador precisa saber QUAL assunto ficou descoberto; saber de quem é o
 * cliente transformaria esta tela num navegador de clientes alheios.
 */
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Lock, Warning } from "@/lib/ui/icons";

import { mensagemDoErro, useLacunas } from "./_dados";
import { formatarInstante, plural } from "./_derivacao";

const PERIODOS = [
  { valor: "7", rotulo: "Últimos 7 dias" },
  { valor: "30", rotulo: "Últimos 30 dias" },
  { valor: "90", rotulo: "Últimos 90 dias" },
];

function Numero({
  titulo,
  valor,
  explicacao,
}: {
  titulo: string;
  valor: string;
  explicacao: string;
}) {
  return (
    <Card className="space-y-1 p-4">
      <p className="text-sm text-muted-foreground">{titulo}</p>
      <p className="text-2xl font-semibold tracking-tight">{valor}</p>
      <p className="text-xs text-muted-foreground">{explicacao}</p>
    </Card>
  );
}

export function PainelDeLacunas() {
  const [dias, setDias] = useState("30");
  const { data, isLoading, isError, error } = useLacunas(Number(dias));

  const lacunas = data?.data;
  const truncado = data?.meta?.truncated === true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Perguntas que o agente não conseguiu responder por falta de material. É daqui que sai a
          próxima coisa a escrever.
        </p>
        <Select value={dias} onValueChange={setDias}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODOS.map((p) => (
              <SelectItem key={p.valor} value={p.valor}>
                {p.rotulo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      ) : isError ? (
        <Card className="p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Não consegui carregar as lacunas.</p>
          <p className="mt-1">{mensagemDoErro(error)}</p>
        </Card>
      ) : lacunas ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Numero
              titulo="Perguntas encaminhadas a um humano"
              valor={String(lacunas.refusals.total)}
              explicacao={
                lacunas.refusals.open > 0
                  ? `${lacunas.refusals.open} ainda sem tratativa na Central`
                  : "Todas já foram tratadas na Central"
              }
            />
            <Numero
              titulo="Buscas que não acharam nada"
              valor={String(lacunas.searches.empty)}
              explicacao={`de ${plural(lacunas.searches.total, "busca no período", "buscas no período")}`}
            />
            <Numero
              titulo="Quase acharam"
              valor={String(lacunas.searches.near_miss)}
              explicacao="Havia material perto do assunto. Aqui o conserto costuma ser melhorar o texto que já existe, não escrever um novo."
            />
          </div>

          {truncado ? (
            <div className="flex gap-3 rounded-lg border border-warning-fg/25 bg-warning-bg p-3 text-sm text-warning-fg">
              <Warning size={18} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
              <p>
                O período tem mais registros do que cabe numa leitura, então os números abaixo são
                de uma amostra recente — a lacuna real é maior do que a mostrada. Escolha um período
                menor para ver o quadro completo.
              </p>
            </div>
          ) : null}

          <Card className="overflow-hidden">
            <div className="border-b px-4 py-3">
              <h3 className="text-sm font-medium">Por operadora</h3>
              <p className="text-xs text-muted-foreground">
                Analisadas {plural(lacunas.refusals.analyzed, "recusa", "recusas")} no período.
              </p>
            </div>
            {lacunas.refusals.by_scope.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                Nenhuma pergunta ficou sem resposta neste período.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Operadora</TableHead>
                    <TableHead>Vezes</TableHead>
                    <TableHead>Exemplo de pergunta</TableHead>
                    <TableHead>Última vez</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lacunas.refusals.by_scope.map((linha) => (
                    <TableRow key={linha.scope ?? "—sem-operadora—"}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {linha.scope ?? (
                          <span className="text-muted-foreground">Não identificada</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={linha.count >= 5 ? "warning" : "neutral"}>
                          {linha.count}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-md text-sm text-muted-foreground">
                        {linha.example_question ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatarInstante(linha.last_seen_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          {lacunas.refusals.examples.length > 0 ? (
            <Card className="space-y-3 p-4">
              <h3 className="text-sm font-medium">Perguntas recentes, como o cliente escreveu</h3>
              <ul className="space-y-2">
                {lacunas.refusals.examples.map((ex, i) => (
                  <li key={`${ex.seen_at}-${i}`} className="rounded-md border p-3 text-sm">
                    <p>“{ex.question}”</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ex.scope ?? "Operadora não identificada"} · {formatarInstante(ex.seen_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <div className="flex gap-3 rounded-lg border p-3 text-xs text-muted-foreground">
            <Lock size={16} aria-hidden className="mt-0.5 shrink-0" />
            <p>
              Nada disto sai deste servidor. As perguntas ficam nesta instalação e não são enviadas
              a quem fez o produto — quem instalou é o curador do catálogo daqui e responde pelo que
              editar nele.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
