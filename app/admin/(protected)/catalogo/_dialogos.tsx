"use client";
/**
 * Os diálogos que escrevem no catálogo: criar material, publicar versão nova, aceitar a
 * versão que veio na atualização, e ler o texto de uma versão.
 *
 * Spec 002 (RAG por operadora), T066.
 *
 * ═══ A COISA MAIS IMPORTANTE DESTE ARQUIVO ═══
 *
 * Aqui NÃO existe botão "Salvar". Corrigir um material do catálogo não reescreve o
 * material: cria uma versão nova, e a anterior continua guardada. Uma tela com "Salvar" e
 * um campo preenchido diria ao curador que ele está editando o que já existe — e ele
 * tomaria decisões erradas sobre isso, como apagar um trecho "porque dá para voltar" ou
 * hesitar em corrigir "porque perde o original". Os dois medos são infundados, e os dois
 * vêm do rótulo do botão.
 *
 * Por isso o botão diz o número da versão que vai nascer, o cabeçalho diz de qual versão a
 * correção parte, e o rodapé diz o que acontece com a anterior. Nenhuma dessas três frases
 * é enfeite: são a diferença entre a tela descrever a gravação ou mentir sobre ela.
 *
 * ═══ E A VERSÃO QUE ESTÁ ESPERANDO ═══
 *
 * Quando a atualização do produto traz uma versão de um material que esta instalação já
 * corrigiu, ela chega SEM VALER — para não apagar a correção local. Ela fica esperando
 * decisão, e esta tela é o único lugar do sistema onde essa decisão pode ser tomada. Se o
 * diálogo de aceitar não existisse, "chegar sem valer" seria só um jeito educado de perder
 * a atualização para sempre.
 *
 * Aceitar não é um botão mágico: ele publica o texto que veio como a versão nova (e, como
 * toda publicação daqui, preserva as anteriores). É por isso que a comparação lado a lado
 * vem junto — a decisão é de conteúdo, e não dá para tomá-la sem ler os dois.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle, CircleNotch, Info, Warning } from "@/lib/ui/icons";

import {
  formatarInstante,
  formatarTamanho,
  origemLegivel,
  rotuloDeValidade,
  type PapelDaVersao,
} from "./_derivacao";
import { mensagemDoErro, useMaterial, usePublicarVersao, type NovoMaterial } from "./_dados";
import type { MaterialCompleto, MaterialResumido } from "./_tipos";

// ---------------------------------------------------------------------------
// Peças pequenas
// ---------------------------------------------------------------------------

/** Bloco de aviso. `tom` decide a cor; o texto é sempre o mesmo tipo de conteúdo: consequência. */
function Aviso({
  tom = "info",
  titulo,
  children,
}: {
  tom?: "info" | "atencao" | "ok";
  titulo: string;
  children?: React.ReactNode;
}) {
  const cores = {
    info: "border-info-fg/25 bg-info-bg text-info-fg",
    atencao: "border-warning-fg/25 bg-warning-bg text-warning-fg",
    ok: "border-success-fg/25 bg-success-bg text-success-fg",
  }[tom];
  const Icone = tom === "atencao" ? Warning : tom === "ok" ? CheckCircle : Info;

  return (
    <div className={`flex gap-3 rounded-lg border p-3 text-sm ${cores}`}>
      <Icone size={18} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">{titulo}</p>
        {children ? <div className="text-sm opacity-90">{children}</div> : null}
      </div>
    </div>
  );
}

function Carregando({ texto }: { texto: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <CircleNotch size={16} className="animate-spin" aria-hidden />
      {texto}
    </div>
  );
}

/**
 * Diz se aquela versão está de fato respondendo — e o papel dela é metade da resposta.
 *
 * Duas coisas precisam ser verdade ao mesmo tempo para um texto responder: a versão tem de
 * ser a que vale hoje E ter passado pela indexação do catálogo. Publicar não coloca o
 * texto no ar na hora; até a indexação passar, quem perguntar sobre o assunto é
 * encaminhado a um humano. É desconfortável de mostrar e pior de esconder — sem isso o
 * curador conclui que a correção não funcionou.
 *
 * A versão histórica é o caso que obriga o `papel` a estar aqui: ela CONTINUA com os
 * trechos dela no banco, então uma etiqueta baseada só na contagem diria "respondendo"
 * sobre um texto que a busca não olha mais. Seria a tela afirmando o contrário do que o
 * banco faz, com um número verdadeiro do lado para dar credibilidade.
 */
function EstadoDeIndexacao({ trechos, papel }: { trechos: number; papel: PapelDaVersao }) {
  if (papel !== "vigente") {
    return (
      <Badge variant="neutral">
        {trechos > 0 ? `${trechos} trecho${trechos === 1 ? "" : "s"} indexados` : "Sem trechos"} · não
        entra nas respostas
      </Badge>
    );
  }
  if (trechos > 0) {
    return (
      <Badge variant="success">
        Respondendo ({trechos} trecho{trechos === 1 ? "" : "s"})
      </Badge>
    );
  }
  return <Badge variant="warning">Ainda não entrou no ar</Badge>;
}

// ---------------------------------------------------------------------------
// Formulário compartilhado
// ---------------------------------------------------------------------------

interface CamposDoMaterial {
  slug: string;
  title: string;
  body: string;
  valid_until: string;
}

function CamposEditaveis({
  valores,
  aoMudar,
  slugTravado,
  desabilitado,
}: {
  valores: CamposDoMaterial;
  aoMudar: (v: CamposDoMaterial) => void;
  /** Na correção o assunto não muda: trocar o slug não renomeia, cria um material solto. */
  slugTravado: boolean;
  desabilitado: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="material-slug">Identificador do assunto</Label>
        <Input
          id="material-slug"
          value={valores.slug}
          disabled={slugTravado || desabilitado}
          onChange={(e) => aoMudar({ ...valores, slug: e.target.value })}
          placeholder="carencia-consulta-eletiva"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {slugTravado
            ? "O identificador acompanha o assunto e não muda numa correção — é por ele que as atualizações do produto reconhecem este material."
            : "Minúsculas, números e hífen. É por ele que as atualizações do produto reconhecem o material, então escolha pensando no assunto, não no texto."}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="material-titulo">Título</Label>
        <Input
          id="material-titulo"
          value={valores.title}
          disabled={desabilitado}
          onChange={(e) => aoMudar({ ...valores, title: e.target.value })}
          placeholder="Carência para consulta eletiva"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="material-texto">Texto</Label>
        <Textarea
          id="material-texto"
          value={valores.body}
          disabled={desabilitado}
          onChange={(e) => aoMudar({ ...valores, body: e.target.value })}
          rows={14}
          placeholder="Escreva a orientação como você a daria ao cliente, em frases curtas."
          className="font-normal"
        />
        <p className="text-xs text-muted-foreground">
          {formatarTamanho(valores.body.length)}. Escreva só procedimento de operadora — nome,
          telefone ou dado de cliente não entram no catálogo.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="material-validade">Válido até (opcional)</Label>
        <Input
          id="material-validade"
          type="date"
          value={valores.valid_until}
          disabled={desabilitado}
          onChange={(e) => aoMudar({ ...valores, valid_until: e.target.value })}
          className="w-48"
        />
        <p className="text-xs text-muted-foreground">
          Depois desta data o material deixa de ser usado nas respostas. Em branco, não vence.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criar material
// ---------------------------------------------------------------------------

export function DialogNovoMaterial({
  aberto,
  aoFechar,
  onde,
  criar,
  pendente,
}: {
  aberto: boolean;
  aoFechar: () => void;
  /** Onde o material vai nascer, em texto — aparece no cabeçalho. */
  onde: string;
  criar: (m: NovoMaterial) => Promise<unknown>;
  pendente: boolean;
}) {
  const [valores, setValores] = useState<CamposDoMaterial>({
    slug: "",
    title: "",
    body: "",
    valid_until: "",
  });
  const [erro, setErro] = useState<string | null>(null);

  const completo = valores.slug.trim() && valores.title.trim() && valores.body.trim();

  async function enviar() {
    setErro(null);
    try {
      await criar({
        slug: valores.slug.trim(),
        title: valores.title.trim(),
        body: valores.body,
        valid_until: valores.valid_until || null,
      });
      toast.success(`Material "${valores.title.trim()}" criado como versão 1.`);
      setValores({ slug: "", title: "", body: "", valid_until: "" });
      aoFechar();
    } catch (e) {
      setErro(mensagemDoErro(e));
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Novo material</DialogTitle>
          <DialogDescription>{onde}</DialogDescription>
        </DialogHeader>

        <CamposEditaveis
          valores={valores}
          aoMudar={setValores}
          slugTravado={false}
          desabilitado={pendente}
        />

        {erro ? <Aviso tom="atencao" titulo="Não deu para criar">{erro}</Aviso> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={aoFechar} disabled={pendente}>
            Cancelar
          </Button>
          <Button onClick={() => void enviar()} disabled={!completo || pendente}>
            {pendente ? "Criando…" : "Criar versão 1"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Publicar versão nova
// ---------------------------------------------------------------------------

function FormularioDeCorrecao({
  base,
  proxima,
  aoFechar,
}: {
  base: MaterialCompleto;
  proxima: number;
  aoFechar: () => void;
}) {
  const [valores, setValores] = useState<CamposDoMaterial>({
    slug: base.slug,
    title: base.title,
    body: base.body,
    valid_until: base.valid_until ?? "",
  });
  const [erro, setErro] = useState<string | null>(null);
  const publicar = usePublicarVersao();

  const mudou =
    valores.title !== base.title ||
    valores.body !== base.body ||
    (valores.valid_until || null) !== base.valid_until;

  async function enviar() {
    setErro(null);
    try {
      const nova = await publicar.mutateAsync({
        baseId: base.id,
        title: valores.title.trim(),
        body: valores.body,
        valid_until: valores.valid_until || null,
      });
      toast.success(
        `Versão ${nova.version} publicada. A versão ${base.version} continua guardada no histórico.`,
      );
      aoFechar();
    } catch (e) {
      setErro(mensagemDoErro(e));
    }
  }

  return (
    <>
      <Aviso tom="info" titulo={`Isto publica a versão ${proxima}, não altera a versão ${base.version}`}>
        <p>
          Material do catálogo nunca é reescrito. A versão {base.version} continua guardada e
          consultável depois que você publicar — e é assim que a próxima atualização do produto
          consegue chegar sem apagar o que você corrigiu.
        </p>
      </Aviso>

      <CamposEditaveis
        valores={valores}
        aoMudar={setValores}
        slugTravado
        desabilitado={publicar.isPending}
      />

      <Aviso tom="atencao" titulo="Há um intervalo até a correção entrar no ar">
        <p>
          A versão nova só passa a ser usada nas respostas depois que a indexação do catálogo
          passar por ela. Nesse intervalo, quem perguntar sobre este assunto é encaminhado a um
          humano em vez de receber a versão antiga.
        </p>
      </Aviso>

      {erro ? <Aviso tom="atencao" titulo="Não deu para publicar">{erro}</Aviso> : null}

      <DialogFooter>
        <Button variant="ghost" onClick={aoFechar} disabled={publicar.isPending}>
          Cancelar
        </Button>
        <Button onClick={() => void enviar()} disabled={!mudou || publicar.isPending}>
          {publicar.isPending ? "Publicando…" : `Publicar versão ${proxima}`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function DialogPublicarVersao({
  base,
  proxima,
  aoFechar,
}: {
  /** A versão de onde a correção parte — normalmente a vigente. `null` mantém o diálogo fechado. */
  base: MaterialResumido | null;
  proxima: number;
  aoFechar: () => void;
}) {
  const { data, isLoading, isError, error } = useMaterial(base?.id ?? null);

  return (
    <Dialog open={base !== null} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[90vh] max-w-2xl space-y-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Corrigir “{base?.title ?? ""}”</DialogTitle>
          <DialogDescription>
            Partindo da versão {base?.version ?? "—"} · assunto <code>{base?.slug ?? ""}</code>
          </DialogDescription>
        </DialogHeader>

        {isLoading ? <Carregando texto="Abrindo o texto da versão…" /> : null}
        {isError ? (
          <Aviso tom="atencao" titulo="Não consegui abrir o material">
            {mensagemDoErro(error)}
          </Aviso>
        ) : null}
        {data ? (
          // `key` remonta o formulário quando o material muda — é o que faz os campos
          // nascerem com o texto certo sem um efeito copiando prop para estado.
          <FormularioDeCorrecao key={data.id} base={data} proxima={proxima} aoFechar={aoFechar} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Aceitar a versão que veio na atualização
// ---------------------------------------------------------------------------

function TextoLadoALado({ rotulo, material }: { rotulo: string; material: MaterialCompleto }) {
  const validade = rotuloDeValidade(material.valid_until);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{rotulo}</p>
        <p className="text-sm font-medium">{material.title}</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="neutral">Versão {material.version}</Badge>
          <Badge variant="neutral">{origemLegivel(material.origin)}</Badge>
          <Badge variant={validade.estado === "vencido" ? "error" : "neutral"}>{validade.texto}</Badge>
        </div>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-sans text-sm leading-relaxed">
        {material.body}
      </pre>
    </div>
  );
}

function ComparacaoEDecisao({
  vigente,
  esperando,
  proxima,
  aoFechar,
}: {
  vigente: MaterialCompleto | null;
  esperando: MaterialCompleto;
  proxima: number;
  aoFechar: () => void;
}) {
  const [erro, setErro] = useState<string | null>(null);
  const publicar = usePublicarVersao();

  async function aceitar() {
    setErro(null);
    try {
      // Aceitar é publicar o texto que veio como a versão nova. Não existe "ligar a versão
      // que chegou": ligá-la no lugar apagaria a correção local do topo da pilha, que é
      // exatamente o que a inércia foi criada para impedir.
      const nova = await publicar.mutateAsync({
        baseId: esperando.id,
        title: esperando.title,
        body: esperando.body,
        valid_until: esperando.valid_until,
      });
      toast.success(
        `Versão ${nova.version} publicada com o texto que veio na atualização. ` +
          `As versões anteriores continuam guardadas.`,
      );
      aoFechar();
    } catch (e) {
      setErro(mensagemDoErro(e));
    }
  }

  return (
    <>
      <Aviso tom="atencao" titulo="Esta versão chegou na atualização e está esperando você">
        <p>
          Ela veio com o produto DEPOIS de esta instalação já ter corrigido este material. Para não
          apagar a sua correção, ela chegou sem valer — hoje quem responde é a versão{" "}
          {vigente?.version ?? "—"}. Nada acontece com ela até você decidir aqui.
        </p>
      </Aviso>

      <div className="flex flex-col gap-4 md:flex-row">
        {vigente ? <TextoLadoALado rotulo="O que responde hoje" material={vigente} /> : null}
        <TextoLadoALado rotulo="O que veio na atualização" material={esperando} />
      </div>

      <Aviso tom="info" titulo={`Aceitar publica este texto como a versão ${proxima}`}>
        <p>
          Nada é sobrescrito: a versão {vigente?.version ?? "—"} e a versão {esperando.version}{" "}
          continuam guardadas. Se preferir aproveitar só um pedaço, feche isto e use “Corrigir” —
          lá você escreve o texto final você mesmo.
        </p>
      </Aviso>

      {erro ? <Aviso tom="atencao" titulo="Não deu para publicar">{erro}</Aviso> : null}

      <DialogFooter>
        <Button variant="ghost" onClick={aoFechar} disabled={publicar.isPending}>
          Decidir depois
        </Button>
        <Button onClick={() => void aceitar()} disabled={publicar.isPending}>
          {publicar.isPending ? "Publicando…" : `Aceitar e publicar como versão ${proxima}`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function DialogAceitarVersao({
  esperando,
  vigente,
  proxima,
  aoFechar,
}: {
  /** A versão inerte a decidir. `null` mantém o diálogo fechado. */
  esperando: MaterialResumido | null;
  vigente: MaterialResumido | null;
  proxima: number;
  aoFechar: () => void;
}) {
  const nova = useMaterial(esperando?.id ?? null);
  const atual = useMaterial(esperando ? (vigente?.id ?? null) : null);

  return (
    <Dialog open={esperando !== null} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[90vh] max-w-4xl space-y-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Versão esperando decisão</DialogTitle>
          <DialogDescription>
            Assunto <code>{esperando?.slug ?? ""}</code> · versão {esperando?.version ?? "—"} chegou
            na atualização do produto
          </DialogDescription>
        </DialogHeader>

        {nova.isLoading || atual.isLoading ? <Carregando texto="Abrindo os dois textos…" /> : null}
        {nova.isError ? (
          <Aviso tom="atencao" titulo="Não consegui abrir a versão que chegou">
            {mensagemDoErro(nova.error)}
          </Aviso>
        ) : null}
        {nova.data ? (
          <ComparacaoEDecisao
            key={nova.data.id}
            vigente={atual.data ?? null}
            esperando={nova.data}
            proxima={proxima}
            aoFechar={aoFechar}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Ler uma versão
// ---------------------------------------------------------------------------

export function DialogVerVersao({
  versao,
  papel,
  aoFechar,
}: {
  versao: MaterialResumido | null;
  /** O papel desta versão dentro do assunto — decide o que a etiqueta pode afirmar. */
  papel: PapelDaVersao;
  aoFechar: () => void;
}) {
  const { data, isLoading, isError, error } = useMaterial(versao?.id ?? null);
  const validade = rotuloDeValidade(versao?.valid_until ?? null);

  return (
    <Dialog open={versao !== null} onOpenChange={(v) => !v && aoFechar()}>
      <DialogContent className="max-h-[90vh] max-w-2xl space-y-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{versao?.title ?? ""}</DialogTitle>
          <DialogDescription>
            Assunto <code>{versao?.slug ?? ""}</code> · versão {versao?.version ?? "—"} · publicada
            em {formatarInstante(versao?.published_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5">
          {versao ? <Badge variant="neutral">{origemLegivel(versao.origin)}</Badge> : null}
          <Badge variant={validade.estado === "vencido" ? "error" : "neutral"}>{validade.texto}</Badge>
          {papel === "aguardando" ? (
            <Badge variant="warning">Esperando decisão — chegou na atualização</Badge>
          ) : null}
          {data ? <EstadoDeIndexacao trechos={data.chunks_count} papel={papel} /> : null}
        </div>

        {versao?.adopted_at ? (
          <p className="text-xs text-muted-foreground">
            Escrita nesta instalação em {formatarInstante(versao.adopted_at)}.
          </p>
        ) : null}

        {isLoading ? <Carregando texto="Abrindo o texto…" /> : null}
        {isError ? (
          <Aviso tom="atencao" titulo="Não consegui abrir o material">
            {mensagemDoErro(error)}
          </Aviso>
        ) : null}
        {data ? (
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-4 font-sans text-sm leading-relaxed">
            {data.body}
          </pre>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={aoFechar}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
