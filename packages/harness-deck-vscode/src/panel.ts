/**
 * One webview panel per harness.
 *
 * The panel is a thin shell around the harness' own Web GUI: it embeds the GUI
 * URL (token included) in an iframe and shows a small bar with the harness name,
 * the engine and a reload button. Everything else — workspaces, sessions, chat —
 * belongs to the harness, which is exactly the isolation REQ-02 asks for.
 */
import { ViewColumn, window, type Disposable, type WebviewPanel } from 'vscode';
import type { HarnessEntry } from './registry';
import type { HarnessState } from './processes';

/** View type shared by every harness panel. */
export const VIEW_TYPE = 'harnessDeck.harness';

/** Panels currently open, keyed by harness name. */
const panels = new Map<string, WebviewPanel>();

/** Nonce for the panel's own inline script. */
function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 24; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

/** Escape a string for use inside an HTML attribute or text node. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * HTML of the panel.
 *
 * `frame-src` has to allow the harness origin, otherwise the iframe is blocked
 * by the webview CSP and the panel stays blank.
 */
export function renderPanelHtml(entry: HarnessEntry, state: HarnessState, scriptNonce: string): string {
  const origin = `http://127.0.0.1:${entry.port}`;
  const status = state.listening ? 'no ar' : 'parado';
  const detail = state.listening
    ? `${origin} · ${entry.engine}`
    : `o harness nao esta respondendo em ${origin} — veja o log pelo menu do Harness Deck`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
<title>${escapeHtml(entry.name)}</title>
<style>
  html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); }
  #bar {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px;
    font-family: var(--vscode-font-family); font-size: 12px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  #name { color: var(--vscode-foreground); font-weight: 600; }
  #reload { margin-left: auto; cursor: pointer; border: none; background: transparent;
    color: var(--vscode-textLink-foreground); font-size: 12px; }
  #frame { width: 100%; height: calc(100% - 26px); border: 0; }
  #offline { padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
</style>
</head>
<body>
<div id="bar">
  <span id="name">${escapeHtml(entry.name)}</span>
  <span>${escapeHtml(entry.engine)}</span>
  <span>${escapeHtml(status)}</span>
  <span>${escapeHtml(detail)}</span>
  <button id="reload">recarregar</button>
</div>
${state.listening
  ? `<iframe id="frame" src="${escapeHtml(state.url)}" allow="clipboard-read; clipboard-write"></iframe>`
  : '<div id="offline">Nada respondendo nesta porta. Suba o harness pelo Harness Deck e recarregue.</div>'}
<script nonce="${scriptNonce}">
  const reload = document.getElementById('reload');
  reload?.addEventListener('click', () => {
    const frame = document.getElementById('frame');
    if (frame) frame.src = frame.src;
  });
</script>
</body>
</html>`;
}

/** Options for {@link openHarnessPanel}. */
export interface OpenOptions {
  /** Column to show the panel in. Defaults to `ViewColumn.Beside`. */
  column?: ViewColumn;
  /** Keep the current focus where it is. */
  preserveFocus?: boolean;
}

/** Panel handle returned to the caller. */
export interface HarnessPanelHandle {
  panel: WebviewPanel;
  /** True when the panel already existed. */
  existing: boolean;
}

/**
 * Open (or reveal) the panel of one harness.
 *
 * A panel is created once per harness; asking again reveals the same panel
 * instead of stacking duplicates, which is what makes "one panel per harness"
 * hold when the row is clicked twice.
 */
export function openHarnessPanel(
  entry: HarnessEntry,
  state: HarnessState,
  options: OpenOptions = {},
  onDispose?: (name: string) => void,
): HarnessPanelHandle {
  const existing = panels.get(entry.name);
  if (existing !== undefined) {
    existing.reveal(options.column ?? ViewColumn.Beside, options.preserveFocus ?? false);
    updateHarnessPanel(entry, state);
    return { panel: existing, existing: true };
  }
  const panel = window.createWebviewPanel(
    VIEW_TYPE,
    `Harness: ${entry.name}`,
    { viewColumn: options.column ?? ViewColumn.Beside, preserveFocus: options.preserveFocus ?? false },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panels.set(entry.name, panel);
  panel.webview.html = renderPanelHtml(entry, state, nonce());
  panel.onDidDispose(() => {
    panels.delete(entry.name);
    onDispose?.(entry.name);
  });
  return { panel, existing: false };
}

/** Re-render an open panel (after start/stop, or on refresh). */
export function updateHarnessPanel(entry: HarnessEntry, state: HarnessState): void {
  const panel = panels.get(entry.name);
  if (panel === undefined) return;
  panel.webview.html = renderPanelHtml(entry, state, nonce());
}

/** Reveal the panel of a harness, if it is open. */
export function revealHarnessPanel(name: string): boolean {
  const panel = panels.get(name);
  if (panel === undefined) return false;
  panel.reveal(ViewColumn.Beside, false);
  return true;
}

/** Names of the harnesses with an open panel. */
export function openPanelNames(): string[] {
  return [...panels.keys()];
}

/** Dispose every panel (used on deactivate). */
export function disposeAllPanels(): Disposable[] {
  return [...panels.values()];
}
