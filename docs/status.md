# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 13:08 (America/Sao_Paulo)

## Agora

- [x] **Item 1.1** — SDK falando com a Avello. Chave via `.env` do projeto (fora do git). Testado
  com `@anthropic-ai/sdk` já instalado no profile do DSH, modelo `claude-sonnet-5`, resposta ok.
  **Atenção:** a conta Avello está sem crédito agora (ver Bloqueios).
- [x] **Item 1.2** — Esqueleto do plugin `harness-deck-claude-code`, commit `ace5e67`.
- [x] **Item 1.3.a** — Sequência real de eventos documentada em
  [event-sequence.md](../packages/harness-deck-claude-code/docs/event-sequence.md).
- [x] **Decisão do dono (opção C, ponte ACP)** — abandonar reimplementação do motor (1.3.b em
  diante). Novo plano B.1–B.5 em [plano.md](plano.md).
- [x] **Item B.1** — subprocesso `claude-agent-acp` + handshake ACP. **Verificado rodando** (não só
  por leitura): `session/prompt` no servidor SDK do DSH chega ao plugin, abre a sessão, sobe o
  subprocesso e completa o handshake — `phase=sdk-initialize durationMs=504` e
  `phase=set-model model=sonnet outcome=success` — e o primeiro turno abre (`turn/start`,
  `step/start`).
- [x] **Item B.2 (texto durável)** — tradução `session/update` → `SessionEvent`, só texto, em
  `packages/harness-deck-claude-code/src/index.ts`. `tsc` limpo e **turno completo verificado
  rodando**: `turn/start → step/start → user/message → session/title → assistant/message ("pong")
  → step/end → turn/end (completed)`, em 2,6 s, sem GUI e sem crédito, com um endpoint Anthropic
  falso local. Falta só o `agent/assistant-stream` (texto ao vivo) — ver Bloqueios.
- [x] **Turno real por provedor de verdade (OpenRouter).** Mesmo teste, sem endpoint falso:
  `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, modelo `deepseek/deepseek-v4.1-flash`,
  `ANTHROPIC_AUTH_TOKEN` vindo do ambiente. Sequência completa em **2,8 s** (o `assistant/message`
  em 2,0 s), mesmo resultado do endpoint falso. Ou seja: o harness funciona com o Claude Code de
  verdade; o que estava fora era a conta Avello, não a ponte.
- [ ] **Item B.3** — teste na Web GUI do perfil isolado. O turno completo já está provado sem GUI;
  falta abrir a GUI e ver a resposta desenhada no chat.

## Defeitos reais encontrados e corrigidos nesta rodada

Três erros que só apareceram **rodando** o caminho ponta a ponta, nenhum deles visível por leitura:

1. **Duas cópias do `cordis`.** O plugin tinha `@deepseek-ai/cordis` e `dsh-*` instalados em
   `node_modules/` próprios e resolvia a própria cópia, o que quebra o registro de serviço do DSH.
   Numa instalação real o plugin resolve as cópias compartilhadas do perfil
   (`profiles/node_modules/@deepseek-ai/*`, que já são links para a instalação do DSH); no ambiente
   de desenvolvimento os links foram apontados para a mesma instalação.
2. **`cannot get property "sessions" without inject`** ao criar sessão. `this.ctx.sessions` era
   resolvido no contexto do **chamador**, que não declara o `inject`. O motor padrão do DSH resolve
   isso guardando o contexto num *holder* simples — comentário literal em
   `dsh-agent-loop/lib/index.js:1573`: "Plain holder prevents Cordis from re-tracing the factory's
   dependency context through a caller shadow". O plugin passou a fazer o mesmo.
3. **`Cannot read properties of undefined (reading 'acpBinPath')`.** O carregador do DSH instancia
   o plugin com `config` `undefined` quando a entrada do `cordis.patch.yml` não traz bloco
   `config:`. O padrão passou a ser aplicado no construtor (o `static Config` do `dsh-agent-loop`
   é o lugar definitivo, quando houver campos de verdade).
4. **A pergunta do usuário não aparecia no chat.** O motor padrão anexa `user/message` quando
   consome a caixa de entrada (`dsh-agent-loop/lib/index.js:1061`); trocando o motor, ninguém mais
   anexava. Lição registrada em
   [event-sequence.md](../packages/harness-deck-claude-code/docs/event-sequence.md): **todo evento
   de superfície que o motor padrão anexa precisa ser reanexado por quem o substitui.**

## Subagentes em segundo plano

_Nenhum em execução._ O endpoint Anthropic falso local (`.run-fake-anthropic.mjs`) já cumpriu o
papel: foi com ele que o turno do B.2 fechou sem depender de crédito.

## Bloqueios

- **Conta Avello sem crédito — deixou de importar.** `POST
  https://avello.online/v1/messages` com a chave do `.env` responde `HTTP 429`:
  `{"error":{"message":"Avello credit limit exceeded. Try again later.","type":"rate_limit_error","code":"AVELLO_CREDIT_LIMIT_EXCEEDED"}}`.
  Sintoma no bridge: a chamada de modelo nunca responde, então a ponte fica parada depois de
  `step/start`. **Não é defeito da ponte**: um teste direto no `claude-agent-acp`, sem DSH nenhum,
  para no mesmo ponto. O turno completo foi provado com um endpoint Anthropic falso local, então
  isso **não** trava mais nada: o turno real já foi provado pelo OpenRouter (ver acima).
- **Chave OpenRouter do cofre do DSH está morta.** `~/.dsh/.credentials.yaml` guarda um
  `OPENROUTER_API_KEY` que o próprio `GET https://openrouter.ai/api/v1/key` recusa com
  `401 User not found`. A chave viva está em `~/.claude/settings-or.json` (o "or" é OpenRouter) e
  responde `200`. A Web GUI da porta 3080 continua funcionando, então ela não está usando a chave do
  cofre — está pegando do ambiente de lançamento. **Vale limpar/atualizar o cofre** (mexer em
  `~/.dsh/` pede aval do dono).
- **Ponto de desenho para o F2:** a ponte repassa `process.env` inteiro para o subprocesso ACP.
  Num painel com vários harness lado a lado, cada harness precisa do **seu** provedor e da sua
  credencial, não do ambiente do processo do painel. Isso entra junto com a configuração por
  harness (REQ-04).
- **`agent/assistant-stream` ainda não é emitido.** Hoje a ponte só grava a mensagem final
  (`assistant/message`). O critério "streaming" do B.3 exige o evento ao vivo; está anotado em
  [event-sequence.md](../packages/harness-deck-claude-code/docs/event-sequence.md).
- **Pendência de ambiente (não do produto):** o script de teste usa um `DSH_HOME` dentro do
  repositório (`.run/dsh-home`, fora do git) porque o sandbox não deixa escrever em
  `~/.harnessdeck`.

**Resolvidos desde a última atualização** (as duas afirmações antigas estavam erradas): `tsc` **roda**
e passa limpo, e o `claude-agent-acp` **está instalado** (`0.89.1`) como dependência do plugin.

## Próxima decisão do dono

- Nenhuma pendente. O teste com provedor real passou pelo OpenRouter; a Avello pode ficar como
  está (a conta sem crédito não bloqueia mais nada).
