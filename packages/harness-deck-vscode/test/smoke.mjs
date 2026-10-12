/**
 * Smoke test for the parts of the extension that do not need VS Code.
 *
 * `lib/panel.js` and `lib/registry.js` are free of `vscode` at runtime (the
 * import is type-only), so the panel HTML and the registry reader can be
 * exercised in plain Node. Run with:
 *   node test/smoke.mjs [deck-home]
 */
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'lib');

// `panel.js` imports `vscode` for `window.createWebviewPanel`, which this test
// never calls. Intercept the load so the pure HTML renderer runs in plain Node.
const vscodeStub = new Proxy({}, { get: () => () => undefined });
const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, parent, isMain);
};

const { renderPanelHtml } = require(join(lib, 'panel.js'));
const { loadRegistry, resolveHome, harnessHome, harnessLogPath } = require(join(lib, 'registry.js'));

const deckHome = process.argv[2] ?? resolveHome();
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    process.stdout.write(`ok   ${label}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`FAIL ${label}${detail ? ` — ${detail}` : ''}\n`);
}

const registry = await loadRegistry(deckHome);
process.stdout.write(`deck home: ${deckHome}\n`);
process.stdout.write(`harnesses: ${registry.harnesses.map((entry) => `${entry.name}:${entry.port}`).join(', ') || '(nenhum)'}\n`);

check('registro tem pelo menos um harness', registry.harnesses.length > 0);
check(
  'cada harness tem DSH_HOME proprio',
  new Set(registry.harnesses.map((entry) => harnessHome(deckHome, entry))).size === registry.harnesses.length,
);
check(
  'cada harness tem porta distinta',
  new Set(registry.harnesses.map((entry) => entry.port)).size === registry.harnesses.length,
);

const first = registry.harnesses[0];
if (first !== undefined) {
  const running = renderPanelHtml(
    first,
    { entry: first, managed: true, listening: true, pid: 123, url: `http://127.0.0.1:${first.port}/?token=abc`, tail: '' },
    'nonce123',
  );
  check('painel no ar tem iframe com o token', running.includes(`http://127.0.0.1:${first.port}/?token=abc`));
  check('painel no ar libera a origem no CSP', running.includes(`frame-src http://127.0.0.1:${first.port};`));

  const stopped = renderPanelHtml(
    first,
    { entry: first, managed: false, listening: false, url: `http://127.0.0.1:${first.port}`, tail: 'erro' },
    'nonce456',
  );
  check('painel parado nao tem iframe', !stopped.includes('<iframe'));
  check('painel parado explica a porta', stopped.includes(`nao esta respondendo em http://127.0.0.1:${first.port}`));

  check('log fica na raiz do deck', harnessLogPath(deckHome, first).startsWith(join(deckHome, '.run')));
}

process.stdout.write(failures === 0 ? '\ntudo ok\n' : `\n${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
