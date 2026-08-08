/**
 * Por que uma busca de conhecimento não ancorou nada — spec 002 (FR-029), migration 0126.
 *
 * ═══ POR QUE ISTO MORA SOZINHO, E NÃO NO PAINEL ═══
 *
 * Quem EMITE o motivo é o agent-engine (`search-knowledge.ts`); quem o LÊ é o painel de
 * evolução e a tela do curador. Deixá-lo na casa de um dos leitores faria o motor da busca
 * importar de um relatório — dependência ao contrário, que sobrevive até alguém reescrever
 * o painel e descobrir que levou a busca junto.
 *
 * A coluna é de vocabulário ABERTO — sem CHECK, pela exceção deliberada do CLAUDE.md: a
 * constraint quebraria a re-aplicação do `baseline.sql` em modo update no dia em que uma
 * razão nova aparecesse numa linha já gravada, que é justamente o que o job `invariants`
 * roda. O preço dessa liberdade é que o vocabulário só existe no TypeScript, e que emissor
 * e leitor TÊM de compartilhar esta constante: string literal dos dois lados é como as duas
 * pontas passam a discordar sem nada ficar vermelho.
 *
 * São três porque os CONSERTOS são três, não porque "não respondeu" tem três sinônimos:
 * escrever material que não existe, reescrever o material que existe com as palavras que o
 * cliente usa, e olhar a infraestrutura — que não é trabalho do corretor e não deve
 * aparecer para ele como se fosse.
 */
export const MOTIVO_DE_RECUSA = {
  /** A base não tem o assunto. Conserto: escrever material novo. */
  SEM_MATERIAL: 'sem_material',
  /** A base tem algo perto, insuficiente para ancorar. Conserto: reescrever o que existe. */
  QUASE_NO_LIMIAR: 'quase_no_limiar',
  /** A busca nem aconteceu (embed/banco fora do ar). Ninguém escreve nada. */
  BUSCA_INDISPONIVEL: 'busca_indisponivel',
} as const;

export type MotivoDeRecusa = (typeof MOTIVO_DE_RECUSA)[keyof typeof MOTIVO_DE_RECUSA];
