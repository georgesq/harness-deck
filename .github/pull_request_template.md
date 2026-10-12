## Problema

<!-- O que está errado ou faltando, e como isso aparece para quem usa. -->

## Solução

<!-- O que o PR faz. Se houver decisão de projeto, diga qual e por quê. -->

## Verificação

<!-- O que você rodou e o que apareceu. Ex.: `npm test` nos dois pacotes → "tudo ok". -->

- [ ] `cd packages/harness-deck-launcher && npm test`
- [ ] `cd packages/harness-deck-vscode && npm test`
- [ ] Sem chave de API nem segredo em arquivo versionado
      (`git ls-files | grep -E '(^|/)\.env'` devolve só `.env.example`)
- [ ] Um commit por caminho, Conventional Commits, mensagem em inglês

## Observações

<!-- Limitação conhecida, o que ficou de fora, o que não deu para verificar. -->
