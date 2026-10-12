# harness-deck-vscode

Extensão do VS Code do harness-deck: **um painel por harness, todos na mesma janela**.

Esta é uma implementação própria, não um fork do código da extensão
`vithrive.deepseek-harness-vscode`. A decisão está em [docs/plano.md](../../docs/plano.md) e
[docs/status.md](../../docs/status.md): a extensão instalada é um singleton (uma `activeView`, um
`managedChild`, `VIEW_ID` fixo) e **container do VS Code não se registra em tempo de execução** —
N harnesses exigiriam N views declaradas no manifesto, o que transforma o fork num produto com
manifesto gerado. Aqui o painel de cada harness é uma **aba** (`WebviewPanel`), que é dinâmica por
natureza: a extensão abre quantas abas quiser, uma por harness.

## O que ela faz

- Lê o registro do harness-deck (`<raiz>/harnesses.json`) — o mesmo arquivo que o CLI
  `harness-deck` escreve.
- Lista os harnesses num painel lateral, com motor, porta e estado (`no ar` / `parado`).
- Sobe o harness que estiver parado, com `DSH_HOME` próprio, e espera a porta responder.
- Dá a cada harness uma aba com a GUI dele embutida (URL com token), na mesma janela.
- Para, reinicia, abre no navegador do sistema e mostra o log.

## O que ela **não** faz

- Não escreve o registro nem materializa perfil: isso é do CLI (`harness-deck add`). A extensão só
  executa o que já está registrado.
- Não toca em `~/.dsh`.
- Não registra o DSH como modelo de chat do Copilot (o provedor de LM da extensão original ficou de
  fora da primeira versão).
- Não abre uma view por harness na barra lateral, pelo motivo acima.

## Construir e instalar

```bash
cd packages/harness-deck-vscode
../harness-deck-claude-code/node_modules/.bin/tsc -p tsconfig.json   # gera lib/
node test/smoke.mjs                                                  # testes sem VS Code
```

O empacotamento (`.vsix`) e a instalação no VS Code ainda não foram feitos: publicar no marketplace
pede aval do dono, e instalar por `.vsix` também é uma ação no ambiente dele.

## Configuração

| Chave | Padrão | Para que serve |
|---|---|---|
| `harnessDeck.home` | vazio | Raiz de dados; vazio = `$HARNESS_DECK_HOME` ou `~/.harnessdeck` |
| `harnessDeck.dshCommand` | `dsh` | Comando do DSH |
| `harnessDeck.autoStart` | `true` | Subir o harness ao abrir o painel |
| `harnessDeck.stopOnExit` | `true` | Encerrar, ao fechar o VS Code, só os harnesses que esta extensão subiu |
| `harnessDeck.openSystemBrowser` | `false` | Abrir também no navegador do sistema |

## Estrutura

| Arquivo | Papel |
|---|---|
| `src/registry.ts` | Lê e valida o registro; resolve `DSH_HOME`, log, pid e URL por harness |
| `src/processes.ts` | Sobe, espera a porta, para e inspeciona o processo de cada harness |
| `src/panel.ts` | Uma aba por harness, com a GUI embutida e o CSP que a permite |
| `src/tree.ts` | Lista lateral dos harnesses |
| `src/extension.ts` | Ativação, comandos e ciclo de vida |
| `src/vscode.d.ts` | Superfície mínima da API do VS Code (`@types/vscode` não está instalado aqui) |
