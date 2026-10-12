/**
 * Minimal VS Code API surface used by this extension.
 *
 * The real `@types/vscode` package is not installed in this environment, so the
 * few members the extension actually touches are declared here. This file is
 * deliberately narrow: if the extension starts using another API, the type must
 * be added here too. When `@types/vscode` becomes available, delete this file
 * and add it to `types` in tsconfig.json.
 */
declare module 'vscode' {
  export interface Disposable {
    dispose(): void;
  }

  export interface Event<T> {
    (listener: (event: T) => unknown): Disposable;
  }

  export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3,
  }

  export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
  }

  export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
  }

  export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
  }

  export class TreeItem {
    constructor(label: string, collapsibleState?: TreeItemCollapsibleState);
    label?: string;
    description?: string | boolean;
    tooltip?: string;
    contextValue?: string;
    iconPath?: ThemeIcon | Uri;
    command?: { command: string; title: string; arguments?: unknown[] };
  }

  export class ThemeIcon {
    constructor(id: string, color?: ThemeColor);
  }

  export class ThemeColor {
    constructor(id: string);
  }

  export class Uri {
    static file(path: string): Uri;
    static parse(value: string): Uri;
    readonly scheme: string;
    readonly path: string;
    readonly fsPath: string;
    toString(): string;
  }

  export interface Webview {
    html: string;
    options: { enableScripts?: boolean; localResourceRoots?: Uri[] };
    onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
    asWebviewUri(localResource: Uri): Uri;
    cspSource: string;
  }

  export interface WebviewPanel {
    readonly viewType: string;
    title: string;
    iconPath?: Uri | { light: Uri; dark: Uri };
    webview: Webview;
    readonly visible: boolean;
    onDidDispose(listener: () => unknown): Disposable;
    onDidChangeViewState(listener: (event: { readonly webviewPanel: WebviewPanel }) => unknown): Disposable;
    reveal(viewColumn?: ViewColumn, preserveFocus?: boolean): void;
    dispose(): void;
  }

  export interface TreeDataProvider<T> {
    onDidChangeTreeData?: Event<T | undefined | null | void>;
    getTreeItem(element: T): TreeItem | Thenable<TreeItem>;
    getChildren(element?: T): ProviderResult<T[]>;
  }

  export type ProviderResult<T> = T | undefined | null | Thenable<T | undefined | null>;

  export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue?: T): T;
    update(section: string, value: unknown, target?: ConfigurationTarget): Thenable<void>;
    has(section: string): boolean;
  }

  export interface OutputChannel {
    appendLine(value: string): void;
    append(value: string): void;
    show(preserveFocus?: boolean): void;
    dispose(): void;
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
  }

  export interface ExtensionContext {
    readonly subscriptions: Disposable[];
    readonly extensionPath: string;
    readonly globalState: {
      get<T>(key: string, defaultValue?: T): T;
      update(key: string, value: unknown): Thenable<void>;
    };
  }

  export const window: {
    registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): Disposable;
    createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: ViewColumn | { viewColumn: ViewColumn; preserveFocus?: boolean },
      options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean; localResourceRoots?: Uri[] },
    ): WebviewPanel;
    createOutputChannel(name: string): OutputChannel;
    showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined>;
    showInputBox(options?: { prompt?: string; value?: string; placeHolder?: string }): Thenable<string | undefined>;
    showQuickPick(
      items: readonly string[] | Thenable<readonly string[]>,
      options?: { placeHolder?: string },
    ): Thenable<string | undefined>;
    withProgress<T>(
      options: { location: number; title?: string; cancellable?: boolean },
      task: (progress: { report(value: { message?: string }): void }) => Thenable<T>,
    ): Thenable<T>;
    showTextDocument(uri: Uri): Thenable<unknown>;
    readonly activeTextEditor: { readonly document: { readonly uri: Uri } } | undefined;
    onDidChangeActiveTextEditor(listener: (editor: unknown) => unknown): Disposable;
  };

  export const commands: {
    registerCommand(command: string, callback: (...args: never[]) => unknown): Disposable;
    executeCommand<T = unknown>(command: string, ...rest: unknown[]): Thenable<T>;
    getCommands(filterInternal?: boolean): Thenable<string[]>;
  };

  export const workspace: {
    getConfiguration(section?: string): WorkspaceConfiguration;
    onDidChangeConfiguration(
      listener: (event: { affectsConfiguration(section: string): boolean }) => unknown,
    ): Disposable;
    readonly workspaceFolders: readonly WorkspaceFolder[] | undefined;
    readonly rootPath: string | undefined;
    readonly name: string | undefined;
  };

  export const env: {
    openExternal(uri: Uri): Thenable<boolean>;
  };

  export const ProgressLocation: {
    SourceControl: 1;
    Window: 10;
    Notification: 15;
  };
}
