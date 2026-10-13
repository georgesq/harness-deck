/**
 * Closing the window has to take down the harnesses of the whole deck, not only
 * the ones this window started.
 *
 * `stopAll` used to iterate `startedByUs`, which is per-window memory. A harness
 * left running by a former window — a reload, a reinstall, a second window —
 * survived the close, holding its port and answering HTTP, and nothing in the
 * new window knew it existed. This test starts a listener behind the manager's
 * back and asserts `stopAll` still kills it.
 *
 * Run with:
 *   node test/stopall.test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const { HarnessProcesses } = await import(join(here, '..', 'lib', 'processes.js'));
const { portListening } = await import(join(here, '..', 'lib', 'shared', 'process.js'));

let checks = 0;
function ok(label) {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

/** A free port, taken and released, so nobody else is on it. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A detached process that listens until it is killed. */
function spawnListener(port) {
  const script = `require('node:net').createServer().listen(${String(port)}, '127.0.0.1');`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/** Wait until the port answers, or give up. */
async function waitForListener(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portListening(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Wait until the port stops answering. */
async function waitForFree(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portListening(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const root = await mkdtemp(join(tmpdir(), 'harness-deck-stopall-'));
const port = await freePort();
const entry = {
  name: 'orfao',
  profile: 'orfao',
  home: join(root, 'homes', 'orfao'),
  port,
  engine: 'dsh',
  provider: { kind: 'openrouter', model: 'teste/modelo', apiKeyEnv: 'OPENROUTER_API_KEY' },
  enabled: true,
  providerApiKeyEnv: 'OPENROUTER_API_KEY',
};
// The registry is the deck's word on which port belongs to it; the manager
// never touched it in this process.
await writeFile(join(root, 'harnesses.json'), JSON.stringify({ version: 1, home: root, harnesses: [entry] }));

const pid = spawnListener(port);
assert.equal(await waitForListener(port), true, `o listener de teste nao subiu na porta ${String(port)}`);
ok('listener de teste no ar, sem o gerenciador ter subido nada');

const manager = new HarnessProcesses(root, 'dsh', {}, {});
assert.deepEqual(manager.managedEntries(), []);
ok('o gerenciador nao conhece nenhum harness que ele mesmo tenha subido');

// The regression: a harness of a former window must still be stopped.
const result = await manager.stopAll(10_000, [entry]);
assert.equal(await waitForFree(port), true, 'a porta continua escutando depois do stopAll');
assert.deepEqual(result.stopped, ['orfao']);
ok('stopAll derruba o harness que o registro aponta, mesmo sem te-lo subido');

assert.deepEqual(result.survivors, []);
ok('quem foi derrubado nao aparece como sobrevivente');

// A harness that was already down is a no-op: no warning for a clean close.
const quiet = await manager.stopAll(10_000, [entry]);
assert.deepEqual(quiet.stopped, []);
assert.deepEqual(quiet.survivors, []);
ok('harness que ja estava parado nao vira sobrevivente nem aviso');

try {
  process.kill(pid, 'SIGKILL');
} catch {
  // Already dead: the stopAll above is what killed it.
}
await rm(root, { recursive: true, force: true });
process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
