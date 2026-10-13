/**
 * Stopping a harness process — the one implementation both front ends use.
 *
 * This module is the canonical copy. The VS Code extension compiles a verbatim
 * copy of this file (`packages/harness-deck-vscode/src/shared/process.ts`,
 * produced by that package's `sync-shared` script) so the CLI and the panel can
 * never disagree about what "stopped" means. `test/shared-copy.test.ts` fails
 * when the two files drift apart.
 *
 * It only touches Node builtins on purpose: the extension host runs CommonJS,
 * the CLI runs ESM, and neither should have to know about the other.
 *
 * The three defects it exists to fix (`.spec/spec-feat-parar-e-enviar.md`):
 *
 * 1. **`kill(pid, 0)` lies.** A harness whose runtime re-execs itself, or one
 *    living outside this process namespace, answers on its port while its pid
 *    looks dead. Deciding liveness by the pid alone made `stop` report "nothing
 *    to stop" and delete the pid file — the last pointer to the harness.
 * 2. **The pid file lies.** A pid file written before a window reload can name a
 *    process that no longer exists. The port is the truth; the owner is
 *    discovered with `lsof`/`fuser` when the file does not explain the listener.
 * 3. **The children survive the parent.** A harness spawns the agent CLI and its
 *    tool subprocesses. Signalling only the parent leaves them running.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long the port-owner probes may take before they are given up on. */
const OWNER_PROBE_TIMEOUT_MS = 4000;

/** Signal that did the job, or `none` when there was nothing to stop. */
export type StopSignal = 'SIGTERM' | 'SIGKILL' | 'none';

/** Outcome of stopping one harness process. */
export interface StopOutcome {
  /** False when the process is still there: the caller must not claim success. */
  stopped: boolean;
  /** Signal that did the job, or `none` when there was nothing to stop. */
  signal: StopSignal;
  /**
   * True when the process survived even SIGKILL and the port is still open. The
   * pid file is kept in that case — it is still the only address of the harness.
   */
  stale?: boolean;
  /**
   * True when the pid file did not name the process holding the port, so the
   * owner had to be discovered. The caller should say so: it means the deck's
   * own bookkeeping had already lost track of the harness.
   */
  discovered?: boolean;
  /** Pid that was actually signalled, when one was found. */
  pid?: number;
  /**
   * True when the pid file could not be removed (read-only deck home). The stop
   * itself succeeded; the file will be replaced by the next start.
   */
  pidFileKept?: boolean;
}

/** True when `pid` names a live process this user may signal. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Prove that a directory can be written to, before anything is started there.
 *
 * A harness needs a writable home: the pid file, the log and the DSH state all
 * live under it. When the deck home sits on a read-only filesystem the failure
 * used to surface deep inside the boot as `EROFS: unlink '.../node_modules/...'`,
 * which points at the wrong thing and says nothing about what to do. Probing
 * first turns that into one sentence that names the path and the fix.
 *
 * @param dir - directory that must exist and be writable.
 * @param label - what the directory is, for the message (`a raiz do deck`).
 * @throws Error when the directory cannot be created or written to.
 */
export async function assertWritableDir(dir: string, label: string): Promise<void> {
  const probe = join(dir, `.harness-deck-write-probe-${randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, '');
    await rm(probe, { force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'desconhecido';
    throw new Error(
      `${label} não aceita escrita (${dir}): ${code}. ` +
        'Aponte a raiz para um diretório gravável com ' +
        '`HARNESS_DECK_HOME=/caminho/gravável` no CLI ou com a configuração ' +
        '`harnessDeck.home` na extensão.',
    );
  }
}

/**
 * Remove a pid file, tolerating a filesystem that will not let it go.
 *
 * The stop itself already succeeded when this runs, so a read-only deck home
 * (a mounted backup, a restored snapshot) must not turn a successful stop into a
 * command error. The caller is told whether the file went away.
 *
 * @param path - pid file to remove.
 * @returns true when the file is gone after the attempt.
 */
export async function removePidFile(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Read a pid file; undefined when absent or unparsable. */
export async function readPid(path: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when something accepts a TCP connection on the port.
 *
 * This is a `connect` probe, not a bind probe: binding the port would only prove
 * it is *free*, which is the opposite of what "the harness is up" means.
 */
export function portListening(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Which process is listening on a port.
 *
 * `undefined` means "no tool could tell", never "the port is free": the caller
 * has to probe the port itself. `lsof` is tried first because its output is a
 * bare pid; `fuser` writes pids to stdout and noise to stderr.
 *
 * @param port - the TCP port to look up on loopback.
 * @returns the owner pid and the tool that found it, or undefined.
 */
export async function findPortOwner(port: number): Promise<{ pid: number; via: string } | undefined> {
  const probes: Array<{ via: string; file: string; args: string[] }> = [
    { via: 'lsof', file: 'lsof', args: ['-t', '-sTCP:LISTEN', '-i', `:${port}`] },
    { via: 'fuser', file: 'fuser', args: ['-n', 'tcp', String(port)] },
  ];
  for (const probe of probes) {
    try {
      const { stdout } = await run(probe.file, probe.args, { timeout: OWNER_PROBE_TIMEOUT_MS });
      const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
      if (Number.isInteger(pid) && pid > 0) return { pid, via: probe.via };
    } catch {
      /* tool absent, timed out, or found nothing: try the next one */
    }
  }
  return undefined;
}

/**
 * Signal a whole process tree.
 *
 * Harnesses are spawned detached, so the child leads its own process group and
 * the negative pid reaches the group — the harness *and* the CLI and tool
 * subprocesses it spawned. A child with no group of its own makes the group
 * signal fail with ESRCH, and the plain signal is used then, which is exactly
 * the old behaviour.
 *
 * @param pid - process id of the harness.
 * @param signal - signal to deliver.
 */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group leader (or already gone): fall through to the plain pid */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Wait until a harness is really down.
 *
 * The pid alone is not enough (see the module comment), so the port has to be
 * closed too. That is what the owner sees in the browser, so that is what the
 * deck waits for.
 */
export async function waitForStopped(pid: number, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const down = !processAlive(pid) && !(await portListening(port));
    if (down) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** What {@link stopProcess} needs to know about one harness. */
export interface StopTarget {
  /** Port the harness answers on. The port decides whether it is up. */
  port: number;
  /** Absolute path of the pid file, or undefined when there is none. */
  pidPath?: string;
  /** How long SIGTERM gets before SIGKILL. */
  timeoutMs?: number;
}

/**
 * Stop one harness process.
 *
 * SIGTERM the process group, wait, then SIGKILL; the pid file is removed **only**
 * when the process is gone *and* the port is closed, so a survivor stays visible
 * instead of being silently forgotten.
 *
 * @param target - the port and pid file of the harness.
 * @returns what happened, including whether the owner had to be discovered.
 */
export async function stopProcess(target: StopTarget): Promise<StopOutcome> {
  const timeoutMs = target.timeoutMs ?? 8000;
  const pidFilePid = target.pidPath === undefined ? undefined : await readPid(target.pidPath);
  const listening = await portListening(target.port);
  const pidAlive = pidFilePid !== undefined && processAlive(pidFilePid);

  if (!listening && !pidAlive) {
    const removed = target.pidPath === undefined ? true : await removePidFile(target.pidPath);
    return { stopped: false, signal: 'none', ...(removed ? {} : { pidFileKept: true }) };
  }

  // The port is the truth: prefer whoever holds it, and fall back to the pid
  // file only when no probe could name an owner.
  let pid = pidFilePid;
  let discovered = false;
  if (listening) {
    const owner = await findPortOwner(target.port);
    if (owner !== undefined) {
      pid = owner.pid;
      discovered = owner.pid !== pidFilePid;
    }
  }
  if (pid === undefined) {
    // The port answers and no probe could say who owns it: never delete the pid
    // file, and never claim the harness was stopped.
    return { stopped: false, signal: 'none', stale: true };
  }

  killTree(pid, 'SIGTERM');
  if (await waitForStopped(pid, target.port, timeoutMs)) {
    const removed = target.pidPath === undefined ? true : await removePidFile(target.pidPath);
    return {
      stopped: true,
      signal: 'SIGTERM',
      pid,
      ...(discovered ? { discovered: true } : {}),
      ...(removed ? {} : { pidFileKept: true }),
    };
  }
  killTree(pid, 'SIGKILL');
  if (await waitForStopped(pid, target.port, 3000)) {
    const removed = target.pidPath === undefined ? true : await removePidFile(target.pidPath);
    return {
      stopped: true,
      signal: 'SIGKILL',
      pid,
      ...(discovered ? { discovered: true } : {}),
      ...(removed ? {} : { pidFileKept: true }),
    };
  }
  // Survivor: keep the pid file, it is still the only address of the harness.
  return { stopped: false, signal: 'SIGKILL', stale: true, pid, ...(discovered ? { discovered: true } : {}) };
}
