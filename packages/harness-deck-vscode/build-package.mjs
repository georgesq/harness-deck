/**
 * Builds the VS Code extension and packages it as a .vsix.
 *
 * A .vsix is a zip whose entries live under `extension/`, so no packaging tool
 * is needed: only the compiler that is already a devDependency. Files that must
 * not ship (`src/`, `test/`, `node_modules/`, source maps) are excluded by
 * allow-list.
 *
 * Usage: node build-package.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const vsixName = `${pkg.name}-${pkg.version}.vsix`;
const outDir = join(here, 'dist');
const vsixPath = join(outDir, vsixName);

// The compiler may live in this package or in a sibling package's tree.
const require = createRequire(import.meta.url);
const tsc = (() => {
  for (const candidate of ['typescript/bin/tsc', '../harness-deck-claude-code/node_modules/typescript/bin/tsc']) {
    try {
      return require.resolve(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('typescript nao encontrado; rode npm install neste pacote');
})();
// The stop path is one file shared with the CLI: refresh the copy before
// compiling so the .vsix never ships a stale one.
execFileSync(process.execPath, [join(here, '..', 'harness-deck-launcher', 'scripts', 'sync-shared.mjs')], {
  stdio: 'inherit',
});
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: here, stdio: 'inherit' });

for (const file of ['extension.js', 'panel.js', 'processes.js', 'registry.js', 'tree.js', 'shared/process.js']) {
  statSync(join(here, 'lib', file));
}

// Every file that ships, as a path relative to the extension root.
const entries = [];
const walk = (dir) => {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) walk(path);
    else if (!name.name.endsWith('.map')) entries.push(relative(here, path).split('\\').join('/'));
  }
};
walk(join(here, 'lib'));
walk(join(here, 'media'));
entries.push('package.json', 'README.md', 'LICENSE');
entries.sort();

// Zip through a staging tree so every entry path starts with `extension/`.
const stage = join(outDir, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'extension'), { recursive: true });
for (const entry of entries) {
  const target = join(stage, 'extension', entry);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(here, entry), target);
}

mkdirSync(outDir, { recursive: true });
rmSync(vsixPath, { force: true });
execFileSync('python3', ['-c', `
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(stage):
        for name in sorted(files):
            full = os.path.join(root, name)
            z.write(full, os.path.relpath(full, stage))
`, stage, vsixPath], { stdio: 'inherit' });
rmSync(stage, { recursive: true, force: true });

console.log(`${vsixName} (${(statSync(vsixPath).size / 1024).toFixed(1)} kB) -> ${vsixPath}`);
console.log(`arquivos: ${entries.length}`);
