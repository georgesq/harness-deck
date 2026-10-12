/**
 * Process control for one harness, from inside the VS Code extension window.
 *
 * The extension starts harnesses that the `harness-deck` CLI already registered
 * (profile materialized, port assigned, DSH_HOME decided). It never writes the
 * registry and never touches `~/.dsh`: the only thing it does is run
 * `dsh --profile <p> --port <n> --no-open` with `DSH_HOME=<harness home>` and
 * remember the process so it can be stopped later.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import {
  credentialEnv,
  envFilePath,
  harnessHome,
  harnessLogPath,
  harnessPidPath,
  harnessUrl,
  providerEnv,
  type HarnessEntry,
} from './registry';

/** How long `start` waits for the GUI port before giving up. */
const READY_TIMEOUT_MS = 60_000;

/** Runtime state of one harness. */
export interface HarnessState {
  entry: HarnessEntry;
  /** True when the process this extension started is still alive. */
  managed: boolean;
  /** True when something accepts a connection on the harness' port. */
  listening: boolean;
  /** pid of the managed process, when there is one. */
  pid?: number;
  /** Web GUI URL with the session token, once the process printed it. */
  url: string;
  /** Last lines of the harness log, for the tooltip and the error path. */
  tail: string;
}

/** Callbacks the extension supplies to react to process output. */
export interface HarnessEvents {
  /** Called with every stdout/stderr chunk. */
  onOutput?(harness: HarnessEntry, chunk: string): void;
  /** Called once the GUI URL with token is known. */
  onUrl?(harness: HarnessEntry, url: string): void;
  /** Called when the process exits. */
  onExit?(harness: HarnessEntry, code: number | null): void;
}

/** True when `pid` names a live process. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when something accepts a TCP connection on the port. */
export function portListening(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
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

/** Extract the tokenized GUI URL the DSH prints on startup. */
export function extractGuiUrl(chunk: string, port: number): string | undefined {
  const match = /https?:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w.-]+)/.exec(chunk);
  if (match === null) return undefined;
  const matchedPort = Number.parseInt(match[1] ?? '', 10);
  if (matchedPort !== port) return undefined;
  return `http://127.0.0.1:${matchedPort}/?token=${match[2]}`;
}

/**
 * Last tokenized GUI URL written to the logs of a harness.
 *
 * The DSH prints the URL once, when the process starts, and that token lives as
 * long as the process does. The in-memory map is emptied by a window reload even
 * though the harness keeps running, and a harness started by the CLI logs to
 * `dsh.log` instead of the extension log, so the token is recovered from
 * whichever log was written last. Without it the panel falls back to the bare
 * port, which answers `401 dsh web authentication required`.
 */
export function guiUrlFromLogs(deckHome: string, entry: HarnessEntry): string | undefined {
  const files = [harnessLogPath(deckHome, entry), join(deckHome, '.run', entry.name, 'dsh.log')];
  let best: { url: string; mtime: number } | undefined;
  for (const file of files) {
    let raw: string;
    let mtime: number;
    try {
      raw = readFileSync(file, 'utf8');
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    // Reversed so the newest line of the log wins over the older runs in it.
    const url = extractGuiUrl(raw.split('\n').reverse().join('\n'), entry.port);
    if (url === undefined) continue;
    if (best === undefined || mtime > best.mtime) best = { url, mtime };
  }
  return best?.url;
}

/** Start, stop and inspect the harness processes of one deck home. */
export class HarnessProcesses {
  private readonly children = new Map<string, ChildProcess>();
  private readonly urls = new Map<string, string>();
  private readonly tails = new Map<string, string>();
  private readonly startedByUs = new Map<string, HarnessEntry>();

  constructor(
    private readonly deckHome: string,
    private readonly dshCommand: string,
    private readonly events: HarnessEvents = {},
    /**
     * Variables read from `<deck home>/.env`. The extension host does not inherit
     * an interactive shell, so this file — not `~/.bashrc` — is where the provider
     * keys come from (owner's decision of 12/10/2026).
     */
    private readonly envFile: Record<string, string> = {},
  ) {}

  /** True when this extension started the harness in this window. */
  isManaged(name: string): boolean {
    return this.startedByUs.has(name);
  }

  /** Entries this extension started, for `stopAll`. */
  managedEntries(): HarnessEntry[] {
    return [...this.startedByUs.values()];
  }

  /** Last known URL with token, or the bare port URL. */
  url(entry: HarnessEntry): string {
    return this.urls.get(entry.name) ?? harnessUrl(entry);
  }

  /** Last log tail captured for a harness. */
  tail(entry: HarnessEntry): string {
    return this.tails.get(entry.name) ?? '';
  }

  /** Inspect one harness without changing anything. */
  async inspect(entry: HarnessEntry): Promise<HarnessState> {
    const child = this.children.get(entry.name);
    const pid = child?.pid ?? readPidFile(harnessPidPath(this.deckHome, entry));
    const alive = pid !== undefined && processAlive(pid);
    const listening = await portListening(entry.port);
    // The log is appended by the process itself, so its newest token is never
    // older than the one captured from stdout. A restart made outside this
    // window leaves a dead token in the map, which is exactly the 401.
    const recovered = guiUrlFromLogs(this.deckHome, entry);
    if (listening && recovered !== undefined && recovered !== this.urls.get(entry.name)) {
      this.urls.set(entry.name, recovered);
    }
    const url = this.url(entry);
    return {
      entry,
      managed: this.startedByUs.has(entry.name) && alive,
      listening,
      ...(pid !== undefined && alive ? { pid } : {}),
      url,
      tail: this.tail(entry),
    };
  }

  /**
   * Start a harness unless it is already answering on its port.
   *
   * Returns the state after the attempt; `listening` tells whether the GUI is
   * reachable, and `tail` carries the log when it is not.
   */
  async start(entry: HarnessEntry, options: { wait?: boolean } = {}): Promise<HarnessState> {
    if (await portListening(entry.port)) return this.inspect(entry);

    const logPath = harnessLogPath(this.deckHome, entry);
    mkdirSync(dirname(logPath), { recursive: true });
    const log = createWriteStream(logPath, { flags: 'a' });
    // `dsh --profile <name>` boots the profile; the flags after it are the app's.
    log.write(
      `[vscode] starting ${this.dshCommand} --profile ${entry.profile} --port ${entry.port} --no-open\n`,
    );

    const child = spawn(
      this.dshCommand,
      ['--profile', entry.profile, '--port', String(entry.port), '--no-open'],
      {
        cwd: harnessHome(this.deckHome, entry),
        env: {
          ...this.envFile,
          ...process.env,
          ...providerEnv(entry, this.envFile),
          DSH_HOME: harnessHome(this.deckHome, entry),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    this.children.set(entry.name, child);
    this.startedByUs.set(entry.name, entry);
    const keyEnv = credentialEnv(entry);
    if (!process.env[keyEnv] && !this.envFile[keyEnv]) {
      log.write(
        `[vscode] aviso: ${keyEnv} nao esta no ambiente do VS Code nem em ${envFilePath(this.deckHome)}; o modelo vai falhar\n`,
      );
    }

    const consume = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      log.write(text);
      this.appendTail(entry.name, text);
      const url = extractGuiUrl(text, entry.port);
      if (url !== undefined) {
        this.urls.set(entry.name, url);
        this.events.onUrl?.(entry, url);
      }
      this.events.onOutput?.(entry, text);
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    if (child.pid !== undefined) {
      writeFileSync(harnessPidPath(this.deckHome, entry), `${child.pid}\n`, 'utf8');
    }
    child.once('exit', (code) => {
      log.write(`[vscode] exited with code ${String(code)}\n`);
      log.end();
      this.children.delete(entry.name);
      this.startedByUs.delete(entry.name);
      this.events.onExit?.(entry, code);
    });

    if (options.wait !== false) await this.waitForPort(entry, READY_TIMEOUT_MS);
    return this.inspect(entry);
  }

  /** Wait until the port answers, or the timeout expires. */
  async waitForPort(entry: HarnessEntry, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portListening(entry.port)) return true;
      if (!this.startedByUs.has(entry.name)) return false;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return portListening(entry.port);
  }

  /** Stop a harness this extension started. */
  async stop(entry: HarnessEntry, timeoutMs = 8000): Promise<boolean> {
    const child = this.children.get(entry.name);
    if (child === undefined || child.pid === undefined) return false;
    child.kill('SIGTERM');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && processAlive(child.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (processAlive(child.pid)) child.kill('SIGKILL');
    this.children.delete(entry.name);
    this.startedByUs.delete(entry.name);
    rmSync(harnessPidPath(this.deckHome, entry), { force: true });
    return true;
  }

  /** Stop every harness this extension started (used on deactivate). */
  async stopAll(): Promise<void> {
    for (const entry of this.managedEntries()) await this.stop(entry);
  }

  /** Keep the last 40 lines of output for tooltips and error messages. */
  private appendTail(name: string, text: string): void {
    const combined = `${this.tails.get(name) ?? ''}${text}`;
    const lines = combined.split('\n');
    this.tails.set(name, lines.slice(-40).join('\n'));
  }
}

/** Read a pid file, or undefined when it is absent or unparsable. */
function readPidFile(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True when a pid file exists on disk. */
export function pidFileExists(path: string): boolean {
  return existsSync(path);
}
