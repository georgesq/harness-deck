/**
 * Workspaces of a harness, from the VS Code side.
 *
 * This is the same unit the launcher reads and writes
 * (`packages/harness-deck-launcher/src/workspaces.ts`), kept as a second small
 * implementation on purpose: the extension has no runtime dependency on the
 * launcher package, and both sides fail loud if the DSH changes the format.
 *
 * One DSH_HOME per harness means each harness owns its list, so the panel
 * offers "add to this harness" and "add to all of them" — the second is what
 * saves the user from registering the same folder once per harness.
 */
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { expandTilde, harnessHome, type HarnessEntry } from './registry';

/** Schema version of the workspace unit the installed DSH reads. */
export const WORKSPACE_UNIT_VERSION = 2;

interface StoredWorkspace {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceUnit {
  unit: { name: string; version: number };
  global: { initialized: boolean; workspaceIds: string[]; [key: string]: unknown };
  tables: { workspaces: Record<string, StoredWorkspace>; [key: string]: unknown };
  [key: string]: unknown;
}

/** Absolute path of one harness' workspace unit. */
export function workspacesPath(deckHome: string, entry: HarnessEntry): string {
  return join(harnessHome(deckHome, entry), 'storages', 'workspace.json');
}

function emptyUnit(): WorkspaceUnit {
  return {
    unit: { name: 'workspace', version: WORKSPACE_UNIT_VERSION },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  };
}

async function readUnit(path: string): Promise<WorkspaceUnit> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyUnit();
    throw error;
  }
  const parsed = JSON.parse(raw) as WorkspaceUnit;
  if (parsed?.unit?.version !== WORKSPACE_UNIT_VERSION) {
    throw new Error(
      `${path}: unidade "workspace" na versão ${String(parsed?.unit?.version)}, esperada ` +
        `${WORKSPACE_UNIT_VERSION}. O DSH instalado mudou o formato.`,
    );
  }
  parsed.global ??= emptyUnit().global;
  parsed.tables ??= emptyUnit().tables;
  parsed.tables.workspaces ??= {};
  return parsed;
}

async function writeUnit(path: string, unit: WorkspaceUnit): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(unit, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Folders already registered in one harness, canonicalized. */
export async function listPaths(deckHome: string, entry: HarnessEntry): Promise<string[]> {
  const unit = await readUnit(workspacesPath(deckHome, entry));
  return unit.global.workspaceIds
    .map((id) => unit.tables.workspaces[id]?.path)
    .filter((path): path is string => path !== undefined);
}

/** Whether one harness already lists this folder. */
export async function hasWorkspace(deckHome: string, entry: HarnessEntry, folder: string): Promise<boolean> {
  const wanted = await realpath(resolve(expandTilde(folder)));
  return (await listPaths(deckHome, entry)).includes(wanted);
}

/** Register a folder in one harness. Returns the canonical path stored. */
export async function addWorkspace(
  deckHome: string,
  entry: HarnessEntry,
  folder: string,
  title?: string,
): Promise<{ path: string; existing: boolean }> {
  const wanted = await realpath(resolve(expandTilde(folder)));
  const path = workspacesPath(deckHome, entry);
  const unit = await readUnit(path);
  const already = unit.global.workspaceIds.some((id) => unit.tables.workspaces[id]?.path === wanted);
  if (already) return { path: wanted, existing: true };

  const now = new Date().toISOString();
  const id = randomUUID();
  unit.tables.workspaces[id] = {
    path: wanted,
    title: title?.trim() ? title.trim() : basename(wanted),
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  unit.global.workspaceIds.push(id);
  await writeUnit(path, unit);
  return { path: wanted, existing: false };
}

/** Unregister a folder from one harness. */
export async function removeWorkspace(
  deckHome: string,
  entry: HarnessEntry,
  folder: string,
): Promise<{ path: string; removed: boolean }> {
  const wanted = await realpath(resolve(expandTilde(folder)));
  const path = workspacesPath(deckHome, entry);
  const unit = await readUnit(path);
  const id = unit.global.workspaceIds.find((candidate) => unit.tables.workspaces[candidate]?.path === wanted);
  if (id === undefined) return { path: wanted, removed: false };

  delete unit.tables.workspaces[id];
  unit.global.workspaceIds = unit.global.workspaceIds.filter((candidate) => candidate !== id);
  await writeUnit(path, unit);
  return { path: wanted, removed: true };
}
