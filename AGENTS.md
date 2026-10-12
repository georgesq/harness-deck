# AGENTS.md — harness-deck

## Ponto de partida

Leia [docs/analise-inicial.md](docs/analise-inicial.md) antes de qualquer coisa. Ela traz o porquê,
o que foi verificado e o que **não** foi.

## Regras locais

- **Português do Brasil** em chat, relatório e documento interno. **Inglês** no código, nos
  comentários e nos commits.
- Padrão de git global: `~/.dsh/padrao-git.md` (branch `main`, bloco de segredo, Conventional
  Commits, commit por caminho).
- **O produto é neutro de harness.** Nada de "dsh" no nome de pacote, comando ou tela do produto; o
  DSH é um dos harness suportados, não a marca. (Plugin específico de um harness pode levar o nome
  dele, ex.: `harness-deck-claude-code`.)
- **Nunca** gravar chave de API em arquivo do repositório; a chave vem do ambiente.
- Campo que não se sabe é **não localizado**, nunca estimado.
- O DSH é pré-lançamento (`0.2.0-rc.2`): toda dependência de API interna dele fica isolada numa
  camada só, para a troca de versão doer pouco.

## O que pede aval do dono

- Criar o remote no GitHub e o primeiro push.
- Publicar no npm ou no marketplace do VS Code.
- Mudar qualquer arquivo em `~/.dsh/`, na instalação do DSH ou em outro projeto
  (inclusive `paperclip-adapter-dsh`).
- Instalar o Paperclip ou trocar o harness de uma frente real.
