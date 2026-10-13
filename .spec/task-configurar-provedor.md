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

## Descoberta do teste do dono (13/10/2026): campo da chave travado

O dono abriu `models/third-party`, escolheu Google e o campo da chave veio **somente-leitura**. Não é
o deck: `~/.harnessdeck/.env` tem só `OPENROUTER_API_KEY` e o cofre do harness
(`<raiz>/homes/<nome>/.credentials.yaml`) está sem nenhum provider. A origem é o **ambiente do shell**:

- `~/.bashrc` exporta `GOOGLE_API_KEY`, além de `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` e
  `OPENROUTER_API_KEY`;
- o VS Code server herda, o host da extensão repassa a todo processo que ele sobe, e o harness vê a
  variável no ambiente do processo;
- `credentials-local.describe` responde `source: "env"`, `writable: false` quando a referência vem do
  ambiente herdado ([dsh-credentials-local:490-499](file:///usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js#L490-L499));
- a página marca `readOnly: !writable` e o campo não aceita edição.

Contorno imediato, sem código: tirar o export do `~/.bashrc` e reiniciar o VS Code server.

**O contorno foi aplicado em 13/10/2026 e NÃO surtiu efeito.** `~/.bashrc` linhas 2 e 147 comentadas
(`export GOOGLE_API_KEY`, `export OPENROUTER_API_KEY`), backup `~/.bashrc.bak-20261013-182741`,
sintaxe conferida com `bash -n`; janela remota reaberta e o campo continuou travado. O que fica sem
prova é se o processo do VS Code server realmente renasceu com o ambiente novo — a extensão recebe o
ambiente do host, e host antigo repassa ambiente antigo. Não afirmei que sumiu porque do sandbox os
processos ficam fora do namespace e `/proc/<pid>/environ` não é legível.

Decisão do dono: **não corrigir agora**. A frente seguinte já vai escrever para outros harnesses e
refatorar para ser configurável sem intrusão; o desenho a considerar lá é o deck **não repassar ao
harness** as variáveis de provider herdadas do shell, injetando no lugar o que estiver no cofre do
harness. Isso torna a UI dona da chave e o `.env` do deck volta a ser o caminho de quem roda sem
painel.

## BACKLOG — campo da chave travado: ler o dado na fonte antes de tentar de novo

Duas tentativas e nenhuma resolveu, e nas duas o defeito de método foi o mesmo: **mexi no arquivo
errado sem ler de onde o dado vinha**. A primeira apostou no `.env` do deck, que só tem
`OPENROUTER_API_KEY`; a segunda apostou no `~/.bashrc`, e mexer nele não mudou a tela. Isso é
tentativa e erro, e o dono vetou repetir assim.

Duas hipóteses já caíram por medição, e valem como fato:

- não é o `.env` do deck: limpar chave de lá não destravou o campo;
- não é o conteúdo do `~/.bashrc`: comentar os exports não destravou o campo.

O que continua **não localizado**, e é o que precisa ser medido:

1. **qual referência a página pede.** O campo trava a partir de `apiKeyEnvOf(namespace,
   settingsPath, schema)` por rota, não de um nome fixo; pode ser `GEMINI_API_KEY` ou
   `GOOGLE_API_KEY` conforme o schema da rota Google. Ler esse valor em vez de adivinhar.
2. **o que `describe` responde para ela.** `configured`, `source` e `writable` decidem a tela. Se vier
   `source: "env"`, o ambiente ainda carrega a variável; se vier `source: "file"`, a chave está no
   cofre e o travamento tem outra causa — inclusive a quarta possibilidade, que ninguém descartou:
   `state.writable === false` no documento de settings inteiro, que trava **todas** as rotas, não só
   Google.
3. **se o processo do VS Code server renasceu.** Sem isso, mexer em arquivo de shell não tem como
   aparecer na tela.

Instrumentação, não palpite — o passo que lê o dado na fonte: o host expõe `credentials.describe` e
`credentials.set` por transporte remoto (`/api/remote.mux`) e a extensão já fala com o mesmo host pelo
painel. O caminho é chamar `describe` com a referência exata da rota (itens 1 e 2) e olhar a resposta,
em vez de deduzir do arquivo. Alternativa barata: subir o harness com um log temporário do ambiente
que ele recebeu e conferir se a variável está lá dentro.

Só depois disso faz sentido escrever correção. Enquanto os três itens não estiverem medidos, qualquer
conserto é chute com nome bonito.

## Pendências fora das fatias

- [x] VSIX reempacotado e conferido (arquivo e contagem) — `dist/harness-deck-vscode-0.1.2.vsix`,
      47048 bytes, 14 arquivos; instalado no VS Code do dono em 13/10/2026 (`0.1.1` → `0.1.2`).
- [x] Commit por caminho e push, depois das fatias C e D fechadas — 7 commits em
      `origin/feat/model-list-and-tool-approval`, o último `09d32b5`.
- [~] Teste do dono: instalar, `Developer: Reload Window`, configurar o provedor pelo painel, subir e
      mandar uma mensagem de verdade numa rota não-OpenRouter (é a prova que fecha o REQ-R3 da spec
      [spec-feat-provider-route.md](spec-feat-provider-route.md)). Instalou e chegou até a tela de
      `models/third-party`; parou no campo da chave travado (acima). A mensagem real em rota não
      OpenRouter segue sem prova, e o escopo foi congelado pelo dono antes disso.
