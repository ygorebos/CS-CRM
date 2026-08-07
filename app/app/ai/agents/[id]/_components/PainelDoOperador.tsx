"use client";
/**
 * O painel do papel OPERADOR (spec 16 §3.2 e §6).
 *
 * A tela precisa fazer três coisas que a versão anterior não fazia, e as três
 * saíram da medição, não de gosto:
 *
 *   1. **Dizer onde cada configuração ATUA.** O defeito de 30% de vazamento
 *      nasceu de um único contexto servindo dois destinatários; a tela que
 *      configura isso não pode repetir a confusão apresentando tudo junto.
 *   2. **Dizer a CONSEQUÊNCIA de desligar**, não o nome do que se desliga.
 *      "Desabilitar agente operador" não informa nada a um dono de clínica.
 *   3. **Não mentir sobre o alcance.** O que está aqui é o que ESTE papel usa —
 *      lista própria (`operator_tool_ids`), nunca a do Conversador.
 */
import * as React from "react";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { ModelPicker } from "./ModelPicker";
import { ToolPicker } from "./ToolPicker";
import type { Provider } from "@/hooks/ai/useCredentials";

interface Props {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  /** "" = herda o modelo do Conversador. */
  model: string;
  onModelChange: (v: string) => void;
  provider: Provider;
  toolIds: string[];
  onToolIdsChange: (ids: string[]) => void;
  /** o modelo do Conversador, para dizer o que "herdar" significa na prática. */
  modeloDoConversador: string;
  disabled?: boolean;
}

export function PainelDoOperador(props: Props) {
  const desabilitado = props.disabled ?? false;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Switch
            id="operator_enabled"
            data-testid="operador-liga"
            checked={props.enabled}
            onCheckedChange={props.onEnabledChange}
            disabled={desabilitado}
          />
          <div className="space-y-1">
            <Label htmlFor="operator_enabled" className="text-sm font-medium">
              Deixar o agente organizar o sistema depois de cada conversa
            </Label>
            <p className="text-xs text-muted-foreground">
              Quem conversa com o cliente é uma coisa; quem mantém o sistema em dia é outra.
              Separar os dois evita que o assistente comente com o cliente o que está fazendo
              por dentro — e é o que faz ele realmente registrar, em vez de só responder bem.
            </p>
          </div>
        </div>

        {/*
          A consequência de DESLIGAR, dita antes de a pessoa desligar. Um switch
          que só diz o nome da feature transfere ao usuário a tarefa de adivinhar
          o que perde — e essa é a decisão que a spec 16 §2.1 fechou: desligar
          NÃO desliga o registro básico, desliga o julgamento.
        */}
        {!props.enabled ? (
          <div
            data-testid="operador-consequencia"
            className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
          >
            <p className="font-medium text-foreground">Com isto desligado:</p>
            <p className="mt-1">
              o assistente continua atendendo e o básico continua sendo registrado sozinho —
              a etapa do cliente, o retorno que ele prometeu e o histórico da conversa.
            </p>
            <p className="mt-1">
              O que ele deixa de fazer é <strong>decidir sobre a operação</strong>: abrir
              chamados, distribuir para a pessoa certa, organizar marcadores e etapas.
              Isso passa a ser trabalho de alguém do time.
            </p>
          </div>
        ) : null}
      </Card>

      {props.enabled ? (
        <>
          <Card className="space-y-2 p-4">
            <h3 className="text-sm font-medium">A inteligência que ele usa para organizar</h3>
            <p className="text-xs text-muted-foreground">
              Pode ser diferente da que conversa. Organizar o sistema é uma tarefa mais
              mecânica que atender uma pessoa — costuma sair bem com um modelo mais barato.
            </p>
            <ModelPicker
              provider={props.provider}
              value={props.model}
              onChange={props.onModelChange}
              disabled={desabilitado}
              // O estado vazio é legítimo aqui e precisa ter NOME: chamá-lo de
              // "Selecione um modelo" faria parecer pendência o que é escolha.
              placeholder={
                props.modeloDoConversador === ""
                  ? "A mesma que conversa"
                  : `A mesma que conversa (${props.modeloDoConversador})`
              }
            />
            {/*
              O caminho de VOLTA. Um Select não consegue oferecer "nenhum" como
              item (valor vazio não é selecionável), então sem este botão a
              escolha seria de mão única: bastaria clicar uma vez para nunca mais
              conseguir voltar a herdar — e o usuário não teria como saber por quê.
            */}
            {props.model !== "" ? (
              <button
                type="button"
                data-testid="operador-modelo-herdar"
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={() => props.onModelChange("")}
                disabled={desabilitado}
              >
                Usar a mesma que conversa
              </button>
            ) : null}
          </Card>

          <Card className="space-y-2 p-4">
            <h3 className="text-sm font-medium">O que ele pode mexer no sistema</h3>
            <p className="text-xs text-muted-foreground">
              Esta lista é só deste papel — nada aqui é usado enquanto ele conversa com o
              cliente. Ligue por jornada de trabalho.
            </p>
            <div data-testid="operador-capacidades">
              <ToolPicker
                value={props.toolIds}
                onChange={props.onToolIdsChange}
                disabled={desabilitado}
              />
            </div>
            {props.toolIds.length === 0 ? (
              // Estado legítimo, mas que precisa ser explicado: sem isto o
              // usuário liga o papel, não escolhe nada, e conclui que quebrou.
              <p data-testid="operador-sem-capacidade" className="text-xs text-muted-foreground">
                Sem nada marcado, ele ainda avisa você quando o assistente prometer algo a um
                cliente e ninguém cumprir — mas não consegue resolver sozinho.
              </p>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
