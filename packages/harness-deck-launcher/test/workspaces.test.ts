/**
 * Workspace unit tests — no DSH, no VS Code, no network.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/workspaces.test.ts
 *
 * The point of these checks is the contract with the DSH: the unit this tool
 * writes has to be the one `@deepseek-ai/dsh-workspace` reads back, a folder
 * must not be registered twice, and a unit from a different schema version must
 * fail loud instead of being silently rewritten.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  WORKSPACE_UNIT_VERSION,
  addWorkspace,
  listWorkspaces,
  readWorkspaces,
  removeWorkspace,
  workspacesPath,
} from '../src/workspaces.ts';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

const root = await mkdtemp(join(tmpdir(), 'harness-deck-workspaces-'));
const folderA = join(root, 'projeto-a');
const folderB = join(root, 'projeto-b');
await mkdir(folderA);
await mkdir(folderB);
const dshHome = join(root, 'homes', 'claude');

// A harness that never booted has no unit: that is an empty list, not an error.
const fresh = await readWorkspaces(dshHome);
assert.deepEqual(listWorkspaces(fresh), []);
ok('DSH_HOME sem storages/workspace.json devolve lista vazia');

const added = await addWorkspace(dshHome, folderA);
assert.equal(added.existing, false);
assert.equal(added.path, folderA);
ok('adiciona a pasta e devolve o caminho canonical');

// The file has to be the DSH's own shape, or the DSH refuses to boot.
const raw = JSON.parse(await readFile(workspacesPath(dshHome), 'utf8'));
assert.equal(raw.unit.name, 'workspace');
assert.equal(raw.unit.version, WORKSPACE_UNIT_VERSION);
assert.equal(raw.global.initialized, true);
assert.equal(raw.global.workspaceIds.length, 1);
const record = raw.tables.workspaces[raw.global.workspaceIds[0]];
assert.equal(record.path, folderA);
assert.equal(record.title, 'projeto-a');
assert.deepEqual(record.sessionIds, []);
assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
ok('o arquivo sai na forma da unidade "workspace" do DSH, título = nome da pasta');

// Trailing slash and `..` are the same folder, so they are the same workspace.
const again = await addWorkspace(dshHome, `${folderA}/../projeto-a`);
assert.equal(again.existing, true);
assert.equal((await readWorkspaces(dshHome)).global.workspaceIds.length, 1);
ok('a mesma pasta escrita de outro jeito não duplica');

const titled = await addWorkspace(dshHome, folderB, 'Projeto B');
assert.equal(titled.existing, false);
const workspaces = listWorkspaces(await readWorkspaces(dshHome));
assert.deepEqual(
  workspaces.map((workspace) => workspace.title),
  ['projeto-a', 'Projeto B'],
);
ok('--title vence e a ordem de inserção é preservada');

// Removing takes the record and its session list with it, and is idempotent.
const removed = await removeWorkspace(dshHome, folderA);
assert.equal(removed.removed, true);
assert.equal(removed.sessions, 0);
assert.deepEqual(
  listWorkspaces(await readWorkspaces(dshHome)).map((workspace) => workspace.title),
  ['Projeto B'],
);
assert.equal((await removeWorkspace(dshHome, folderA)).removed, false);
ok('remove tira o workspace e repetir não é erro');

// A folder that does not exist has to fail: a workspace points at a real dir.
await assert.rejects(() => addWorkspace(dshHome, join(root, 'nao-existe')));
ok('pasta inexistente falha em vez de gravar um workspace quebrado');

// A unit from another schema version is not ours to rewrite.
const otherHome = join(root, 'homes', 'dsh');
await mkdir(join(otherHome, 'storages'), { recursive: true });
await writeFile(
  join(otherHome, 'storages', 'workspace.json'),
  JSON.stringify({ unit: { name: 'workspace', version: 1 }, global: {}, tables: {} }),
);
await assert.rejects(() => readWorkspaces(otherHome), /versão 1, esperada 2/);
ok('unidade de outra versão falha alto, com o caminho e a versão no erro');

await rm(root, { recursive: true, force: true });
process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
