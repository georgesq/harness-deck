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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';

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

const { panelSignature, renderPanelHtml } = require(join(lib, 'panel.js'));
const { loadRegistry, resolveHome, harnessHome, harnessLogPath } = require(join(lib, 'registry.js'));
const { guiUrlFromLogs } = require(join(lib, 'processes.js'));
const { HarnessProxy, stripFrameAncestors } = require(join(lib, 'proxy.js'));

const deckHome = process.argv[2] ?? resolveHome();
let failures = 0;

/** GET one URL and collect the answer. */
function get(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET' }, (answer) => {
      let body = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk) => {
        body += chunk;
      });
      answer.on('end', () => resolve({ status: answer.statusCode, headers: answer.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** POST a small JSON body and collect the answer. */
function postJson(url, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ probe: true });
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
      },
      (answer) => {
        let text = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk) => {
          text += chunk;
        });
        answer.on('end', () => resolve({ status: answer.statusCode, body: text }));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

/** Status of a WebSocket handshake against one origin. */
function upgradeStatus(baseUrl) {
  return new Promise((resolve) => {
    const target = new URL(baseUrl);
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      path: '/socket',
      headers: { connection: 'Upgrade', upgrade: 'websocket' },
    });
    request.on('upgrade', (answer) => {
      answer.socket.destroy();
      resolve(answer.statusCode ?? 0);
    });
    request.on('response', (answer) => {
      answer.resume();
      resolve(answer.statusCode ?? 0);
    });
    request.on('error', () => resolve(0));
    request.end();
  });
}

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
  check('painel no ar diz que o token esta no iframe', running.includes('token: sim'));

  const stopped = renderPanelHtml(
    first,
    { entry: first, managed: false, listening: false, url: `http://127.0.0.1:${first.port}`, tail: 'erro' },
    'nonce456',
  );
  check('painel parado nao tem iframe', !stopped.includes('<iframe'));
  check('painel parado explica a porta', stopped.includes(`nao esta respondendo em http://127.0.0.1:${first.port}`));
  check('painel sem token avisa', stopped.includes('token: nao'));

  check('log fica na raiz do deck', harnessLogPath(deckHome, first).startsWith(join(deckHome, '.run')));

  const before = { entry: first, managed: true, listening: true, pid: 1, url: `http://127.0.0.1:${first.port}/?token=um`, tail: '' };
  check('assinatura igual para o mesmo estado', panelSignature(before) === panelSignature({ ...before }));
  check(
    'assinatura muda quando o token muda',
    panelSignature(before) !== panelSignature({ ...before, url: `http://127.0.0.1:${first.port}/?token=dois` }),
  );
}

// A window reload empties the in-memory map while the harness keeps running, so
// the token has to be recovered from the log instead of the bare port.
const fixtureHome = mkdtempSync(join(tmpdir(), 'hd-deck-'));
const fixtureEntry = { name: 'probe', profile: 'probe', port: 3199, engine: 'dsh', enabled: true };
const fixtureLog = join(fixtureHome, '.run', fixtureEntry.name, 'vscode.log');
mkdirSync(join(fixtureHome, '.run', fixtureEntry.name), { recursive: true });
writeFileSync(fixtureLog, 'dsh web: http://127.0.0.1:3199/?token=velho\ndsh web: http://127.0.0.1:3199/?token=novo\n', 'utf8');
check(
  'token vem do log quando a memoria do painel esta vazia',
  guiUrlFromLogs(fixtureHome, fixtureEntry) === 'http://127.0.0.1:3199/?token=novo',
);
writeFileSync(fixtureLog, 'dsh web: http://127.0.0.1:3131/?token=outra-porta\n', 'utf8');
check('token de outra porta e ignorado', guiUrlFromLogs(fixtureHome, fixtureEntry) === undefined);
rmSync(fixtureHome, { recursive: true, force: true });

// The panel iframe is cross-site to the webview, so the `SameSite=Strict` cookie
// the DSH sets is never stored in it. The proxy mints the cookie on the Node side
// and injects it, which is what makes the GUI work inside the tab.
const upstream = createServer((request, response) => {
  if ((request.url ?? '').startsWith('/?token=')) {
    response.writeHead(303, {
      location: './',
      'set-cookie': 'dsh-auth-fake=v1; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
    });
    response.end();
    return;
  }
  // O DSH responde 403 quando o Origin nao e a autoridade dele.
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${upstream.address().port}`) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('forbidden');
    return;
  }
  if ((request.headers.cookie ?? '').includes('dsh-auth-fake=')) {
    response.writeHead(200, {
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    response.end('<html>gui</html>');
    return;
  }
  response.writeHead(401, { 'content-type': 'text/plain' });
  response.end('dsh web authentication required; reopen the URL printed by dsh web.');
});
upstream.on('upgrade', (request, socket) => {
  if (!(request.headers.cookie ?? '').includes('dsh-auth-fake=')) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return;
  }
  socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const proxyHome = mkdtempSync(join(tmpdir(), 'hd-proxy-'));
const proxyEntry = { name: 'fake', profile: 'fake', port: upstreamPort, engine: 'dsh', enabled: true };
mkdirSync(join(proxyHome, '.run', proxyEntry.name), { recursive: true });
writeFileSync(
  join(proxyHome, '.run', proxyEntry.name, 'vscode.log'),
  `dsh web: http://127.0.0.1:${upstreamPort}/?token=fake\n`,
  'utf8',
);

const proxy = new HarnessProxy();
const proxyUrl = await proxy.url(proxyHome, proxyEntry);
check('proxy sobe para o harness', typeof proxyUrl === 'string' && proxyUrl.startsWith('http://127.0.0.1:'));
const answer = await get(`${proxyUrl}/`);
check('proxy entrega a GUI autenticada', answer.status === 200 && answer.body.includes('gui'), `status ${answer.status}`);
check('proxy tira o x-frame-options', answer.headers['x-frame-options'] === undefined);
check('proxy tira o frame-ancestors', !(answer.headers['content-security-policy'] ?? '').includes('frame-ancestors'));
check('porta crua continua 401', (await get(`http://127.0.0.1:${upstreamPort}/`)).status === 401);
const post = await postJson(`${proxyUrl}/api/session/create`, { origin: proxyUrl, referer: `${proxyUrl}/` });
check('proxy reescreve o Origin e o POST nao toma 403', post.status === 200, `status ${post.status} ${post.body.slice(0, 40)}`);
check('websocket autenticado passa pelo proxy', (await upgradeStatus(proxyUrl)) === 101);
check('websocket sem cookie e recusado', (await upgradeStatus(`http://127.0.0.1:${upstreamPort}`)) === 401);
check('frame-ancestors sai da politica, o resto fica', stripFrameAncestors("default-src 'self'; frame-ancestors 'none'") === "default-src 'self'");
proxy.dispose();
upstream.close();
rmSync(proxyHome, { recursive: true, force: true });

process.stdout.write(failures === 0 ? '\ntudo ok\n' : `\n${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
