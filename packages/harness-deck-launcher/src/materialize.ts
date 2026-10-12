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
import { harnessProfileDir, providerModels, PROVIDER_BASE_URLS, type HarnessEntry } from './registry.ts';
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
 * it exists and the registry only seeds it.
 *
 * The two owned rows are not equally owned, and treating them alike is a bug
 * that hides the model list (found by running, 12/10/2026):
 *
 * - `agent-default-model` is **entirely** the harness'. Its `model` is what the
 *   owner picked in the selector, so the row on disk wins outright.
 * - `llm-pi-ai` is **half** ours. Its `models` array is the deck's settings —
 *   the list the selector offers, which only changes when the registry changes
 *   — so it is always regenerated. Anything else the DSH may have written into
 *   that row (a credential reference, say) is carried over, because that part
 *   belongs to the harness.
 *
 * Every other row stays ours and is refreshed from the registry.
 *
 * @param generated - the patch this registry entry produces.
 * @param existing - the patch currently on disk.
 * @returns the merged patch.
 */
export function mergeProfilePatch(generated: string, existing: string): string {
  const generatedSplit = splitPatchBlocks(generated);
  const existingSplit = splitPatchBlocks(existing);
  const existingBlocks = indexPatchBlocks(existingSplit.blocks);
  const blocks: string[] = [];
  for (const block of generatedSplit.blocks) {
    const onDisk = block.id === undefined ? undefined : existingBlocks.get(block.id);
    if (onDisk === undefined) {
      blocks.push(block.text);
      continue;
    }
    // The user's model choice survives; the offered list is ours.
    if (block.id === 'agent-default-model') {
      blocks.push(onDisk);
      continue;
    }
    if (block.id === 'llm-pi-ai') {
      blocks.push(mergeProviderRoute(block.text, onDisk));
      continue;
    }
    blocks.push(block.text);
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

/**
 * Merge the `llm-pi-ai` row: our model list, the harness' everything else.
 *
 * The row is a nested YAML document, and only the `models:` list is the deck's
 * to own. The list is replaced wholesale (it is settings, and the DSH replaces
 * it wholesale too), while keys the DSH may have added to the same route — a
 * credential reference, a retry policy — are carried over from disk. A route
 * the harness added for another provider is kept as well, since this generator
 * only ever writes the one provider of the registry entry.
 *
 * The list is located by indentation rather than by parsing YAML: the shape is
 * the one this generator writes, and pulling in a parser for one row would put
 * a dependency in the launcher's path for a file it already generates by hand.
 *
 * @param generated - the row this registry entry produces.
 * @param onDisk - the row currently in the profile.
 * @returns the merged row.
 */
export function mergeProviderRoute(generated: string, onDisk: string): string {
  const generatedModels = extractModelsList(generated);
  const diskModels = extractModelsList(onDisk);
  if (generatedModels === undefined || diskModels === undefined) return onDisk;
  // The generated row already carries our keys (`apiKeyEnv`, `api`, `baseURL`)
  // and our list. Only keys the harness added on disk are appended, right
  // before the list, so they sit under the same provider route.
  const extras = routeExtras(onDisk, diskModels);
  if (extras.length === 0) return generated;
  const lines = generated.split('\n');
  return [
    ...lines.slice(0, generatedModels.start),
    ...extras,
    ...lines.slice(generatedModels.start),
  ].join('\n');
}

/** The `models:` list of a provider route row, with the lines it spans. */
interface ModelsList {
  /** Index of the `models:` line. */
  start: number;
  /** Index one past the last line belonging to the list. */
  end: number;
  /** The list's lines, joined. */
  text: string;
}

/**
 * Locate the `models:` list inside a route row.
 *
 * @param block - the `llm-pi-ai` row text.
 * @returns the list and its span, or undefined when the row has no list.
 */
function extractModelsList(block: string): ModelsList | undefined {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => /^\s+models:\s*$/.test(line));
  if (start < 0) return undefined;
  const indent = lines[start]!.search(/\S/);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.trim() === '') break;
    const lineIndent = line.search(/\S/);
    // A list item sits deeper than `models:`; anything at or above it ends the
    // list (the next route key, or the next provider).
    if (lineIndent <= indent) break;
    end += 1;
  }
  return { start, end, text: lines.slice(start, end).join('\n') };
}

/**
 * Route keys the harness owns, to re-apply under the generated route.
 *
 * Only the keys that sit beside `apiKeyEnv` — that is, the direct children of
 * the provider route — are considered. Everything above them (`id`, `name`,
 * `config`, `providers`, the provider name) is structure this generator owns,
 * and treating it as an "extra" would splice the row into itself on the second
 * merge. Returned as raw lines so a nested key keeps its own indentation.
 */
function routeExtras(onDisk: string, diskModels: ModelsList): string[] {
  const ours = new Set(['apiKeyEnv', 'api', 'baseURL']);
  const lines = onDisk.split('\n');
  const withoutModels = [...lines.slice(0, diskModels.start), ...lines.slice(diskModels.end)];
  // The provider's own key sits one level above the route keys; `models:` and
  // `apiKeyEnv` share the same indentation, so that is the level to match.
  const routeIndent = lines[diskModels.start]!.search(/\S/);
  const extras: string[] = [];
  for (let index = 0; index < withoutModels.length; index += 1) {
    const line = withoutModels[index]!;
    if (line.search(/\S/) !== routeIndent) continue;
    const key = /^\s+([A-Za-z_][A-Za-z0-9_]*):/.exec(line)?.[1];
    if (key === undefined || ours.has(key)) continue;
    // A key with a nested block carries its children along.
    extras.push(line);
    while (index + 1 < withoutModels.length) {
      const next = withoutModels[index + 1]!;
      if (next.trim() === '' || next.search(/\S/) <= routeIndent) break;
      index += 1;
      extras.push(withoutModels[index]!);
    }
  }
  return extras;
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
  ];
  const head = lines.length;
  if (entry.engine === 'claude-code') {
    lines.push(
      '# One AgentFactory per DSH process: the Claude Code engine disables the',
      '# default loop and inserts the ACP bridge here.',
      '- id: agent-loop',
      '  disabled: true',
      '',
      '- insert:',
      `    - id: ${CLAUDE_CODE_PLUGIN}`,
      `      name: ${CLAUDE_CODE_PLUGIN}`,
      '',
    );
  }
  if (entry.providerBaseUrl) {
    lines.push(`# Provider endpoint for this harness (from the registry).`);
    lines.push(`# Set ${entry.providerApiKeyEnv ?? 'ANTHROPIC_API_KEY'} in the environment before \`up\`.`);
  }
  if (entry.provider) {
    const baseUrl = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
    const provider = entry.provider;
    // Every offered model is registered, not just the default: the DSH model
    // selector is built from `llm.listModels()` (`dsh-api-session-controller`,
    // `buildModelCatalog`), so a provider that advertises one model offers
    // exactly one choice. The owner decided on 12/10/2026 that this list is
    // the harness' settings, not the CLI's own built-in catalog.
    const modelRows = providerModels(provider).flatMap((slug) => [
      `          - id: ${slug}`,
      `            name: ${provider.kind}/${slug.split('/').at(-1) ?? slug}`,
      '            contextWindow: 1048576',
      '            maxTokens: 262144',
    ]);
    lines.push(
      entry.engine === 'claude-code'
        ? '# Provider route. The bridge hands the model call to claude-agent-acp, but the\n# DSH still requires a registered route for the model selector and the session\n# controller to boot.'
        : '# Provider route, from the registry: this is the model the DSH engine calls.',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      `    provider: ${provider.kind}`,
      `    model: ${provider.model}`,
      '',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      `      ${provider.kind}:`,
      `        apiKeyEnv: ${provider.apiKeyEnv}`,
      '        api: openai-completions',
      `        baseURL: ${baseUrl}`,
      '        models:',
      ...modelRows,
      '',
    );
  }
  if (lines.length === head) lines.push('[]');
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
