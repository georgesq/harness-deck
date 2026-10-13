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
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { catalogModelId, FAST_MODEL_SLUG, harnessHome, loadEnvFile, modelMap, PROVIDER_BASE_URLS, runtimeDir, type HarnessEntry, type Registry } from './registry.ts';
import { materializeProfile, pathExists, profileDir, type MaterializeResult } from './materialize.ts';
// The lifecycle rules live in one module so the CLI and the VS Code panel can
// never disagree about what "stopped" means. Re-exported below for callers that
// still import them from here.
import { findPortOwner, killTree, portListening, processAlive, readPid, stopProcess, waitForStopped, type StopOutcome } from './process.ts';

export { findPortOwner, killTree, portListening, processAlive, readPid, stopProcess, waitForStopped };
export type { StopOutcome, StopSignal } from './process.ts';

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
  /**
   * Pid actually listening on the port, when a probe could name it and it
   * differs from the pid file. Its presence is the "orphan" signal: something
   * answers on the port that the pid file does not account for.
   */
  portOwner?: { pid: number; via: string };
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

/** Build the state of one harness without changing anything. */
export async function inspect(home: string, entry: HarnessEntry): Promise<HarnessState> {
  const pidPath = harnessPidPath(home, entry);
  const pid = await readPid(pidPath);
  const alive = pid !== undefined && processAlive(pid);
  const listening = await portListening(entry.port);
  // The port is the truth and `kill(pid, 0)` can lie: a harness whose runtime
  // re-execs, or one living outside this process namespace, answers on the port
  // while its pid looks dead. Only probe for a foreign owner when the pid file
  // does not already explain the listener.
  let portOwner: { pid: number; via: string } | undefined;
  if (listening && !alive) {
    portOwner = await findPortOwner(entry.port);
    if (portOwner !== undefined && portOwner.pid === pid) portOwner = undefined;
  }
  return {
    entry,
    dshHome: harnessHome(home, entry),
    ...(pid ? { pid } : {}),
    running: alive,
    listening,
    ...(portOwner ? { portOwner } : {}),
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
  /** Extra environment for the child process, on top of `process.env` and the deck `.env`. */
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
 *
 * @param entry - the harness being started.
 * @param fromFile - variables read from the deck `.env`, which fill in a key the
 *   caller's own environment does not have.
 */
export function providerEnv(entry: HarnessEntry, fromFile: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (entry.providerBaseUrl) {
    env.ANTHROPIC_BASE_URL = entry.providerBaseUrl;
    return env;
  }
  if (entry.engine !== 'claude-code' || !entry.provider) return env;
  const key = process.env[entry.provider.apiKeyEnv] ?? fromFile[entry.provider.apiKeyEnv];
  const baseUrl = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
  env.ANTHROPIC_BASE_URL = baseUrl;
  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  // The CLI only accepts model ids its own catalog describes, and the provider
  // only accepts its own slugs: the bridge maps one onto the other. Without
  // this the harness dies on "There's an issue with the selected model". The
  // map carries *every* offered model, because a mapped run can land on any of
  // them once the DSH model selector switches the session.
  if (entry.provider.model) {
    const catalog = catalogModelId(entry.provider.model);
    const fast = catalogModelId(FAST_MODEL_SLUG);
    env.ANTHROPIC_MODEL = catalog;
    env.ANTHROPIC_SMALL_FAST_MODEL = fast;
    env.HARNESS_DECK_MODEL_MAP = JSON.stringify(modelMap(entry.provider));
    env.HARNESS_DECK_UPSTREAM_URL = baseUrl;
    if (key) env.HARNESS_DECK_UPSTREAM_KEY = key;
  }
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
  // The provider key comes from `<deck home>/.env` (owner's decision of
  // 12/10/2026): neither the CLI nor the VS Code extension host inherits an
  // interactive shell, so a key exported in `~/.bashrc` reaches nobody. A value
  // already present in the real environment wins, which keeps a one-off
  // `KEY=… harness-deck up` possible.
  const envFile = await loadEnvFile(home);
  // `dsh --profile <name>` boots the profile; everything after the launcher's own
  // flags reaches the app, so `--port` and `--no-open` are the web app's.
  const args = ['--profile', entry.profile, '--port', String(entry.port), '--no-open'];
  const child = spawn(DSH_BIN, args, {
    cwd: profileDir(home, entry),
    detached: true,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
    env: {
      ...envFile,
      ...process.env,
      ...providerEnv(entry, envFile),
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
  /**
   * True when the pid file did not name the process that held the port and the
   * owner had to be discovered. The caller should say so: it means the deck's
   * own bookkeeping had already lost track of the harness.
   */
  discovered?: boolean;
  /** Pid that was actually signalled. */
  pid?: number;
}

/**
 * Stop one harness.
 *
 * Thin wrapper over {@link stopProcess}: it owns the harness' paths and writes
 * the outcome to the harness log, so the CLI, the panel and the tests all take
 * the exact same decision path.
 *
 * @param home - deck home holding the pid file.
 * @param entry - the harness to stop.
 * @param timeoutMs - how long SIGTERM gets before SIGKILL.
 */
export async function stopHarness(home: string, entry: HarnessEntry, timeoutMs = 8000): Promise<StopResult> {
  const outcome = await stopProcess({
    port: entry.port,
    pidPath: harnessPidPath(home, entry),
    timeoutMs,
  });
  const log = harnessLogPath(home, entry);
  if (outcome.stale) {
    await appendLog(
      log,
      `[launcher] harness "${entry.name}" survived${outcome.pid !== undefined ? ` pid ${outcome.pid}` : ''}; port ${entry.port} still open\n`,
    );
  } else if (outcome.stopped) {
    await appendLog(log, `[launcher] stopped (${outcome.signal}) pid ${String(outcome.pid)}\n`);
  }
  return {
    name: entry.name,
    stopped: outcome.stopped,
    signal: outcome.signal,
    ...(outcome.stale ? { stale: true } : {}),
    ...(outcome.discovered ? { discovered: true } : {}),
    ...(outcome.pid !== undefined ? { pid: outcome.pid } : {}),
  };
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
