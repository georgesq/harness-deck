/**
 * harness-deck launcher — profile materialization.
 *
 * A DSH profile is a directory under `<DSH_HOME>/profiles/<name>` holding
 * `package.json` (which bundles to load), `cordis.patch.yml` (the overlay that
 * picks the engine) and `node_modules` (symlinks to the plugins). This module
 * turns a registry entry into that directory, so registering a harness is a
 * command and not a hand-copy of a dev profile.
 *
 * `cordis.yml` is NOT written here: the DSH CLI generates it from the bundles
 * plus the patch on every start, and writing it by hand would go stale.
 *
 * WARNING (learned in docs/analise-inicial.md): running `dsh <profile> --help`
 * regenerates `cordis.yml`. The launcher only ever starts a profile, never
 * asks it for help.
 */
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { harnessProfileDir, PROVIDER_BASE_URLS, type HarnessEntry } from './registry.ts';
/** Bundles every harness-deck web profile loads. */
export const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const;

/** The engine plugin package name. */
export const CLAUDE_CODE_PLUGIN = 'harness-deck-claude-code';

/** Where the plugin package lives inside the repository. */
export function defaultPluginPath(repoRoot: string): string {
  return join(repoRoot, 'packages', CLAUDE_CODE_PLUGIN);
}

/** Thrown when a profile cannot be materialized. */
export class MaterializeError extends Error {}

/** Result of materializing one profile. */
export interface MaterializeResult {
  /** Absolute profile directory. */
  profileDir: string;
  /** Files created or rewritten by this call. */
  written: string[];
  /** Symlinks created or replaced by this call. */
  linked: string[];
}

/** Absolute path of a profile directory inside a harness-deck home. */
export function profileDir(home: string, entry: HarnessEntry): string {
  return harnessProfileDir(home, entry);
}

/**
 * Merge a freshly generated patch with the patch already on disk.
 *
 * The profile patch is not only ours: the DSH config editor writes the model the
 * user picked in the harness UI into the `agent-default-model` row of this very
 * file (`dsh-config-editor/lib/index.js`, which rewrites the row in place and
 * keeps everything else). Regenerating the file wholesale would silently undo
 * that choice on the next `up`, so the model row is the user's from the moment
 * it exists and the registry only seeds it. Every other row stays ours and is
 * refreshed from the registry.
 *
 * @param generated - the patch this registry entry produces.
 * @param existing - the patch currently on disk.
 * @returns the merged patch.
 */
export function mergeProfilePatch(generated: string, existing: string): string {
  const generatedSplit = splitPatchBlocks(generated);
  const existingSplit = splitPatchBlocks(existing);
  const existingBlocks = indexPatchBlocks(existingSplit.blocks);
  const keep = new Set<string>();
  // Rows owned by the running harness: the user's model choice, and the route
  // the model selector needs. Both come from the DSH side once the profile ran.
  for (const id of ['agent-default-model', 'llm-pi-ai']) {
    if (existingBlocks.has(id)) keep.add(id);
  }
  const blocks: string[] = [];
  for (const block of generatedSplit.blocks) {
    if (block.id !== undefined && keep.has(block.id)) {
      blocks.push(existingBlocks.get(block.id)!);
    } else {
      blocks.push(block.text);
    }
  }
  // Rows the DSH added that this generator does not know about.
  for (const [id, text] of existingBlocks) {
    if (!generatedSplit.blocks.some((block) => block.id === id)) blocks.push(text);
  }
  const body = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const header = generatedSplit.header === '' ? '' : `${generatedSplit.header}\n`;
  return `${header}${body === '' ? '[]' : body}\n`;
}

/** Index patch rows by plugin id, keeping the last occurrence. */
function indexPatchBlocks(blocks: PatchBlock[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const block of blocks) {
    if (block.id !== undefined) index.set(block.id, block.text);
  }
  return index;
}

/** One row of a profile patch: its plugin id, when it has one, and its text. */
interface PatchBlock {
  id?: string;
  text: string;
}

/** A profile patch split into its leading comment and its top-level rows. */
interface SplitPatch {
  header: string;
  blocks: PatchBlock[];
}

/**
 * Split a profile patch into its leading comment and its top-level rows. Only the
 * shape this generator writes is supported: one row per `- ` line at column zero,
 * its `id` on the next indented line.
 */
function splitPatchBlocks(patch: string): SplitPatch {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith('- ') || line === '-' || line === '[]');
  if (start < 0) return { header: lines.join('\n').trimEnd(), blocks: [] };
  const header = lines.slice(0, start).join('\n').trimEnd();
  const blocks: PatchBlock[] = [];
  let current: { id?: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const text = current.lines.join('\n').trimEnd();
    if (text !== '') blocks.push({ ...(current.id === undefined ? {} : { id: current.id }), text });
    current = undefined;
  };
  for (const line of lines.slice(start)) {
    if (line.startsWith('- ') || line === '-' || line === '[]') {
      flush();
      const inline = /^- id:\s*(\S+)\s*$/.exec(line);
      current = inline === null ? { lines: [line] } : { id: inline[1], lines: [line] };
      continue;
    }
    if (current === undefined) continue;
    // A row may name itself on the dash line (`- id: x`) or on the next one
    // (`- insert:` followed by an indented list, whose ids are not this row's).
    const id = current.lines.length === 1 ? /^\s+id:\s*(\S+)\s*$/.exec(line) : null;
    if (id !== null && current.id === undefined) current.id = id[1];
    current.lines.push(line);
  }
  flush();
  return { header, blocks };
}

/**
 * Body of the generated `package.json` of a profile.
 *
 * Same shape as `initProfile` in `@deepseek-ai/dsh-app-boot` (lib/index.js:576):
 * the DSH only writes this file when it is absent, so writing the identical
 * shape here is what makes the profile a first-class DSH profile and not a
 * foreign directory.
 */
export function profilePackageJson(profile: string): string {
  const document = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...WEB_BUNDLES] } },
  };
  return `${JSON.stringify(document, undefined, 2)}\n`;
}

/**
 * Body of the generated `cordis.patch.yml`.
 *
 * The DSH default engine (`agent-loop`) is disabled and the Claude Code ACP
 * bridge is inserted in its place. Both entries matter: `AgentRegistry.setFactory`
 * throws `an agent factory is already registered`, so the profile must run
 * exactly one engine. See packages/harness-deck-claude-code/src/index.ts.
 */
export function profilePatchYml(entry: HarnessEntry): string {
  const lines: string[] = [
    '# Generated by harness-deck-launcher. Edit the registry, not this file:',
    '#   harness-deck add <name> --engine <dsh|claude-code> --port <port>',
    `# harness: ${entry.name} (engine: ${entry.engine})`,
    '#',
    '# One AgentFactory per DSH process: disable the default loop and insert the',
    '# ACP bridge. For engine "dsh" this file is an empty patch.',
  ];
  if (entry.engine !== 'claude-code') {
    lines.push('[]', '');
    return lines.join('\n');
  }
  lines.push(
    '- id: agent-loop',
    '  disabled: true',
    '',
    '- insert:',
    `    - id: ${CLAUDE_CODE_PLUGIN}`,
    `      name: ${CLAUDE_CODE_PLUGIN}`,
    '',
  );
  if (entry.providerBaseUrl) {
    lines.push(`# Provider endpoint for this harness (from the registry).`);
    lines.push(`# Set ${entry.providerApiKeyEnv ?? 'ANTHROPIC_API_KEY'} in the environment before \`up\`.`);
  }
  if (entry.provider) {
    const baseUrl = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
    lines.push(
      '# Provider route. The bridge hands the model call to claude-agent-acp, but the',
      '# DSH still requires a registered route for the model selector and the session',
      '# controller to boot.',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      `    provider: ${entry.provider.kind}`,
      `    model: ${entry.provider.model}`,
      '',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      `      ${entry.provider.kind}:`,
      `        apiKeyEnv: ${entry.provider.apiKeyEnv}`,
      '        api: openai-completions',
      `        baseURL: ${baseUrl}`,
      '        models:',
      `          - id: ${entry.provider.model}`,
      `            name: ${entry.provider.kind}/${entry.provider.model.split('/').at(-1) ?? entry.provider.model}`,
      '            contextWindow: 1048576',
      '            maxTokens: 262144',
      '',
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** True when the path exists. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update the profile directory of one harness.
 *
 * Idempotent: `package.json` and `cordis.patch.yml` are rewritten from the
 * registry on every call, so the registry stays the source of truth. The
 * plugin symlink is only created for the `claude-code` engine, and an existing
 * one is replaced (never followed) so a stale link to another checkout cannot
 * survive.
 */
export async function materializeProfile(
  home: string,
  entry: HarnessEntry,
  options: { pluginPath: string },
): Promise<MaterializeResult> {
  const dir = profileDir(home, entry);
  const written: string[] = [];
  const linked: string[] = [];
  await mkdir(dir, { recursive: true });

  const packagePath = join(dir, 'package.json');
  const nextPackage = profilePackageJson(entry.profile);
  if ((await readIfExists(packagePath)) !== nextPackage) {
    await writeFile(packagePath, nextPackage, 'utf8');
    written.push(packagePath);
  }

  const patchPath = join(dir, 'cordis.patch.yml');
  const existingPatch = await readIfExists(patchPath);
  const nextPatch = existingPatch === undefined ? profilePatchYml(entry) : mergeProfilePatch(profilePatchYml(entry), existingPatch);
  if (existingPatch !== nextPatch) {
    await writeFile(patchPath, nextPatch, 'utf8');
    written.push(patchPath);
  }

  const workspacePath = join(dir, 'pnpm-workspace.yaml');
  if (!(await pathExists(workspacePath))) {
    await writeFile(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8');
    written.push(workspacePath);
  }

  if (entry.engine === 'claude-code') {
    const plugin = resolve(options.pluginPath);
    const manifest = join(plugin, 'package.json');
    if (!(await pathExists(manifest))) {
      throw new MaterializeError(
        `engine "claude-code" needs the plugin at ${plugin}, but ${manifest} is missing. ` +
          `Pass --plugin <path-to-packages/harness-deck-claude-code>.`,
      );
    }
    const built = join(plugin, 'lib', 'index.js');
    if (!(await pathExists(built))) {
      throw new MaterializeError(`${manifest} found, but ${built} is missing: run \`pnpm build\` in the plugin first.`);
    }
    const link = join(dir, 'node_modules', CLAUDE_CODE_PLUGIN);
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    await rm(link, { recursive: true, force: true });
    await symlink(plugin, link, 'dir');
    linked.push(link);
  }

  return { profileDir: dir, written, linked };
}

/** Read a file as UTF-8, or undefined when it does not exist. */
async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
