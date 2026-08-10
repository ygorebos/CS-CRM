"use client";
/**
 * O formulário de material novo (spec 002, T090 e T118).
 *
 * ## Ele não decide nada
 *
 * O que é válido, o que vai no corpo do pedido e o que a tela diz moram em
 * `app/app/ai/knowledge/sources/_regras.ts` — importados daqui de propósito. A cópia é
 * varrida por teste (jargão nosso e concordância de gênero com o rótulo configurável);
 * reescrevê-la aqui criaria uma segunda versão do mesmo texto, sem ninguém olhando. Este
 * arquivo desenha os campos e devolve o que foi digitado.
 *
 * ## Pergunta e resposta, e não um campo de texto livre
 *
 * O motivo está em `ParDePerguntaEResposta`, em `_regras.ts`: é o único formato que o
 * produto sabe transformar em conteúdo buscável hoje. Um textarea grande aceitaria o
 * manual inteiro da operadora e produziria zero trecho — que é exatamente o defeito que
 * esta fatia existe para eliminar.
 *
 * ## A data é opcional, e isso é requisito
 *
 * FR-025: datar material é opcional e **não pode travar o corretor apressado**. Por isso o
 * campo nasce vazio, o botão de salvar funciona com ele vazio, e a única coisa que a tela
 * diz sobre a data é o que acontece se ela for preenchida.
 */
import { useState } from "react";

import {
  LIMITE_DE_PERGUNTAS,
  MAIS_UMA_PERGUNTA,
  NOVO_MATERIAL_DESCRICAO,
  NOVO_MATERIAL_TITULO,
  PERGUNTA_EXEMPLO,
  PERGUNTA_ROTULO,
  RESPOSTA_EXEMPLO,
  RESPOSTA_ROTULO,
  VALIDADE_AJUDA,
  VALIDADE_ROTULO,
  type DadosDoNovoMaterial,
  type ParDePerguntaEResposta,
} from "@/app/app/ai/knowledge/sources/_regras";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash } from "@/lib/ui/icons";
import type { RotuloDoEscopo } from "@/lib/vocabulary/knowledge-scope";

export interface EscopoParaEscolher {
  id: string;
  display_name: string;
}

interface Props {
  aberto: boolean;
  /** Só as operadoras ligadas: carregar material para uma desligada não responderia nada. */
  escopos: readonly EscopoParaEscolher[];
  /** Qual já vem escolhida — vem do link "Carregar material" da tela vizinha. */
  escopoInicial: string | null;
  rotulo: RotuloDoEscopo;
  enviando: boolean;
  aoFechar: () => void;
  aoEnviar: (dados: DadosDoNovoMaterial) => void;
}

const PAR_VAZIO: ParDePerguntaEResposta = { pergunta: "", resposta: "" };

export function NovoMaterialDialog({
  aberto,
  escopos,
  escopoInicial,
  rotulo,
  enviando,
  aoFechar,
  aoEnviar,
}: Props) {
  // Abrir é o momento de recomeçar: reaproveitar o que ficou da vez anterior faria o
  // corretor salvar sem querer o rascunho de outro material. Quem zera é a REMONTAGEM —
  // a tela dá um `key` novo a cada abertura (ver `_client.tsx`). Um `useEffect` que
  // chamasse `setState` faria a mesma coisa por um caminho que o React desaconselha e o
  // lint reprova, e ainda desenharia o formulário uma vez com o estado anterior.
  const [escopoId, setEscopoId] = useState(
    () => escopoInicial ?? (escopos.length === 1 ? (escopos[0]?.id ?? "") : ""),
  );
  const [nome, setNome] = useState("");
  const [pares, setPares] = useState<ParDePerguntaEResposta[]>([PAR_VAZIO]);
  const [validade, setValidade] = useState("");

  function mudarPar(indice: number, campo: keyof ParDePerguntaEResposta, valor: string) {
    setPares((atual) => atual.map((p, i) => (i === indice ? { ...p, [campo]: valor } : p)));
  }

  const temConteudo = pares.some((p) => p.pergunta.trim() !== "" || p.resposta.trim() !== "");
  const podeSalvar = escopoId !== "" && nome.trim() !== "" && temConteudo && !enviando;

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{NOVO_MATERIAL_TITULO}</DialogTitle>
          <DialogDescription>{NOVO_MATERIAL_DESCRICAO}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="material-escopo">{rotulo.singular}</Label>
            <Select value={escopoId} onValueChange={setEscopoId}>
              <SelectTrigger id="material-escopo" aria-label={rotulo.singular}>
                <SelectValue placeholder={`Escolha ${rotulo.singular.toLowerCase()}`} />
              </SelectTrigger>
              <SelectContent>
                {escopos.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="material-nome">Nome do material</Label>
            <Input
              id="material-nome"
              value={nome}
              placeholder="Ex.: boleto e pagamento"
              onChange={(e) => setNome(e.target.value)}
            />
          </div>

          <div className="space-y-3">
            {pares.map((par, i) => (
              <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`material-pergunta-${i}`}>{PERGUNTA_ROTULO}</Label>
                  {pares.length > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remover a pergunta ${i + 1}`}
                      onClick={() => setPares((atual) => atual.filter((_, j) => j !== i))}
                    >
                      <Trash size={14} aria-hidden />
                    </Button>
                  )}
                </div>
                <Input
                  id={`material-pergunta-${i}`}
                  value={par.pergunta}
                  placeholder={PERGUNTA_EXEMPLO}
                  onChange={(e) => mudarPar(i, "pergunta", e.target.value)}
                />
                <Label htmlFor={`material-resposta-${i}`}>{RESPOSTA_ROTULO}</Label>
                <Textarea
                  id={`material-resposta-${i}`}
                  rows={4}
                  value={par.resposta}
                  placeholder={RESPOSTA_EXEMPLO}
                  onChange={(e) => mudarPar(i, "resposta", e.target.value)}
                />
              </div>
            ))}

            {pares.length < LIMITE_DE_PERGUNTAS && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPares((atual) => [...atual, PAR_VAZIO])}
              >
                <Plus size={14} aria-hidden />
                {MAIS_UMA_PERGUNTA}
              </Button>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="material-validade">{VALIDADE_ROTULO}</Label>
            <Input
              id="material-validade"
              type="date"
              value={validade}
              className="max-w-[12rem]"
              onChange={(e) => setValidade(e.target.value)}
            />
            <p className="text-xs text-text-muted">{VALIDADE_AJUDA}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={aoFechar} disabled={enviando}>
            Cancelar
          </Button>
          <Button
            disabled={!podeSalvar}
            onClick={() => aoEnviar({ escopoId, nome, pares, validade })}
          >
            {enviando ? "Salvando…" : "Salvar material"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
