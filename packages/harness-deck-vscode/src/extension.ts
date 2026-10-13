/**
 * Harness Deck for VS Code.
 *
 * The extension is a thin control surface over the `harness-deck` registry: it
 * lists the registered harnesses, starts the ones that are down and gives each
 * one a panel in this same window. Isolation (workspaces, sessions, engine,
 * credential) belongs to the harness process, which is why one process per
 * harness is the whole design — see docs/plano.md.
 */
import {
  ProgressLocation,
  Uri,
  ViewColumn,
  commands,
  env,
  window,
  workspace,
  type Disposable,
  type ExtensionContext,
} from 'vscode';
import {
  credentialEnv,
  envFilePath,
  harnessLogPath,
  harnessUrl,
  loadEnvFile,
  loadRegistry,
  resolveHome,
  type HarnessEntry,
} from './registry';
import { HarnessProcesses, type HarnessState } from './processes';
import type { StopOutcome } from './shared/process';
import { HarnessProxy } from './proxy';
import { HarnessTree } from './tree';
import { openHarnessPanel, openPanelNames, revealHarnessPanel, updateHarnessPanel } from './panel';
import { addWorkspace, hasWorkspace, listPaths, removeWorkspace } from './workspaces';

/** Poll interval of the tree, in milliseconds. */
const POLL_MS = 5000;

/**
 * How long `deactivate` may spend stopping harnesses.
 *
 * VS Code does not wait indefinitely for deactivation, and an overrun is worse
 * than a partial stop: the harness stays up either way, but an overrun also
 * delays the shutdown with no report. What does not fit in this budget is
 * reported to the owner (REQ-L2/L3).
 */
const DEACTIVATE_BUDGET_MS = 10_000;

let processes: HarnessProcesses | undefined;
let proxy: HarnessProxy | undefined;
let tree: HarnessTree | undefined;
let output: ReturnType<typeof window.createOutputChannel> | undefined;
let poller: ReturnType<typeof setInterval> | undefined;
/** Variables from `<deck home>/.env`, read at activation. */
let envFile: Record<string, string> = {};

/** Deck home from the settings, or the environment/default. */
function deckHome(): string {
  return resolveHome(workspace.getConfiguration('harnessDeck').get<string>('home', ''));
}

/** DSH command from the settings. */
function dshCommand(): string {
  return workspace.getConfiguration('harnessDeck').get<string>('dshCommand', 'dsh');
}

/** Build the process manager once per window. */
function runtime(): HarnessProcesses {
  if (processes !== undefined) return processes;
  proxy = new HarnessProxy();
  processes = new HarnessProcesses(
    deckHome(),
    dshCommand(),
    {
      onOutput: (entry, chunk) => output?.append(chunk),
      onUrl: (entry, url) => output?.appendLine(`[${entry.name}] GUI em ${url}`),
      onExit: (entry, code) => {
        output?.appendLine(`[${entry.name}] processo saiu (code ${String(code)})`);
        void refresh();
      },
    },
    envFile,
  );
  return processes;
}

/** Registered harnesses, or an empty list when the registry is unreadable. */
async function listHarnesses(): Promise<HarnessEntry[]> {
  try {
    const registry = await loadRegistry(deckHome());
    return registry.harnesses;
  } catch (error) {
    output?.appendLine(`registro ilegivel: ${String(error)}`);
    return [];
  }
}

/** Find one harness by name. */
async function findHarness(name: string): Promise<HarnessEntry | undefined> {
  return (await listHarnesses()).find((entry) => entry.name === name);
}

/**
 * State as the panel should see it.
 *
 * The iframe goes through the loopback proxy, which injects the session cookie
 * the browser would refuse in a cross-site frame; without a proxy URL the panel
 * keeps the direct one and only the browser button authenticates.
 */
async function forPanel(entry: HarnessEntry, state: HarnessState): Promise<HarnessState> {
  if (!state.listening) return state;
  const frameUrl = await proxy?.url(deckHome(), entry);
  return frameUrl === undefined ? state : { ...state, frameUrl };
}

/** Repaint the tree and re-render the panels whose state changed. */
async function refresh(): Promise<void> {
  await tree?.refresh();
  const open = openPanelNames();
  if (open.length === 0) return;
  for (const entry of await listHarnesses()) {
    if (!open.includes(entry.name)) continue;
    updateHarnessPanel(entry, await forPanel(entry, await runtime().inspect(entry)));
  }
}

/** Normalize the argument the commands receive: an entry, a node or a name. */
function entryOf(argument: unknown): HarnessEntry | undefined {
  if (argument === undefined || argument === null) return undefined;
  if (typeof argument === 'string') return undefined;
  const candidate = argument as { entry?: HarnessEntry; name?: string };
  if (candidate.entry !== undefined && typeof candidate.entry.name === 'string') return candidate.entry;
  return undefined;
}

/** Resolve the harness a command should act on. */
async function resolveEntry(argument: unknown): Promise<HarnessEntry | undefined> {
  const direct = entryOf(argument);
  if (direct !== undefined) return direct;
  const names = await listHarnesses();
  if (names.length === 0) {
    await window.showWarningMessage('Nenhum harness registrado. Rode `harness-deck add <nome>` no terminal.');
    return undefined;
  }
  if (names.length === 1) return names[0];
  const picked = await window.showQuickPick(names.map((entry) => entry.name), { placeHolder: 'Escolha o harness' });
  if (picked === undefined) return undefined;
  return names.find((entry) => entry.name === picked);
}

/** Start a harness and update whatever is on screen. */
async function startHarness(entry: HarnessEntry, silent = false): Promise<HarnessState> {
  const state = await window.withProgress(
    { location: ProgressLocation.Notification, title: `Harness Deck: subindo ${entry.name}…` },
    async () => runtime().start(entry),
  );
  if (!state.listening && !silent) {
    const tail = runtime().tail(entry);
    const choice = await window.showErrorMessage(
      `O harness "${entry.name}" nao respondeu na porta ${entry.port}.`,
      'Ver log',
      'Abrir no navegador',
    );
    if (choice === 'Ver log') await showLog(entry);
    if (choice === 'Abrir no navegador') await env.openExternal(Uri.parse(harnessUrl(entry)));
    output?.appendLine(tail);
  }
  updateHarnessPanel(entry, state);
  await refresh();
  return state;
}

/** What the owner must see after a stop, independent of VS Code. */
export interface StopReport {
  /** Severity of the notification. */
  severity: 'info' | 'warning';
  /** Sentence shown in the notification and written to the log. */
  message: string;
  /** Extra line for the output channel, when the message needs context. */
  detail?: string;
  /** Button offered with the notification, when there is a next step. */
  action?: 'Ver log';
}

/**
 * Decide what to tell the owner after one stop attempt.
 *
 * Pure on purpose: the wording is the requirement (REQ-P6), and a wording that
 * only ever reaches the output channel is a wording the owner never sees.
 *
 * @param entry - harness that was asked to stop.
 * @param outcome - what the stop path actually did.
 * @returns the notification to show and the line to log.
 */
export function stopReport(entry: HarnessEntry, outcome: StopOutcome): StopReport {
  if (outcome.stale) {
    // Never say "parado" while the port answers: that lie is the bug this whole
    // path exists to remove.
    const pid = outcome.pid !== undefined ? ` (pid ${String(outcome.pid)})` : '';
    return {
      severity: 'warning',
      message: `O harness "${entry.name}" nao parou: a porta ${entry.port} continua respondendo${pid}.`,
      action: 'Ver log',
    };
  }
  if (!outcome.stopped) {
    return {
      severity: 'info',
      message: `O harness "${entry.name}" nao estava rodando; nada a parar.`,
    };
  }
  const detail = outcome.discovered
    ? `o dono da porta nao era o do pid file, pid ${String(outcome.pid)}`
    : undefined;
  return {
    severity: 'info',
    message: `O harness "${entry.name}" parou (${outcome.signal}).`,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * What to warn the owner about when the closing budget did not stop everything.
 *
 * The names are the whole point: a warning that says "some harness is still up"
 * leaves the owner to guess which one (REQ-L3).
 *
 * @param survivors - names reported by `stopAll`.
 * @returns the sentence shown in the warning notification.
 */
export function survivorWarning(survivors: readonly string[]): string {
  return (
    `Estes harnesses continuam rodando em segundo plano: ${survivors.join(', ')}. ` +
    'Rode `harness-deck down` (ou pare pela paleta de comandos) para encerrar.'
  );
}

/** Stop a harness and update whatever is on screen. */
async function stopHarness(entry: HarnessEntry): Promise<void> {
  const outcome = await runtime().stop(entry);
  const report = stopReport(entry, outcome);
  output?.appendLine(`[${entry.name}] ${report.message}${report.detail === undefined ? '' : ` — ${report.detail}`}`);
  if (report.severity === 'warning') {
    void window.showWarningMessage(report.message, ...(report.action === undefined ? [] : [report.action])).then(
      (choice: string | undefined) => {
        if (choice === 'Ver log') void showLog(entry);
      },
    );
  } else {
    void window.showInformationMessage(report.message);
  }
  updateHarnessPanel(entry, await runtime().inspect(entry));
  await refresh();
}

/** Open (and, when configured, start) the panel of one harness. */
async function openHarness(entry: HarnessEntry): Promise<void> {
  const autoStart = workspace.getConfiguration('harnessDeck').get<boolean>('autoStart', true);
  let state = await runtime().inspect(entry);
  if (!state.listening && autoStart) state = await startHarness(entry, true);
  openHarnessPanel(entry, await forPanel(entry, state), { column: ViewColumn.Beside, preserveFocus: false }, () => {
    void refresh();
  });
  await refresh();
}

/** Show the log file of a harness in the editor. */
async function showLog(entry: HarnessEntry): Promise<void> {
  const path = harnessLogPath(deckHome(), entry);
  try {
    await window.showTextDocument(Uri.file(path));
  } catch {
    await window.showWarningMessage(`Sem log em ${path} — o harness ainda nao subiu por esta extensao.`);
  }
}

/**
 * Register a folder as a workspace of one or more harnesses.
 *
 * A running harness keeps the workspace list in memory and writes the whole
 * document back, so a write now would be lost on the next change made in its
 * GUI: the user is offered to stop it first instead of getting a silent no-op.
 */
async function addWorkspaces(entries: HarnessEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const picked = await window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Adicionar como workspace',
    title: entries.length === 1 ? `Workspace de ${entries[0]?.name ?? ''}` : 'Workspace em todos os harnesses',
  });
  const folder = picked?.[0]?.fsPath;
  if (folder === undefined) return;

  // `managed` is a process this window started; `listening` covers a harness
  // started from a terminal, which holds the list in memory just the same.
  const running: HarnessEntry[] = [];
  for (const entry of entries) {
    const state = await runtime().inspect(entry);
    if (state.managed || state.listening) running.push(entry);
  }
  if (running.length > 0) {
    const choice = await window.showWarningMessage(
      `${running.map((entry) => entry.name).join(', ')} está(ão) no ar e a lista de workspaces vive ` +
        'em memória — sem parar, o workspace some na próxima mudança feita na GUI.',
      'Parar, adicionar e subir',
      'Cancelar',
    );
    if (choice !== 'Parar, adicionar e subir') return;
    for (const entry of running) await stopHarness(entry);
  }

  const added: string[] = [];
  const skipped: string[] = [];
  await window.withProgress(
    { location: ProgressLocation.Notification, title: 'Harness Deck: registrando workspace…' },
    async () => {
      for (const entry of entries) {
        const result = await addWorkspace(deckHome(), entry, folder);
        (result.existing ? skipped : added).push(entry.name);
      }
    },
  );

  for (const entry of running) await startHarness(entry, true);
  const parts = [`${folder} → ${added.join(', ')}`];
  if (skipped.length > 0) parts.push(`já estava em ${skipped.join(', ')}`);
  await window.showInformationMessage(`Workspace registrado: ${parts.join('; ')}`);
  output?.appendLine(`workspace ${parts.join(' | ')}`);
}

/** Unregister a folder from one harness, picking from what it already lists. */
async function removeWorkspaces(entries: HarnessEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const folders: { label: string; detail: string; entry: HarnessEntry }[] = [];
  for (const entry of entries) {
    for (const path of await listPaths(deckHome(), entry)) {
      folders.push({ label: path, detail: entry.name, entry });
    }
  }
  if (folders.length === 0) {
    await window.showInformationMessage('Nenhum workspace registrado nos harnesses.');
    return;
  }
  const picked = await window.showQuickPick(folders, { placeHolder: 'Workspace a remover', canPickMany: false });
  if (picked === undefined) return;
  const result = await removeWorkspace(deckHome(), picked.entry, picked.label);
  await window.showInformationMessage(
    result.removed ? `Removido de ${picked.entry.name}: ${result.path}` : `${result.path} não estava em ${picked.entry.name}`,
  );
  await refresh();
}

/** Register the commands, each resolving its harness from the argument. */
function registerCommands(context: ExtensionContext): void {
  const register = (id: string, handler: (argument: unknown) => Promise<void>): void => {
    context.subscriptions.push(
      commands.registerCommand(id, (async (argument: unknown) => {
        await handler(argument);
      }) as never),
    );
  };

  register('harnessDeck.refresh', async () => {
    await refresh();
  });
  register('harnessDeck.openHarness', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry !== undefined) await openHarness(entry);
  });
  register('harnessDeck.startHarness', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry !== undefined) await startHarness(entry);
  });
  register('harnessDeck.stopHarness', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry !== undefined) await stopHarness(entry);
  });
  register('harnessDeck.restartHarness', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry === undefined) return;
    await stopHarness(entry);
    await startHarness(entry);
  });
  register('harnessDeck.openInBrowser', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry !== undefined) await env.openExternal(Uri.parse(runtime().url(entry)));
  });
  register('harnessDeck.showLog', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry !== undefined) await showLog(entry);
  });
  register('harnessDeck.addWorkspace', async (argument) => {
    const entry = await resolveEntry(argument);
    if (entry !== undefined) await addWorkspaces([entry]);
  });
  register('harnessDeck.addWorkspaceEverywhere', async () => {
    await addWorkspaces(await listHarnesses());
  });
  register('harnessDeck.removeWorkspace', async (argument) => {
    await removeWorkspaces(argument === undefined ? await listHarnesses() : [await resolveEntry(argument)].filter(
      (entry): entry is HarnessEntry => entry !== undefined,
    ));
  });
}

/** Called by VS Code when the extension is activated. */
export async function activate(context: ExtensionContext): Promise<void> {
  output = window.createOutputChannel('Harness Deck');
  context.subscriptions.push(output);
  output.appendLine(`Harness Deck: raiz de dados ${deckHome()}`);
  // The extension host does not inherit an interactive shell: the provider keys
  // come from the deck's own `.env`, never from `~/.bashrc`.
  try {
    envFile = await loadEnvFile(deckHome());
    const names = Object.keys(envFile);
    output.appendLine(
      names.length === 0
        ? `nenhuma variavel em ${envFilePath(deckHome())}`
        : `variaveis carregadas de ${envFilePath(deckHome())}: ${names.join(', ')}`,
    );
  } catch (error) {
    output.appendLine(`nao consegui ler ${envFilePath(deckHome())}: ${String(error)}`);
  }

  tree = new HarnessTree(
    (entry) => runtime().inspect(entry),
    () => listHarnesses(),
  );
  context.subscriptions.push(window.registerTreeDataProvider('harnessDeck.harnesses', tree));
  registerCommands(context);
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('harnessDeck')) {
        processes = undefined;
        void refresh();
      }
    }),
  );

  await refresh();
  poller = setInterval(() => void refresh(), POLL_MS);
}

/** Called by VS Code when the extension is deactivated. */
export async function deactivate(): Promise<void> {
  if (poller !== undefined) clearInterval(poller);
  proxy?.dispose();
  proxy = undefined;
  // Closing the window has to take the harnesses with it: they were spawned
  // detached, so nothing else would. `deactivate` gets a bounded budget — VS Code
  // does not wait forever — and what did not fit is reported instead of being
  // silently left running (REQ-L1/L2/L3).
  const stopOnExit = workspace.getConfiguration('harnessDeck').get<boolean>('stopOnExit', true);
  if (!stopOnExit || processes === undefined) return;
  // The registry goes along so a harness started by a former window — reload,
  // reinstall, second window — is still this window's to stop.
  const result = await processes.stopAll(DEACTIVATE_BUDGET_MS, await listHarnesses());
  if (result.stopped.length > 0) {
    output?.appendLine(`[harness-deck] encerrados no fechamento: ${result.stopped.join(', ')}`);
  }
  if (result.survivors.length > 0) {
    const message = survivorWarning(result.survivors);
    output?.appendLine(`[harness-deck] ${message}`);
    void window.showWarningMessage(message);
  }
}

/** Exported for the smoke test: render the panel HTML without VS Code. */
export { renderPanelHtml } from './panel';
export { harnessUrl, credentialEnv, resolveHome };
export { revealHarnessPanel };
