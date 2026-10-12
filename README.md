# harness-deck

Uma UI única para trabalhar em **vários projetos** com **qualquer harness** de agente (o programa
que roda o agente: loop, ferramentas, sessão). Primeiros harness suportados: **DSH** (DeepSeek
Harness) e **Claude Code**. Outros entram como plugin.

## Estado

**Nada implementado ainda.** Análise em [docs/analise-inicial.md](docs/analise-inicial.md);
andamento em [docs/plano.md](docs/plano.md).

## Objetivo

1. Painel único no VS Code (e no navegador) com lista de projetos, sessões por projeto e chat,
   independente do harness que roda cada sessão.
2. Harness plugável: DSH e Claude Code primeiro; Codex, Gemini e outros depois, via ACP (Agent
   Client Protocol, protocolo padrão entre editor e agente).
3. Vários harness registrados abertos juntos na mesma janela do VS Code, cada um com os próprios
   workspaces (REQ-01 e REQ-02 em [docs/analise-inicial.md](docs/analise-inicial.md)).
4. Suporte ao [Paperclip](https://github.com/paperclipai/paperclip) (control plane: heartbeat,
   tarefas, orçamento), configurável dentro da própria UI.

## Abordagem escolhida

Não construir UI do zero. Reaproveitar a UI do DSH (Web GUI + extensão do VS Code, ambas MIT) e
adicionar harness como **plugin do DSH**. Detalhe e riscos em
[docs/analise-inicial.md](docs/analise-inicial.md).

## Como roda

Não localizado — será definido na implementação.
