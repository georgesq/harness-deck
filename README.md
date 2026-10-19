# harness-deck

Uma UI única para trabalhar em **vários projetos** com **qualquer harness** de agente (o programa
que roda o agente: loop, ferramentas, sessão). Primeiros harness suportados: **DSH** (DeepSeek
Harness) e **Claude Code**. Outros entram como plugin.

MIT. Contribuição pelo protocolo em [CONTRIBUTING.md](CONTRIBUTING.md) — a branch `main` é protegida,
tudo entra por pull request.

## Estado

**Versão 1.0 estável e fechada** (19/10/2026). Funciona de ponta a ponta para múltiplos harnesses (**DSH** e **Claude Code**), operando simultaneamente em abas dedicadas no VS Code ou no navegador:

- CLI `harness-deck` (registro, materialização do perfil, ciclo de vida, rotas e workspaces) em
  [packages/harness-deck-launcher](packages/harness-deck-launcher);
- painel do VS Code com uma aba por harness e gerenciamento de processos em
  [packages/harness-deck-vscode](packages/harness-deck-vscode);
- ponte ACP estável que integra o loop do Claude Code ao DSH com streaming, aprovação de ferramentas e troca dinâmica de modelos em
  [packages/harness-deck-claude-code](packages/harness-deck-claude-code).

Verificado e homologado: os dois harnesses sobem e convivem na mesma janela do VS Code, cada um com seus próprios workspaces (`DSH_HOME` isolado por harness), a escolha de modelo persiste entre reinícios e as ferramentas pedem aprovação diretamente na UI. O que está pronto, o que foi verificado e o histórico: [docs/status.md](docs/status.md). O que cada harness oferece de skill, plugin, MCP e subagente: [docs/capacidades-por-harness.md](docs/capacidades-por-harness.md).

## Objetivo

1. Painel único no VS Code (e no navegador) com lista de projetos, sessões por projeto e chat,
   independente do harness que roda cada sessão.
2. Harness plugável: DSH e Claude Code primeiro; Codex, Gemini e outros depois, via ACP (Agent
   Client Protocol, protocolo padrão entre editor e agente).
3. Vários harness registrados abertos juntos na mesma janela do VS Code, cada um com os próprios
   workspaces (REQ-01 e REQ-02 em [docs/analise-inicial.md](docs/analise-inicial.md)).
4. Suporte ao [Paperclip](https://github.com/paperclipai/paperclip) (control plane: heartbeat,
   tarefas, orçamento), configurável dentro da própria UI. **Não iniciado.**

## Abordagem escolhida

Não construir UI do zero. Reaproveitar a UI do DSH (Web GUI + extensão do VS Code, ambas MIT) e
adicionar harness como **plugin do DSH**. Detalhe e riscos em
[docs/analise-inicial.md](docs/analise-inicial.md).

## Como roda

Pré-requisitos: **Node 24+** e o DSH instalado (`npm i -g @deepseek-ai/dsh`). A chave do provedor
vai no `.env` da raiz de dados, nunca no repositório — veja
[docs/status.md](docs/status.md#credenciais-raizenvex-a-única-fonte-decidido-em-12102026).

```bash
# 1. chave do provedor (uma vez)
printf 'OPENROUTER_API_KEY=sk-or-v1-...\n' > ~/.harnessdeck/.env
chmod 600 ~/.harnessdeck/.env

# 2. registrar os harnesses
CLI=packages/harness-deck-launcher/bin/harness-deck.mjs
node $CLI add dsh    --engine dsh         --port 3130
node $CLI add claude --engine claude-code --port 3131

# 3. subir e abrir a GUI (o comando imprime a URL com o token)
node $CLI up --wait 45000
node $CLI down

# 4. pastas que aparecem na GUI — uma DSH_HOME por harness (REQ-02) significa
#    que cada harness tem a sua lista; sem --harness, vale para todos
node $CLI workspace list
node $CLI workspace add /caminho/do/projeto --title "Projeto"
node $CLI workspace remove /caminho/do/projeto --harness claude
```

`workspace add` grava a unidade `storages/workspace.json` do DSH_HOME daquele harness. Com o
harness **no ar** a lista vive em memória e o comando seria sobrescrito no próximo clique da GUI:
suba com o harness parado, ou pare e suba de novo depois.

O comando `harness-deck` no PATH depende de publicar o pacote no npm — ainda **não publicado**.
Enquanto isso, chame o `bin/harness-deck.mjs` pelo caminho.
