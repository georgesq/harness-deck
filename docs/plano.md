# Plano — harness-deck

Acompanhamento do andamento. Status: ✅ feito · 🔄 em andamento · ⏳ a fazer · ⛔ bloqueado.
Prazo: **não localizado** (nada medido ainda; medir com o custo real de tokens e tempo da F1). Cada fase só começa quando o **portão** da anterior passa.

Requisitos (detalhe em [analise-inicial.md](analise-inicial.md)):
- **REQ-01:** os harness registrados abrem juntos na mesma janela do VS Code.
- **REQ-02:** cada harness tem os próprios workspaces e sessões.
- **REQ-03:** nada mexe em `~/.dsh`; o projeto vive em `~/.harnessdeck`.

## F0 — Base e viabilidade ✅

| # | Item | Status |
|---|---|---|
| 0.1 | Repositório, README, AGENTS.md, análise inicial | ✅ |
| 0.2 | Confirmar se o motor do agente é trocável por perfil (é por processo) | ✅ |
| 0.3 | Perfil isolado em `~/.harnessdeck` sobe sem o motor padrão | ✅ |

## F1 — Prova de conceito: Claude Code dentro da UI

| # | Item | Status |
|---|---|---|
| 1.1 | Agent SDK falando com a Avello (`ANTHROPIC_BASE_URL` + chave do ambiente) | ✅ |
| 1.2 | Esqueleto do plugin `harness-deck-claude-code` (registra o `AgentFactory`, o criador de agente do DSH) | ✅ `ace5e67` |
| 1.3 | Criar sessão e ver a resposta em streaming no chat — **substituído pela ponte ACP (B.1–B.5), ver abaixo** | ✅ resolvido por B.3 |
| 1.4 | Aprovação de ferramenta do SDK aparecendo na aprovação da UI — **vira B.4** | ⏳ |
| 1.5 | Retomar sessão depois de reiniciar — **vira B.5** | ⏳ |

**Portão F1:** uma conversa com Claude Code no perfil isolado, com streaming, aprovação e retomada.

### Decisão do dono em 12/10/2026: opção B (plugin reimplementando o motor) abandonada, opção C (ponte ACP) escolhida

Achado ao investigar 1.3.b: o `Agent` público do DSH tem contrato completo (`inbox`, `status`,
`cancel`, `send`/`followup`/`steer`, eventos `agent/*`) — implementá-lo do zero era escrever uma
segunda versão do `dsh-agent-loop` (quase 2000 linhas), só troca o SDK por dentro. Caro demais para
uma prova de conceito.

Confirmado por leitura de código e do repositório: `@deepseek-ai/dsh-acp` (instalado) faz o DSH ser
**servidor** ACP (expõe agentes do DSH para fora); o caminho inverso — **DSH cliente** de um agente
ACP externo — não existe em nenhum pacote instalado. O
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) (ex-`claude-code-acp`,
projeto moveu de `zed-industries` para a org `agentclientprotocol`) já implementa o lado do agente:
tool calls com permissão, streaming, subagentes, slash commands, MCP, tudo em npm
(`@agentclientprotocol/claude-agent-acp`). A ponte muda de "reimplementar o motor" para "tradução
de protocolo": o adapter já faz a parte difícil, o plugin só traduz `session/update` do ACP para
`SessionEvent` do DSH e vice-versa.

| # | Item | Escopo | Status |
|---|---|---|---|
| B.1 | Subir `claude-agent-acp` como subprocesso; handshake ACP (`initialize` → `new_session`) | protocolo padrão, sem UI ainda | ✅ |
| B.2 | Tradução de ida: `session/update` (texto chegando) → `SessionEvent` do DSH (`assistant/message` + `agent/assistant-stream`, ver [event-sequence.md](../packages/harness-deck-claude-code/docs/event-sequence.md)) | só texto, sem ferramenta | ✅ texto durável **e** ao vivo, com frames densos verificados em provedor real (OpenRouter) |
| B.3 | Teste manual: pergunta simples no perfil isolado, resposta real do Claude Code no chat da Web GUI, em streaming | fecha o portão do F1 (streaming) | ✅ resposta desenhada **crescendo** no chat da GUI (navegador sem cabeça no perfil isolado, provedor real); o teste achou e corrigiu dois defeitos de escopo do agente — ver [status.md](status.md) |
| B.4 | Tradução de volta: tool call do ACP → aprovação da UI do DSH → resposta pro ACP | fecha aprovação (era 1.4) | ⏳ |
| B.5 | Retomada de sessão (era 1.5) | depois do B.3 provado | ⏳ |

Corte do meio-termo: **B.1–B.3 primeiro**, prova o portão do F1 sem entrar em aprovação de
ferramenta. B.4/B.5 só depois de B.3 funcionar de ponta a ponta.

## F2 — Vários harness no VS Code (REQ-01, REQ-02)

| # | Item | Status |
|---|---|---|
| 2.0 | **Escolher o harness ao criar o workspace** (pedido do dono em 12/10/2026): hoje o harness é fixado no perfil que se sobe — `agent-loop` desligado, plugin instalado — e workspace no DSH é só uma pasta, sem harness. Ver "Como o harness pode ser escolhido" abaixo | ✅ **decidido pelo dono em 12/10/2026: caminho A agora, caminho B depois** — começa em 2.1 |
| 2.1 | Registro de harness: um perfil por harness em `~/.harnessdeck`, cada um com porta própria | ✅ pacote `harness-deck-launcher` (registro JSON + materialização do perfil + comandos `list`/`add`/`rm`/`up`/`down`/`status`/`logs`), verificado com dois harness rodando juntos |
| 2.2 | Verificar se a lista de workspaces fica separada por perfil ou se precisa de `DSH_HOME` por harness | ✅ **é o `DSH_HOME`, não o perfil** — dois perfis no mesmo `DSH_HOME` dividem `storages/workspace.json` e o log de sessões. Adotado um `DSH_HOME` por harness (`<raiz>/homes/<nome>`) |
| 2.3 | Lançador: sobe e para os processos de todos os harness registrados | ✅ `harness-deck up` / `down`, processo destacado com pid e log por harness; `up` espera a porta responder |
| 2.4 | Painel do VS Code: um painel por harness, na mesma janela | 🔄 **autorizado pelo dono em 12/10/2026.** Implementação própria (não fork): `packages/harness-deck-vscode`, painel = aba `WebviewPanel` por harness, lista lateral, sobe/para/inspeciona. Mapa do código da extensão de referência em [mapa-cirurgia-extension-vscode.md](mapa-cirurgia-extension-vscode.md). **Escolha de harness e de provedor/modelo decidida em 12/10/2026: o painel não tem seletor próprio — o modelo se escolhe no seletor nativo do DSH dentro de cada painel** (o registro guarda só o default inicial). Falta empacotar o `.vsix` e instalar |
| 2.5 | Teste lado a lado: DSH e Claude Code abertos juntos, cada um com seus projetos | ⏳ |

**Portão F2:** dois harness na mesma janela, sem misturar workspaces, e o DSH da 3080 intacto.

### Como o harness pode ser escolhido (verificado no código em 12/10/2026)

Restrição real: o DSH aceita **uma fábrica de agente por processo** — `setFactory` lança
`an agent factory is already registered` (`dsh-agent/lib/index.js:429`). O harness, portanto, é
propriedade do **processo**, não do workspace.

Encaixe que já existe para escolher por **sessão**: a criação de sessão carrega
`meta.agentPreset` até a fábrica (`dsh-agent/lib/types/index.d.ts:70`) e o serviço `agentPresets`
monta os plugins **por agente** (`presets.mount(agentCtx, id)`,
`dsh-api-session-controller/lib/index.js:359-368`). O seletor de preset que já aparece no cabeçalho
da GUI ("Standard mode") é esse campo.

| Caminho | Como fica | Custo |
|---|---|---|
| **A. Um processo por harness** | O deck sobe N perfis/portas, cada um com o seu harness; "novo workspace → harness → pasta" vive na nossa UI e roteia para o processo certo | N processos; a GUI de cada harness só enxerga os workspaces dele |
| **B. Uma fábrica roteadora** | Um processo só; a fábrica lê `meta.agentPreset` e constrói ponte ACP ou motor padrão (o `dsh-agent-loop` **exporta** `AgentLoop`, confirmado por `import()`), e o harness aparece no seletor de preset nativo | isolamento por harness vira regra nossa, não do processo; mais acoplamento à API interna |

Não são exclusivos: A dá o isolamento duro e depois B pode juntar tudo numa janela.

## F3 — Claude Code completo

| # | Item | Status |
|---|---|---|
| 3.0 | Medir REQ-04: mapear plugin/automation task/setting de cada harness (DSH: `cordis`, jobs, agenda; Claude Code: mods, hooks, settings) — o que isola por harness e o que cabe numa tela comum | ⏳ |
| 3.1 | Subagentes e jobs do Claude Code nos painéis da UI | ⏳ |
| 3.2 | Espelhar a sessão entre `~/.claude/projects` e o log do DSH | ⏳ |
| 3.3 | Título de sessão, compactação e goal com o motor do Claude Code | ⏳ |
| 3.4 | Camada única para a API interna do DSH (troca de versão doer pouco) | ⏳ |

## F4 — Paperclip na UI

| # | Item | Status |
|---|---|---|
| 4.1 | Tela em Configurações → Plugins: URL, empresa, vínculo agente ↔ projeto (chave do ambiente) | ⏳ |
| 4.2 | Painel: tarefas, heartbeat e orçamento | ⏳ |
| 4.3 | Instalar o Paperclip | ⏳ pede aval do dono |

## F5 — Outros harness via ACP

| # | Item | Status |
|---|---|---|
| 5.1 | Plugin que faz o DSH ser cliente de agente ACP (Agent Client Protocol) | ⏳ |
| 5.2 | Codex e Gemini registrados como harness | ⏳ |

## F6 — Publicação (a combinar)

| # | Item | Status |
|---|---|---|
| 6.1 | Remote privado no GitHub e primeiro push | ⏳ pede aval do dono |
| 6.2 | Publicar no npm e no marketplace do VS Code | ⏳ pede aval do dono |

## Bloqueios abertos

- **1.1 resolvido:** chave via `.env` do projeto (fora do git), carregada com `set -a; source .env`.
  Pendência real: o `dsh web` da porta 3080 pode ter o mesmo problema de não herdar `~/.bashrc`;
  não verificado ainda.
