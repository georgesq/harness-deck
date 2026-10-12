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
(1,5 s até o `assistant/message`).

## Não verificado ainda

- Como `agent/assistant-stream` chega exatamente ao componente de chat da Web GUI (não li o
  código do front-end ainda — fora do escopo de 1.3.a).
- Formato exato de `createAssistantMessage` e dos "blocks" de conteúdo (texto vs. tool-call) —
  necessário para o item 1.3.c, não investigado aqui.
