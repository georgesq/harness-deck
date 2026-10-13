/**
 * Drift check for the shared stop path.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/shared-copy.test.ts
 *
 * The VS Code extension compiles its own copy of `src/process.ts` (see
 * `scripts/sync-shared.mjs`), because the extension host cannot import across
 * packages. A copy that silently drifts is exactly the bug this whole task
 * fixes — two front ends disagreeing about what "stopped" means — so the copies
 * are compared byte for byte here.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = join(here, '..', 'src', 'process.ts');
const copy = join(here, '..', '..', 'harness-deck-vscode', 'src', 'shared', 'process.ts');

const [source, mirrored] = await Promise.all([readFile(canonical, 'utf8'), readFile(copy, 'utf8')]);

assert.equal(
  mirrored,
  source,
  'a cópia em packages/harness-deck-vscode/src/shared/process.ts divergiu; rode `npm run sync-shared`',
);

process.stdout.write('ok   a cópia compartilhada do caminho de parada está idêntica à canônica\n');
process.stdout.write('\ntudo ok (1 verificação)\n');
