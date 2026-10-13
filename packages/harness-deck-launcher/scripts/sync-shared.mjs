/**
 * Copies the shared process module into the VS Code extension.
 *
 * `src/process.ts` is the canonical copy of the stop path: the CLI and the panel
 * must take the same decision, and the extension host compiles its own sources
 * with `rootDir: src`, so it cannot import across packages. Instead of writing
 * the rule twice, this script copies the file verbatim and
 * `test/shared-copy.test.ts` fails when the two copies drift apart.
 *
 * Usage: node scripts/sync-shared.mjs
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'process.ts');
const target = join(here, '..', '..', 'harness-deck-vscode', 'src', 'shared', 'process.ts');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const lines = readFileSync(target, 'utf8').split('\n').length;
process.stdout.write(`shared/process.ts sincronizado (${String(lines)} linhas)\n`);
