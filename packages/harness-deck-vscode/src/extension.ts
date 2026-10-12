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
import { credentialEnv, harnessLogPath, harnessUrl, loadRegistry, resolveHome, type HarnessEntry } from './registry';
import { HarnessProcesses, type HarnessState } from './processes';
import { HarnessTree } from './tree';
import { openHarnessPanel, revealHarnessPanel, updateHarnessPanel } from './panel';

/** Poll interval of the tree, in milliseconds. */
const POLL_MS = 5000;

let processes: HarnessProcesses | undefined;
let tree: HarnessTree | undefined;
let output: ReturnType<typeof window.createOutputChannel> | undefined;
let poller: ReturnType<typeof setInterval> | undefined;

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
  processes = new HarnessProcesses(deckHome(), dshCommand(), {
    onOutput: (entry, chunk) => output?.append(chunk),
    onUrl: (entry, url) => output?.appendLine(`[${entry.name}] GUI em ${url}`),
    onExit: (entry, code) => {
      output?.appendLine(`[${entry.name}] processo saiu (code ${String(code)})`);
      void refresh();
    },
  });
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

/** Repaint the tree. */
async function refresh(): Promise<void> {
  await tree?.refresh();
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

/** Stop a harness and update whatever is on screen. */
async function stopHarness(entry: HarnessEntry): Promise<void> {
  const stopped = await runtime().stop(entry);
  if (!stopped) {
    output?.appendLine(`[${entry.name}] nao ha processo desta janela para parar`);
  }
  updateHarnessPanel(entry, await runtime().inspect(entry));
  await refresh();
}

/** Open (and, when configured, start) the panel of one harness. */
async function openHarness(entry: HarnessEntry): Promise<void> {
  const autoStart = workspace.getConfiguration('harnessDeck').get<boolean>('autoStart', true);
  let state = await runtime().inspect(entry);
  if (!state.listening && autoStart) state = await startHarness(entry, true);
  openHarnessPanel(entry, state, { column: ViewColumn.Beside, preserveFocus: false }, () => {
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
}

/** Called by VS Code when the extension is activated. */
export async function activate(context: ExtensionContext): Promise<void> {
  output = window.createOutputChannel('Harness Deck');
  context.subscriptions.push(output);
  output.appendLine(`Harness Deck: raiz de dados ${deckHome()}`);

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
  const stopOnExit = workspace.getConfiguration('harnessDeck').get<boolean>('stopOnExit', true);
  if (stopOnExit) await processes?.stopAll();
}

/** Exported for the smoke test: render the panel HTML without VS Code. */
export { renderPanelHtml } from './panel';
export { harnessUrl, credentialEnv, resolveHome };
export { revealHarnessPanel };
