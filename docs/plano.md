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
| 1.3 | Criar sessão e ver a resposta em streaming no chat | ⏳ |
| 1.4 | Aprovação de ferramenta do SDK aparecendo na aprovação da UI | ⏳ |
| 1.5 | Retomar sessão depois de reiniciar | ⏳ |

**Portão F1:** uma conversa com Claude Code no perfil isolado, com streaming, aprovação e retomada.
Se falhar, reavaliar a opção C (ponte ACP) antes de seguir.

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
