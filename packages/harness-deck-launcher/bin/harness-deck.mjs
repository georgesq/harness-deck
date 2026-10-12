#!/usr/bin/env node
/**
 * harness-deck CLI entry point.
 *
 * The sources are TypeScript with no build step: Node 24 strips the types at
 * load time. `--no-warnings` hides the one-off experimental warning so the
 * command output stays readable.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', cli, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
