/**
 * Copies the shared modules into the VS Code extension.
 *
 * `src/process.ts` is the canonical copy of the stop path and `src/registry.ts`
 * of the registry contract — route ids, model lists, paths and the credential
 * variable. The CLI and the panel must take the same decision on both, and the
 * extension host compiles its own sources with `rootDir: src`, so it cannot
 * import across packages. Instead of writing the rules twice, this script copies
 * the files verbatim and `test/shared-copy.test.ts` fails when a copy drifts.
 *
 * Usage: node scripts/sync-shared.mjs
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', '..', 'harness-deck-vscode', 'src', 'shared');
mkdirSync(shared, { recursive: true });

for (const name of ['process.ts', 'registry.ts']) {
  const source = join(here, '..', 'src', name);
  const target = join(shared, name);
  copyFileSync(source, target);
  const lines = readFileSync(target, 'utf8').split('\n').length;
  process.stdout.write(`shared/${name} sincronizado (${String(lines)} linhas)\n`);
}
