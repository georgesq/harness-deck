/**
 * Drift check for the shared modules.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/shared-copy.test.ts
 *
 * The VS Code extension compiles its own copies of `src/process.ts` and
 * `src/registry.ts` (see `scripts/sync-shared.mjs`), because the extension host
 * cannot import across packages. A copy that silently drifts is exactly the bug
 * this whole task fixes — two front ends disagreeing about what "stopped" means,
 * or about which models a harness offers — so the copies are compared byte for
 * byte here.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', '..', 'harness-deck-vscode', 'src', 'shared');

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

for (const name of ['process.ts', 'registry.ts']) {
  const [source, mirrored] = await Promise.all([
    readFile(join(here, '..', 'src', name), 'utf8'),
    readFile(join(shared, name), 'utf8'),
  ]);
  assert.equal(
    mirrored,
    source,
    `a cópia em packages/harness-deck-vscode/src/shared/${name} divergiu; rode \`npm run sync-shared\``,
  );
  ok(`a cópia compartilhada de ${name} está idêntica à canônica`);
}

process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
