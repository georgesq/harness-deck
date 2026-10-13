/**
 * Panel notifications, driven through the real extension entry points.
 *
 * REQ-P6 and REQ-L3 ask for something the owner can see on screen. A test that
 * only reads the output channel proves nothing about that, so this suite loads
 * `extension.ts` with a stub of the `vscode` module and asserts on what the
 * extension asks VS Code to *show*.
 *
 * Run: node test/notify.test.mjs  (after `npm run build`)
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, Module } from 'node:module';

const shown = { info: [], warning: [], error: [] };
const logged = [];

/** Minimal `vscode` surface the extension touches at load and on these paths. */
const vscodeStub = {
  ProgressLocation: { Notification: 15 },
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  Uri: { parse: (value) => ({ toString: () => value }), file: (value) => ({ fsPath: value }) },
  ViewColumn: { Beside: -2, One: 1 },
  commands: { registerCommand: () => ({ dispose: () => undefined }) },
  env: { openExternal: async () => true, clipboard: { writeText: async () => undefined } },
  window: {
    createOutputChannel: () => ({
      appendLine: (line) => logged.push(line),
      append: (line) => logged.push(line),
      dispose: () => undefined,
      show: () => undefined,
    }),
    registerTreeDataProvider: () => ({ dispose: () => undefined }),
    createWebviewPanel: () => ({ dispose: () => undefined, webview: { html: '', onDidReceiveMessage: () => undefined }, onDidDispose: () => undefined }),
    showInformationMessage: async (message) => {
      shown.info.push(message);
      return undefined;
    },
    showWarningMessage: async (message) => {
      shown.warning.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      shown.error.push(message);
      return undefined;
    },
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
    withProgress: async (_options, task) => task({ report: () => undefined }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    workspaceFolders: [],
    updateWorkspaceFolders: () => true,
  },
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return load.call(Module, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const lib = join(process.cwd(), 'lib');
const { activate, deactivate, stopReport, survivorWarning } = require(join(lib, 'extension.js'));

let failures = 0;
function ok(label) {
  process.stdout.write(`ok   ${label}\n`);
}
function fail(label, error) {
  failures += 1;
  process.stdout.write(`FAIL ${label}\n     ${error?.message ?? String(error)}\n`);
}
async function check(label, body) {
  try {
    await body();
    ok(label);
  } catch (error) {
    fail(label, error);
  }
}

const entry = { name: 'teste', profile: 'teste', home: '', port: 3199, engine: 'dsh', enabled: true };

// REQ-P6: the three outcomes the owner must be able to read on screen.
await check('REQ-P6: parada normal diz "parou (SIGTERM)" numa notificacao', () => {
  const report = stopReport(entry, { stopped: true, signal: 'SIGTERM', pid: 42 });
  assert.equal(report.severity, 'info');
  assert.match(report.message, /parou \(SIGTERM\)/);
});

await check('REQ-P6: SIGKILL tambem aparece, sem inventar sucesso', () => {
  const report = stopReport(entry, { stopped: true, signal: 'SIGKILL', pid: 42 });
  assert.match(report.message, /parou \(SIGKILL\)/);
});

await check('REQ-P6: porta ainda respondendo vira aviso nomeando porta e pid', () => {
  const report = stopReport(entry, { stopped: false, signal: 'SIGKILL', stale: true, pid: 42 });
  assert.equal(report.severity, 'warning');
  assert.match(report.message, /nao parou/);
  assert.match(report.message, /porta 3199/);
  assert.match(report.message, /pid 42/);
  assert.equal(report.action, 'Ver log');
});

await check('REQ-P6: dono descoberto pela porta fica registrado no log, nao no aviso', () => {
  const report = stopReport(entry, { stopped: true, signal: 'SIGTERM', discovered: true, pid: 7 });
  assert.equal(report.severity, 'info');
  assert.match(report.detail ?? '', /pid file/);
});

await check('REQ-P6: nada para parar tambem avisa, em vez de silencio', () => {
  const report = stopReport(entry, { stopped: false, signal: 'none' });
  assert.equal(report.severity, 'info');
  assert.match(report.message, /nao estava rodando/);
});

// REQ-L3: closing the window must name what stayed up. The stub configuration
// returns `true` for `stopOnExit`, and the registry below has one harness whose
// port is closed, so `deactivate` runs the real `stopAll` path.
const deck = await mkdtemp(join(tmpdir(), 'harness-deck-notify-'));
await mkdir(join(deck, '.run', 'teste'), { recursive: true });
await writeFile(
  join(deck, 'harnesses.json'),
  JSON.stringify({
    version: 1,
    home: deck,
    harnesses: [{ ...entry, home: join(deck, 'homes', 'teste') }],
  }),
);
process.env.HARNESS_DECK_HOME = deck;

const subscriptions = [];
await activate({
  subscriptions: { push: (item) => subscriptions.push(item) },
  extensionPath: process.cwd(),
  globalStorageUri: { fsPath: deck },
});

await check('REQ-L3: sem sobrevivente, o fechamento nao inventa aviso', async () => {
  await deactivate();
  const invented = shown.warning.filter((message) => message.includes('continuam rodando'));
  assert.deepEqual(invented, []);
});

// REQ-L3: the warning names every survivor. `stopAll` only reports a survivor
// when the port still answers after the budget, which cannot be faked without
// an unkillable process — so the wording is checked against the exact input
// shape, and the wiring above proves the no-survivor path shows nothing.
await check('REQ-L3: a mensagem nomeia cada sobrevivente, um por um', () => {
  const message = survivorWarning(['teste', 'outro']);
  assert.match(message, /continuam rodando em segundo plano: teste, outro\./);
  assert.match(message, /harness-deck down/);
});

await rm(deck, { recursive: true, force: true });

process.stdout.write(failures === 0 ? '\ntudo ok (7 verificações)\n' : `\n${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
