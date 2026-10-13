/**
 * Stop-path tests — real processes, real sockets, no DSH, no VS Code.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/stop.test.ts
 *
 * These checks exist because the deck reported "parado" while a harness kept
 * answering on its port (`.spec/spec-feat-parar-e-enviar.md`, REQ-P1..P3 and
 * REQ-L1/L2/L4/L5/L7/L8). Every case below is one of the ways that happened:
 * the pid file naming a dead process, the pid file naming a process that is not
 * the listener, the port answering with no pid file at all, a process that
 * ignores SIGTERM, and a parent whose child would outlive it.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  assertWritableDir,
  findPortOwner,
  killTree,
  portListening,
  processAlive,
  stopProcess,
} from '../src/process.ts';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

/** Processes the test started, so a failure cannot leak one. */
const started: number[] = [];
function track(pid: number | undefined): number {
  assert.ok(pid !== undefined, 'spawn sem pid');
  started.push(pid);
  return pid;
}
process.on('exit', () => {
  for (const pid of started) {
    if (processAlive(pid)) killTree(pid, 'SIGKILL');
  }
});

/** Ask the OS for a port nothing is using right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start a fake harness: a detached Node process that answers on `port`.
 *
 * Detached on purpose — it is what makes the process a group leader, so
 * {@link killTree} can reach the whole tree, exactly like a real harness.
 *
 * @param port - port to listen on.
 * @param options - `children` adds tool-like grandchildren; `ignoreSigterm`
 *   makes the process refuse to die on SIGTERM; `pidFile` records its pid.
 */
async function fakeHarness(
  port: number,
  options: { children?: number; ignoreSigterm?: boolean; pidFile?: string } = {},
): Promise<number> {
  const script = `
    const net = require('node:net');
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    ${options.ignoreSigterm ? "process.on('SIGTERM', () => {});" : ''}
    ${options.pidFile !== undefined ? `writeFileSync(${JSON.stringify(options.pidFile)}, process.pid + '\\n');` : ''}
    const kids = [];
    for (let i = 0; i < ${options.children ?? 0}; i += 1) {
      kids.push(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));
    }
    const server = net.createServer(() => {});
    server.listen(${port}, '127.0.0.1', () => console.log('listening'));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
  const pid = track(child.pid);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await portListening(port)) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`o harness falso não subiu na porta ${port}`);
}

/** A pid that is certainly not running: a short-lived process already reaped. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = track(child.pid);
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

const root = await mkdtemp(join(tmpdir(), 'harness-deck-stop-'));

// 1. The ordinary case: pid file right, process alive, port open.
{
  const port = await freePort();
  const pidPath = join(root, 'ordinary.pid');
  const pid = await fakeHarness(port, { pidFile: pidPath });
  assert.equal(await portListening(port), true);
  const outcome = await stopProcess({ port, pidPath });
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.signal, 'SIGTERM');
  assert.equal(outcome.pid, pid);
  assert.equal(await portListening(port), false);
  assert.equal(processAlive(pid), false);
  await assert.rejects(readFile(pidPath, 'utf8'), 'o pid file tinha de sair');
  ok('REQ-P1: parada normal fecha a porta, mata o processo e remove o pid file');
}

// 2. REQ-P3: the pid file names a dead process while the port is still answered.
{
  const port = await freePort();
  const pidPath = join(root, 'lying.pid');
  const pid = await fakeHarness(port);
  await writeFile(pidPath, `${await deadPid()}\n`, 'utf8');
  const outcome = await stopProcess({ port, pidPath });
  assert.equal(outcome.stopped, true, 'o pid file morto não pode fazer o deck desistir');
  assert.equal(outcome.pid, pid, 'a parada tinha de acertar o dono real da porta');
  assert.equal(outcome.discovered, true, 'o dono foi descoberto, não veio do pid file');
  assert.equal(await portListening(port), false);
  assert.equal(processAlive(pid), false);
  ok('REQ-P3: pid file morto com porta viva — a parada acha o dono e fecha a porta');
}

// 3. REQ-L4/L7: no pid file at all, and the port is answered.
{
  const port = await freePort();
  const pidPath = join(root, 'missing.pid');
  const pid = await fakeHarness(port);
  const outcome = await stopProcess({ port, pidPath });
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.pid, pid);
  assert.equal(outcome.discovered, true);
  assert.equal(await portListening(port), false);
  ok('REQ-L4: sem pid file, a porta revela o dono e a parada funciona');
}

// 4. REQ-L2: the process ignores SIGTERM, so SIGKILL has to finish the job.
{
  const port = await freePort();
  const pidPath = join(root, 'stubborn.pid');
  const pid = await fakeHarness(port, { pidFile: pidPath, ignoreSigterm: true });
  const outcome = await stopProcess({ port, pidPath, timeoutMs: 1500 });
  assert.equal(outcome.stopped, true);
  assert.equal(outcome.signal, 'SIGKILL');
  assert.equal(await portListening(port), false);
  assert.equal(processAlive(pid), false);
  ok('REQ-L2: processo que ignora SIGTERM morre no SIGKILL e a porta fecha');
}

// 5. REQ-L8: the child the harness spawned must not outlive it.
{
  const port = await freePort();
  const pidPath = join(root, 'tree.pid');
  const pid = await fakeHarness(port, { pidFile: pidPath, children: 1 });
  const children = await new Promise<number[]>((resolve) => {
    // The fake harness prints nothing, so read the child from /proc by ppid.
    import('node:fs/promises').then(async (fs) => {
      const found: number[] = [];
      for (const entry of await fs.readdir('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const status = await fs.readFile(`/proc/${entry}/status`, 'utf8');
          if (status.includes(`PPid:\t${pid}\n`)) found.push(Number(entry));
        } catch {
          /* the process vanished between readdir and read */
        }
      }
      resolve(found);
    });
  });
  assert.equal(children.length, 1, 'o harness falso tinha de ter um filho');
  const childPid = children[0] as number;
  const outcome = await stopProcess({ port, pidPath });
  assert.equal(outcome.stopped, true);
  assert.equal(processAlive(pid), false);
  assert.equal(processAlive(childPid), false, `o filho ${childPid} sobreviveu ao pai`);
  ok('REQ-L8: a parada mata a árvore, não só o processo do harness');
}

// 6. Nothing to stop: no port, no live process. The pid file goes, nothing else.
{
  const port = await freePort();
  const pidPath = join(root, 'idle.pid');
  await writeFile(pidPath, `${await deadPid()}\n`, 'utf8');
  const outcome = await stopProcess({ port, pidPath });
  assert.equal(outcome.stopped, false);
  assert.equal(outcome.signal, 'none');
  assert.equal(outcome.stale, undefined);
  await assert.rejects(readFile(pidPath, 'utf8'), 'pid file de processo morto tem de sair');
  ok('REQ-P2: sem porta e sem processo, a parada é um no-op honesto');
}

// 7. A read-only deck home must not turn a successful stop into an error.
{
  const port = await freePort();
  const locked = join(root, 'locked');
  await mkdir(locked, { recursive: true });
  const pidPath = join(locked, 'dsh.pid');
  const pid = await fakeHarness(port, { pidFile: pidPath });
  await chmod(locked, 0o500);
  const outcome = await stopProcess({ port, pidPath });
  await chmod(locked, 0o700);
  assert.equal(outcome.stopped, true, 'a parada aconteceu; só o pid file é que não saiu');
  assert.equal(outcome.pidFileKept, true);
  assert.equal(await portListening(port), false);
  assert.equal(processAlive(pid), false);
  ok('REQ-L5: pid file em diretório somente leitura — a parada vale e o aviso é explícito');
}

// 8. A deck home on a read-only filesystem is named before anything is spawned.
{
  const locked = join(root, 'read-only-home');
  await mkdir(locked, { recursive: true });
  await chmod(locked, 0o500);
  let message = '';
  try {
    await assertWritableDir(locked, 'a raiz do deck');
  } catch (error) {
    message = (error as Error).message;
  } finally {
    await chmod(locked, 0o700);
  }
  assert.match(message, /a raiz do deck não aceita escrita/);
  assert.match(message, /HARNESS_DECK_HOME=/, 'a mensagem tem de dizer o que fazer');
  assert.match(message, /harnessDeck\.home/, 'e o equivalente na extensão');
  ok('raiz somente leitura: o erro nomeia o caminho e o contorno, antes de subir nada');
}

// 9. findPortOwner is the piece that made cases 2 and 3 work.
{
  const port = await freePort();
  const pid = await fakeHarness(port);
  const owner = await findPortOwner(port);
  assert.equal(owner?.pid, pid);
  assert.ok(owner?.via === 'lsof' || owner?.via === 'fuser');
  await stopProcess({ port });
  assert.equal(await findPortOwner(port), undefined, 'porta fechada não tem dono');
  ok(`findPortOwner acha o dono da porta (via ${String(owner?.via)}) e não acha depois de fechar`);
}

await rm(root, { recursive: true, force: true });
process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
