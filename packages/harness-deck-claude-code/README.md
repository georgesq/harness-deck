# harness-deck-claude-code

Plugin [cordis](https://www.npmjs.com/package/@deepseek-ai/cordis) que registra o **Claude Code**
(via [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)) como
motor de agente (`AgentFactory`) do [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh), no lugar
do motor padrão `@deepseek-ai/dsh-agent-loop`.

## Estado (itens B.1–B.3 do [plano](../../docs/plano.md))

**Funciona**: uma sessão criada com este plugin no lugar do `agent-loop` sobe o
`claude-agent-acp` como subprocesso, faz o handshake ACP, manda o prompt do usuário e traduz a
resposta de texto de volta para o log de sessão do DSH.

Sequência verificada rodando o servidor SDK do DSH (`session/prompt` → notificações
`session.event`), em 12/10/2026:

```
turn/start {"turn":1}
step/start {"turn":1,"step":1}
user/message {"content":[{"type":"text","text":"..."}], ...}
assistant/message {"turn":1,"step":1,"message":{... "text":"pong" ...}, "stream":[...]}
step/end {"turn":1,"step":1}
turn/end {"turn":1,"reason":{"kind":"completed"}}
```

**Texto ao vivo (streaming)**: além do `assistant/message` durável, a tentativa publica
`agent/assistant-stream` — evento de *dispatch*, não de log — com os frames `start` / `chunk` /
`end` que a Web GUI usa para desenhar o texto enquanto ele chega. Verificado com provedor real
(OpenRouter): 22 frames densos em `revision` e `index`, 19 deltas de texto ao longo de ~160 ms,
antes do `assistant/message`. O `assistant/message` carrega o mesmo stream no campo `stream`, então
recarregar a sessão reconstrói o texto idêntico. Contrato e regras em
[event-sequence.md](docs/event-sequence.md).

**Turno vazio é falha, não sucesso**: se o `claude-agent-acp` morre no meio do turno, o cliente ACP
*resolve* o prompt pendente em vez de rejeitar. Sem tratamento isso virava um `assistant/message`
vazio com `turn/end reason=completed` — resposta em branco com cara de sucesso. Agora o turno fecha
com `assistant/attempt` (o stream sem mensagem) e `turn/end reason=error`, código
`EMPTY_RESPONSE` — o mesmo que o motor padrão usa para resposta vazia.

**Escopo do agente (o que a Web GUI exigiu)**: o `ClaudeCodeAgent` minta o **próprio escopo**
(`@deepseek-ai/dsh-scope`'s `createScope`) dentro do construtor, com **ele mesmo como chave**, sob o
contexto do plugin, dentro de um `ownerCtx.effect(...)` que amarra a vida do escopo à do dono —
mesma ordem do `dsh-agent-loop` (`lib/index.js:778` e `:1714`). Duas armadilhas, as duas só
aparecem com sessão de verdade na GUI:

- `ownerCtx.extend()` copia a cadeia de contexto mas **não** a marca de escopo; sem marca o
  `agent-preset-registry` recusa ligar o preset (`dsh-agent-preset-registry/lib/index.js:663`,
  `Agent preset binding requires a scoped context`) e a **criação** da sessão falha.
- A chave do escopo tem de ser o próprio agente: o upload de arquivo confere
  `scopeOf(agent.ctx) === agent` (`dsh-client-file-upload/lib/index.js:297`) e, com chave
  arbitrária, o **primeiro prompt** é recusado com um rótulo que não nomeia a causa
  (`prompt rejected (session/agent-busy)`).

Verificado também na Web GUI do perfil isolado, com **navegador sem cabeça** (Playwright) dirigindo
a página de verdade em 12/10/2026: o chat foi criado, o prompt aceito e a resposta apareceu
**crescendo na tela** — numa pergunta "números de 1 a 30 separados por vírgula", o DOM mostrava 5
números aos 9,2 s, 10 aos 9,6 s, 13 aos 10,0 s, 26 aos 10,4 s e 30 aos 10,8 s (amostras de 400 ms),
com `turn/end reason=completed`.

**Ainda não feito**:

- **B.4** aprovação de ferramenta e **B.5** retomada de sessão (`resume` ainda lança
  `Error("not implemented yet — item B.5")`, de propósito).

## Como se encaixa no plano

O DSH permite só **um** `AgentFactory` registrado por processo
(`AgentRegistry.setFactory` lança erro se já houver um — ver
`@deepseek-ai/dsh-agent/lib/types/index.d.ts`). O motor padrão (`@deepseek-ai/dsh-agent-loop`) se
registra sozinho no construtor da sua classe de plugin, chamando
`ctx.agents.setFactory(this)` dentro de um `ctx.effect(...)`. Este pacote segue o mesmo padrão de
registro (não a lógica interna do loop padrão): um plugin que, instalado num perfil do DSH no lugar
do `agent-loop`, assume esse papel para sessões do Claude Code.

O motor é uma **ponte ACP** (decisão do dono em 12/10/2026, opção C): o adapter
`@agentclientprotocol/claude-agent-acp` faz o trabalho difícil; o plugin só traduz `session/update`
do ACP para `SessionEvent` do DSH e vice-versa. Nada de reimplementar o laço do modelo.

Ver [docs/analise-inicial.md](../../docs/analise-inicial.md) e [docs/plano.md](../../docs/plano.md)
(fase F1) para o desenho completo, e
[docs/event-sequence.md](docs/event-sequence.md) para a sequência de eventos que este plugin
reproduz.

## Estrutura

```
package.json       # nome "harness-deck-claude-code" (sem "dsh" no nome, por regra do AGENTS.md
                    # do projeto — plugin específico de harness pode ter o nome do harness)
tsconfig.json       # compila src/ para lib/
src/index.ts        # ClaudeCodeAgentLoop (plugin cordis / AgentFactory) + a fachada ClaudeCodeAgent
docs/event-sequence.md
```

## Dependências e por que peer + dev

`@deepseek-ai/cordis`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`,
`@deepseek-ai/dsh-llm` e `@deepseek-ai/dsh-scope` estão declaradas como **peerDependencies** (mesmas
versões da instalação do DSH: `cordis@~4.0.4` e `0.2.0-rc.2`). Isso é intencional: este plugin roda
**dentro** do processo do DSH, que já traz a própria cópia dessas bibliotecas; **trazer uma cópia
própria quebra o plugin** — foi um defeito real observado em 12/10/2026, com o sintoma `cannot get
property "sessions" without inject` ao criar a sessão, porque o registro de serviço do `cordis` não
enxergava a classe vinda de outra instância da biblioteca.

As mesmas entradas aparecem em **devDependencies** só para o ambiente de desenvolvimento ter os
tipos ao compilar. Nesse ambiente, os pacotes `@deepseek-ai/*` de
`packages/harness-deck-claude-code/node_modules/` devem ser **links** para a instalação do DSH
(`/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`), como já são os de
`~/.dsh/profiles/node_modules/@deepseek-ai/`. Numa instalação real isso é automático: o plugin mora
em `profiles/<perfil>/node_modules/` e resolve as cópias compartilhadas do perfil.

## Como compilar e testar

```bash
cd packages/harness-deck-claude-code
npm run build     # tsc -p tsconfig.json
```

Para exercitar de ponta a ponta sem depender de provedor, suba um endpoint Anthropic falso local,
aponte o subprocesso para ele e rode o smoke do servidor SDK do DSH:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_AUTH_TOKEN=test ANTHROPIC_API_KEY=test \
ANTHROPIC_MODEL=claude-sonnet-5 ANTHROPIC_SMALL_FAST_MODEL=claude-haiku-4.5 \
CLAUDE_CONFIG_DIR=<dir com settings.json vazio> \
DSH_HOME=<home isolado do DSH> node .run-sdk-smoke.mjs
```

`CLAUDE_CONFIG_DIR` importa: sem ele o `~/.claude/settings.json` do usuário sobrescreve a
`ANTHROPIC_BASE_URL` e o teste fala com o provedor real.
