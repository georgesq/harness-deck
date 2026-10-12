# Como contribuir

Obrigado pelo interesse. Este projeto é aberto para a comunidade melhorar e acrescentar, mas a
branch `main` é protegida: **ninguém escreve nela diretamente** — nem o mantenedor. Toda mudança
entra por pull request.

Leia primeiro [docs/analise-inicial.md](docs/analise-inicial.md) (o porquê e o que foi verificado) e
[docs/status.md](docs/status.md) (o que existe agora). O roadmap fica em
[docs/plano.md](docs/plano.md).

## O que é bem-vindo

| Tipo | Exemplos |
|---|---|
| Novo harness | adapter para Codex, Gemini, Aider ou qualquer agente que fale ACP |
| Defeito | correção com um caso que reproduz, de preferência com teste |
| Documentação | corrigir o que está errado ou "não localizado", traduzir, exemplos |
| Experiência de uso | teclado, acessibilidade, mensagens de erro, estados vazios |

## O que precisa ser combinado antes

Abra uma issue e espere o retorno **antes** de escrever o código quando a mudança:

- altera arquitetura (a fronteira entre painel, registro e processo do harness);
- troca o protocolo de integração de um harness (hoje: ACP);
- adiciona dependência pesada ou serviço externo;
- muda o formato do registro (`<raiz>/harnesses.json`), que é contrato com os harnesses já
  instalados.

## O que fica fora

- **Duplicar o seletor de modelo.** O provedor/modelo é escolhido no seletor nativo de cada harness;
  o painel não mantém uma segunda verdade.
- **Chave de API em qualquer arquivo do repositório.** As chaves vivem em `<raiz>/.env`, fora do git.
- **Quebrar o isolamento.** Cada harness tem o próprio `DSH_HOME` (workspaces e sessões separados,
  REQ-02 em [docs/analise-inicial.md](docs/analise-inicial.md)). Um processo por harness é requisito,
  não preferência.
- **Marca de um harness no produto.** O nome de pacote, comando e tela é neutro (`harness-deck`);
  plugin específico de um harness pode levar o nome dele (ex.: `harness-deck-claude-code`).

## Preparando o pull request

1. Faça um fork e crie uma branch com nome descritivo (`fix/porta-ocupada`,
   `feat/plugin-codex`, `docs/contribuindo`).
2. Um commit por caminho, com **Conventional Commits** e mensagem em **inglês**
   (`fix(launcher): ...`, `feat(vscode): ...`, `docs: ...`). Nunca `git add .`.
3. Rode os testes antes de abrir o PR:

   ```bash
   cd packages/harness-deck-launcher && npm test
   cd packages/harness-deck-vscode    && npm test
   ```

4. Abra o PR preenchendo o modelo. Descreva **o problema** antes da solução, e o que você verificou
   para saber que funciona.

## O que o mantenedor avalia

- **Verificação, não promessa.** Todo número, caminho ou afirmação precisa apontar para algo que dá
  para conferir. Campo que não se sabe é "não localizado", nunca estimado.
- **Fronteira de responsabilidade.** O painel controla processos e mostras telas; quem materializa
  perfil e escreve o registro é o CLI (`harness-deck add`).
- **Português no chat, relatório e documento; inglês no código, nos comentários e nos commits.**
- **Testes.** O que dá para testar sem abrir o VS Code é testado assim
  (`node test/smoke.mjs` nos dois pacotes). Teste que não roda em CI não conta como verificação.

Retorno esperado: alguns dias úteis. PR parado sem resposta por muito tempo pode ser fechado — mas
pode ser reaberto quando você quiser.

## Segurança

Achou falha ou segredo exposto? Não abra issue pública: escreva para o mantenedor pelo perfil do
GitHub ([@georgesq](https://github.com/georgesq)).

## Licença

Ao contribuir você concorda que a sua contribuição é licenciada sob a [MIT](LICENSE), a mesma do
projeto.
