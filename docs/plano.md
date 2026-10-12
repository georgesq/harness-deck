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
| 1.3 | Criar sessão e ver a resposta em streaming no chat — **substituído pela ponte ACP (B.1–B.5), ver abaixo** | ⏳ |
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
| B.3 | Teste manual: pergunta simples no perfil isolado, resposta real do Claude Code no chat da Web GUI, em streaming | fecha o portão do F1 (streaming) | 🟡 streaming provado fora da GUI (ouvinte global igual ao da GUI); falta abrir a Web GUI do perfil e ver a resposta desenhada |
| B.4 | Tradução de volta: tool call do ACP → aprovação da UI do DSH → resposta pro ACP | fecha aprovação (era 1.4) | ⏳ |
| B.5 | Retomada de sessão (era 1.5) | depois do B.3 provado | ⏳ |

Corte do meio-termo: **B.1–B.3 primeiro**, prova o portão do F1 sem entrar em aprovação de
ferramenta. B.4/B.5 só depois de B.3 funcionar de ponta a ponta.

## F2 — Vários harness no VS Code (REQ-01, REQ-02)

| # | Item | Status |
|---|---|---|
| 2.1 | Registro de harness: um perfil por harness em `~/.harnessdeck`, cada um com porta própria | ⏳ |
| 2.2 | Verificar se a lista de workspaces fica separada por perfil ou se precisa de `DSH_HOME` por harness | ⏳ |
| 2.3 | Lançador: sobe e para os processos de todos os harness registrados | ⏳ |
| 2.4 | Extensão própria do VS Code (fork da Vithrive, MIT): um painel por harness | ⏳ |
| 2.5 | Teste lado a lado: DSH e Claude Code abertos juntos, cada um com seus projetos | ⏳ |

**Portão F2:** dois harness na mesma janela, sem misturar workspaces, e o DSH da 3080 intacto.

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
