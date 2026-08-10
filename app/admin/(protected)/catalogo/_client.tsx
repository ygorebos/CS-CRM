"use client";
/**
 * A tela de curadoria do catálogo — a mesa de trabalho de quem mantém o conteúdo que toda
 * instalação recebe pronto.
 *
 * Spec 002 (RAG por operadora), T066.
 *
 * ═══ AS TRÊS ABAS SÃO O CICLO, NÃO UM MENU ═══
 *
 * Lacunas mostra o que faltou responder; Operadoras é onde o material daquele assunto é
 * escrito; Vale para todas é onde mora o que independe de operadora. A ordem em que
 * aparecem é a ordem em que o trabalho acontece — abre-se na primeira porque a pergunta do
 * curador ao chegar aqui quase nunca é "o que existe?", e quase sempre "o que está
 * faltando?".
 *
 * ═══ QUEM VÊ ISTO ═══
 *
 * Só administrador de plataforma. A guarda não está neste arquivo: quem barra é
 * `app/admin/(protected)/layout.tsx`, que valida o papel no servidor e manda quem não tem
 * para `/admin/forbidden` — negação explicada, não tela vazia. As rotas por trás repetem a
 * mesma trava, então nem uma aba aberta com o papel revogado no meio do caminho passa
 * conteúdo adiante.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { PainelDeEscopos } from "./_escopos";
import { PainelDeMateriaisGerais } from "./_gerais";
import { PainelDeLacunas } from "./_lacunas";

export function CatalogoClient() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Catálogo de conhecimento</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          O conteúdo sobre operadoras que já vem pronto em toda instalação deste servidor. Não
          pertence a nenhuma conta: é escrito aqui e usado por todas. Cada conta pode desligar o
          que não serve para ela e sobrepor com material próprio, mas não consegue editar o que
          está aqui.
        </p>
      </div>

      <Tabs defaultValue="lacunas" className="space-y-4">
        <TabsList>
          <TabsTrigger value="lacunas">O que está faltando</TabsTrigger>
          <TabsTrigger value="operadoras">Operadoras</TabsTrigger>
          <TabsTrigger value="gerais">Vale para todas</TabsTrigger>
        </TabsList>

        <TabsContent value="lacunas">
          <PainelDeLacunas />
        </TabsContent>

        <TabsContent value="operadoras">
          <PainelDeEscopos />
        </TabsContent>

        <TabsContent value="gerais">
          <PainelDeMateriaisGerais />
        </TabsContent>
      </Tabs>
    </div>
  );
}
