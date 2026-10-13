# Spec de feature — parar de verdade, enviar sem esperar, não deixar órfão

Três defeitos que impediram o dono de usar o deck no VS Code. Um turno de implementação.

**Status:** contrato da implementação — em execução nesta sessão
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

O dono estava usando o deck no VS Code e parou por três motivos, todos reproduzidos abaixo com
evidência. Esta spec é o **contrato da tarefa**: os requisitos numerados são o que a implementação
tem de cumprir e cada um traz a verificação ao lado.

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

## 4. Problema 3 — fechar o painel/VS Code deixa harness rodando em segundo plano

### 4.1 Sintoma do dono
*"se fechar o extension não derruba tudo, precisamos ver essa funcionalidade, para não ficar algo
rodando em BG"*. O dono fechou tudo e **a porta 3131 continuou respondendo**.

### 4.2 Evidência (13/10/2026, depois de o dono fechar o VS Code)

```
$ ss -ltnp | grep 3131
LISTEN 127.0.0.1:3131          # VS Code fechado, servidor no ar
$ cat ~/.harnessdeck/.run/claude/dsh.pid
394127                          # processo morto: o pid file mente
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3131/
401                             # e continua respondendo
```

O dono rodou `kill` no processo que achou e **a porta continuou no ar**; `lsof -i :3131` e
`fuser -n tcp 3131` não devolvem nada, e o socket (`/proc/net/tcp`, inode `2016498`, uid 1000) não
aparece no `/proc` de nenhum processo visível. Ou seja: há um servidor respondendo cuja posse o deck
não consegue provar — exatamente o caso que o REQ-L4 tem de resolver (a porta é a verdade, e o deck
precisa de um caminho confiável para achar o dono dela).

### 4.3 Causa

- `packages/harness-deck-vscode/src/extension.ts` (função `deactivate`) só para **o que esta janela
  subiu** (`processes?.stopAll()`), e só quando `harnessDeck.stopOnExit` está ligado. Harness subido
  pelo terminal/CLI, ou subido por uma janela anterior, **não** é derrubado.
- Quando a janela do VS Code é recarregada ou fechada, o extension host é recriado/terminado e o
  `Map` de processos vivos se perde: o painel **deixa de saber** o que subiu. O processo continua
  vivo, reparentado, e o pid file fica apontando para um pid que já morreu.
- `deactivate` é assíncrono e o VS Code **não espera** indefinidamente por ele. Um `stopAll` que
  espera 8 s por harness pode ser cortado no meio, deixando o processo vivo.
- Bônus verificado no DSH: ele **trata SIGTERM** e sai com código 0
  (`/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/profile-boot-BZ2ZjNWi.js:249-251`, via
  `createProcessShutdown`). Então o sinal certo resolve — o que não resolve é **não saber para quem
  mandar o sinal**.

### 4.4 Segundo achado — o pid file estava certo e a checagem de vida mentiu

Depois de o dono rodar `kill`, o `ss -ltnp` dele mostrou:

```
LISTEN 0 511 127.0.0.1:3131 0.0.0.0:* users:(("MainThread",pid=394127,fd=21))
```

- O pid **394127 é o dono real da porta** — o mesmo que está no pid file. Ou seja: o deck tinha a
  informação certa e concluiu que o processo estava morto.
- O nome do thread é `MainThread`, assinatura de runtime embutido — não de um `node` comum. O deck
  não pode assumir que o processo que ele subiu é o processo que fica com a porta.
- `processAlive(pid)` (`process.kill(pid, 0)`) devolveu falso negativo nesse ambiente, e o
  `stopHarness` (`launcher.ts:274-277`) então **removeu o pid file e devolveu "nada para parar"**,
  deixando o servidor no ar e o deck sem o endereço do dono. O mesmo vale para o `inspect`, que
  passou a mostrar `parado` com a porta ocupada.

### 4.5 Requisitos

| ID | Requisito | Verificação |
|---|---|---|
| **REQ-L1** | Ao fechar a janela do VS Code (ou desativar a extensão), **nenhum** harness subido por aquele painel pode continuar no ar — nem o processo do harness, nem os filhos que ele criou (o CLI do Claude Code, subprocessos de ferramenta, workers). | Teste automatizado que sobe um harness pelo painel, chama o `deactivate` e prova porta fechada, pid inexistente e **nenhum filho sobrevivente**. |
| **REQ-L2** | O encerramento não pode depender de espera longa: primeiro sinal, checagem rápida, e **SIGKILL como rede** — tudo dentro do orçamento que o VS Code dá ao `deactivate`. | Teste com processo que ignora SIGTERM: mesmo assim a porta tem de fechar. |
| **REQ-L3** | Se o painel **não** consegue garantir a parada, ele tem de dizer isso ao dono ao subir: aviso explícito de que aquele harness vai sobreviver ao fechamento da janela (e onde está o log). Nada de silêncio. | Teste manual com print + asserção do texto. |
| **REQ-L4** | O deck **descobre o dono real da porta** quando o pid file está morto ou ausente, em vez de desistir: a porta é a verdade. Técnicas disponíveis na máquina do dono: `lsof -t -i :<porta>`, `fuser -n tcp <porta>`, e o mapeamento socket→pid em `/proc/net/tcp`. | Teste com pid file morto e listener vivo: a parada tem de funcionar. |
| **REQ-L5** | Depois de qualquer parada, o pid file **não pode mentir**: se o processo morreu, o arquivo sai; se sobreviveu, o arquivo fica e a mensagem diz o motivo. | Asserção sobre o arquivo nos testes de parada. |
| **REQ-L6** | `harnessDeck.stopOnExit` continua existindo, mas o padrão e o texto da configuração têm de ser honestos: "parar o que esta janela subiu ao fechar" — e o que ele **não** cobre (subido por fora) tem de estar dito na descrição da configuração. | Revisão do `package.json` da extensão + teste manual. |
| **REQ-L7** | A vida do harness **não** pode ser decidida só por `kill(pid, 0)`: o veredito é a porta. O processo só conta como morto quando a porta está fechada **e** o pid não responde; e o deck tem de ter caminho alternativo para achar o dono quando o `kill(pid, 0)` der falso negativo (foi o que aconteceu: pid file certo, `processAlive` falso, servidor no ar). | Teste em que `processAlive` devolve falso e a porta continua ocupada: o deck tem de continuar reportando "no ar" e conseguir parar. |
| **REQ-L8** | Parar mata a **árvore**: o processo do harness e os filhos (CLI do Claude Code, subprocessos de ferramenta). Nada de neto sobrevivendo porque o pai morreu. | Teste com processo pai que gera um filho: depois do stop, nenhum dos dois existe. |

### 4.6 Fora de escopo
Daemon/serviço gerenciado pelo sistema operacional, subir harness que sobrevive de propósito e
reconectar na próxima janela (é outra feature; se o dono quiser, vira item próprio).

---

## 5. Critérios de aceite (o que fecha a tarefa)

1. Teste automatizado prova REQ-P1/P2/P3: subir um harness pelo CLI, chamar o stop pelo painel,
   provar **porta fechada + pid inexistente**; e o caso "pid file morto com porta viva" falhando com
   mensagem que nomeia porta e pid file.
2. Teste automatizado prova REQ-M1/M2/M3/M4 com um agente ACP falso controlado pelo teste (mesma
   técnica já usada em `.run-fake-anthropic.mjs` no repositório).
3. Teste automatizado prova REQ-L1/L2/L4/L5/L7/L8: subir pelo painel, chamar o `deactivate`, provar
   **porta fechada e pid inexistente** — inclusive no caso em que o processo ignora SIGTERM, no
   caso em que o pid file aponta para um processo morto, no caso em que `processAlive` dá falso
   negativo com a porta ocupada, e no caso de processo com filho.
4. `npm test` do lançador continua verde (hoje: 3 suítes) e o teste de fumaça do painel
   (`node packages/harness-deck-vscode/test/smoke.mjs`) continua verde.
5. `tsc --noEmit` limpo nos pacotes tocados. **Atenção:** o `tsc` só existe em
   `packages/harness-deck-claude-code/node_modules/.bin/tsc`; `npm run typecheck` do lançador falha
   com `tsc: not found` — use o binário do outro pacote.
6. Relatório no fim dizendo, para cada requisito, **como foi verificado** — sem estimativa e sem
   "deve funcionar". Campo que não se sabe é **não localizado**.
7. Commits em inglês, Conventional Commits, um por caminho; nada de `git add .`; push na branch
   `chore/protocolo-contribuicao` (a `main` é PR-only).

## 6. Dependências e riscos

- **Dependência do REQ-M4: resolvida, `session/cancel` existe.** Verificado em 13/10/2026 no
  instalado, não em suposição:
  - o CLI trata a notificação: `@agentclientprotocol/claude-agent-acp@0.89.1`,
    `dist/acp-agent.js:74` (`session/cancel`) e `:3261`;
  - o SDK do cliente expõe `cancel(params): Promise<void>` e documenta o comportamento esperado
    (parar pedidos ao modelo, abortar tool calls, responder ao `session/prompt` original com
    `StopReason::Cancelled`): `@agentclientprotocol/sdk`, `dist/acp.d.ts:1205-1222`;
  - o CLI instalado tem ainda `session/steering` (`dist/acp-agent.js`), que pode ser a via para o
    REQ-M2/REQ-M3b — **a confirmar na implementação**, não dado como certo.
  - Atenção: abortar o `cancellationSignal` do `prompt()` manda `$/cancel_request` (cancelamento de
    request JSON-RPC), **não** o `session/cancel`. Para o REQ-M4 o que vale é a notificação
    `session/cancel`; o bridge precisa guardar a sessão ACP viva para poder mandá-la.
- **Risco 1:** o DSH é pré-lançamento (`0.2.0-rc.2`). Toda dependência de API interna dele fica
  isolada numa camada só — é regra do repositório.
- **Risco 2:** o painel hoje **não** escreve no registro nem materializa perfil. Se o REQ-P4 for
  resolvido fazendo o painel chamar o CLI, isso continua valendo; se for por código compartilhado,
  não duplicar a regra de parada em dois lugares.
- **Risco 3:** o dono tem um processo órfão vivo na porta 3131 na raiz real. A tarefa pode começar
  reproduzindo exatamente esse estado (é o caso de teste mais valioso) — mas **mexer em
  `~/.harnessdeck` e na instalação do DSH pede aval do dono**, conforme `AGENTS.md`.

## 7. Plano de teste mínimo (sugestão, não obrigação)

- `packages/harness-deck-launcher/test/stop.test.ts` — REQ-P1/P2/P3 contra um processo de mentira
  (um `node -e 'setInterval(()=>{},1e3)'` com pid file próprio).
- `packages/harness-deck-claude-code/test/inbox.test.ts` — REQ-M2/M3 sobre `SimpleInbox` e o laço.
- `packages/harness-deck-claude-code/test/turn-cancel.test.ts` — REQ-M4/M5 com agente ACP falso.
- `packages/harness-deck-vscode/test/smoke.mjs` — REQ-P4: o painel e o CLI resolvem parada pelo
  mesmo caminho.
- `packages/harness-deck-vscode/test/lifecycle.test.ts` — REQ-L1/L2/L4/L5/L7/L8: sobe processo de
  mentira com pid file, chama o encerramento e prova porta fechada; repete com processo que ignora
  SIGTERM, com pid file apontando para processo morto, com `processAlive` mentindo e com árvore de
  dois processos.

## 8. Ligação com o que já está no plano

- O **B.4** de `docs/plano.md` já estava marcado como "aprovado e recusado, os dois observados
  rodando" — falta o tool call na trajetória. O REQ-M4 puxa a parte de abort do mesmo item.
- O **B.5** (retomada de sessão) é o que daria durabilidade à fila; aqui **não** entra.
- Este spec não muda o desenho do deck: continuam uma `DSH_HOME` por harness, sessões separadas por
  harness e workspaces registrados por harness (`harness-deck workspace ...`).

---

## 9. Estado da execução (13/10/2026, sessão do mestre)

O dono revogou o registro no Paperclip ("acho que é furada colocar pele PPC, por que ele vai
chamar o HD que é justamente onde estamos ajustando") e autorizou modo yolo: a spec passou a ser o
**contrato da implementação**, executada nesta sessão. Problemas 1 e 3 estão fechados; o problema 2
segue na ponte.

### 9.1 O que foi entregue

| Requisito | Onde | Como foi verificado |
| --- | --- | --- |
| REQ-P1 | `packages/harness-deck-launcher/src/process.ts` (`stopProcess`) | `test/stop.test.ts` caso 1: porta fecha, processo morre, pid file sai |
| REQ-P2 | idem | `test/stop.test.ts` caso 6 e `test/lifecycle.test.mjs` caso 6: no-op honesto, `stopped: false` |
| REQ-P3 | `stopProcess` (a porta decide) | `test/stop.test.ts` caso 2 e `test/lifecycle.test.mjs` caso 5: pid file morto + porta viva ⇒ dono descoberto |
| REQ-L1 | `processes.ts` (`stop`, `stopAll`) + `extension.ts` (`deactivate`) | `test/lifecycle.test.mjs` caso 1: pai e filho mortos, porta fechada |
| REQ-L2 | `waitForStopped` + `DEACTIVATE_BUDGET_MS` | `test/stop.test.ts` caso 4 (SIGTERM ignorado ⇒ SIGKILL); `test/lifecycle.test.mjs` caso 4 |
| REQ-L3 | `deactivate` avisa os sobreviventes | `extension.ts:369-380` — aviso com a lista; sem teste automatizado (depende do host do VS Code) |
| REQ-L4 | `findPortOwner` (`lsof -t -sTCP:LISTEN` → `fuser -n tcp`) | `test/stop.test.ts` caso 8; `test/lifecycle.test.mjs` caso 3 |
| REQ-L5 | `removePidFile` best-effort | `test/stop.test.ts` caso 7 (diretório somente leitura) |
| REQ-L7 | `portListening` no veredito, não `kill(pid, 0)` | todos os casos acima: o veredito é `!processAlive && !portListening` |
| REQ-L8 | `killTree` (grupo do processo, `-pid`) | `test/stop.test.ts` caso 5 e `test/lifecycle.test.mjs` caso 1 |

Um módulo só resolve a parada dos dois front ends: `packages/harness-deck-launcher/src/process.ts` é
a cópia canônica e `packages/harness-deck-vscode/src/shared/process.ts` é copiada dele por
`scripts/sync-shared.mjs` (rodado pelo `build` dos dois pacotes). `test/shared-copy.test.ts` falha
quando as duas divergem — é o que impede o CLI e o painel de discordarem sobre o que é "parado".

### 9.2 Achado novo — a raiz do deck está em sistema de arquivos somente leitura

`findmnt -T ~/.harnessdeck/.run` devolve `ext4 ro,nosuid,nodev` (`/dev/sdd` montado em `/`), e
`touch ~/.harnessdeck/.run/claude/teste-w` falha com `Read-only file system`. Consequência prática:
o `down` **para** o harness (porta fecha, processo morre), mas não consegue apagar o pid file, e os
dois pids velhos (`claude` 394127, `dsh` 707115) ficam no disco. Antes desta correção esse EROFS
derrubava o comando inteiro com `erro: EROFS`; agora é aviso.

O contorno **não** é remount da raiz: o dono recusou com razão ("permissao de R/W para raiz, não
pode, isso é contra segurança"). A raiz do deck é configurável — `HARNESS_DECK_HOME` no CLI e
`harnessDeck.home` na extensão (`resolveHome`, `registry.ts:206`) — então a saída é apontar a raiz
para um diretório gravável. Neste ambiente só há dois pontos graváveis fora de `/tmp`: o próprio
projeto (bind mount `rw`) e `/dev/shm`. Como `/tmp` não sobrevive entre sessões, o caminho natural é
uma pasta ignorada pelo git dentro do projeto.

O produto passou a **provar a escrita antes de subir qualquer coisa**: `assertWritableDir` faz um
probe no diretório e, quando falha, diz o caminho e as duas formas de contornar. Antes, o dono via:

```
erro: EROFS: read-only file system, unlink
      '/home/georgesq/.harnessdeck/homes/claude/profiles/claude/node_modules/harness-deck-claude-code'
```

Agora vê:

```
erro: a raiz do deck não aceita escrita (/home/georgesq/.harnessdeck): EROFS.
      Aponte a raiz para um diretório gravável com `HARNESS_DECK_HOME=/caminho/gravável`
      no CLI ou com a configuração `harnessDeck.home` na extensão.
```

### 9.3 Ciclo completo provado com a raiz gravável

Com `HARNESS_DECK_HOME` apontando para uma pasta gravável dentro do projeto, o ciclo inteiro rodou
com o harness real (não o de mentira) em 13/10/2026:

```
$ harness-deck up claude
claude: subindo na porta 3131 (pid 40)
claude: pronto em http://127.0.0.1:3131

$ ss -ltn | grep 3131
LISTEN 0  511  127.0.0.1:3131  0.0.0.0:*

$ harness-deck down claude
claude: parado (SIGTERM)

$ ss -ltn | grep 3131      # nada
$ ls .run/claude/dsh.pid   # No such file or directory
```

Esse é o REQ-P1 fechado de ponta a ponta, com o binário real do DSH.

### 9.3 Provas colhidas no ambiente real

```
$ node --experimental-strip-types --no-warnings src/cli.ts list
claude           claude-code  porta 3131   parado   pid 394127
dsh              dsh          porta 3130   parado   pid 707115

$ /usr/bin/ss -ltnp | grep 3131      # nada: a porta que ficou presa em 13/10 está fechada
```

O `list` acima já é o código novo: antes ele diria "no ar" para um pid morto com a porta respondendo.
A porta 3131 que motivou o problema 1 não responde mais, e o `down` agora nomeia o dono quando o pid
file não explica a porta.
