# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 16:32 (America/Sao_Paulo)

## Agora

- [x] **Autorizações do dono em 12/10/2026:** (1) escrever a raiz de dados real em
  `~/.harnessdeck`; (2) entrar no item 2.4 (painel do VS Code).
- [x] **Raiz real em uso.** O registro saiu do diretório de teste e vive em
  `/home/georgesq/.harnessdeck/harnesses.json` com dois harnesses: `dsh` (motor padrão, porta 3130) e
  `claude` (ponte ACP, porta 3131). **Verificado rodando, na raiz real:** os dois subiram com
  `harness-deck up`, responderam `HTTP 401` na porta (servidor no ar, autenticação exigida) e pararam
  com SIGTERM. Cada um com o seu `DSH_HOME` (`homes/dsh`, `homes/claude`).
- [x] **Ordem de argumentos do DSH (defeito de produto corrigido).** O comando certo é
  `dsh --profile <nome> --port <n> --no-open`: o lançador do DSH para de ler no primeiro token que
  não reconhece e repassa o resto ao app. Com `web` no meio (`dsh web --profile <nome>`) o próprio app
  recusa com `select a profile only once`, e o processo morria sem escrever nada no log — o harness
  aparecia como "subindo" para sempre. O log do launcher passou a registrar a linha de comando, que é
  o que tornou o defeito visível.
- [x] **Item 2.4: painel do VS Code instalado.** `packages/harness-deck-vscode` (implementação própria,
  não fork) abre **uma aba por harness** na mesma janela. Empacotado em `.vsix` por
  `node build-package.mjs` (o `.vsix` é um zip com as entradas sob `extension/`, então não precisa de
  ferramenta de terceiro) e **instalado no VS Code do dono** como `georgesq.harness-deck-vscode@0.1.0`;
  a aba **Harness Deck** apareceu na barra após recarregar a janela. Teste sem VS Code:
  `node test/smoke.mjs`; teste do lançador: `npm test` (duas suítes).
- [x] **Workspace por harness (defeito de uso corrigido).** O dono não conseguia apontar uma pasta
  nova para o harness que queria: a GUI só registra pasta no harness da porta aberta, e uma
  `DSH_HOME` por harness (REQ-02) faz cada harness ter a sua lista. Entrou
  `harness-deck workspace list|add|remove <pasta> [--harness <nome>]... [--title <titulo>]` —
  sem `--harness`, vale para todos. Grava a unidade `storages/workspace.json` do DSH_HOME alvo, na
  forma que `@deepseek-ai/dsh-workspace` lê (versão 2), com caminho canonicalizado por `realpath` para
  não duplicar a mesma pasta escrita de dois jeitos. **Cuidado documentado:** com o harness no ar a
  lista vive em memória e a gravação seria perdida no próximo clique da GUI — o comando avisa e pede
  parar/subir. Verificado com 8 verificações (`test/workspaces.test.ts`) e uma raiz de teste em
  `.run/deck-ws`; a gravação na raiz real `~/.harnessdeck` ficou bloqueada pela política de arquivo
  desta sessão e precisa de um comando do dono (ver Bloqueios).
- [x] **Credenciais concentradas em `<raiz>/.env`** (decisão do dono). CLI e painel leem o arquivo e
  entregam as variáveis ao harness; `~/.bashrc` não é mais caminho de chave. Ver seção abaixo.
- [x] **Protocolo de contribuição** (decisão do dono em 12/10/2026: o repositório é aberto e a
  `main` é fechada para escrita direta, inclusive do mantenedor). [CONTRIBUTING.md](../CONTRIBUTING.md),
  [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) e os modelos de issue e de pull request em `.github/`.
  Ver seção abaixo.
- [ ] **Rotacionar a chave do OpenRouter** — ela foi impressa em texto puro no transcript desta
  sessão. Colar a chave nova em `~/.harnessdeck/.env` (arquivo já criado, modo `600`, campo vazio).

## Como o dono escolhe harness e provedor/modelo (decidido em 12/10/2026)

**Caminho A, sem duplicar UI.** A escolha de **harness** é no registro (lista lateral do painel, um
item por harness). A escolha de **provedor/modelo** é no **seletor nativo do DSH, dentro do painel de
cada harness** — o painel do VS Code não tem seletor próprio, para não manter duas verdades.

Onde cada coisa vive:

| O quê | Onde | Quem escreve |
|---|---|---|
| Quais harnesses existem, porta, motor, provedor/modelo **inicial** | `<raiz>/harnesses.json` | CLI (`harness-deck add`) |
| Provedor/modelo **em uso** | `<DSH_HOME>/profiles/<nome>/cordis.patch.yml`, linha `agent-default-model` | o próprio DSH, quando o dono troca no seletor da GUI |
| Rota do provedor (URL base, `apiKeyEnv`, lista de modelos) | a linha `llm-pi-ai` do mesmo arquivo | CLI, a partir do registro |

Verificado no código: `AgentDefaultModelConfig.saveSelection` grava via o serviço `configEditor`
(`dsh-agent-default-model/lib/index.js:53-66`), e o `configEditor` reescreve **a linha** do patch com
`writeFileAtomic`, preservando comentários e as demais linhas
(`dsh-config-editor/lib/index.js:88-130`). Ou seja: o modelo escolhido é durável e **é por harness**,
porque cada harness tem o seu `DSH_HOME`.

**Defeito de produto corrigido no caminho:** o lançador regerava o `cordis.patch.yml` inteiro a cada
`up`, o que **desfazia silenciosamente** a escolha do dono, voltando ao default do registro. Agora as
linhas `agent-default-model` e `llm-pi-ai` pertencem ao harness que já rodou: o registro só as semeia
na primeira materialização e atualiza o resto. Coberto por `packages/harness-deck-launcher/test/merge-patch.test.ts`
(9 verificações, incluindo idempotência) e conferido na raiz real: troquei o modelo no perfil do
`claude`, subi com `up` e a escolha sobreviveu.

## Credenciais: `<raiz>/.env` é a única fonte (decidido em 12/10/2026)

**Problema:** nem o VS Code nem o processo que sobe o DSH herdam um shell interativo. Chave
exportada em `~/.bashrc` **não chega a ninguém**: o harness sobe e o modelo falha (observado no
`claude`, aviso do lançador).

**Decisão do dono:** as chaves de provedor ficam **só** em `<raiz do harness-deck>/.env`
(`~/.harnessdeck/.env`, modo `600`, fora do git). O CLI e o painel do VS Code leem esse arquivo e
entregam as variáveis ao processo do harness.

Implementado:

- `packages/harness-deck-launcher/src/registry.ts`: `ENV_FILE`, `envFilePath()`, `loadEnvFile()` e
  `parseEnvFile()` (formato shell: `KEY=valor`, aceita `export`, aspas e `#`; arquivo ausente é
  vazio, não erro).
- `packages/harness-deck-launcher/src/launcher.ts`: o `spawn` monta o ambiente como
  `.env` → `process.env` → variáveis do provedor → `options.env`. **O ambiente real tem
  precedência**, então um `KEY=… harness-deck up` avulso continua funcionando.
- `packages/harness-deck-launcher/src/cli.ts`: o aviso de credencial agora diz se falta no ambiente
  **e** no `.env`.
- `packages/harness-deck-vscode/src/registry.ts` e `src/processes.ts` e `src/extension.ts`: o painel
  lê o mesmo `.env` na ativação, registra no canal de saída **quais** variáveis carregou (nunca os
  valores) e repassa ao `spawn`.

**Verificado, três níveis:**

1. Deck de teste (`.run/deck-env`, porta 3199) com um `.env` contendo `OPENROUTER_API_KEY` entre
   aspas, `export DEEPSEEK_API_KEY` e uma linha malformada: o `up` subiu o harness e o
   `/proc/<pid>/environ` do filho mostrou as duas variáveis preenchidas e a malformada ignorada.
2. Raiz real: com a chave no `.env`, o `/proc/<pid>/environ` do `claude` traz `OPENROUTER_API_KEY`
   **e** `ANTHROPIC_AUTH_TOKEN` (a ponte ACP recebe a mesma chave), e `https://openrouter.ai/api/v1/key`
   responde `HTTP 200` para ela.
3. **Ponta a ponta, na GUI:** sessão aberta em `harness-deck` na porta 3131, mensagem enviada pelo
   chat com o modelo `openrouter/anthropic/claude-sonnet-4.5` — **`Completed in 3s`, resposta `ok`**.
   O caminho chave → rota → modelo está fechado.

**Pendência do dono:** a chave do OpenRouter foi impressa em texto puro no transcript desta sessão;
deve ser **rotacionada** (a que está no `.env` é a mesma, já validada).

## Repositório aberto, `main` fechada (12/10/2026)

**Decisão do dono:** o projeto é aberto para a comunidade melhorar e acrescentar, mas **ninguém
escreve na `main`** — só pull request, inclusive do mantenedor. O que existe hoje, conferido pela API
do GitHub:

| Configuração | Estado |
|---|---|
| Visibilidade | `PUBLIC` |
| Descrição | preenchida |
| Licença | MIT |
| Issues | habilitadas |
| Proteção da `main` | ativa |
| PR obrigatório antes do merge | sim |
| Push direto / force push / apagar a branch | bloqueados |
| Revisão obrigatória | **0 aprovadores** |
| `enforce_admins` | **desligado** — o dono passa por cima |
| Rulesets | nenhum |

Sem revisão obrigatória, um PR de terceiro pode ser mergeado por quem tem escrita sem passar por
outro par de olhos. Ligar `required_approving_review_count = 1` resolve, mas aí o próprio PR do dono
também precisa de aprovação de outra conta.

Protocolo escrito: [CONTRIBUTING.md](../CONTRIBUTING.md) (o que é bem-vindo, o que pede aval antes
do código, o que fica fora, como preparar o PR e o que o mantenedor avalia),
[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md), modelo de PR e dois modelos de issue (defeito e
melhoria/novo harness) em `.github/`.

## Por que implementação própria e não fork (item 2.4)

A extensão instalada (`vithrive.deepseek-harness-vscode` 1.0.0, MIT) é um singleton de verdade: 20
campos `let` de módulo no topo do arquivo (`extension.js:10-47`), `managedChild` único,
`registerWebviewViewProvider(VIEW_ID)` com id fixo (`:3919`), painel de aba com id fixo `'dsh.tab'`
(`:3933`) reusando 100% do estado global, `killOnDispose` só num `deactivate` que mata **um** filho
(`:4131-4134`). **Contribution point de view do VS Code é estático** — não existe registro de view em
tempo de execução —, então N harnesses na barra lateral exigiriam N views declaradas no manifesto e
um `registerWebviewViewProvider` por view. Já o **painel de aba** (`WebviewPanel`) é dinâmico por
natureza: a extensão abre quantas abas quiser, uma por harness, sem teto de manifesto.

Mapa completo do código de referência, com linha citada por afirmação:
[mapa-cirurgia-extension-vscode.md](mapa-cirurgia-extension-vscode.md).

**Limitação do DSH, não do VS Code:** o próprio readme da extensão (`readme.md:263`) registra que o
front-end do DSH **degenera para singleton com múltiplos webviews** no VS Code (no navegador comum,
múltiplas abas funcionam). Ou seja: N harnesses **distintos** (DSH + Claude Code/ACP) convivem; N
instâncias **do mesmo front-end DSH** não convivem sem mexer no front-end dele. Isso não bloqueia o
F2 (o alvo é DSH + Claude Code), mas fecha a porta para "dois DSH lado a lado" por ora.

## O que o painel do VS Code faz e o que não faz

- Lê o mesmo registro do CLI (`harnesses.json`), lista os harnesses com motor, porta e estado, sobe o
  que estiver parado com o `DSH_HOME` próprio, dá uma aba por harness com a GUI embutida (URL com
  token, `frame-src` liberado no CSP), para, reinicia, abre no navegador e mostra o log.
- **Não** escreve o registro nem materializa perfil (isso é do CLI), **não** toca em `~/.dsh`, **não**
  registra o DSH como modelo de chat do Copilot e **não** abre view por harness na barra lateral.

- [x] **Item 2.1 — completo: registro de harnesses + lançador (`harness-deck`).** Pacote novo
  [packages/harness-deck-launcher](../packages/harness-deck-launcher/) com registro em JSON
  (`<raiz>/harnesses.json`), materialização do perfil do DSH e ciclo de vida do processo. Comandos:
  `list`, `add`, `rm`, `up`, `down`, `status`, `logs`. **Verificado rodando** com dois harnesses
  simultâneos — `alfa` (motor `dsh`, porta 3121) e `bravo` (motor `claude-code` + ponte ACP, porta
  3122): os dois subiram, responderam HTTP na porta (401 sem token, como esperado), apareceram como
  `no ar` no `list` e pararam com SIGTERM no `down`. `tsc --noEmit` limpo.
- [x] **Item 2.2 — completo, e mudou o desenho.** O que separa **workspaces e sessões é o
  `DSH_HOME`, não o perfil**: dois perfis dentro do mesmo `DSH_HOME` compartilham a mesma
  `storages/workspace.json` e o mesmo log de sessões (`resolveDshHome()` não olha o perfil;
  `dsh-home-paths/lib/index.js:82`). Medido: os perfis `web`, `hd-web` e `acp-smoke-sdk` dividiam um
  único `workspace.json` e 65 arquivos de projeção de sessão. Consequência adotada: **um `DSH_HOME`
  por harness** (`<raiz>/homes/<nome>`), com o perfil servindo só para isolar motor e plugins. O
  teste acima confirmou o isolamento: cada harness escreveu o **seu** `storages/workspace.json`, os
  dois vazios e independentes.

- [x] **Item 1.1** — SDK falando com uma rota Anthropic-shaped. Chave via `.env` do projeto (fora do git). Testado
  com `@anthropic-ai/sdk` já instalado no profile do DSH, modelo `claude-sonnet-5`, resposta ok.
  **Atenção:** aquela conta ficou sem crédito (ver Bloqueios); a rota viva hoje é o OpenRouter.
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
- [x] **Item B.3 — completo: o texto aparece crescendo no chat da GUI.** Verificado com navegador
  sem cabeça (Playwright) contra o servidor do perfil isolado, **dirigindo a página de verdade**:
  o chat foi criado, o prompt foi aceito e a resposta foi desenhada progressivamente. Numa pergunta
  "números de 1 a 30 separados por vírgula", o DOM mostrava **5 números aos 9,2 s, 10 aos 9,6 s,
  13 aos 10,0 s, 26 aos 10,4 s e os 30 aos 10,8 s** (amostras de 400 ms), fechando com
  `turn/end reason=completed`. A captura do meio do stream está em `.run/gui-stream-t26.png`
  (fora do git) — aos 10,4 s a tela mostrava `1, 2, …, 26`. Num turno curto: frames `rev=1..6`
  densos, `assistant/message seq=7 text="pong"`, `turn/end completed`.
- **Por que a GUI achou o que os testes anteriores não acharam.** O teste de B.1/B.2 cria a sessão
  pelo **servidor SDK**, que não passa pelo `mount` de preset nem pelo serviço de upload de arquivo
  do controlador de sessão da GUI. Dois defeitos de escopo (itens 6 e 7 abaixo) só existem nesse
  caminho — e o sintoma que chegava ao dono era "não consigo criar um new chat ou informar uma
  workspace", sem nome de serviço nem causa.

## Defeitos reais encontrados e corrigidos nesta rodada

Sete erros que só apareceram **rodando** o caminho ponta a ponta, nenhum deles visível por leitura:

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
6. **`Agent preset binding requires a scoped context` — a GUI criava a sessão e morria.** O plugin
   entregava ao agente um `ownerCtx.extend()`, que copia a cadeia de contexto mas **não** a marca de
   escopo do `@deepseek-ai/dsh-scope`. Sem essa marca o `agent-preset-registry` recusa ligar o
   preset (`dsh-agent-preset-registry/lib/index.js:663`) e a criação da sessão falha. O motor padrão
   minta o escopo dentro do construtor do driver (`dsh-agent-loop/lib/index.js:778`); o plugin
   passou a fazer o mesmo.
7. **`prompt rejected (session/agent-busy)` — o chat criava e recusava o texto.** A chave do escopo
   tem de ser **o próprio agente**: o serviço de upload de arquivo confere
   `scopeOf(agent.ctx) === agent` (`dsh-client-file-upload/lib/index.js:297`) e, com uma chave
   qualquer, o primeiro prompt é recusado. O rótulo que chega à tela não nomeia o serviço nem a
   causa. Lição: **escopo de agente no DSH não é só "ter escopo" — é ter o agente como chave.**

## Como o lançador monta um harness (item 2.1)

- **Registro** em `<raiz>/harnesses.json` (JSON, não YAML: evita dependência de parser). Campos por
  harness: `name`, `profile`, `home` (o `DSH_HOME`), `port`, `engine` (`dsh` | `claude-code`),
  `provider` (`kind`/`model`/`apiKeyEnv`), `enabled`, `note`. A raiz é `$HARNESS_DECK_HOME` ou
  `~/.harnessdeck`.
- **Perfil materializado, nunca escrito à mão.** `add` gera `package.json`, `cordis.patch.yml` e
  `pnpm-workspace.yaml` do perfil. Para o motor `claude-code` o patch desabilita o `agent-loop` e
  insere a ponte ACP — **um `AgentFactory` por processo do DSH** é regra do DSH
  (`AgentRegistry.setFactory` recusa o segundo) — e registra a rota do provedor
  (`agent-default-model` + `llm-pi-ai`), sem a qual o DSH não sobe seletor de modelo. Para o motor
  `dsh` o patch é vazio.
- **Chave de API nunca vai para arquivo.** O registro guarda só o **nome** da variável
  (`OPENROUTER_API_KEY`); o valor vem do ambiente de quem roda `up`. O `.env.example` do perfil lista
  os nomes.
- **A ponte ACP fala o formato Anthropic**, então provedor não-Anthropic chega ao subprocesso por
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (derivados do provedor do harness), enquanto o lado
  DSH do mesmo processo lê a variável do próprio provedor.
- **Ciclo de vida:** processo destacado, `DSH_HOME=<raiz>/homes/<nome>`, pid em
  `<raiz>/.run/<nome>/dsh.pid`, log em `<raiz>/.run/<nome>/dsh.log`, `up` espera a porta responder,
  `down` manda SIGTERM e só então SIGKILL.

## Subagentes em segundo plano

_Nenhum em execução._ O endpoint Anthropic falso local (`.run-fake-anthropic.mjs`) já cumpriu o
papel: foi com ele que o turno do B.2 fechou sem depender de crédito — e agora ele também tem um
gancho de pausa (`FAKE_HOLD_MS`) para o teste de abandono descrito acima.

## Bloqueios

- **Gravar em `~/.harnessdeck` a partir desta sessão.** A política de arquivo desta sessão é
  `workspace-write` (só o repositório), e a escalada para acesso total falha no executor com
  `invalid escalation: justification is only valid together with sandbox_permissions` — o campo não
  chega ao servidor. Consequência prática: o comando `workspace add` funciona (provado numa raiz de
  teste), mas **a lista de workspaces dos harnesses reais ainda não foi preenchida por mim**. Ou o
  dono roda o comando (uma linha, na seção "Próxima decisão do dono"), ou me libera acesso total na
  próxima sessão.
- **A rota Anthropic anterior ficou sem crédito — deixou de importar.** `POST
  <endpoint Anthropic-shaped>/v1/messages` com a chave do `.env` responde `HTTP 429` com o erro de
  limite de crédito do provedor (`type: rate_limit_error`, `code: ..._CREDIT_LIMIT_EXCEEDED`).
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
- **Pendência de ambiente resolvida em 12/10/2026:** o dono autorizou a escrita em
  `~/.harnessdeck`, e a raiz real passou a ser usada nos testes (registro, perfis e `homes/`).
- **O sandbox mata processo destacado.** Cada comando do sandbox roda com `bwrap --die-with-parent`,
  então um harness que o `up` sobe **morre quando o comando que o subiu termina**. O ciclo completo
  (`up` → portas no ar → `down`) foi verificado dentro de **um único comando**; numa máquina sem esse
  sandbox o processo destacado sobrevive normalmente. Não é defeito do lançador. **É também a razão
  de o teste do painel do VS Code não ter sido feito ainda**: a extensão vive dentro do VS Code, que
  está fora do sandbox.

**Resolvidos desde a última atualização:** `tsc` **roda** e passa limpo; o `claude-agent-acp` **está
instalado** (`0.89.1`) como dependência do plugin; a raiz real está em uso; o painel do VS Code existe
e compila.

## Próxima decisão do dono

- **Preencher os workspaces dos harnesses reais** (uma linha; ver Bloqueios):
  ```bash
  CLI=/home/georgesq/project/harness-deck/packages/harness-deck-launcher/bin/harness-deck.mjs
  for p in orchestrator kanban lia saas-hiperlocal-backend; do
    node $CLI workspace add /home/georgesq/project/$p --harness dsh
  done
  node $CLI workspace list
  ```
  Com o harness parado. Os harnesses estão parados agora (`claude` terminou depois do teste da GUI).
- **Empacotar e instalar o painel do VS Code — feito nesta rodada.** Instalado como
  `georgesq.harness-deck-vscode@0.1.0`; a aba apareceu na barra após recarregar a janela. Falta o dono
  confirmar que a GUI abre **dentro da aba** e que o item 2.5 (DSH + Claude Code lado a lado, cada um
  com seus projetos) fecha o portão do F2.
- **Chave do OpenRouter no ambiente.** O harness `claude` está registrado com
  `OPENROUTER_API_KEY`; quando o `.env` do projeto não trazia essa variável, o processo subia e o
  falha. É só exportar a variável (nada vai para arquivo).
- **Decisão de produto que o mapa revelou:** N harnesses **distintos** convivem na mesma janela, mas N
  instâncias **do mesmo front-end DSH** não — o próprio readme da extensão de referência registra que
  o front-end do DSH degenera para singleton com múltiplos webviews no VS Code (`readme.md:263`). Se
  "dois DSH lado a lado" for requisito, o caminho é o front-end do DSH, não o VS Code.

