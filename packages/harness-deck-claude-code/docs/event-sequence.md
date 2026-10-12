# Sequência de eventos de um turno sem ferramenta (item 1.3.a)

> Lido direto de `@deepseek-ai/dsh-agent-loop/lib/index.js` (instalado em
> `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/`),
> versão `0.2.0-rc.2`, em 12/10/2026. Isso é leitura de implementação **privada** do pacote padrão,
> só para entender o contrato — este plugin não reusa nenhuma dessas classes, só replica a mesma
> sequência de `SessionEvent` que a Web GUI já sabe desenhar.

## Sequência mínima (pergunta simples, sem tool call), nessa ordem

1. `turn/start` — `{ turn }` (linha 943).
2. `step/start` — `{ turn, step }` (linha 968).
3. (opcional) `system/message` — só se o prompt de sistema mudou desde o turno anterior
   (linha 1056).
4. `user/message` — a mensagem do usuário, só na primeira tentativa do passo (linha 1061),
   `surfaceOp: "append"`.
5. **Streaming ao vivo, fora do log:** `agent/assistant-stream` é um evento de **dispatch**
   (`this.dispatch.emit`), não um `SessionEvent` — não entra no log, não persiste, é só o que a UI
   escuta para desenhar o texto chegando token a token durante a tentativa (linha 1067-1069). Cada
   chunk do stream do LLM dispara um frame (linha 1078).
6. `assistant/message` — anexado **uma vez**, no final do stream, com o conteúdo completo
   (`live.blocks()`), `surfaceOp: "append"` (linha 1144). Esse é o evento durável; o
   `agent/assistant-stream` de cima é só a prévia ao vivo.
7. `step/end` — `{ turn, step }` (linha 992, no `finally`).
8. `turn/end` — `{ turn, reason }` (linha 1027, no `finally` externo).

Se o passo falhar ou for abortado, aparece `assistant/attempt` em vez de `assistant/message`
(linhas 1101-1123) — não precisa ser replicado na primeira versão deste plugin (sem retomada ainda,
item 1.5).

## O que isso significa para este plugin

- **Streaming de verdade (item 1.3.d) depende de emitir `agent/assistant-stream` durante o
  consumo do stream do Claude Agent SDK**, não só anexar `assistant/message` no final. Sem isso, a
  resposta aparece de uma vez só quando o SDK termina — funciona, mas não é "streaming no chat".
- `turn/start` → `step/start` → `user/message` → (stream) → `assistant/message` → `step/end` →
  `turn/end` é o esqueleto mínimo. Tool call, revisão (`agent/request-error`), e retomada ficam
  para os itens 1.4 e 1.5.
- `Session.append` exige `surfaceOp` para todo `SurfaceEventType` (mensagens); `turn/start`,
  `step/start`, `step/end`, `turn/end` não são eventos de superfície e não aceitam `opts`
  (ver `dsh-session/lib/types/index.d.ts:217-246`).

## Frames de `agent/assistant-stream` (implementado e verificado em 12/10/2026)

Contrato lido da implementação do motor padrão (`AssistantStreamAttempt`, privada em
`dsh-agent-loop/lib/index.js:354`) e do consumidor real, o controlador de sessão da Web GUI
(`dsh-api-session-controller/lib/index.js:1249`):

| Frame | Campos | Observação |
|---|---|---|
| `start` | `attemptId`, `revision`, `turn`, `step` | abre a tentativa antes do primeiro chunk |
| `chunk` | `attemptId`, `revision`, `index`, `time`, `chunk` | `index` é **denso e zerado por tentativa**; `time` é o timestamp do chunk |
| `end` | `attemptId`, `revision`, `index`, `outcome` | `outcome` é `{kind:'committed', eventType, seq}` ou `{kind:'abandoned'}` |

Três regras que o consumidor impõe, e que o bridge segue:

1. **`revision` denso.** O acumulador da GUI compara com a revisão anterior e, se não for
   exatamente `anterior + 1`, **descarta a tentativa inteira** (`:1254`). Por isso o contador é
   único por ciclo de vida do agente e nunca reinicia entre turnos.
2. **`index` denso e alinhado ao `attemptId`.** Um chunk fora de ordem zera a tentativa (`:1275`).
3. **O `end` vem depois do evento durável.** `settle` só publica `end` com `outcome.committed`
   depois que o `append` devolveu o `seq` — assim a GUI nunca vê o stream fechar antes de o texto
   ser durável. Se o `append` falhar, ou o turno quebrar no meio, o frame final sai como
   `abandoned` — esse caso ainda **não foi observado rodando** (o que se observa é o turno
   "vazio" logo abaixo, que fecha em `assistant/attempt`).

Os chunks são a sequência canônica de blocos, porque o ACP só entrega texto solto:

```
block-start{index:0, blockType:'text'}
text-delta{index:0, text}            (um por pedaço que o ACP entrega)
block-end{index:0, block:{type:'text', text: <texto completo>}}
finish{reason:{kind:'stop'}}
```

O mesmo acumulador alimenta o campo `stream` do `assistant/message` durável — antes ele ia vazio
(`stream: []`), e quem recarregava a sessão perdia o texto. Agora recarrega e reconstrói igual.

Verificação (12/10/2026, provedor real via OpenRouter, `deepseek/deepseek-v4.1-flash`): 22 frames
em sequência, `revision` 1..22 e `index` 0..20 sem buraco, com 19 `text-delta` ao longo de ~160 ms
e o `end` carregando `outcome=committed seq=7` antes do `assistant/message`.

Como o servidor SDK do DSH não repassa esse evento, a prova usou um ouvinte com
`{ global: true }` — o mesmo caminho do controlador da GUI — num plugin descartável fora do git.

## Verificado rodando (12/10/2026)

O caminho real confirma a sequência acima. Ordem observada nas notificações `session.event` do
servidor SDK do DSH:

```
turn/start -> step/start -> user/message -> session/title -> assistant/message -> step/end
  -> turn/end(reason=completed)
```

Duas observações que só apareceram rodando:

- **`user/message` não vinha de ninguém.** O motor padrão anexa a mensagem do usuário quando
  consome a caixa de entrada (`dsh-agent-loop/lib/index.js:1061`); trocando o motor, ninguém mais
  fazia isso — a primeira execução real mostrou o `assistant/message` sem a pergunta acima dele. O
  bridge passou a anexar. Fica como lembrete: **todo evento de superfície que o motor padrão anexa
  precisa ser reanexado por quem o substitui.**
- **`session/title` aparece sozinho**, gerado pelo DSH a partir da primeira mensagem
  (`source: fallback`), sem o bridge fazer nada.

Medição: 2,6 s do prompt ao `turn/end` com um endpoint Anthropic falso local respondendo "pong"
(1,5 s até o `assistant/message`); 2,8 s com provedor real (OpenRouter).

## Não verificado ainda

- Como o componente de chat da Web GUI **desenha** o resultado do fold (li o acumulador, não o
  renderizador). O critério do B.3 é justamente abrir a GUI e ver.
- Blocos que não são texto (`tool-call`): o ACP manda `tool_call`/`tool_call_update`, e nada disso
  é traduzido ainda — é o item B.4.
- **Resposta vazia** (resolvido em 12/10/2026, mantido aqui como registro do comportamento do
  ACP): um turno sem nenhum texto acontece quando o subprocesso `claude-agent-acp` morre no meio —
  o cliente ACP **resolve** o prompt pendente em vez de rejeitar, e o turno chega como
  `stopReason` normal. O motor padrão trata isso como falha
  (`EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"`, retentável, em `dsh-llm`) e a ponte passou a fazer
  igual: `assistant/attempt` + `turn/end reason=error code=EMPTY_RESPONSE`, sem mensagem vazia.
  Confirmado matando o subprocesso aos 4 s de um turno que o provedor segurava por 60 s. Um
  provedor que *espera* (host morto) é o oposto: não gera evento nenhum, o turno só pendura.
