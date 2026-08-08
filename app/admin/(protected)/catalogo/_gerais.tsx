"use client";
/**
 * Material que vale para TODAS as operadoras.
 *
 * Spec 002 (RAG por operadora), T066.
 *
 * Não é "a operadora genérica": um escopo fictício chamado "Todas" apareceria na lista de
 * operadoras e alguém acabaria vinculando um cliente a ele — um vínculo que não quer dizer
 * nada. Por isso material geral é uma categoria própria, com rota própria, e o banco exige
 * exatamente um dos dois: ou o material é de uma operadora, ou vale para todas.
 */
import { useState } from "react";

import { mensagemDoErro, useCriarMaterialGeral, useMateriaisGerais } from "./_dados";
import { DialogNovoMaterial } from "./_dialogos";
import { ListaDeMateriais } from "./_materiais";

export function PainelDeMateriaisGerais() {
  const { data, isLoading, isError, error } = useMateriaisGerais();
  const criar = useCriarMaterialGeral();
  const [criando, setCriando] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Orientações que independem da operadora — o que vale igual em qualquer plano. Elas entram
        nas respostas de todas as contas desta instalação, junto com o material da operadora do
        cliente.
      </p>

      <ListaDeMateriais
        materiais={data ?? []}
        carregando={isLoading}
        erro={isError ? mensagemDoErro(error) : null}
        vazioTexto="Nenhum material geral ainda. O que vale para qualquer operadora mora aqui — carência mínima por lei, prazos da ANS, esse tipo de coisa."
        aoPedirNovo={() => setCriando(true)}
      />

      <DialogNovoMaterial
        aberto={criando}
        aoFechar={() => setCriando(false)}
        onde="Este material vai valer para TODAS as operadoras desta instalação."
        criar={(m) => criar.mutateAsync(m)}
        pendente={criar.isPending}
      />
    </div>
  );
}
