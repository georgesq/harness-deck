/**
 * Workspaces of a harness — the project folders the DSH GUI lists.
 *
 * WHY THIS EXISTS: one DSH_HOME per harness (REQ-02) means the workspace list
 * lives *inside* that harness. The GUI dialog only ever registers a folder for
 * the harness whose port is open, so a folder added while looking at one
 * harness never appears in the others — the user has to register it once per
 * harness. This module does that from the deck, for one harness or for all of
 * them at once.
 *
 * THE FORMAT IS THE DSH'S, NOT OURS. The unit lives at
 * `<DSH_HOME>/storages/workspace.json` and is read by
 * `@deepseek-ai/dsh-workspace` through `@deepseek-ai/dsh-json-storage`. Two
 * consequences, both isolated here so a DSH upgrade touches one file:
 *
 * - `unit.version` must match the schema the installed DSH expects (2 today).
 *   The DSH rejects a unit whose stored version differs, so a version bump
 *   fails loud at boot instead of corrupting data.
 * - The DSH keeps the unit in memory and writes the whole document back, so a
 *   workspace added while the harness is running is **overwritten on the next
 *   write**. The caller must add with the harness stopped (or restart it).
 *
 * The path is stored canonicalized: `fs.realpath`, so a trailing slash, `..`
 * and symlinks all resolve. Two spellings of the same folder are one workspace.
 */
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { expandTilde } from './registry.ts';

/** Schema version of the workspace unit the installed DSH reads. */
export const WORKSPACE_UNIT_VERSION = 2;

/** Name of the unit inside the DSH storage directory. */
export const WORKSPACE_UNIT_FILE = 'workspace.json';

/** One workspace as the DSH stores it. Fields beyond these are preserved. */
export interface StoredWorkspace {
  path: string;
  title: string;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** The workspace unit document, with unknown keys preserved on write. */
export interface WorkspaceUnit {
  unit: { name: string; version: number };
  global: { initialized: boolean; workspaceIds: string[]; [key: string]: unknown };
  tables: { workspaces: Record<string, StoredWorkspace>; [key: string]: unknown };
  [key: string]: unknown;
}

/** Absolute path of the workspace unit of one harness' DSH_HOME. */
export function workspacesPath(dshHome: string): string {
  return join(dshHome, 'storages', WORKSPACE_UNIT_FILE);
}

/** An empty, valid unit for a DSH_HOME that never booted. */
function emptyUnit(): WorkspaceUnit {
  return {
    unit: { name: 'workspace', version: WORKSPACE_UNIT_VERSION },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  };
}

/** Read the unit; a missing file is an empty unit, not an error. */
export async function readWorkspaces(dshHome: string): Promise<WorkspaceUnit> {
  const path = workspacesPath(dshHome);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyUnit();
    throw error;
  }
  const parsed = JSON.parse(raw) as WorkspaceUnit;
  const version = parsed?.unit?.version;
  if (version !== WORKSPACE_UNIT_VERSION) {
    throw new Error(
      `${path}: unidade "workspace" na versão ${String(version)}, esperada ${WORKSPACE_UNIT_VERSION}. ` +
        'O DSH instalado mudou o formato; ajuste WORKSPACE_UNIT_VERSION em src/workspaces.ts.',
    );
  }
  parsed.global ??= emptyUnit().global;
  parsed.tables ??= emptyUnit().tables;
  parsed.tables.workspaces ??= {};
  return parsed;
}

/** Workspaces of one harness, in insertion order. */
export function listWorkspaces(unit: WorkspaceUnit): StoredWorkspace[] {
  return unit.global.workspaceIds
    .map((id) => unit.tables.workspaces[id])
    .filter((workspace): workspace is StoredWorkspace => workspace !== undefined);
}

/** Atomic write through a sibling temp file, so a crash cannot truncate the unit. */
export async function writeWorkspaces(dshHome: string, unit: WorkspaceUnit): Promise<void> {
  const path = workspacesPath(dshHome);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(unit, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** Result of registering one folder in one harness. */
export interface AddWorkspaceResult {
  /** Canonical absolute path that was stored. */
  path: string;
  /** True when the folder was already registered (nothing was written). */
  existing: boolean;
}

/**
 * Register a folder as a workspace of one harness' DSH_HOME.
 *
 * @param dshHome - DSH_HOME of the harness (the isolation boundary of REQ-02).
 * @param folder - Folder to register; must exist.
 * @param title - Title to show; defaults to the folder's base name, as the DSH does.
 */
export async function addWorkspace(dshHome: string, folder: string, title?: string): Promise<AddWorkspaceResult> {
  const wanted = await realpath(resolve(expandTilde(folder)));
  const unit = await readWorkspaces(dshHome);
  const already = listWorkspaces(unit).find((workspace) => workspace.path === wanted);
  if (already !== undefined) return { path: wanted, existing: true };

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
  await writeWorkspaces(dshHome, unit);
  return { path: wanted, existing: false };
}

/** Result of unregistering one folder from one harness. */
export interface RemoveWorkspaceResult {
  /** Canonical absolute path that was targeted. */
  path: string;
  /** True when the folder was in the list and was removed. */
  removed: boolean;
  /** Sessions the workspace still held; they are dropped with it. */
  sessions: number;
}

/**
 * Unregister a folder from one harness' DSH_HOME.
 *
 * The whole record goes, sessions included: the DSH keeps a session's own data
 * under its id, so dropping the workspace only removes it from the list. A
 * folder that is not registered is not an error — the answer says so.
 */
export async function removeWorkspace(dshHome: string, folder: string): Promise<RemoveWorkspaceResult> {
  const wanted = await realpath(resolve(expandTilde(folder)));
  const unit = await readWorkspaces(dshHome);
  const id = unit.global.workspaceIds.find((candidate) => unit.tables.workspaces[candidate]?.path === wanted);
  if (id === undefined) return { path: wanted, removed: false, sessions: 0 };

  const sessions = unit.tables.workspaces[id]?.sessionIds.length ?? 0;
  delete unit.tables.workspaces[id];
  unit.global.workspaceIds = unit.global.workspaceIds.filter((candidate) => candidate !== id);
  await writeWorkspaces(dshHome, unit);
  return { path: wanted, removed: true, sessions };
}
