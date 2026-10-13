# Task — configurar o provedor pelo painel

Acompanhamento de [spec-feat-configurar-provedor.md](spec-feat-configurar-provedor.md).
Cada item marcado aponta a prova; item sem prova fica desmarcado, mesmo que o código exista.

Legenda: `[x]` feito e verificado · `[~]` código pronto, falta a prova combinada · `[ ]` pendente.

## Quebra por fatia (cada fatia tem um dono e um arquivo)

| Fatia | Escopo | Arquivo | Estado |
| --- | --- | --- | --- |
| A | catálogo instalado, protocolos, fallback sem `pi-ai` | `src/provider.ts` (topo) | escrita |
| B | fluxo de escolha, gravação, registro do comando, reiniciar | `src/provider.ts` (fluxo), `src/extension.ts`, `package.json` | escrita |
| C | aceitação de ponta a ponta: comando → registro → perfil | `test/provider-e2e.test.mjs` | entregue, 11 verificações |
| D | determinismo das três execuções + guarda contra vazamento de estado | `test/provider.test.mjs` | entregue, 5 execuções idênticas |

## Requisitos

| | Requisito | Onde | Prova |
| --- | --- | --- | --- |
| [~] | REQ-C1 — comando existe e ativa | `src/extension.ts:389`, `package.json` (`contributes.commands` + `activationEvents`) | código pronto; falta asserção de que os dois pontos declaram o comando |
| [~] | REQ-C2 — rota vem do catálogo instalado + `outra rota` | `src/provider.ts` (`pickRoute`) | `provider.test.mjs` (com e sem catálogo); falta a prova de ponta a ponta (fatia C) |
| [~] | REQ-C3 — modelo é multi-select do catálogo da rota | `src/provider.ts` (`askModels`) | `provider.test.mjs`: ids de `google` iguais aos de `getBuiltinModels('google')` |
| [~] | REQ-C4 — sem catálogo: avisa, pede o id, nunca lista vazia | `src/provider.ts` (`CATALOG_MISSING`, `askModelsByHand`) | `provider.test.mjs`; **falhou uma vez sem causa localizada** — fechando na fatia D |
| [~] | REQ-C5 — rota fora da tabela exige URL e protocolo, falhando nomeando o campo antes do CLI | `src/provider.ts` (`missingRouteFields`, `routeFieldsMessage`) | `provider.test.mjs`: sem URL e sem protocolo, nenhuma chamada ao CLI |
| [~] | REQ-C6 — chave sugerida é a da rota (`GEMINI_API_KEY` para `google`) | `src/provider.ts`, `registry.ts` (`providerKeyEnv`) | `provider.test.mjs`; falta a asserção de ponta a ponta (fatia C) |
| [x] | REQ-C7 — grava pelo CLI `add --force`, sem perder o resto da entrada | `src/provider.ts` (`addArguments`, `spawnLauncher`) | `provider-e2e.test.mjs`: CLI real, `harnesses.json` com rota/modelos/chave/URL e `note` + `providerApiKeyEnv` preservados |
| [~] | REQ-C8 — avisa rota + variável e oferece reiniciar | `src/provider.ts` (`ConfigureOutcome`), `src/extension.ts` | caso adicionado pelo autor; asserção conferida por mim na leitura, não executada em VS Code real |
| [x] | REQ-C9 — `npm test` determinístico em três execuções | `test/provider.test.mjs` | 5 execuções com árvore congelada, logs byte a byte idênticos (hash `f568a32d`); guarda de duas travessias falsificada por injeção de vazamento no `lib` compilado |
| [x] | REQ-C10 — nenhum valor de chave gravado em arquivo do repositório | `src/provider.ts` (só nome de variável) | `provider-e2e.test.mjs`: sentinela `valor-de-teste` ausente dos args do CLI, do `harnesses.json` e do perfil |

## Falha de método registrada (culpa do gerente, não do código)

A suíte oscilou uma vez em `repeticao: a segunda configuracao responde ao proprio catalogo`. Causa:
**dois donos escrevendo `provider.test.mjs` ao mesmo tempo** — o gerente ajustando a asserção do
`--model` e a fatia D acrescentando a guarda. O arquivo mudou em disco no meio da execução. Provado o
modo (a fatia D reproduziu uma rodada com hash `WORKSPACE CHANGED` falhando no mesmo caso) e provado
o estado atual (7 execuções seguidas verdes com hash do arquivo igual antes e depois). A revisão
exata que estava em disco na execução que falhou fica **não localizada**.

Regra que passa a valer nas próximas quebras: **um arquivo, um dono por vez** — fatia que precise do
mesmo arquivo de outra espera a outra fechar.

## Pendências fora das fatias

- [ ] VSIX reempacotado e conferido (arquivo e contagem) — não empacotar em cima de estado que ainda
      está sendo escrito.
- [ ] Commit por caminho e push, depois das fatias C e D fechadas.
- [ ] Teste do dono: instalar, `Developer: Reload Window`, configurar o provedor pelo painel, subir e
      mandar uma mensagem de verdade numa rota não-OpenRouter (é a prova que fecha o REQ-R3 da spec
      [spec-feat-provider-route.md](spec-feat-provider-route.md)).
