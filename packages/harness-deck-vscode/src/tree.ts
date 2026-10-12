/**
 * Tree view of the registered harnesses.
 *
 * One row per harness, with the engine, the port and whether it is answering.
 * The row is the entry point for every action: open the panel, start, stop,
 * restart, see the log.
 */
import { ThemeIcon, TreeItem, TreeItemCollapsibleState, type TreeDataProvider } from 'vscode';
import type { HarnessEntry } from './registry';
import type { HarnessState } from './processes';

/** One row of the tree. */
export class HarnessNode extends TreeItem {
  constructor(
    readonly entry: HarnessEntry,
    readonly state: HarnessState | undefined,
  ) {
    super(entry.name, TreeItemCollapsibleState.None);
    const status = state?.listening === true ? 'no ar' : state?.managed === true ? 'subindo' : 'parado';
    this.description = `${entry.engine} · porta ${entry.port} · ${status}`;
    this.contextValue = state?.listening === true ? 'harnessRunning' : 'harnessStopped';
    this.iconPath = new ThemeIcon(state?.listening === true ? 'circle-filled' : 'circle-outline');
    this.tooltip = [
      `harness: ${entry.name}`,
      `engine:  ${entry.engine}`,
      `porta:   ${entry.port}`,
      `DSH_HOME: ${state?.entry.home ?? '(padrao do deck)'}`,
      entry.note !== undefined ? `nota:    ${entry.note}` : undefined,
      state?.pid !== undefined ? `pid:     ${state.pid}` : undefined,
      state?.url !== undefined ? `url:     ${state.url}` : undefined,
      entry.provider !== undefined ? `modelo:  ${entry.provider.kind}/${entry.provider.model}` : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');
    this.command = { command: 'harnessDeck.openHarness', title: 'Abrir', arguments: [entry] };
  }
}

/** Supplies the harness rows and refreshes them on demand. */
export class HarnessTree implements TreeDataProvider<HarnessNode> {
  private readonly states = new Map<string, HarnessState>();
  private readonly emitter = new SimpleEmitter<HarnessNode | undefined | void>();

  /** Event the view subscribes to. */
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly inspect: (entry: HarnessEntry) => Promise<HarnessState>,
    private readonly list: () => Promise<HarnessEntry[]>,
  ) {}

  /** Update the cached states and repaint. */
  async refresh(): Promise<void> {
    const entries = await this.list();
    for (const entry of entries) {
      this.states.set(entry.name, await this.inspect(entry));
    }
    this.emitter.fire();
  }

  /** Last known state of a harness, for the other commands. */
  stateOf(name: string): HarnessState | undefined {
    return this.states.get(name);
  }

  getTreeItem(element: HarnessNode): TreeItem {
    return element;
  }

  async getChildren(element?: HarnessNode): Promise<HarnessNode[]> {
    if (element !== undefined) return [];
    const entries = await this.list();
    return entries.map((entry) => new HarnessNode(entry, this.states.get(entry.name)));
  }
}

/** Tiny event source, so the tree does not need `vscode.EventEmitter`. */
export class SimpleEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  readonly event = (listener: (event: T) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}
