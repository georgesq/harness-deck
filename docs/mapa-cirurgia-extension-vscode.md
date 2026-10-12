# Mapa de cirurgia — `vithrive.deepseek-harness-vscode@1.0.0`

Fonte única: `/home/georgesq/.vscode-server/extensions/vithrive.deepseek-harness-vscode-1.0.0/extension.js` (4186 linhas, CommonJS, sem build) e `package.json` (251 linhas). Toda afirmação cita linha real. Campo ausente = **não localizado**.

`extension.js` não tem `src/`, não tem `tsconfig`, não tem bundler: `package.json:19` aponta `"main": "./extension.js"` direto para o arquivo instalado.

---

## 1. Estado global singleton

Todos os campos abaixo são variáveis de módulo (`let` no topo, 10-47) ou constantes de módulo — singleton por processo de extensão.

| # | Símbolo | Linha | Hoje | Precisa virar |
|---|---|---|---|---|
| 1 | `VIEW_ID = 'dsh.webview'` | `extension.js:10` | id fixo do view webview | id por harness (`harnessDeck.<h>.view`) |
| 2 | `DEFAULT_URL` | 11 | `http://127.0.0.1:3080` | default por harness |
| 3 | `activeView` | 14 | referência do view de sidebar ativo | `Map<harnessId, WebviewView>` |
| 4 | `managedChild` | 16 | ChildProcess do `dsh` lançado | `Map<harnessId, ChildProcess>` |
| 5 | `ensurePromise` | 18 | dedup de start (1 por extensão) | `Map<harnessId, Promise>` |
| 6 | `dshInvocation` | 21 | `{cmd,prefix}` resolvido | por harness (Claude Code tem binário próprio) |
| 7 | `dshInvocationAt` | 22 | TTL 15 min do probe | por harness |
| 8 | `activeTab` | 24 | painel de aba atual | `Map<harnessId, WebviewPanel>` |
| 9 | `gContext` | 26 | `ExtensionContext` | global, ok (não é por harness) |
| 10 | `dshModelProviderRegistered` | 28 | flag bool do provedor LM | por harness (ou global, ver §6) |
| 11 | `dshLaunchToken` | 30 | token de auth do stdout | por harness |
| 12 | `authProxy` | 32 | handle do proxy HTTP | por harness |
| 13 | `authProxyPromise` | 34 | dedup de criação do proxy | por harness |
| 14 | `dshNoOpenBroken` | 36 | flag de retry `--no-open` | por harness |
| 15 | `dshAuthCapable` | 39 | suporte a auth web | por harness |
| 16 | `dshBootAnnouncedAt` | 41 | timestamp do boot | por harness |
| 17 | `dshNoOpenSupported` | 43 | cache do probe `--help` | por harness |
| 18 | `lastAuthPromptAt` | 45 | cooldown de prompt (3 min) | por harness |
| 19 | `tabReloadFn` | 47 | reload da aba | `Map<harnessId, fn>` |
| 20 | `dshModelDriftChecked` | 1636 | gate "1× por sessão" | por harness |
| 21 | `chatFileReadCache` | 2514 | `Map` de cache de leitura de chat, cap 40 | global, ok (chaveado por path) |
| 22 | `DSH_MODEL_MAP_KEY = 'dsh.modelSessions'` | 2632 | chave de `globalState` do mapeamento chat→sessão DSH | chave por harness |
| 23 | `BUNDLED_PLUGINS_DIR` / `VSCODE_HOST_ID` / `FILE_LINK_PLUGIN_SOURCE` / `FILE_LINK_ACTION_KEY` | 1628, 1630, 1631, 1633 | constantes do handshake de plugin | revisar com o naming neutro |

Citações:

```js
10: const VIEW_ID = 'dsh.webview';
14: let activeView = null;
16: let managedChild = null;
18: let ensurePromise = null;
24: let activeTab = null;
30: let dshLaunchToken = null;
32: let authProxy = null;
34: let authProxyPromise = null;
```

Cache real (linha 2514-2529):

```js
2514: const chatFileReadCache = new Map();
2518:  const hit = chatFileReadCache.get(file);
2519:  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && (Date.now() - hit.ts) < 10000) {
2526:  if (chatFileReadCache.size > 40) {
```

Timers: **não há timer de módulo** (nenhum handle `setInterval`/`setTimeout` guardado no topo). Os existentes são locais e morrem com o escopo:
`extension.js:849` (`setInterval` dentro de `waitAuthed`, 846-855), `859` (`setTimeout(...).unref()` do `close`), `125` (timeout do `runCommandOk`), `1529-1530` (handshake do iframe), `3782/3786-3789` (refresh do provedor LM). Para N harnesses, `waitAuthed` (849) e o `close` de 1500 ms (859) passam a existir N vezes — sem handle global, não vaza.

Listeners de configuração: **não há listener global**. São dois locais, um por view e um por aba:

```js
3901:      const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
3902:        if (e.affectsConfiguration('dshPanel')) {
3903:          render(view);
...
3911:        cfgSub.dispose();
```

```js
3960:    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
3962:      if (e.affectsConfiguration('dshPanel')) {
3963:        reloadTab();
```

Cirurgia: `affectsConfiguration('dshPanel')` é o prefixo único — com N harnesses qualquer mudança em `dshPanel.*` re-renderiza **todos** os N. Tem de virar `affectsConfiguration('harnessDeck.<h>')` (e o descarte correspondente em 3911 e 3972).

Chaves de `globalState` hoje globais: `'dsh.webAuth.tokenCache'` (449), `'dsh.authCapable'` (492, 546), `'dsh.quietBoot'` (1218, 1239), `DSH_MODEL_MAP_KEY` (3385, 3511). Todas precisam de sufixo por harness (ou de um valor que já embuta o id/`target`).

---

## 2. Ciclo de vida do processo

**Detecção do `dsh`** — `resolveDshInvocation()` 182-191; probe `dsh --version` e fallback `npx --no-install`:

```js
184:   if (await runCommandOk(cmd, ['--version'])) {
185:     return { cmd, prefix: [] };
187:   if (await runCommandOk('npx', ['--no-install', '@deepseek-ai/dsh', '--version'])) {
188:     return { cmd: 'npx', prefix: ['--yes', '@deepseek-ai/dsh'] };
```

Cache de detecção: `ensureDshInstalled()` 216-266, TTL 15 min em 219-220. Instalação automática: `installDsh()` 197-210 (`npm install -g @deepseek-ai/dsh` em 199).

**Lançamento** — `startDsh()` 1013-1064. `spawn` real em 1042-1047; `managedChild = child` em 1048:

```js
1042:   const child = spawn(cmdText, args, {
1043:     cwd: getWorkspaceDir(),
1044:     shell: process.platform === 'win32',
1045:     windowsHide: true,
1046:     stdio: ['ignore', 'pipe', 'pipe']
1047:   });
1048:   managedChild = child;
1049:   attachDshOutputReader(child);
```

**Porta e host** entram como argumentos de CLI, não como env:

```js
1024:   const args = [
1025:     ...inv.prefix,
1026:     'web',
1027:     '--host', String(getHost()),
1028:     '--port', String(getPort())
1029:   ];
```

`getHost()` 67-71 (whitelist `HOST_PATTERN`, 62; fallback `127.0.0.1` em 70), `getPort()` 73-77 (inteiro 1-65535; `DEFAULT_PORT = 3080` em 65). `getWorkspaceDir()` 290-296 devolve **só o primeiro** workspace folder (`folders[0].uri.fsPath`, 293) — para "cada harness com seus workspaces" isso é um ponto de cirurgia direto.

Handlers do filho: `error` 1051-1056 (pinta `activeView.description = '启动失败'`), `exit` 1057-1061 (zera `managedChild` só se for o mesmo child):

```js
1057:   child.on('exit', (code) => {
1058:     if (managedChild === child) {
1059:       managedChild = null;
```

**Leitura do stdout / token**: `attachDshOutputReader()` 1095-1127; regex `dsh web:` em 1103, timestamp 1105, `learnDshToken` 1107, detecção de dsh antigo 1108-1110.

**Espera de boot**: `ensureRunning` 1154-1167 → `startDshAndWaitReady` 1175-1185 → `startDshAndAwaitPort` 1188-1207 (poll de 60×500 ms, retry sem `--no-open` em 1196-1205) → `waitDshFullBoot` 1217-1242 (usa `dshBootAnnouncedAt`, 1228, e `managedChild` 1225/1234). Dedup: `ensureRunningOnce` 1247-1254 lê/escreve `ensurePromise` (1248-1253).

**`--no-open`**: probe `dshWebSupportsNoOpen` 1072-1084 (cache `dshNoOpenSupported` 1073/1076, marca `dshNoOpenBroken` 1081); decisão em 1033-1037. `freePort(port)` 1263-1295 (Windows `netstat`+`taskkill` 1266-1287; POSIX `fuser`/`lsof` 1290-1291 — nota: porta interpolada em shell). `restartDsh()` 1303-1319.

**`killOnDispose`** — só no `deactivate()` 4129-4142:

```js
4131:   const killOnDispose = cfg().get('dshPanel.killOnDispose', true);
4132:   if (killOnDispose && managedChild) {
4133:     killTree(managedChild);
4134:     managedChild = null;
```

`killTree(child)` 1133-1147 (`taskkill /t /f` 1136; `process.kill(-pid,'SIGTERM')` 1142). Com N harnesses, `deactivate` precisa iterar o mapa (e `killTree` genérico já serve).

**Token de auth**: obtido em 1103-1107 (`m[1]` do stdout) → `learnDshToken` 496-512 → persistido em `globalState` 503-508 → entregue ao proxy 510 e 559; reusado do cache 551-558.

---

## 3. Proxy de auth / URL

Constante da chave de cache: `AUTH_PROXY_STATE_KEY = 'dsh.webAuth.tokenCache'` (449). Elegibilidade: `isLocalLoopbackTarget()` 452-462 (recusa remoto exceto `wsl`, 456; hostname tem de ser loopback, 457-458). Extração de token: `extractTokenParam` 474-479.

**URL da GUI**: `getUrl()` 56-58 lê `dshPanel.url`. `resolveDisplayUrl()` 275-283 passa por `vscode.env.asExternalUri` (278) — é isso que cria o port-forward no Remote. `apiBase()` 993-1005 é o que a extensão usa para `/api` (proxy se houver Cookie, 999-1001; senão URL crua, 1004).

**Montagem final + entrega ao webview** em `resolvePanelTarget(isTab)` 910-936; a URL do proxy (base ou tab) é escolhida em 921:

```js
920:   if (proxy.hasCookieForBase()) {
921:     displayUrl = isTab ? proxy.urlForTab() : proxy.baseUrl();
```

O webview recebe em `preparePanelHtml` 2244-2295, que injeta no iframe:

```js
2290:     return { ok: true, html: buildIframeHtml(target.displayUrl, getFontScale(), fileLinkAction()) };
```

e em `buildIframeHtml` 1462-1597 — `origin` calculado em 1476, CSP `frame-src ${origin}` em 1488, `src` do iframe em 1491:

```js
1491: <iframe id="dsh-frame" name="${VSCODE_HOST_ID}" src="${escapeHtml(url)}"
```

**Roteamento do proxy HTTP**: `createAuthProxy(targetUrl)` 577-865.
- `exchangeFor(authority)` 587-618: `GET /?token=` com Host forjado (593-598), captura `set-cookie` do 303 (602-609).
- `preAuth()` 621-627: pré-aquece `127.0.0.1:<port>` e `localhost:<port>`.
- `probeIndexStatus` 630-650, `probeSelf` 653-671, `buildForwardHeaders` 674-684 (remove hop-by-hop 678-680, injeta `host` 681 e `cookie` 682).
- `forward` 687-740 com retry em 401 (692-695); `attempt` 698-739.
- `onUpgrade` 743-798 (WebSocket).
- `server.listen(0, '127.0.0.1', ...)` 805 — porta aleatória, ok para N proxies (um listen por harness).
- API do handle: `target()` 810, `port()` 811, `baseUrl()` 812, `urlForTab()` 813-817, `hasCookieForBase()` 818, `token()` 820, `status()` 821-826, `authenticatedUrl()` 828-840, `onToken` 841, `waitAuthed` 846-855, `close` 856-861.

`ensureAuthProxy()` 519-565 é o dedup singleton; o bloco 522-527 já recria tudo quando `authProxy.target() !== getUrl()` — esse é exatamente o gancho onde a chave por harness entra:

```js
521:   if (authProxy) {
522:     if (authProxy.target() !== getUrl()) {
524:       const old = authProxy;
525:       authProxy = null;
526:       authProxyPromise = null;
```

Aba usa origin diferente de propósito: `getTabDisplayUrl` 2221-2236 troca `127.0.0.1` ↔ `localhost`; `urlForTab()` 813-817 faz o mesmo no proxy. `maybeGuideAuth` 943-990 é a UI de 401 (cooldown `lastAuthPromptAt` 945-946) e `authStatusText` 3867-3880 o diagnóstico.

---

## 4. Webview

**HTML do painel**: quatro builders puros, todos sem estado:
- `buildLoadingHtml()` 1344-1371 (mostra `getWorkspaceDir()` em 1367)
- `buildErrorHtml(reason)` 1373-1405
- `buildSuspendedHtml()` 1411-1438 (placeholder quando a aba assume; motivo do singleton documentado em 1407-1410)
- `buildIframeHtml(url, scale, mode)` 1462-1597 (iframe + ponte `postMessage`, handshake 1521-1531, reveal 1551-1558, insert-selection 1577-1590)

`preparePanelHtml(isTab)` 2244-2295 orquestra: `ensureDshInstalled` 2246 → `ensureDshPlugins` 2256 → `ensureRunningOnce` 2262 → `registerWorkspace()` fire-and-forget 2272 → `resolvePanelTarget` 2275.

**`VIEW_ID` no `resolveWebviewView`**: o provider é um objeto literal em `activate` 3886-3917 e o registro usa `VIEW_ID`:

```js
3887:     resolveWebviewView(view) {
3888:       activeView = view;
3889:       view.title = 'DeepSeek Harness';
3891:       view.webview.options = { enableScripts: true };
3895:       render(view);
3899:       view.webview.onDidReceiveMessage((m) => handleWebviewMessage(m, view.webview));
```

```js
3919:   const viewSub = vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
3920:     webviewOptions: { retainContextWhenHidden: true }
3921:   });
```

`render(view)` 2297-2316 é o ponto onde o singleton se materializa — a guarda 2299-2303 suspende a sidebar quando existe `activeTab`, e a guarda 2308 descarta renders obsoletos:

```js
2299:   if (activeTab) {
2300:     view.description = '在标签页中打开';
2301:     view.webview.html = buildSuspendedHtml();
2306:   const r = await preparePanelHtml(false);
2308:   if (activeView !== view) return;
```

**`openInTab`**: 3925-3983. Guarda de singleton em 3926-3929 (`if (activeTab) { activeTab.reveal(); return; }`); coluna e painel em 3931-3937; `activeTab = panel` em 3938; suspensão da sidebar 3940-3943; `reloadTab` local 3945-3957 registrado em `tabReloadFn` 3958; `onDidDispose` 3970-3979 restaura a sidebar. Ou seja: **a aba reusa o estado global** (`activeTab`, `tabReloadFn`, `getUrl()`, `authProxy`, `managedChild`) e apenas escolhe HTML/origin diferente via `preparePanelHtml(true)` (3949). Não existe qualquer estrutura por instância.

---

## 5. Comandos e registros

| Símbolo / linha | Estado que toca | Precisa de argumento de harness? |
|---|---|---|
| `registerWebviewViewProvider(VIEW_ID, provider, ...)` 3919-3921 | `activeView` (3888), `VIEW_ID` (10) | Sim — 1 chamada por view id declarado no manifesto |
| `dshPanel.openInTab` 3925-3983 | `activeTab` 3926/3938/3973, `activeView` 3940/3976, `tabReloadFn` 3958/3974, cria painel fixo `'dsh.tab'` 3933 | Sim — id do painel + coluna + slot de aba |
| `dshPanel.refresh` 3985-3993 | `activeView` 3986/3989 | Sim |
| `dshPanel.openInBrowser` 3995-4011 | `getUrl()`, `ensureAuthProxy()` 4000, `dshLaunchToken` 4003 | Sim |
| `dshPanel.restart` 4013-4068 | `activeView` 4014/4018/4038..., `managedChild` 4023, `restartDsh` 4045 | Sim |
| `dsh.sendSelection` 4076-4109 | `activeTab \|\| activeView` 4079 | Sim — hoje manda para "a" aba ativa |
| `dshPanel.diagnoseModels` 4111-4113 | `diagnoseModels()` 3802 (global LM) | Não (provedor LM é do VS Code, não por harness) |
| `dshPanel.chatStatus` 4115-4117 | `showChatStatus()` 3846, usa `gContext` 3858 e `dshModelProviderRegistered` 3855 | Sim (reporta a instância) |
| `dshPanel.resetChatMapping` 4119-4124 | apaga `DSH_MODEL_MAP_KEY` inteiro 4121 | Sim — hoje apaga o mapa de todos |
| `wsSub` (workspace folders) 4071-4073 | chama `registerWorkspace()` sem harness | Sim |
| push de todos em `context.subscriptions` 4126 | — | 1 conjunto hoje; vira N |

Todos os 8 `registerCommand` estão concentrados em `activate` (3925, 3985, 3995, 4013, 4076, 4111, 4115, 4119) — não há registro fora de `activate`. `activate`/`deactivate` exportados em 4144; hook de teste `__internals` 4147-4186.

---

## 6. Provedor de modelo de chat (LM)

Nome real da API: **`vscode.lm.registerLanguageModelChatProvider`** (`registerChatModelProvider` → **não localizado**). Implementação em `registerDshModelProvider(context)` 3703-3796:

```js
3704:   if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
3708:   if (!cfg().get('dshPanel.enableDshModel', true)) return;
3732:     const provider = {
3733:       onDidChangeLanguageModelChatInformation: dshModelEmitter.event,
3734:       provideLanguageModelChatInformation(_options, _token) { ... }
3767:       provideLanguageModelChatResponse(model, messages, options, progress, token) {
3768:         return handleDshModelRequest(model, messages, options, progress, token);
```

Registro com vendor **fixo** `'dsh'` (3775):

```js
3775:     context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('dsh', provider));
```

Manifesto: `package.json:30-35` declara `languageModelChatProviders: [{ vendor: "dsh", displayName: "DeepSeek Harness" }]`; a feature liga/desliga em `dshPanel.enableDshModel` (129-133). Modelos: `DSH_MODEL_DEFS` 3688-3697; mapeamento id→modelo `resolveDshModelSelection` 3598-3605; drift `checkDshModelDrift` 3636-3659 (gate `dshModelDriftChecked` 1636). Execução da conversa: `handleDshModelRequest` 3269-3581 — resolve a base em `apiBase()` (3270), lê o mapa de sessões em `gContext.globalState` (3385), persiste (3511, 3540, 3549, 3570, 3576), chama `session.prompt` (3528-3533).

**Com N harnesses**: o `vendor` é único por extensão/provedor no VS Code; não há vendor por harness. O caminho natural é **um vendor por harness** (`harness-deck-dsh`, `harness-deck-claude`...) ou **um vendor só com ids prefixados** (`<h>:<modelo>`) e resolução do harness dentro de `handleDshModelRequest` (3269). Toda a lógica de sessão (3385-3576) assume **um** backend — o `base` vem de `apiBase()` (3270), singleton.

**Dá para adiar?** Sim. O provedor é auto-contido atrás de `dshPanel.enableDshModel` (3708) e `vscode.lm` (3704); basta passar `false` no fork (ou remover a contribuição 30-35) que painel, comandos, proxy e processo continuam funcionando. Nada mais no arquivo importa `dshModelProviderRegistered` fora de diagnóstico (3855) e nada mais depende do vendor `'dsh'`.

---

## 7. `package.json` — o que depende de um harness só

| Chave | Linhas | Acoplamento |
|---|---|---|
| `main` | 19 | aponta direto para o bundle |
| `activationEvents` | 23-28 | `onView:dsh.webview` fixo |
| `languageModelChatProviders` | 30-35 | vendor `dsh` único |
| `configuration.properties.dshPanel.url` | 39-43 | **uma** URL |
| `.host` / `.port` | 44-48 / 49-53 | **um** par host/porta |
| `.dshCommand` | 94-98 | **um** binário |
| `.killOnDispose` | 99-103 | um mapa, não por harness |
| demais `dshPanel.*` | 54-155 | globais de UI/chat |
| `viewsContainers.activitybar` | 158-166 | container `dsh-panel` único |
| `views['dsh-panel']` | 167-175 | **um** view `dsh.webview` |
| `commands` | 176-213 | 8 comandos sem parâmetro de harness |
| `menus.view/title` | 222-243 | `when: view == dsh.webview` |

Declaração de N views webview estáticas (o contribution point é estático: **não existe registro dinâmico de view id**, então N tem de ser um teto fixo no manifesto):

```json
"viewsContainers": {
  "activitybar": [
    { "id": "harnessDeck", "title": "Harness Deck", "icon": "media/icon.svg" }
  ]
},
"views": {
  "harnessDeck": [
    { "type": "webview", "id": "harnessDeck.h1", "name": "DSH" },
    { "type": "webview", "id": "harnessDeck.h2", "name": "Claude Code" },
    { "type": "webview", "id": "harnessDeck.h3", "name": "Harness 3",
      "when": "config.harnessDeck.h3.enabled" }
  ]
}
```

`when` aceita o context key de configuração `config.<setting>` ([when clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts)); a visibilidade de view é controlada por `when` ([contribution points](https://code.visualstudio.com/api/references/contribution-points)). Cada view nova exige `onView:harnessDeck.hN` em `activationEvents` (hoje 23-28) e uma chamada própria de `registerWebviewViewProvider` (hoje 3919). Settings por slot:

```json
"harnessDeck.h1.enabled": { "type": "boolean", "default": true },
"harnessDeck.h1.url":     { "type": "string",  "default": "http://127.0.0.1:3080" },
"harnessDeck.h1.port":    { "type": "number",  "default": 3080 },
"harnessDeck.h1.kind":    { "type": "string",  "enum": ["dsh", "acp"] }
```

---

## 8. `dsh-plugins/`

Conteúdo (4 arquivos, 269 linhas no total): `dsh-vscode-file-links/package.json` (39), `cordis.patch.yml` (5), `lib/index.js` (10, host half no-op), `lib/client.js` (215, client bundle).

Para que serve: é o pacote **embutido** do plugin DSH que troca o clique em link de arquivo do chat para o Explorer do VS Code. É lido como arquivos reais (não template string) por `fileLinkPluginFiles()`:

```js
1955: function fileLinkPluginFiles() {
1956:   const base = path.join(__dirname, BUNDLED_PLUGINS_DIR, FILE_LINK_PLUGIN_NAME);
1957:   const rels = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js'];
```

`BUNDLED_PLUGINS_DIR = 'dsh-plugins'` (1628) e `FILE_LINK_PLUGIN_NAME = 'dsh-vscode-file-links'` (1631); versão lida do próprio `package.json` do plugin em `fileLinkPluginVersion()` 1966-1972; instalação copia para o profile DSH e registra em `dsh.profile.bundles` — `ensureFileLinkPlugin` 1978-2001 (`ensureProfileDeclaration(..., null)` em 1994, sem `dependencies`, comentário 1993).

**O fork precisa dela?** Só se mantiver a feature de link de arquivo para o harness DSH. É código **específico do DSH** (`window.__ModuleLoader__`, `cordis.patch.yml`, `dsh.client.platform: web`, contract de handshake `VSCODE_HOST_ID`/`FILE_LINK_PLUGIN_SOURCE` de 1630-1631 com o relay em 1499-1564). Para Claude Code/ACP não serve. O outro plugin embutido, `dsh-webview-clipboard`, **não** mora em `dsh-plugins/` — é gerado inline por `clipboardPluginFiles()` 1782-1838 e escrito por `ensureClipboardPlugin` 1925-1950. O `dsh-drop-caret` vem do npm via `installPluginViaNpm` 1702+ / `tryDshPluginAdd` 1735+. Tudo isso opera no profile `~/.dsh/profiles/web` (`dshHomeDir` 1638-1640, `dshWebProfileDir` 1642-1644) — **um profile global**, não por harness.

---

## 9. Dependências de API do VS Code incompatíveis com múltiplas instâncias

- `vscode.window.registerWebviewViewProvider(VIEW_ID, ...)` com id fixo — 3919-3921 + `VIEW_ID` 10. Para N: N registros, um por id declarado no manifesto.
- `vscode.window.createWebviewPanel('dsh.tab', ...)` id fixo em 3933 e `viewColumn` derivado do editor ativo em 3931; o singleton é imposto antes, em 3926-3929.
- `vscode.lm.registerLanguageModelChatProvider('dsh', provider)` — vendor string fixo em 3775; o VS Code não tem conceito de "vendor por instância".
- `viewsContainers`/`views` estáticos (`package.json:158-175`): view id não é registrável em runtime — N é teto de manifesto.
- `when: view == dsh.webview` nos menus (`package.json:225,230,235,240`) e `onView:dsh.webview` (24): cada view nova precisa da sua cláusula.
- `vscode.env.asExternalUri` (278) é chamado por URL; com N portas ele funciona, mas cada porta precisa do próprio forward no Remote.
- `retainContextWhenHidden: true` (3920, 3936): custo de memória × N webviews.

Limitação do harness, não do VS Code, mas decisiva: o readme do próprio pacote (`readme.md:263`) registra que o front-end do DSH degenera para singleton com múltiplos webviews no VS Code, e que a extensão contorna com a política de view única (é a razão de `buildSuspendedHtml` 1411-1438 e das guardas 2299-2303/3940-3943). N harnesses **distintos** (DSH + ponte ACP) escapam disso; N instâncias **de DSH** não escapam sem resolver esse ponto no front-end do DSH.

---

## 10. Riscos do fork e caminho prático

Fatos do pacote: 1 único arquivo de 4186 linhas, CommonJS, `main` apontando direto para ele (`package.json:19`); sem `src/`, sem `tsconfig`, sem bundler, sem `files` no manifesto; o "teste" é o hook `module.exports.__internals` 4147-4186, que expõe 38 símbolos — inclusive funções puras (`buildIframeHtml` 4162, `jsonForScript` 4167, `resolveDshModelSelection` 4169, `sanitizeCommand` 4178, `getHost`/`getPort` 4179-4180).

Riscos concretos de editar o arquivo gerado como fonte:
- Sem source map: cada rename de singleton (`activeView` 14, `activeTab` 24, `authProxy` 32, `ensurePromise` 18) é uma varredura de 4186 linhas com colisão textual possível — `authProxy` aparece em 32, 510, 521-529, 541, 947, 984, 2278, 3868, 4137-4139.
- Sem build, o `.vsix` empacota o que está no disco: erro de sintaxe só aparece ao ativar a extensão; não há lint/typecheck para segurar regressão em 4186 linhas.
- `__internals` (4147) não cobre nada do estado por instância; não há teste para `resolveWebviewView`/`openInTab`.

O que eu faria na prática: **reescrever em `src/` com TypeScript**, mas por extração, não big-bang. Motivo: as fronteiras já existem e são limpas — as funções puras (HTML 1344-1597, mapeamento de modelo 3598-3612, sanitização 62-88, parser de sessão 2439-2531) migram para módulos sem tocar em VS Code; o que sobra e precisa de redesenho é exatamente o bloco por instância (10-47, 1013-1064, 3882-4126), que vira uma classe `HarnessInstance` com `child`, `proxy`, `view`, `tab`, `workspaces`. Em paralelo, `package.json` ganha N views/containers (§7) e o provedor LM fica desligado (§6) até o redesenho por vendor. Editar `extension.js` só se o objetivo for um patch incremental de curto prazo no pacote instalado — como base de fork, ele não sustenta o rename de ~20 singletons.

---

## 11. Não localizado

- `dshPanel.port` como setting **por harness** — não existe; hoje é escalar (`package.json:49-53`).
- Qualquer mapa/array de instâncias (`harnesses`, `instances`, `views`) — não localizado.
- `registerChatModelProvider` — não localizado; a API usada é `registerLanguageModelChatProvider` (3775).
- Handler global de configuração — não localizado; só os dois locais (3901, 3960).
- Timer global persistente — não localizado; todos os `setInterval`/`setTimeout` são de escopo local (125, 849, 859, 1529-1530, 3782-3789).
- Suporte a ACP/Claude Code — não localizado em `extension.js` nem em `package.json`.
- Mecanismo de escolha de workspace por harness — não localizado; `getWorkspaceDir()` (290-296) devolve sempre `workspaceFolders[0]`.
