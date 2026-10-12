# Análise inicial — por que este projeto existe

> Origem: avaliação feita em `novas_ideias_mkt` em 12/10/2026 (área de viabilidade de
> agregadores). Este arquivo é o ponto de partida do agente que vai executar aqui.

## 1. O problema

George trabalha em várias frentes ao mesmo tempo (orchestrator, saas-hiperlocal-backend, lia,
kanban, backoffice-ad-management, secondbrain). Hoje faz isso pela extensão do DSH no VS Code, que
mostra vários projetos num painel só. Quer o mesmo ambiente, mas podendo usar **outros harness**
(começando pelo Claude Code), e com o **Paperclip** configurável na própria UI.

## 1.1 Requisitos registrados

- **REQ-01 — Vários harness na mesma janela do VS Code** (pedido do dono em 12/10/2026). Os harness
  registrados abrem juntos na mesma sessão do VS Code, sem trocar de janela.
- **REQ-02 — Workspace por harness** (mesmo pedido). Cada harness tem a própria lista de workspaces
  (projetos) e as próprias sessões, sem misturar com as dos outros.

Leitura confirmada pelo dono em 12/10/2026: cada harness é um painel/aba próprio no VS Code, ligado
ao seu processo; a lista de workspaces fica isolada por harness.

- **REQ-03 — Não quebrar o DSH em uso** (dono, 12/10/2026). Teste e execução do harness-deck não
  mexem em `~/.dsh`; tudo o que for do projeto fica em pasta exclusiva `~/.harnessdeck`.
- **REQ-04 — Plugins, automation tasks e settings isolados por harness** (dono, 12/10/2026). Cada
  harness tem suas particularidades (ex.: Claude Code tem "mods"; o DSH tem plugins `cordis` e
  jobs/agenda próprios) — não dá para tratar como um conceito único entre harness. **Não medido
  ainda:** o que cada harness chama de plugin/task/setting, onde cada um guarda isso (arquivo do
  projeto? pasta home? servidor remoto?), e o que dá para expor numa tela comum vs. o que precisa
  de tela própria por harness. Entra como item de medição antes do F3 (ver `plano.md`).

## 2. O que foi descartado e por quê

| Caminho | Por que não |
|---|---|
| Extensão oficial do Claude Code | Um projeto por janela; o seletor só mostra sessões da pasta atual; multi-root mal suportado. Pedidos abertos: [#34985](https://github.com/anthropics/claude-code/issues/34985), [#29825](https://github.com/anthropics/claude-code/issues/29825), [#58044](https://github.com/anthropics/claude-code/issues/58044), [#36949](https://github.com/anthropics/claude-code/issues/36949) |
| Extensões de terceiros ([vscode-claude-sessions](https://github.com/kevin-ghfr/vscode-claude-sessions), [Claude Code Sessions](https://open-vsx.org/extension/es6kr/claude-sessions)) | Só Claude Code, sessão em terminal ou só consulta; sem subagentes, jobs, Paperclip |
| Web UIs ([CloudCLI](https://github.com/siteboon/claudecodeui), [OpenCockpit](https://github.com/SilentBob347/claudecode-cockpit)) | O pedido é extensão no VS Code, não web UI à parte |
| Extensão nova do zero sobre o Claude Agent SDK | Estimativa (não medição): 6–8 semanas para chegar perto da extensão do DSH; a maior parte do custo é UI |

## 3. Abordagem escolhida: reaproveitar a UI do DSH

Verificado lendo o código instalado (DSH `0.2.0-rc.2`, `/usr/local/lib/node_modules/@deepseek-ai/dsh/`):

- **DSH é MIT** e todo montado em plugins (framework `cordis`).
- **~~A extensão do VS Code não precisa mudar.~~ Revisto em 12/10/2026 pelo REQ-01:** a extensão
  instalada (`vithrive.deepseek-harness-vscode` 1.0.0) tem **uma URL só** (`dshPanel.url`, padrão
  `http://127.0.0.1:3080`) e **um webview só** (`dsh.webview`). Não abre vários harness juntos.
  Precisa de extensão própria (ou fork, é MIT) com uma entrada por harness registrado. É a
  [Deepseek-Harness-for-VS-Code](https://github.com/Vithrive/Deepseek-Harness-for-VS-Code)
  (`vithrive.deepseek-harness-vscode`, MIT, terceiro): mostra a Web GUI do DSH na barra lateral e
  registra o DSH como modelo do chat do Copilot. O que aparece no DSH aparece nela.
- **O motor do agente é trocável.** `@deepseek-ai/dsh-agent` tem `AgentRegistry` com
  `setFactory(AgentFactory)`; a interface `AgentFactory` exige `createAgent(ownerCtx, options)` e
  `resume(ownerCtx, options)`. Hoje quem fornece é `@deepseek-ai/dsh-agent-loop`. O comentário no
  código diz que o registro existe justamente para consumidores não dependerem do loop concreto.
- **O provedor de modelo também é trocável:** `@deepseek-ai/dsh-llm` (interface neutra) com
  implementações como `dsh-llm-deepseek` e `dsh-llm-pi-ai`.
- **Já existe ponte parcial com o Claude Code:** `dsh-hooks-claude-code` roda `hooks.json` /
  `settings` de hooks do Claude Code dentro do DSH (só hooks, não o motor).
- **`dsh-acp`** é servidor ACP: expõe o DSH como agente para outro cliente. O caminho inverso (DSH
  como cliente de um agente ACP) **não existe**.

## 4. Opções de integração de harness

| Opção | O que é | Esforço (estimativa) |
|---|---|---|
| A. Modelo Claude no motor do DSH | Já funciona hoje (rota Anthropic-shaped). Mas o harness continua sendo o DSH | zero |
| **B. Plugin `AgentFactory` com Claude Agent SDK** | Plugin cria/retoma agente via [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview); traduz eventos do SDK para eventos de sessão do DSH e aprovação do SDK para aprovação do DSH | 1–2 semanas |
| C. Ponte ACP | Plugin que faz o DSH ser cliente de qualquer agente ACP: Claude Code via [claude-code-acp](https://github.com/zed-industries/claude-code-acp), Codex, Gemini | 2–3 semanas; vale para vários harness |

Caminho sugerido: **B primeiro** (resolve Claude Code rápido), **C depois** (abre para outros
harness sem um plugin por harness).

## 5. Paperclip

- [Paperclip](https://github.com/paperclipai/paperclip) é control plane (heartbeat, tarefas,
  orçamento, organograma); aciona agentes por adaptador.
- Já tem adaptador para Claude Code:
  [claude_local](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/claude-local.md).
- Projeto irmão: `~/project/paperclip-adapter-dsh` (adaptador do Paperclip para o DSH via
  `dsh headless`). Com a opção B, ele cobre os dois harness: Paperclip → `dsh headless` → perfil com
  motor Claude Code.
- Configuração na UI: plugin com tela própria em Configurações → Plugins (o DSH já tem a área,
  `dsh-client-ui-settings-plugins`). Campos: URL, chave (do ambiente, nunca em arquivo), empresa,
  vínculo agente do Paperclip ↔ projeto. Painel: tarefas, heartbeat, orçamento.

## 6. Riscos e pontos não verificados

- **Motor por processo, não por sessão (verificado em 12/10/2026, lendo o código):**
  `AgentRegistry.setFactory` lança `an agent factory is already registered` se já houver um
  (`dsh-agent/lib/types/index.js:141-151`). O `dsh-agent-loop` se registra no próprio construtor
  (`dsh-agent-loop/lib/index.js:1563`) e entra pela linha `id: agent-loop` do
  `dsh-base/cordis.patch.yml:511`. Cada perfil sobe um processo próprio, então dá para ter um
  perfil `claude` com `- id: agent-loop / disabled: true` e o plugin no lugar.
  **Testado em 12/10/2026:** perfil `hd-probe` (cópia do template `web`) com o overlay
  [probes/no-agent-loop.yml](../probes/no-agent-loop.yml) **sobe sem erro** na porta 3190, sem o
  loop. `DSH_HOME=~/.harnessdeck` isola o perfil do `~/.dsh` (variável lida em
  `dsh-home-paths/lib/index.js:15`). **Não testado:** criar sessão e conversar nesse perfil (sem
  factory, deve falhar até o plugin existir); se título de sessão, subagente, goal e compactação
  funcionam com outro motor.
- **Cuidado ao testar:** `dsh <perfil> --help` **regrava** `profiles/<perfil>/cordis.yml`. Rodar
  `dsh` deste projeto sempre com `DSH_HOME=~/.harnessdeck`.
- **Dois perfis = dois processos e duas URLs.** Com o REQ-01 e o REQ-02 isso deixa de ser problema
  e vira o desenho: um perfil (processo) por harness, cada um com seus workspaces, e a extensão
  própria mostrando um painel por URL. O factory "despachante" (dois motores no mesmo processo) sai
  do caminho. **Não verificado:** se o DSH isola workspaces por perfil ou se eles são globais em
  `~/.dsh` (se forem globais, o REQ-02 pede `DSH_HOME` separado por harness).
- **Painéis do DSH:** subagentes, jobs, goal e agenda são ferramentas do motor do DSH. Com o motor
  do Claude Code eles só se preenchem se o plugin traduzir os eventos equivalentes.
- **Sessão em dois lugares:** o Claude Code grava em `~/.claude/projects`; o DSH exige o log dele.
  O plugin precisa espelhar.
- **API interna instável:** DSH pré-lançamento; pode mudar a cada versão.
- **Rota Anthropic no Agent SDK:** falta testar o SDK com `ANTHROPIC_BASE_URL` apontando para um
  endpoint Anthropic-shaped e `ANTHROPIC_API_KEY` vindo do ambiente.
- **Termos da Anthropic:** app de terceiro com o Agent SDK usa chave de API, não login de assinatura
  Pro/Max (leitura dos termos, não conferido o texto em 12/10/2026).
- **Paperclip:** não verificado se o `claude_local` repassa `ANTHROPIC_BASE_URL`; bug aberto de
  chave perdida no heartbeat ([#856](https://github.com/paperclipai/paperclip/issues/856)).
- **Nome — decidido pelo dono em 12/10/2026:** mantém `harness-deck`. "Harness" também é marca de
  uma empresa de CI/CD (harness.io); o risco de confusão foi aceito. Repositório já criado em
  [github.com/georgesq/harness-deck](https://github.com/georgesq/harness-deck), público.

## 7. Custo

- Desenvolvimento: tokens do agente que codifica. **Valor em dinheiro: não localizado** — medir
  com `novas_ideias_mkt/custo-tokens.py` após uma semana piloto.
- Uso: a UI não cobra; custo é só o do modelo, igual ao de hoje.

## 8. Primeiros passos para quem executa (prova de conceito, 2–3 dias)

1. Confirmar se dá para escolher o `AgentFactory` por perfil do DSH.
2. Plugin mínimo da opção B: uma sessão do Claude Code aparecendo no chat do DSH, com streaming e
   aprovação de ferramenta.
3. Testar o Agent SDK com uma rota Anthropic-shaped.
4. Se os três passarem, planejar a opção B completa e depois a C e o plugin do Paperclip.
