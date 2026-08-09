# SC-006 — escala com 20 operadoras (T071 + T124)

Medido em 2026-08-09, contra o Supabase local do `baseline.sql`, com
`scripts/medir-sc006-escala.ts`. Cinco execuções: as três primeiras com o desenho
sequencial (que foi descartado) e as demais com o pareado.

## O desenho que NÃO decidia nada

A primeira versão media 1 operadora, acrescentava 19 e media de novo. Três execuções
seguidas, **sem mudar uma linha do produto**:

| execução | crescimento do p95 | veredito que ela daria |
|---|---|---|
| 1 | −26,9% | PASSA |
| 2 | −6,1% | PASSA |
| 3 | **+70,1%** | **REPROVA** |

A consulta custa ~5 ms e a máquina é compartilhada: o p95 estava medindo o escalonador
do host, não o número de operadoras. Registrar a execução 1 como prova de SC-006 teria
sido o verde falso mais caro desta spec.

## O desenho pareado

Duas organizações existem **ao mesmo tempo** — A com 1 operadora, B com 20 — e o laço
alterna A, B, A, B…, invertendo a ordem a cada repetição. Ruído do host cai sobre as
duas na mesma proporção. 500 amostras por condição (20 perguntas × 25 repetições).

```
--- execução 1
amostras por condição: 500 (20 perguntas x 25 repetições, intercaladas)
p95 com  1 operadora (org A): 4.69 ms
p95 com 20 operadoras (org B): 5.05 ms
mediana  1 / 20: 2.39 ms / 2.38 ms
crescimento do p95: +7.7%  (teto de SC-006: +25%)
âncoras devolvidas com 1: 1 · com 20: 1
veredito: PASSA
--- execução 2
amostras por condição: 500 (20 perguntas x 25 repetições, intercaladas)
p95 com  1 operadora (org A): 6.22 ms
p95 com 20 operadoras (org B): 6.27 ms
mediana  1 / 20: 3.49 ms / 3.47 ms
crescimento do p95: +0.8%  (teto de SC-006: +25%)
âncoras devolvidas com 1: 1 · com 20: 1
veredito: PASSA
--- execução 3
amostras por condição: 500 (20 perguntas x 25 repetições, intercaladas)
p95 com  1 operadora (org A): 6.86 ms
p95 com 20 operadoras (org B): 6.48 ms
mediana  1 / 20: 3.44 ms / 3.40 ms
crescimento do p95: -5.6%  (teto de SC-006: +25%)
âncoras devolvidas com 1: 1 · com 20: 1
veredito: PASSA
```

## Conclusão

**SC-006 PASSA, com folga.** O crescimento do p95 fica dentro de poucos pontos percentuais
do teto de +25% — e o **sinal alterna entre execuções**, que é a assinatura de uma diferença
menor que o ruído. Vinte operadoras não movem o custo da busca: `fn_buscar_lastro` filtra
por escopo dentro do banco, então o número de vizinhas não entra no conjunto candidato.

O outro lado do critério — "100% das perguntas que eram respondidas com 1 operadora
continuam sendo respondidas" — está no contador de âncoras da saída, e é o que impede a
leitura ingênua de que ficar rápido é bom: uma versão que devolvesse **menos** âncoras
também ficaria mais rápida, e reprovaria aqui.

## O que esta medição NÃO cobre

O turno inteiro do agente (modelo, rede, WhatsApp). Esse tempo é dominado pelo provedor e
não varia com o número de operadoras — que é exatamente a variável que SC-006 isola.
