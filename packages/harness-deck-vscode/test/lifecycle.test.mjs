/**
 * Lifecycle tests for the extension host side of the deck — real processes,
 * real sockets, no VS Code.
 *
 * Run with (after `npm run build`):
 *   node test/lifecycle.test.mjs
 *
 * They cover the defect the owner hit: closing the window left the harness
 * running in the background, and the panel's "parar" reported success while the
 * port kept answering (`.spec/spec-feat-parar-e-enviar.md`, REQ-L1/L2/L4/L5/L8).
 * `HarnessProcesses` is the piece under test; the `vscode` module is stubbed
 * because none of the lifecycle paths touch it.
 */
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'lib');

const vscodeStub = new Proxy({}, { get: () => () => undefined });
const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return load.call(this, request, parent, isMain);
};

const { HarnessProcesses, portListening, processAlive } = require(join(lib, 'processes.js'));

let checks = 0;
function ok(label) {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

const root = mkdtempSync(join(tmpdir(), 'harness-deck-lifecycle-'));

/** Ask the OS for a port nothing is using right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Write a fake `dsh` that answers on `--port` and spawns one child.
 *
 * A shell script on purpose: it stands in for the real command line
 * (`dsh --profile <p> --port <n> --no-open`) without needing DSH installed. The
 * child is what makes REQ-L8 observable — a stop that only kills the parent
 * leaves it behind.
 */
function fakeDsh() {
  const path = join(root, 'fake-dsh.sh');
  writeFileSync(
    path,
    `#!/bin/sh
port=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port="$2"; shift 2 ;;
    *) shift ;;
  esac
done
exec ${JSON.stringify(process.execPath)} -e '
  const net = require("node:net");
  const { spawn } = require("node:child_process");
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  net.createServer(() => {}).listen(Number(process.argv[1]), "127.0.0.1", () => console.log("listening"));
  setInterval(() => {}, 1000);
' "$port"
`,
    'utf8',
  );
  chmodSync(path, 0o755);
  return path;
}

const dshCommand = fakeDsh();
const deckHome = join(root, 'deck');
const { harnessPidPath, harnessHome } = require(join(lib, 'registry.js'));

/** Build an entry the way the registry would. */
function entry(name, port) {
  return { name, profile: name, port, engine: 'dsh', enabled: true };
}

const runtime = new HarnessProcesses(deckHome, dshCommand, {}, {});

/** The one child the fake harness spawns, read from /proc. */
function childrenOf(pid) {
  const { readdirSync } = require('node:fs');
  const found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      if (status.includes(`PPid:\t${pid}\n`)) found.push(Number(name));
    } catch {
      /* the process vanished between readdir and read */
    }
  }
  return found;
}

try {
  // 1. start spawns detached, writes the pid file and answers on the port.
  {
    const port = await freePort();
    const item = entry('ordinary', port);
    const state = await runtime.start(item, { wait: true });
    assert.equal(state.listening, true, 'o harness falso tinha de subir');
    const pidPath = harnessPidPath(deckHome, item);
    assert.equal(existsSync(pidPath), true, 'o pid file tinha de ser escrito');
    const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    assert.equal(processAlive(pid), true);
    assert.equal(childrenOf(pid).length, 1, 'o harness falso tinha de ter um filho');

    // 2. REQ-L1/L8: stop kills the process and the child, and closes the port.
    const outcome = await runtime.stop(item);
    assert.equal(outcome.stopped, true);
    assert.equal(await portListening(port), false);
    assert.equal(processAlive(pid), false);
    assert.equal(childrenOf(pid).length, 0, 'o filho do harness sobreviveu');
    assert.equal(existsSync(pidPath), false, 'o pid file tinha de sair');
    ok('REQ-L1/L8: parar pelo painel mata o processo e o filho, e fecha a porta');
  }

  // 3. REQ-L4: the panel stops a harness it did not start, via the port.
  {
    const port = await freePort();
    const item = entry('foreign', port);
    const { spawn } = require('node:child_process');
    const child = spawn(
      process.execPath,
      ['-e', `require("node:net").createServer(() => {}).listen(${port}, "127.0.0.1"); setInterval(() => {}, 1000);`],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(await portListening(port))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(await portListening(port), true);
    // The pid file names nothing, exactly like a harness started outside this
    // window after a reload.
    const outcome = await runtime.stop(item);
    assert.equal(outcome.stopped, true, 'o painel tinha de parar o que nao subiu');
    assert.equal(outcome.discovered, true);
    assert.equal(await portListening(port), false);
    assert.equal(processAlive(child.pid), false);
    ok('REQ-L4: o painel para um harness que ele nao subiu, achando o dono pela porta');
  }

  // 4. REQ-L2: stopAll inside the budget, reporting what it could not stop.
  {
    const first = entry('one', await freePort());
    const second = entry('two', await freePort());
    await runtime.start(first, { wait: true });
    await runtime.start(second, { wait: true });
    const result = await runtime.stopAll(20_000);
    assert.deepEqual(result.stopped.sort(), ['one', 'two']);
    assert.deepEqual(result.survivors, []);
    assert.equal(await portListening(first.port), false);
    assert.equal(await portListening(second.port), false);
    assert.equal(runtime.managedEntries().length, 0, 'nada pode sobrar na lista de gerenciados');
    ok('REQ-L2: stopAll encerra tudo dentro do orçamento e reporta o resultado');
  }

  // 5. REQ-L5: a pid file that lies does not stop the panel from stopping.
  {
    const port = await freePort();
    const item = entry('lying', port);
    await runtime.start(item, { wait: true });
    const pidPath = harnessPidPath(deckHome, item);
    const realPid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    // A pid that is certainly dead: a short-lived process already reaped.
    const dead = require('node:child_process').spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    writeFileSync(pidPath, `${dead.pid}\n`, 'utf8');
    const outcome = await runtime.stop(item);
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.discovered, true, 'a porta tinha de revelar o dono');
    assert.equal(await portListening(port), false);
    assert.equal(processAlive(realPid), false);
    ok('REQ-L5: pid file mentiroso nao engana o painel — a porta decide');
  }

  // 6. Nothing to stop is reported as such, not as success.
  {
    const item = entry('idle', await freePort());
    const outcome = await runtime.stop(item);
    assert.equal(outcome.stopped, false);
    assert.equal(outcome.signal, 'none');
    ok('REQ-P2: sem processo, o painel diz que nao havia o que parar');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
