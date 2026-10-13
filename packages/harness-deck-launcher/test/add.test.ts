/**
 * `add --force` must not lose what the caller did not mention.
 *
 * The bug this covers: re-registering a harness only to fix its key variable
 * reallocated the port (3130 became 3100) and pointed the harness at a fresh
 * data folder, orphaning its workspaces. `--force` is for changing a field, not
 * for resetting the entry.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/add.test.ts
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

const home = await mkdtemp(join(tmpdir(), 'harness-deck-add-'));

/** Run the CLI against the temporary deck home. */
async function cli_(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], {
    env: { ...process.env, HARNESS_DECK_HOME: home },
  });
  return stdout;
}

/** Read the registry as the CLI wrote it. */
async function registry(): Promise<{ harnesses: Record<string, unknown>[] }> {
  return JSON.parse(await readFile(join(home, 'harnesses.json'), 'utf8')) as { harnesses: Record<string, unknown>[] };
}

/** One harness by name, as it is on disk. */
async function entry(name: string): Promise<Record<string, unknown>> {
  const found = (await registry()).harnesses.find((candidate) => candidate.name === name);
  assert.ok(found !== undefined, `harness "${name}" não está no registro`);
  return found;
}

// First registration: the port is allocated.
await cli_('add', 'teste', '--port', '3130', '--provider', 'openrouter', '--model', 'openai/gpt-5.4');
assert.equal((await entry('teste')).port, 3130);
ok('primeiro registro grava a porta pedida');

// The regression: change only the key variable.
await cli_('add', 'teste', '--force', '--key-env', 'OPENROUTER_API_KEY');
const afterKey = await entry('teste');
assert.equal(afterKey.port, 3130, 'a porta foi reescrita pelo padrão');
assert.equal(afterKey.providerApiKeyEnv, 'OPENROUTER_API_KEY');
ok('add --force --key-env não muda a porta');

// The provider and its model list survive an unrelated edit.
const provider = afterKey.provider as Record<string, unknown>;
assert.equal(provider.kind, 'openrouter');
assert.equal(provider.model, 'openai/gpt-5.4');
ok('add --force preserva provider e modelo quando ninguém os menciona');

// The data folder keeps its path, so the harness keeps its workspaces.
assert.equal(afterKey.home, join(home, 'homes', 'teste'));
ok('add --force preserva o DSH_HOME');

// An explicit flag still wins over the remembered value.
await cli_('add', 'teste', '--force', '--port', '3200', '--key-env', 'OUTRA_CHAVE');
const explicit = await entry('teste');
assert.equal(explicit.port, 3200);
assert.equal(explicit.providerApiKeyEnv, 'OUTRA_CHAVE');
ok('a flag explícita vence o valor lembrado');

// Without --force, a second add still refuses to touch an existing entry.
await assert.rejects(() => cli_('add', 'teste'), /já existe/);
ok('sem --force o add continua recusando reescrever');

await rm(home, { recursive: true, force: true });
process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
