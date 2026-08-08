# 🧭 Visão — DeskcommCRM

> **O sistema operacional de vendas com agentes de IA, nativo no WhatsApp.**
> Este documento é a fonte da verdade do posicionamento do projeto. Tudo que for público (README, site, docs, descrições) deriva daqui.
>
> **Alinhado à constituição v2.0.0 (2026-08-08).** O produto deixou de ser distribuído para instalação em máquina de terceiro e passou a ser **SaaS de instância única**. Em caso de conflito, `.specify/memory/constitution.md` manda.

---

## O nome

**Deskcomm** vem de **Desk** (mesa) + **comm** (comércio): **o comercial de mesa**.
A ideia que o nome carrega: toda a operação comercial de um negócio — atendimento, qualificação, funil, pós-venda — operada a partir de uma única mesa, por pessoas e por agentes de IA trabalhando juntos.

O "CRM" no nome é a categoria de entrada, não o teto. O DeskcommCRM é **mais que um CRM**: é o sistema onde a venda acontece.

## De onde viemos, pra onde vamos

O projeto nasceu em 2026 como um CRM operacional para **e-commerce brasileiro** — WhatsApp via WAHA, integração Nuvemshop, LGPD nativa —, desenhado para ser instalado por quem quisesse, na VPS que quisesse.

Duas coisas mudaram o rumo. A primeira: o que nos define não é o vertical, é o **agente de IA que opera o CRM de verdade**, integrado via MCP. E-commerce virou **um** caso de uso, não **o** produto. A segunda, decidida em **2026-08-08**: **paramos de distribuir instalação**. O Deskcomm passa a rodar como **SaaS de instância única, operada por nós** — o usuário se cadastra, usa, testa, e só depois assina. Ninguém instala nada.

**O nicho de validação é o corretor de plano de saúde.** Ele não é desenvolvedor, não é administrador de TI e não vai ler documentação — se ele opera sozinho, o produto está pronto. Multi-nicho continua sendo **capacidade arquitetural** (`vocabulary` por pipeline), não prioridade de validação.

**A transição, em uma frase:** de "CRM de e-commerce self-hosted" para **"SaaS de vendas com agentes de IA, onde o WhatsApp e o CRM se integram de forma inteligente e autônoma"**.

## O que acreditamos sobre agentes de IA

1. **Agente que opera, não chatbot que enfeita.** Nosso agente lê contexto real (histórico, perfil, pedido), consulta a base de conhecimento do tenant (RAG por organização), responde, qualifica, move o lead no funil — e é **assignee de primeira classe** no sistema, com as mesmas regras de governança de um atendente humano.

2. **Agentes que se auto-aprimoram.** O sistema é desenhado como um flywheel: conversas resolvidas viram conhecimento novo na base RAG; handoffs pro humano marcam onde o agente ainda não alcança; métricas e budget por tenant fecham o loop. Cada dia de operação torna o agente melhor — com **gate humano** nas decisões que importam. Essa é a aposta central do roadmap.

3. **MCP como sistema nervoso.** O CRM inteiro é exposto como tools MCP — primeiro para os agentes internos, depois como contrato público. Um negócio deve poder plugar o agente que quiser (Claude, o que vier) e ele **opera** o Deskcomm: cria lead, responde cliente, agenda, consulta pedido. O CRM vira infraestrutura para agentes.

4. **Humano no comando.** Handoff auditado, escopo por papel (RBAC), fila com posição, budget de IA por organização. Autonomia do agente cresce na medida em que a governança prova que ele acerta.

## Os pilares do produto

| Pilar | O que significa na prática |
|---|---|
| **Agentes de IA nativos** | RAG por tenant, análise de sentimento, handoff IA→humano auditado, IA como assignee, budget por org |
| **CRM automatizado pela IA** | O agente move leads, aplica tags, dispara automações QUANDO/SE/ENTÃO — o funil anda sozinho |
| **Ferramentas de apoio ao comercial** | Inbox em tempo real, kanban com fractional indexing, customer 360, métricas por atendente, roteamento automático |
| **WhatsApp-native** | Multi-número, anti-banimento, mídia, STOP detection — o canal onde o Brasil vende |
| **Entrada unificada** | Todo tráfego chega pelo `gateway_go` — WhatsApp oficial e não-oficial, Instagram Direct, webhooks — normalizado num envelope único. Canal novo não vira código novo de ingestão |
| **Multi-nicho por design** | `vocabulary` configurável por pipeline (lead = Cliente/Paciente/Comprador; won = Pago/Agendado/Fechado) — o mesmo core serve corretor, clínica, e-commerce, imobiliária, infoproduto |
| **Pronto em minutos, não em deploy** | Cadastrou, está usando: estrutura pré-pronta, sem instalar, sem configurar arquivo, sem VPS. Teto declarado: **10 minutos** do cadastro ao primeiro atendimento |
| **Compliance nativo** | Multi-tenant com RLS testada em CI, LGPD by-design (redact, data_request, anonimização), audit append-only |

## Posicionamento

**Categoria de entrada (âncora):** a alternativa às plataformas fechadas de atendimento e vendas por WhatsApp (Kommo, Octadesk, Intercom, Zendesk) — com o agente de IA operando o CRM, não um bot pendurado no chat.

**Categoria própria (bandeira):** **sistema operacional de vendas com agentes de IA** — *AI Sales OS*. Os incumbentes vendem assinatura de chat com bot acoplado; nós entregamos um sistema onde o agente de IA é **operador nativo**: atende, qualifica e move o funil junto com o humano.

**Uma frase (pt-br):**
> DeskcommCRM é o sistema operacional de vendas com agentes de IA nativos e WhatsApp — automação e integração inteligente e autônoma entre a conversa e o funil, para quem vende conversando.

**One-liner (en):**
> AI sales OS: a CRM where AI agents natively operate sales and support over WhatsApp — an alternative to Kommo, Octadesk and Intercom.

**Público:** negócios brasileiros que vendem pelo WhatsApp. **Ponta de lança: corretor de plano de saúde.** Depois — clínicas, imobiliárias, infoprodutores, agências, e-commerce, serviços.

## Modelo do projeto (sem letra miúda)

- **Entrega: SaaS de instância única.** Uma instalação, operada por nós, compartilhada por todos os tenants. O usuário **se cadastra, usa e testa**; a assinatura vem depois. Não há VPS do cliente, não há kit de instalação, não há clone com banco próprio.
- **A cobrança é gerenciada no Cotador Simplificado, não aqui.** Este repositório não implementa assinatura, plano, preço, checkout, pagamento ou dado de cartão — e nem armazena. A ponte com o Cotador é contrato HTTP explícito. Corte de acesso é decisão de lá, comunicada, nunca inferida aqui.
- **Consequência que assumimos por escrito:** com uma instância só, bug em produção é bug de todo mundo ao mesmo tempo — e o conserto também. Em troca, **não existe versão de escape**: mudança de schema roda no único banco que existe, e por isso exige caminho de volta pensado antes.
- **Multi-tenant não é detalhe, é a fronteira.** Todas as organizações dividem o mesmo banco. Isolamento por RLS, testado em CI a cada merge.
- **O código segue aberto** (MIT) — como transparência e como convite a contribuição, não como forma de distribuição. Ninguém precisa instalar para usar.

## O que fica de fora, e não é "por enquanto"

- **Cobrança** — mora no Cotador Simplificado.
- **Acoplamento ao Cotador em nível de banco** — sem schema compartilhado, sem FK cruzando fronteira de produto. Só contrato HTTP.
- **Distribuição para instalação alheia** — kit de self-host, `install.sh` de usuário e documentação de VPS deixam de ser produto.

## Princípios de comunicação

1. **Keyword primeiro, jargão depois.** Em todo título público: "agentes de IA", "WhatsApp", "CRM", "automação" antes de qualquer nome interno de subsistema.
2. **Mostrar, não descrever.** Screenshot/GIF do produto no primeiro scroll de qualquer página.
3. **Âncora explícita.** "Alternativa a X" aparece no About do GitHub, no README e no site — é assim que a demanda dos incumbentes nos encontra (busca e LLMs).
4. **Corretor é a ponta, não o teto.** Ao citar casos de uso, comece pelo nicho de validação e mostre a lista multi-nicho em seguida.
5. **Transparência de modelo.** Que a assinatura é gerenciada no Cotador, e que telemetria existe, declarados em linguagem humana — nunca escondidos.
6. **Não prometer instalação.** Nada de "self-hosted", "sua VPS" ou "1 comando" em material público: não é mais verdade, e promessa que não se cumpre custa mais que o clique que ganha.

## Norte de 3 anos

Ser a resposta padrão — do Google, do ChatGPT, do Reddit e do vendedor brasileiro — para **"qual o melhor CRM com agente de IA no WhatsApp?"**; com o Cotador Simplificado migrado para cá e o CRM interno dele aposentado, um ecossistema de agentes plugados via MCP público, e um flywheel de auto-aprimoramento que faça cada tenant vender melhor a cada mês de operação.

---

*Última revisão: 2026-08-08 — alinhamento à constituição v2.0.0: self-host → SaaS de instância única; cobrança no Cotador; nicho de validação = corretor de plano de saúde.*
*Revisão anterior: 2026-07-19 — reposicionamento e-commerce → multi-nicho / AI Sales OS.*
