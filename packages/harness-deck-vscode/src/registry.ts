/**
 * Registry contract of the panel — a thin layer over the shared copy.
 *
 * Everything the CLI and the panel must agree on (route ids, model lists, the
 * credential variable, the paths of a harness' files, the environment a child
 * process needs) lives in `./shared/registry.ts`, whose canonical copy is
 * `packages/harness-deck-launcher/src/registry.ts`. `test/shared-copy.test.ts`
 * fails when the copy drifts, because a rule written twice is how the two front
 * ends start disagreeing about what a harness is.
 *
 * Two things are not simply re-exported, and both are the panel's own:
 *
 * - **`loadRegistry` is tolerant.** The CLI treats a malformed registry as a
 *   hard error, because it is the tool that writes the file. The panel has to
 *   *show* it: one bad entry cannot be allowed to take down the whole view, so
 *   bad entries are dropped and the rest is drawn.
 * - **`harnessLogPath` is the panel's log.** The shared one names the engine's
 *   `dsh.log`; the extension's own output goes to `vscode.log` next to it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  registryPath,
  type HarnessEntry,
  type Registry,
} from './shared/registry';

export * from './shared/registry';

/** Absolute path of the output log the panel writes for a harness. */
export function harnessLogPath(deckHome: string, entry: HarnessEntry): string {
  return join(deckHome, '.run', entry.name, 'vscode.log');
}

/** Minimal shape check, so one bad entry cannot take down the whole view. */
function isHarnessEntry(value: unknown): value is HarnessEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HarnessEntry>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name !== '' &&
    typeof candidate.port === 'number' &&
    (candidate.engine === 'dsh' || candidate.engine === 'claude-code' || candidate.engine === 'gemini')
  );
}

/** Read and validate the registry. A missing file is an empty registry, not an error. */
export async function loadRegistry(deckHome: string): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(registryPath(deckHome), 'utf8');
  } catch {
    return { version: 1, home: deckHome, harnesses: [] };
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`registro invalido em ${registryPath(deckHome)}`);
  }
  const document = parsed as Partial<Registry>;
  const list = Array.isArray(document.harnesses) ? document.harnesses : [];
  return {
    version: typeof document.version === 'number' ? document.version : 1,
    home: typeof document.home === 'string' ? document.home : deckHome,
    harnesses: list.filter(isHarnessEntry),
  };
}
