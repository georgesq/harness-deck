# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 13:42 (America/Sao_Paulo)

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
- [x] **Item B.2 — completo: texto durável e streaming ao vivo.** Tradução `session/update` →
  `SessionEvent` em `packages/harness-deck-claude-code/src/index.ts`, com frames de
  `agent/assistant-stream`. Verificado rodando com provedor real (OpenRouter,
  `deepseek/deepseek-v4.1-flash`): turno completo em **2,8 s** e o texto saindo em **19 frames
  ao longo de ~160 ms**, todos **antes** do `assistant/message` durável. O `assistant/message`
  passou a carregar o `stream` compacto (antes ia `[]`), então quem recarrega a sessão reconstrói
  o mesmo texto que viu ao vivo. Reconferido depois da correção da resposta vazia, com um prompt
  de duas frases: **38 deltas em 43 frames, `turn/end completed` em 4,4 s**.
- **Como o streaming foi verificado:** o servidor SDK do DSH não repassa `agent/assistant-stream`,
  então o teste usa um plugin-sonda descartável (`.run/probe-stream`, fora do git) que escuta o
  evento **com `{ global: true }`, igual ao controlador de sessão da GUI**. Foi assim que se
  comprovou que os frames chegam a um ouvinte global, com `revision` e `index` densos (1..N, 0..N)
  e o frame final carregando `outcome=committed seq=<n>`.
- **Robustez do attempt:** todo caminho de falha publica o frame final antes de sair — sem isso a
  GUI ficaria com um stream aberto para sempre. Se o erro acontece depois de já ter saído texto, o
  turno fecha como `assistant/attempt` (o stream fica registrado, sem virar mensagem do modelo); se
  não saiu texto nenhum, o frame final sai como `abandoned`. **O `abandoned` ainda não foi
  observado rodando**: matar o subprocesso no meio do turno *não* passa por esse caminho (o cliente
  ACP resolve o prompt em vez de rejeitar — é o caso do turno vazio acima); ele exige que
  `nextUpdate()` rejeite, o que um provedor mal configurado não produz (medido: com o host morto o
  turno só pendura).
- **Turno vazio é falha.** Achado que só apareceu no teste em que o subprocesso é morto no meio do
  turno: o cliente ACP **resolve** o prompt pendente em vez de rejeitar, então o turno "concluía"
  com `assistant/message` de conteúdo vazio e `reason=completed` — resposta em branco com cara de
  sucesso. Corrigido: sem texto, o turno fecha como `assistant/attempt` +
  `turn/end reason=error code=EMPTY_RESPONSE` (o código que o motor padrão já usa para resposta
  vazia). Verificado matando o subprocesso aos 4 s de um turno que o provedor segurava por 60 s.
- [ ] **Item B.3** — teste na Web GUI do perfil isolado. O turno completo já está provado sem GUI;
  falta abrir a GUI e ver a resposta desenhada no chat.

## Defeitos reais encontrados e corrigidos nesta rodada

Cinco erros que só apareceram **rodando** o caminho ponta a ponta, nenhum deles visível por leitura:

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
5. **Turno vazio passava por sucesso.** Com o subprocesso morto no meio do turno, a ponte anexava
   `assistant/message` de conteúdo vazio e fechava o turno como `completed` — resposta em branco
   com cara de sucesso. Corrigido com `EMPTY_RESPONSE` (detalhe acima). Lição mais geral: **"fim de
   turno" devolvido pelo adaptador não significa que o turno deu certo**; quem traduz tem de
   conferir se veio conteúdo.

## Subagentes em segundo plano

_Nenhum em execução._ O endpoint Anthropic falso local (`.run-fake-anthropic.mjs`) já cumpriu o
papel: foi com ele que o turno do B.2 fechou sem depender de crédito — e agora ele também tem um
gancho de pausa (`FAKE_HOLD_MS`) para o teste de abandono descrito acima.

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
- **O endpoint morto não é um erro, é uma espera.** Apontando a ponte para um host que não
  responde, o `claude-agent-acp` não falha: ele fica retentando e o turno abre e nunca fecha. Isso é
  comportamento do Claude Code, não da ponte — mas significa que **timeout de provedor não é
  detectado** por nós. Anotado como item de B.4/B.5 (o cancelamento de verdade também está lá).
- **Pendência de ambiente (não do produto):** o script de teste usa um `DSH_HOME` dentro do
  repositório (`.run/dsh-home`, fora do git) porque o sandbox não deixa escrever em
  `~/.harnessdeck`.

**Resolvidos desde a última atualização** (as duas afirmações antigas estavam erradas): `tsc` **roda**
e passa limpo, e o `claude-agent-acp` **está instalado** (`0.89.1`) como dependência do plugin.

## Próxima decisão do dono

- Nenhuma pendente. O teste com provedor real passou pelo OpenRouter; a Avello pode ficar como
  está (a conta sem crédito não bloqueia mais nada).
