/**
 * The command as VS Code sees it (REQ-C1) and what the owner is told when the
 * route is written (REQ-C8).
 *
 * Two things the flow suite cannot see. First, a command that is written in the
 * code and declared in `contributes.commands` but missing from
 * `activationEvents` exists and never activates, so the manifest and the
 * registration are asserted together. Second, "Reiniciar agora" is only worth
 * offering if it runs the extension's *existing* restart path: the option this
 * suite captures is compared by identity with `restartHarness`, the function the
 * `harnessDeck.restartHarness` command calls.
 *
 * `activate` is driven with a stub of `vscode` and of `./provider`, so no CLI
 * runs and nothing touches the real deck home.
 *
 * Run: node test/provider-command.test.mjs  (after `npm run build`)
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'lib');
const manifestPath = join(here, '..', 'package.json');

const REGISTERED = new Map();
/** Options object the registered configure command handed to the flow. */
const captured = [];
/** Notifications the stub was asked to show. */
const shown = { info: [], warning: [], error: [] };
/** Button offered with each information notification. */
const offeredActions = [];
/** What the stub answers when an information notification carries a button. */
let answerToInfo;
/** Deck home the stub hands to the extension. */
let deckHome;
/** Commands the stub pretends to know. */
let settings = {};
/** What the owner answers in the flow cases; empty means "cancel". */
let flowScript = {};

/** The tree is built at import time, so these have to be real shapes. */
class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const vscodeStub = {
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Beside: 2 },
  Uri: { parse: (value) => ({ fsPath: String(value), toString: () => String(value) }), file: (value) => ({ fsPath: value }) },
  env: { openExternal: async () => true },
  commands: {
    registerCommand: (id, handler) => {
      REGISTERED.set(id, handler);
      return { dispose: () => {} };
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (key, fallback) => settings[key] ?? fallback }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  },
  window: {
    createOutputChannel: () => ({ append: () => {}, appendLine: () => {}, dispose: () => {} }),
    registerTreeDataProvider: () => ({ dispose: () => {} }),
    showInformationMessage: async (message, ...actions) => {
      shown.info.push(message);
      offeredActions.push(actions);
      return answerToInfo;
    },
    showWarningMessage: async (message) => {
      shown.warning.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      shown.error.push(message);
      return undefined;
    },
    showQuickPick: async (items, options = {}) => {
      const labels = items.map((item) => (typeof item === 'string' ? item : item.label));
      const answer = flowScript.pick?.(labels, options);
      if (answer === undefined) return undefined;
      if (options.canPickMany) {
        return answer.map((label) => items.find((item) => typeof item !== 'string' && item.label === label));
      }
      if (typeof items[0] === 'string') return answer;
      return items.find((item) => typeof item !== 'string' && item.label === answer);
    },
    showInputBox: async (options = {}) => flowScript.input?.(options.prompt, options.value),
    withProgress: async (_options, task) => task(),
  },
};

/** Stand-in for `./provider`: records what the command passed, runs nothing. */
const providerRecorder = {
  configureProvider: async (argument, options) => {
    captured.push({ argument, options });
    return undefined;
  },
};
let recordProvider = true;

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  const from = String(parent?.filename ?? '');
  if (recordProvider && request === './provider' && from.endsWith('extension.js')) return providerRecorder;
  return load.call(Module, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const extension = require(join(lib, 'extension.js'));
const provider = require(join(lib, 'provider.js'));

let failures = 0;
let checks = 0;
function ok(label) {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}
async function check(label, body) {
  try {
    await body();
    ok(label);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n     ${error?.message ?? String(error)}\n`);
  }
}

const home = await mkdtemp(join(tmpdir(), 'deck-command-'));
deckHome = home;
settings = { home, dshCommand: 'dsh-do-teste', autoStart: false, stopOnExit: false };
await writeFile(
  join(home, 'harnesses.json'),
  JSON.stringify({
    harnesses: [
      {
        name: 'teste',
        port: 4311,
        dshHome: join(home, 'teste'),
        workspaces: [],
        provider: { kind: 'openrouter', model: 'antigo' },
      },
    ],
  }),
  'utf8',
);

await check('REQ-C1: o package.json declara o comando no contributes e na ativacao', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const declared = (manifest.contributes?.commands ?? []).filter(
    (entry) => entry.command === 'harnessDeck.configureProvider',
  );
  assert.equal(declared.length, 1, 'contributes.commands nao declara harnessDeck.configureProvider uma vez');
  assert.equal(declared[0].title, 'Harness Deck: Configurar provedor');

  const activation = manifest.activationEvents ?? [];
  assert.ok(
    activation.includes('onCommand:harnessDeck.configureProvider'),
    `activationEvents nao ativa o comando: ${activation.join(', ')}`,
  );

  const tree = (manifest.contributes?.menus?.['view/item/context'] ?? []).filter(
    (entry) => entry.command === 'harnessDeck.configureProvider',
  );
  assert.equal(tree.length, 1, 'o comando nao esta no menu da arvore do harness');
  assert.equal(tree[0].when, 'view == harnessDeck.harnesses');

  // The palette lists every declared command that is not hidden on purpose.
  const hidden = (manifest.contributes?.menus?.commandPalette ?? []).filter(
    (entry) => entry.command === 'harnessDeck.configureProvider' && entry.when === 'false',
  );
  assert.equal(hidden.length, 0, 'o comando esta escondido da paleta');

  assert.match(manifest.scripts?.test ?? '', /test\/provider-command\.test\.mjs/, 'a suite nao roda este arquivo');
});

await check('REQ-C1: activate registra o comando e o dono o alcanca pelo no da arvore', async () => {
  const context = { subscriptions: [] };
  await extension.activate(context);

  assert.ok(REGISTERED.has('harnessDeck.configureProvider'), `nao registrou: ${[...REGISTERED.keys()].join(', ')}`);
  assert.ok(REGISTERED.has('harnessDeck.restartHarness'), 'o restart existente deixou de ser registrado');

  const node = { entry: { name: 'teste', port: 4311, dshHome: join(home, 'teste'), workspaces: [] } };
  await REGISTERED.get('harnessDeck.configureProvider')(node);

  assert.equal(captured.length, 1, 'o comando registrado nao chamou o fluxo');
  assert.equal(captured[0].argument, node, 'o comando perdeu o argumento vindo da arvore');
  assert.equal(captured[0].options.home, home, 'o fluxo recebeu a raiz de dados errada');
  assert.equal(captured[0].options.dshCommand, 'dsh-do-teste');
});

await check('REQ-C8: a acao Reiniciar agora e o restart que ja existia', async () => {
  const options = captured[0]?.options;
  assert.equal(typeof options?.restart, 'function', 'o comando nao passou um reinicio ao fluxo');
  assert.equal(options.restart, extension.restartHarness, 'o reinicio da acao nao e o mesmo do comando de restart');
  assert.equal(typeof extension.restartHarness, 'function');
});

await check('REQ-C8: o texto final diz rota, variavel da chave e que precisa reiniciar', async () => {
  shown.info.length = 0;
  offeredActions.length = 0;
  answerToInfo = 'Reiniciar agora';
  flowScript = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'deepseek';
      if (String(options.placeHolder).startsWith('Escolha os modelos de')) return ['deepseek-chat'];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    // Every box keeps what came pre-filled, so the suggestion is what is used.
    input: (prompt, value) => (prompt === 'Outros modelos' ? '' : value),
  };

  const restarted = [];
  const entry = { name: 'teste', port: 4311, dshHome: join(home, 'teste'), workspaces: [] };
  const outcome = await provider.configureProvider(
    { entry },
    {
      home,
      repoRoot: join(here, '..', '..', '..'),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      loadCatalog: async () => ({ providers: ['deepseek'], models: { deepseek: [{ id: 'deepseek-chat' }] } }),
      loadProtocols: () => ['openai-completions'],
      restart: async (picked) => {
        restarted.push(picked);
      },
    },
  );

  assert.deepEqual(shown.error, []);
  const message = shown.info.at(-1) ?? '';
  assert.match(message, /rota "deepseek"/, `o texto nao diz a rota: ${message}`);
  assert.match(message, /DEEPSEEK_API_KEY/, `o texto nao diz a variavel da chave: ${message}`);
  assert.match(message, /[Rr]einici/, `o texto nao avisa que precisa reiniciar: ${message}`);
  assert.deepEqual(offeredActions.at(-1), ['Reiniciar agora'], 'a acao oferecida nao reinicia');
  assert.deepEqual(restarted.map((picked) => picked.name), ['teste'], 'a acao nao chegou ao reinicio');
  assert.equal(outcome?.restarted, true);
});

await check('REQ-C8: sem clicar em Reiniciar agora, o harness nao e reiniciado', async () => {
  shown.info.length = 0;
  answerToInfo = undefined;
  flowScript = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'deepseek';
      if (String(options.placeHolder).startsWith('Escolha os modelos de')) return ['deepseek-chat'];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: (prompt, value) => (prompt === 'Outros modelos' ? '' : value),
  };
  const restarted = [];
  const entry = { name: 'teste', port: 4311, dshHome: join(home, 'teste'), workspaces: [] };
  const outcome = await provider.configureProvider(
    { entry },
    {
      home,
      repoRoot: join(here, '..', '..', '..'),
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      loadCatalog: async () => ({ providers: ['deepseek'], models: { deepseek: [{ id: 'deepseek-chat' }] } }),
      loadProtocols: () => ['openai-completions'],
      restart: async (picked) => {
        restarted.push(picked);
      },
    },
  );

  assert.deepEqual(restarted, [], 'reiniciou sem o dono pedir');
  assert.equal(outcome?.restarted, false);
});

await extension.deactivate();
await rm(home, { recursive: true, force: true });

process.stdout.write(failures === 0 ? `tudo ok (${checks} verificacoes)\n` : `${failures} falhas\n`);
process.exit(failures === 0 ? 0 : 1);
