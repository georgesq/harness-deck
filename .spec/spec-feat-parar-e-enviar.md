# Spec de feature — parar de verdade e enviar sem esperar

**Status:** pronto para virar tarefa no Paperclip (não implementado)
**Dono do problema:** georgesq · **Autor da spec:** sessão do mestre em 13/10/2026
**Repositório:** `/home/georgesq/project/harness-deck` (branch de trabalho `chore/protocolo-contribuicao`, `main` é PR-only)
**Leia antes:** [`docs/analise-inicial.md`](../docs/analise-inicial.md), [`docs/plano.md`](../docs/plano.md), [`docs/status.md`](../docs/status.md)

---

## 1. Contexto para quem vai implementar

`harness-deck` é um **deck de harnesses**: sobe vários agentes de código (o DSH e o Claude Code) lado a
lado, cada um com isolamento próprio, e dá a cada um uma aba no VS Code. Três peças importam aqui:

| Peça | Caminho | O que é |
|---|---|---|
| Lançador (CLI) | `packages/harness-deck-launcher` | Sobe/para/inspeciona harness. **É a referência de comportamento**: o `stopHarness` dele já funciona. |
| Painel VS Code | `packages/harness-deck-vscode` | Lista os harnesses, sobe/para e abre a GUI de cada um numa aba. |
| Ponte Claude Code | `packages/harness-deck-claude-code` | Plugin do DSH que **substitui o motor** `dsh-agent-loop` por uma ponte ACP para o `claude-agent-acp`. |

O dono estava usando o deck no VS Code e parou por dois motivos. Os dois são reais e estão
reproduzidos abaixo com evidência.

**Regras do repositório que valem para a implementação:** português do Brasil em documento e
relatório, **inglês** em código/comentário/commit; Conventional Commits e commit por caminho (nunca
`git add .`); nada de chave em arquivo do repositório; o produto é neutro de harness (nada de "dsh" no
nome de pacote/comando/tela do produto — plugin de um harness específico pode levar o nome dele).

---

## 2. Problema 1 — o "parar" não para

### 2.1 Sintoma do dono
Clicou em parar e o harness continuou no ar.

### 2.2 Evidência colhida (13/10/2026, raiz real `~/.harnessdeck`)

```
$ harness-deck list
claude  claude-code  porta 3131   no ar   pid 394127
$ ps -o pid=,stat=,args= -p 394127
(nao existe)                      # o pid do arquivo esta morto
$ ss -ltnp | grep 3131
LISTEN 127.0.0.1:3131             # e a porta continua ocupada
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/
401                               # ha um servidor vivo, de pid desconhecido
```

Ou seja: **a lista diz "no ar" com base na porta, mas o `pid` que o deck conhece está morto** — o
processo real é outro. E o `harness-deck list` do `dsh` mostra `parado   pid 707115`, também morto.

### 2.3 Causa (verificada no código)

- `packages/harness-deck-vscode/src/processes.ts:267-280` — `HarnessProcesses.stop()`:
  ```ts
  const child = this.children.get(entry.name);
  if (child === undefined || child.pid === undefined) return false;   // <- sai sem fazer nada
  child.kill('SIGTERM');
  ```
  Só mata processo **que esta janela do VS Code subiu**. Harness subido pelo terminal, pelo CLI, ou
  cujo `children` se perdeu (recarregar a janela do VS Code recria o extension host e zera o `Map`)
  devolve `false` — e `extension.ts` apenas registra no log `nao ha processo desta janela para parar`.
  **O botão parece não fazer nada.**
- `packages/harness-deck-launcher/src/launcher.ts:271-291` — `stopHarness()` faz o certo: lê o pid do
  arquivo, SIGTERM, espera, SIGKILL, e **só remove o pid file depois que o processo morreu**. O
  problema dele é outro: quando o pid file está morto ele remove o arquivo e devolve
  `{stopped: false, signal: 'none'}` — **sem checar se a porta continua ocupada**. Foi exatamente
  esse estado que ficou na raiz real: pid morto, porta viva, deck sem saber quem é o dono.
- `packages/harness-deck-vscode/src/processes.ts:202-215` — o painel sobe com `spawn(...)` **sem
  `detached`**, enquanto o CLI sobe com `detached: true` (`launcher.ts:224-236`). Dois caminhos de
  subida diferentes para o mesmo processo é o que produz a divergência de comportamento entre o
  botão do painel e o comando do terminal.

### 2.4 Requisitos

| ID | Requisito | Verificação |
|---|---|---|
| **REQ-P1** | Parar funciona para **qualquer** harness no ar, tenha sido ele subido pelo painel, pelo CLI ou pelo terminal. | Teste que sobe pelo CLI, chama o stop do painel e prova porta fechada. |
| **REQ-P2** | Parar só reporta sucesso quando o processo **de fato** morreu: nada respondendo na porta **e** pid inexistente. | Asserção dupla (porta + pid) no teste e no resultado devolvido. |
| **REQ-P3** | Se o pid file estiver morto mas a porta ocupada, o deck **não** pode dizer "parado" e sair de fininho: tem de procurar o dono da porta, matar, ou falhar com mensagem acionável nomeando porta e pid file. | Teste com pid file apontando para processo morto e um listener vivo na porta. |
| **REQ-P4** | Um único caminho de parada no código. O painel passa a usar a mesma implementação do CLI (ou o painel delega ao CLI), em vez de manter a sua própria versão mais fraca. | Revisão de código + o teste do REQ-P1 roda os dois pontos de entrada. |
| **REQ-P5** | Um único caminho de subida: o painel e o CLI sobem o harness do mesmo jeito (`detached`, pid registrado, log no mesmo lugar). | Inspeção + teste que compara o pid file gerado pelos dois caminhos. |
| **REQ-P6** | O resultado do stop chega ao dono na tela (notificação), não só no canal de saída: "parado (SIGTERM)", "parado (SIGKILL)" ou "não parei: porta 3131 ainda responde". | Teste manual no painel, com print. |

### 2.5 Fora de escopo
Matar processo de **outro** usuário; parar todos os harnesses de uma vez (já existe `stopAll` no
`deactivate`); qualquer coisa em `~/.dsh/` ou em outro projeto.

---

## 3. Problema 2 — a mensagem fica no pool até terminar

### 3.1 Sintoma do dono
Mandou uma mensagem durante um turno em andamento e ela não foi logo enviada: ficou no pool até o
turno terminar.

### 3.2 Como o DSH entrega mensagem (verificado no código instalado)

`@deepseek-ai/dsh-api-session-controller/lib/index.js:882-883`:

```js
if (request.mode === "steer") agent.steer(message);
else agent.followup(message);
```

- `followup` (o caminho normal do botão de enviar) vai para a fila **`next-turn`**;
- `steer` vai para a fila **`next-step`**.

Qual dos dois o Enter usa com o agente ocupado é uma preferência do próprio DSH
(`dsh-client-ui-conversation/lib/client.js:14386-14388`, constante em `:14386` e padrão em `:14388`): `busyEnter`, valores `queue` e `steer`,
**padrão `queue`**. Não está configurada nos perfis da raiz real, então hoje o Enter enfileira.

O motor padrão (`dsh-agent-loop/lib/index.js:998-1006`) consome `next-step` **no fim de cada passo**
do turno, e só encerra o turno quando `next-step` está vazia:

```js
if (turnEnds && this.inbox.nextStep.length === 0) break;
target = "next-step";
```

Ou seja: no motor padrão, uma mensagem enfileirada é consumida **na fronteira do passo**, sem esperar
o turno inteiro.

### 3.3 Causa na ponte Claude Code

A ponte substitui o motor e implementa o próprio `Inbox` em memória
(`packages/harness-deck-claude-code/src/index.ts:201-269`) e o próprio laço
(`index.ts:812-921`). O laço é:

```ts
for (;;) {
  const userMessage = await agent.waitForWork(signal);   // index.ts:813
  ...
  acpSession.prompt(promptText);                          // index.ts:876
  for (;;) { const update = await acpSession.nextUpdate(); if (update.kind === 'stop') break; ... }
  ...
  agent.markIdle();                                       // index.ts:918
}
```

- `waitForWork` só é chamado **depois** que o prompt ACP anterior terminou por completo. Enquanto um
  turno está em andamento, a mensagem nova fica parada no `SimpleInbox` — **e é isso que o dono vê
  como "no pool"**.
- Pior: o ACP **não tem fronteira de passo** exposta aqui. Um turno que não termina (ferramenta
  longa, agente ACP pendurado, endpoint de modelo que não responde) **trava a fila para sempre**.
- A saída de emergência também não existe: `cancel` (`index.ts:337-341`) só limpa a fila e vira
  `status = 'idle'` — o próprio código documenta que **não aborta o prompt ACP em andamento**
  (`TODO(B.4)`, `index.ts:278-282`). Então nem "parar o turno" nem "mandar a próxima agora" têm
  caminho.

### 3.4 Requisitos

| ID | Requisito | Verificação |
|---|---|---|
| **REQ-M1** | Mensagem enviada durante um turno em andamento **aparece na trajetória do chat no instante do envio**, marcada como pendente/na fila. Nada de sumir até o turno terminar. | Teste de integração com agente ACP falso: envia durante um turno longo e verifica o evento `user/message` antes do fim do turno. |
| **REQ-M2** | A ponte consome a fila `next-step` **na fronteira de cada passo** do turno, igual ao motor padrão, em vez de só no fim do turno. | Teste unitário do laço com duas mensagens: a segunda é processada antes do `turn/end` da primeira. |
| **REQ-M3** | `steer` (fila `next-step`) e `followup` (fila `next-turn`) se comportam como no motor padrão. Se a ponte não consegue honrar `steer`, tem de recusar de forma explícita, não engolir a mensagem. | Teste dos dois modos com o agente falso. |
| **REQ-M3b** | Com `busyEnter: steer` ligado no DSH, mandar mensagem durante um turno tem de **de fato** encurtar a espera (a mensagem entra no turno em andamento). Hoje não encurta nada, porque a ponte só olha a fila no fim do turno. | Mesmo teste do REQ-M1, com a preferência ligada. |
| **REQ-M4** | Enquanto há turno em andamento, o dono tem uma ação visível para **cancelar o turno**; o cancelamento aborta o prompt ACP de verdade (`session/cancel`) e libera a fila para o próximo turno. | Teste que prova que o `session/cancel` é enviado e que o turno fecha com motivo de aborto, sem deixar stream vivo. |
| **REQ-M5** | Um turno que não termina não pode travar a fila indefinidamente: ou o cancelamento do REQ-M4 resolve, ou existe timeout com erro visível na trajetória. | Teste com agente ACP falso que nunca responde. |
| **REQ-M6** | Nenhuma dessas mudanças pode inventar histórico: a mensagem entra na sessão **uma vez**, e a ordem dos eventos na trajetória tem de continuar válida para o acumulador do cliente (revisões consecutivas). | Testes existentes de evento + asserção de ordem no teste novo. |

### 3.5 Fora de escopo
Durabilidade da fila entre reinícios (é o item **B.5** de `docs/plano.md`, retomada de sessão) e
desenhar tool call na trajetória (pendência do **B.4**). A fila em memória pode continuar em memória.

---

## 4. Critérios de aceite (o que fecha a tarefa)

1. Teste automatizado prova REQ-P1/P2/P3: subir um harness pelo CLI, chamar o stop pelo painel,
   provar **porta fechada + pid inexistente**; e o caso "pid file morto com porta viva" falhando com
   mensagem que nomeia porta e pid file.
2. Teste automatizado prova REQ-M1/M2/M3/M4 com um agente ACP falso controlado pelo teste (mesma
   técnica já usada em `.run-fake-anthropic.mjs` no repositório).
3. `npm test` do lançador continua verde (hoje: 3 suítes) e o teste de fumaça do painel
   (`node packages/harness-deck-vscode/test/smoke.mjs`) continua verde.
4. `tsc --noEmit` limpo nos pacotes tocados. **Atenção:** o `tsc` só existe em
   `packages/harness-deck-claude-code/node_modules/.bin/tsc`; `npm run typecheck` do lançador falha
   com `tsc: not found` — use o binário do outro pacote.
5. Relatório no fim dizendo, para cada requisito, **como foi verificado** — sem estimativa e sem
   "deve funcionar". Campo que não se sabe é **não localizado**.
6. Commits em inglês, Conventional Commits, um por caminho; nada de `git add .`; push na branch
   `chore/protocolo-contribuicao` (a `main` é PR-only).

## 5. Dependências e riscos

- **Dependência dura:** o ACP expõe `session/cancel`? Confirmar na versão instalada do
  `claude-agent-acp` (hoje `0.89.1`) antes de prometer o REQ-M4. Se não expuser, o REQ-M4 vira
  "matar e subir de novo" e isso tem de ser dito na tarefa, não escondido.
- **Risco 1:** o DSH é pré-lançamento (`0.2.0-rc.2`). Toda dependência de API interna dele fica
  isolada numa camada só — é regra do repositório.
- **Risco 2:** o painel hoje **não** escreve no registro nem materializa perfil. Se o REQ-P4 for
  resolvido fazendo o painel chamar o CLI, isso continua valendo; se for por código compartilhado,
  não duplicar a regra de parada em dois lugares.
- **Risco 3:** o dono tem um processo órfão vivo na porta 3131 na raiz real. A tarefa pode começar
  reproduzindo exatamente esse estado (é o caso de teste mais valioso) — mas **mexer em
  `~/.harnessdeck` e na instalação do DSH pede aval do dono**, conforme `AGENTS.md`.

## 6. Plano de teste mínimo (sugestão, não obrigação)

- `packages/harness-deck-launcher/test/stop.test.ts` — REQ-P1/P2/P3 contra um processo de mentira
  (um `node -e 'setInterval(()=>{},1e3)'` com pid file próprio).
- `packages/harness-deck-claude-code/test/inbox.test.ts` — REQ-M2/M3 sobre `SimpleInbox` e o laço.
- `packages/harness-deck-claude-code/test/turn-cancel.test.ts` — REQ-M4/M5 com agente ACP falso.
- `packages/harness-deck-vscode/test/smoke.mjs` — REQ-P4: o painel e o CLI resolvem parada pelo
  mesmo caminho.

## 7. Ligação com o que já está no plano

- O **B.4** de `docs/plano.md` já estava marcado como "aprovado e recusado, os dois observados
  rodando" — falta o tool call na trajetória. O REQ-M4 puxa a parte de abort do mesmo item.
- O **B.5** (retomada de sessão) é o que daria durabilidade à fila; aqui **não** entra.
- Este spec não muda o desenho do deck: continuam uma `DSH_HOME` por harness, sessões separadas por
  harness e workspaces registrados por harness (`harness-deck workspace ...`).
