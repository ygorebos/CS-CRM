"use client";
/**
 * Os materiais de uma operadora — spec 002 (RAG por operadora), T066.
 *
 * Tela própria em vez de acordeão dentro da lista de operadoras: escrever material é
 * trabalho longo, e o curador precisa de um endereço para voltar, mandar para alguém e
 * recarregar sem perder o lugar.
 */
import { useState } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CaretLeft } from "@/lib/ui/icons";

import {
  mensagemDoErro,
  useCriarMaterialNoEscopo,
  useEscopos,
  useMateriaisDoEscopo,
} from "../_dados";
import { DialogNovoMaterial } from "../_dialogos";
import { ListaDeMateriais } from "../_materiais";

export function EscopoClient({ escopoId }: { escopoId: string }) {
  // A lista de escopos já está em cache quando se chega daqui pela navegação; buscá-la de
  // novo é barato e faz a tela abrir sozinha quando alguém cola o endereço direto.
  const escopos = useEscopos();
  const materiais = useMateriaisDoEscopo(escopoId);
  const criar = useCriarMaterialNoEscopo(escopoId);
  const [criando, setCriando] = useState(false);

  const escopo = escopos.data?.find((e) => e.id === escopoId) ?? null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/admin/catalogo">
            <CaretLeft size={14} aria-hidden />
            Catálogo
          </Link>
        </Button>

        {escopos.isLoading ? (
          <Skeleton className="h-9 w-72" />
        ) : escopo ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{escopo.display_name}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <code>{escopo.slug}</code>
                {escopo.official_code ? ` · registro ${escopo.official_code}` : ""}
              </p>
            </div>
            {escopo.is_active ? (
              <Badge variant="success">Em circulação</Badge>
            ) : (
              <Badge variant="neutral">Fora de circulação</Badge>
            )}
          </div>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">Operadora</h1>
        )}
      </div>

      {escopo && !escopo.is_active ? (
        <Card className="border-warning-fg/25 bg-warning-bg p-3 text-sm text-warning-fg">
          Esta operadora está fora de circulação: o material abaixo continua guardado, mas não é
          usado nas respostas de nenhuma conta. Religue na lista de operadoras quando quiser.
        </Card>
      ) : null}

      <ListaDeMateriais
        materiais={materiais.data ?? []}
        carregando={materiais.isLoading}
        erro={materiais.isError ? mensagemDoErro(materiais.error) : null}
        vazioTexto="Esta operadora ainda não tem material. Comece pelo assunto que mais aparece nas perguntas sem resposta."
        aoPedirNovo={() => setCriando(true)}
      />

      <DialogNovoMaterial
        aberto={criando}
        aoFechar={() => setCriando(false)}
        onde={`Este material vai valer só para ${escopo?.display_name ?? "esta operadora"}.`}
        criar={(m) => criar.mutateAsync(m)}
        pendente={criar.isPending}
      />
    </div>
  );
}
