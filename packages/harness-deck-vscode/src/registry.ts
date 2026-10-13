/**
 * Reader for the harness-deck registry.
 *
 * The registry is the same file the `harness-deck` CLI writes
 * (`<deck home>/harnesses.json`); this module only reads it. The shape is
 * duplicated on purpose: the extension is installed outside the repository and
 * cannot import from `packages/harness-deck-launcher`. Keep the two in sync —
 * the field names are the contract.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Engine that runs a harness' agent. */
export type HarnessEngine = 'dsh' | 'claude-code';

/** Provider route of a harness. */
export interface HarnessProvider {
  kind: 'openrouter' | 'deepseek';
  /** Model the harness starts on, as the provider names it. */
  model: string;
  /**
   * Every model the DSH model selector offers, default model first. Absent
   * means "only {@link model}", which is what a registry written before the
   * field existed means.
   */
  models?: string[];
  apiKeyEnv: string;
  baseUrl?: string;
}

/** One registered harness, as stored in the registry. */
export interface HarnessEntry {
  name: string;
  profile: string;
  home?: string;
  port: number;
  engine: HarnessEngine;
  provider?: HarnessProvider;
  providerBaseUrl?: string;
  providerApiKeyEnv?: string;
  enabled: boolean;
  note?: string;
}

/** Whole registry document. */
export interface Registry {
  version: number;
  home: string;
  harnesses: HarnessEntry[];
}

/** Environment variable that overrides the deck home. */
export const HOME_ENV = 'HARNESS_DECK_HOME';

/** Default deck home. */
export const DEFAULT_HOME = join(homedir(), '.harnessdeck');

/** Resolve the deck home: explicit setting, then environment, then default. */
export function resolveHome(configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) return resolve(expandTilde(explicit));
  const fromEnv = process.env[HOME_ENV]?.trim();
  if (fromEnv) return resolve(expandTilde(fromEnv));
  return DEFAULT_HOME;
}

/** Expand a leading `~` to the user's home. */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** Absolute path of the registry file. */
export function registryPath(deckHome: string): string {
  return join(deckHome, 'harnesses.json');
}

/** DSH_HOME of a harness: the registry value, or `<deck home>/homes/<name>`. */
export function harnessHome(deckHome: string, entry: HarnessEntry): string {
  const explicit = entry.home?.trim();
  return explicit ? resolve(expandTilde(explicit)) : join(deckHome, 'homes', entry.name);
}

/** Absolute path of the log the extension writes for a harness. */
export function harnessLogPath(deckHome: string, entry: HarnessEntry): string {
  return join(deckHome, '.run', entry.name, 'vscode.log');
}

/** Absolute path of the pid file of a harness. */
export function harnessPidPath(deckHome: string, entry: HarnessEntry): string {
  return join(deckHome, '.run', entry.name, 'dsh.pid');
}

/** Web GUI URL of a harness. */
export function harnessUrl(entry: HarnessEntry): string {
  return `http://127.0.0.1:${entry.port}`;
}

/** Read and validate the registry. A missing file is an empty registry, not an error. */
export async function loadRegistry(deckHome: string): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(registryPath(deckHome), 'utf8');
  } catch {
    return { version: 1, home: deckHome, harnesses: [] };
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`registro invalido em ${registryPath(deckHome)}`);
  }
  const document = parsed as Partial<Registry>;
  const list = Array.isArray(document.harnesses) ? document.harnesses : [];
  return {
    version: typeof document.version === 'number' ? document.version : 1,
    home: typeof document.home === 'string' ? document.home : deckHome,
    harnesses: list.filter(isHarnessEntry),
  };
}

/** Minimal shape check, so one bad entry cannot take down the whole view. */
function isHarnessEntry(value: unknown): value is HarnessEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<HarnessEntry>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name !== '' &&
    typeof candidate.port === 'number' &&
    (candidate.engine === 'dsh' || candidate.engine === 'claude-code')
  );
}

/** Environment variable holding a harness' credential. */
export function credentialEnv(entry: HarnessEntry): string {
  return entry.providerApiKeyEnv ?? entry.provider?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
}

/** File name of the credential file inside the harness-deck home. */
export const ENV_FILE = '.env';

/** Absolute path of the credential file inside a harness-deck home. */
export function envFilePath(deckHome: string): string {
  return join(deckHome, ENV_FILE);
}

/**
 * Read the credential file of a harness-deck home.
 *
 * The owner decided on 12/10/2026 that the provider keys live in
 * `<deck home>/.env` and only there: the VS Code extension host does not inherit
 * an interactive shell, so a key exported in `~/.bashrc` never reaches the
 * harness this panel starts. Format is shell `KEY=value`; a missing file is
 * empty, not an error.
 */
export async function loadEnvFile(deckHome: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(envFilePath(deckHome), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseEnvFile(raw);
}

/** Parse the `KEY=value` text of a `.env` file. Mirrors the launcher. */
export function parseEnvFile(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separator = body.indexOf('=');
    if (separator <= 0) continue;
    const key = body.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(separator + 1).trim();
    const quoted =
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

/**
 * Environment overrides a harness' child process needs.
 *
 * `claude-agent-acp` speaks the Anthropic wire format, so a non-Anthropic
 * provider has to arrive through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
 *
 * @param entry - the harness being started.
 * @param fromFile - variables read from the deck `.env`, which fill in a key the
 *   extension host's own environment does not have.
 */
export function providerEnv(entry: HarnessEntry, fromFile: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (entry.providerBaseUrl) {
    env.ANTHROPIC_BASE_URL = entry.providerBaseUrl;
    return env;
  }
  if (entry.engine !== 'claude-code' || !entry.provider) return env;
  const baseUrl = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
  env.ANTHROPIC_BASE_URL = baseUrl;
  const key = process.env[entry.provider.apiKeyEnv] ?? fromFile[entry.provider.apiKeyEnv];
  if (key) env.ANTHROPIC_AUTH_TOKEN = key;
  // The CLI only accepts model ids its own catalog describes, and the provider
  // only accepts its own slugs: the bridge maps one onto the other. Without
  // this the harness dies on "There's an issue with the selected model". The
  // map carries *every* offered model, because a mapped run can land on any of
  // them once the DSH model selector switches the session.
  if (entry.provider.model) {
    const catalog = catalogModelId(entry.provider.model);
    const fast = catalogModelId(FAST_MODEL_SLUG);
    env.ANTHROPIC_MODEL = catalog;
    env.ANTHROPIC_SMALL_FAST_MODEL = fast;
    env.HARNESS_DECK_MODEL_MAP = JSON.stringify(modelMap(entry.provider));
    env.HARNESS_DECK_UPSTREAM_URL = baseUrl;
    if (key) env.HARNESS_DECK_UPSTREAM_KEY = key;
  }
  return env;
}

/** Well-known base URLs, mirroring the launcher. */
export const PROVIDER_BASE_URLS: Record<HarnessProvider['kind'], string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

/**
 * Cheap model the Claude Code CLI uses for background work (titles, summaries).
 * Its own default is a Haiku id the provider does not serve.
 *
 * Owner's rule of 13/10/2026: nothing leaves through a Claude model, everything
 * runs on OpenRouter — so the background slot is DeepSeek too, not a Haiku.
 */
export const FAST_MODEL_SLUG = 'deepseek/deepseek-v4.1-flash';

/**
 * The catalog id the Claude Code CLI expects for a provider slug.
 *
 * The CLI refuses any model id this version's hardcoded catalog does not
 * describe, so `anthropic/claude-sonnet-5.5` never leaves the machine. It gets
 * `claude-sonnet-5-5` and the bridge maps it back to the slug.
 */
export function catalogModelId(slug: string): string {
  const bare = slug.slice(slug.lastIndexOf('/') + 1);
  return bare.replace(/\./g, '-');
}

/**
 * Every model a provider block offers, default first, without duplicates.
 *
 * Mirrors `harness-deck-launcher`'s helper of the same name: the extension
 * host cannot import the launcher's TypeScript sources, and this is the one
 * rule both sides must agree on, so it is duplicated deliberately.
 */
export function providerModels(provider: HarnessProvider | undefined): string[] {
  if (!provider) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const slug of [provider.model, ...(provider.models ?? [])]) {
    const trimmed = slug?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

/**
 * The catalog-id ↔ provider-slug map the Claude Code CLI needs.
 *
 * Mirrors `harness-deck-launcher`'s `modelMap`: one entry per offered model,
 * plus the cheap background model.
 */
export function modelMap(provider: HarnessProvider | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const slug of providerModels(provider)) {
    map[catalogModelId(slug)] = slug;
  }
  const fast = catalogModelId(FAST_MODEL_SLUG);
  if (!(fast in map)) map[fast] = FAST_MODEL_SLUG;
  return map;
}
