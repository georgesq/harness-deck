/**
 * harness-deck launcher — start, stop and inspect the harness processes.
 *
 * One harness = one DSH process = one port = one DSH_HOME. That is the whole
 * of path A (docs/plano.md): the isolation the owner asked for (REQ-02) comes
 * from the process, so the launcher's job is to make N processes cheap to
 * start, watch and stop.
 *
 * The launcher never writes into `~/.dsh`: every process it spawns gets
 * `DSH_HOME=<harness-deck home>` (REQ-03).
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { harnessHome, PROVIDER_BASE_URLS, runtimeDir, type HarnessEntry, type Registry } from './registry.ts';
import { materializeProfile, pathExists, profileDir, type MaterializeResult } from './materialize.ts';

/** Name of the executable the launcher spawns. */
export const DSH_BIN = process.env.HARNESS_DECK_DSH_BIN?.trim() || 'dsh';

/** Thrown when a harness cannot be started or stopped. */
export class LaunchError extends Error {}

/** What the launcher knows about one harness process. */
export interface HarnessState {
  entry: HarnessEntry;
  /** DSH_HOME this harness runs with — the isolation boundary of REQ-02. */
  dshHome: string;
  /** Process id from the pid file, when there is one. */
  pid?: number;
  /** True when that pid is a live process. */
  running: boolean;
  /** True when the harness' port accepted a TCP connection. */
  listening: boolean;
  /** Absolute path of the stdout/stderr log. */
  logPath: string;
  /** Absolute path of the pid file. */
  pidPath: string;
}

/** Absolute path of the log file of one harness. */
export function harnessLogPath(home: string, entry: HarnessEntry): string {
  return join(runtimeDir(home), entry.name, 'dsh.log');
}

/** Absolute path of the pid file of one harness. */
export function harnessPidPath(home: string, entry: HarnessEntry): string {
  return join(runtimeDir(home), entry.name, 'dsh.pid');
}

/** Absolute path of the Web GUI of one harness. */
export function harnessUrl(entry: HarnessEntry): string {
  return `http://127.0.0.1:${entry.port}`;
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

/** Read the pid file of a harness; undefined when absent or unparsable. */
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
 * This is a `connect` probe, not a bind probe: binding the port would only
 * prove it is *free*, which is the opposite of what "the harness is up" means.
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

/** Build the state of one harness without changing anything. */
export async function inspect(home: string, entry: HarnessEntry): Promise<HarnessState> {
  const pidPath = harnessPidPath(home, entry);
  const pid = await readPid(pidPath);
  return {
    entry,
    dshHome: harnessHome(home, entry),
    ...(pid ? { pid } : {}),
    running: pid !== undefined && processAlive(pid),
    listening: await portListening(entry.port),
    logPath: harnessLogPath(home, entry),
    pidPath,
  };
}

/** Inspect every harness in the registry. */
export async function inspectAll(home: string, registry: Registry): Promise<HarnessState[]> {
  return Promise.all(registry.harnesses.map((entry) => inspect(home, entry)));
}

/** Options accepted by {@link startHarness}. */
export interface StartOptions {
  /** Path of the `harness-deck-claude-code` package, for the `claude-code` engine. */
  pluginPath: string;
  /** Extra environment for the child process, on top of `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Skip materializing the profile first (used by tests). */
  skipMaterialize?: boolean;
}

/**
 * Environment a harness' child process needs, derived from its provider.
 *
 * `claude-agent-acp` speaks the Anthropic wire format, so a non-Anthropic
 * provider has to arrive through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
 * The DSH side of the same process reads the provider's own variable
 * (`llm-pi-ai`'s `apiKeyEnv`), which the child inherits from the launcher's
 * environment. When the harness has an Anthropic-shaped endpoint of its own
 * (`providerBaseUrl`), that wins.
 */
export function providerEnv(entry: HarnessEntry): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (entry.providerBaseUrl) {
    env.ANTHROPIC_BASE_URL = entry.providerBaseUrl;
    return env;
  }
  if (entry.engine !== 'claude-code' || !entry.provider) return env;
  const key = process.env[entry.provider.apiKeyEnv];
  env.ANTHROPIC_BASE_URL = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  return env;
}

/** Outcome of starting one harness. */
export interface StartResult {
  state: HarnessState;
  /** Profile files created or rewritten before the spawn. */
  materialized?: MaterializeResult;
  /** True when a live process was already there. */
  alreadyRunning: boolean;
}

/**
 * Start one harness.
 *
 * Order matters: the profile is materialized first (so the engine and the
 * provider are the ones in the registry), the port is checked next (so a port
 * clash is reported as such instead of as a mysterious dead GUI) and only then
 * the process is spawned detached, with its pid recorded next to its log.
 */
export async function startHarness(home: string, entry: HarnessEntry, options: StartOptions): Promise<StartResult> {
  const current = await inspect(home, entry);
  if (current.running) return { state: current, alreadyRunning: true };

  let materialized: MaterializeResult | undefined;
  if (!options.skipMaterialize) {
    materialized = await materializeProfile(home, entry, { pluginPath: options.pluginPath });
  }

  if (await portListening(entry.port)) {
    const owner = await readPid(current.pidPath);
    throw new LaunchError(
      `port ${entry.port} of harness "${entry.name}" is already in use` +
        (owner !== undefined ? ` (pid file says ${owner})` : '') +
        `. Stop the other process or change the port in the registry.`,
    );
  }

  const dir = join(runtimeDir(home), entry.name);
  await mkdir(dir, { recursive: true });
  const logPath = harnessLogPath(home, entry);
  const logHandle = await open(logPath, 'a');

  const dshHome = harnessHome(home, entry);
  await mkdir(dshHome, { recursive: true });
  // `dsh --profile <name>` boots the profile; everything after the launcher's own
  // flags reaches the app, so `--port` and `--no-open` are the web app's.
  const args = ['--profile', entry.profile, '--port', String(entry.port), '--no-open'];
  const child = spawn(DSH_BIN, args, {
    cwd: profileDir(home, entry),
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    env: {
      ...process.env,
      ...providerEnv(entry),
      ...options.env,
      DSH_HOME: dshHome,
    },
  });
  child.unref();
  await logHandle.close();
  if (child.pid === undefined) throw new LaunchError(`failed to spawn ${DSH_BIN} for harness "${entry.name}"`);
  await writeFile(current.pidPath, `${child.pid}\n`, 'utf8');
  await appendLog(logPath, `[launcher] started ${DSH_BIN} ${args.join(' ')} (pid ${child.pid}) DSH_HOME=${dshHome}\n`);

  return {
    state: { ...(await inspect(home, entry)), pid: child.pid, running: true },
    ...(materialized ? { materialized } : {}),
    alreadyRunning: false,
  };
}

/** Append one line to a log file, creating it when needed. */
export async function appendLog(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a');
  await handle.appendFile(line);
  await handle.close();
}

/** Outcome of stopping one harness. */
export interface StopResult {
  name: string;
  stopped: boolean;
  /** Signal that did the job, or "none" when there was nothing to stop. */
  signal: 'SIGTERM' | 'SIGKILL' | 'none';
  /** True when the pid file was left in place because the process survived. */
  stale?: boolean;
}

/**
 * Stop one harness: SIGTERM, wait, then SIGKILL. The pid file is removed only
 * after the process is really gone, so a surviving process stays visible.
 */
export async function stopHarness(home: string, entry: HarnessEntry, timeoutMs = 8000): Promise<StopResult> {
  const pidPath = harnessPidPath(home, entry);
  const pid = await readPid(pidPath);
  if (pid === undefined || !processAlive(pid)) {
    await rm(pidPath, { force: true });
    return { name: entry.name, stopped: false, signal: 'none' };
  }
  process.kill(pid, 'SIGTERM');
  if (await waitForExit(pid, timeoutMs)) {
    await rm(pidPath, { force: true });
    await appendLog(harnessLogPath(home, entry), `[launcher] stopped (SIGTERM) pid ${pid}\n`);
    return { name: entry.name, stopped: true, signal: 'SIGTERM' };
  }
  process.kill(pid, 'SIGKILL');
  if (await waitForExit(pid, 3000)) {
    await rm(pidPath, { force: true });
    await appendLog(harnessLogPath(home, entry), `[launcher] killed (SIGKILL) pid ${pid}\n`);
    return { name: entry.name, stopped: true, signal: 'SIGKILL' };
  }
  return { name: entry.name, stopped: false, signal: 'SIGKILL', stale: true };
}

/** Wait until a pid stops being alive, or the timeout expires. */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !processAlive(pid);
}

/** Wait until a harness answers on its port. */
export async function waitForPort(entry: HarnessEntry, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portListening(entry.port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return portListening(entry.port);
}

/** True when a profile directory already holds a DSH manifest. */
export async function profileInitialized(home: string, entry: HarnessEntry): Promise<boolean> {
  return pathExists(join(profileDir(home, entry), 'package.json'));
}
