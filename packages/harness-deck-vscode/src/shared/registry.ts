/**
 * harness-deck launcher — the harness registry.
 *
 * The registry is the single source of truth for "which harnesses exist on
 * this machine". Each entry is one DSH profile, one process, one port and one
 * DSH_HOME; that shape is what the owner chose for path A of docs/plano.md
 * ("one process per harness"). Path B (a single router factory) will read the
 * same registry, so nothing here is specific to path A except the launcher.
 *
 * The file is JSON, not YAML, on purpose: the DSH profile files next to it are
 * YAML, but the registry is written by a tool, and JSON needs no parser
 * dependency to be read back.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Name of the environment variable that overrides the harness-deck home. */
export const HARNESS_DECK_HOME_ENV = 'HARNESS_DECK_HOME';

/** Default harness-deck home. The product lives here, never in `~/.dsh` (REQ-03). */
export const DEFAULT_HARNESS_DECK_HOME = join(homedir(), '.harnessdeck');

/** File name of the registry inside the harness-deck home. */
export const REGISTRY_FILE = 'harnesses.json';

/**
 * File name of the credential file inside the harness-deck home.
 *
 * The owner decided on 12/10/2026 that the provider keys live here and only
 * here: neither the VS Code extension host nor the process that boots the DSH
 * inherits an interactive shell, so a key in `~/.bashrc` reaches nobody. Both
 * the CLI and the panel read this file and hand the values to the harness
 * process. The file is never written by this tool and never committed.
 */
export const ENV_FILE = '.env';

/** Current registry schema version. */
export const REGISTRY_VERSION = 1;

/** Engine that runs a harness' agent. */
export type HarnessEngine = 'dsh' | 'claude-code' | 'gemini';

/**
 * Provider route a harness uses.
 *
 * The DSH needs a *registered* provider route even when the engine ignores it:
 * `agent-default-model` and `llm-pi-ai` are mounted from the profile patch, and
 * the ACP bridge hands the actual model call to `claude-agent-acp`. Declaring
 * the route here is what makes a freshly registered harness boot without a
 * hand-written patch.
 */
export interface HarnessProvider {
  /**
   * Route id, as `llm-pi-ai` names it: `openrouter`, `anthropic`, `deepseek`,
   * `google`, and every other route the installed pi-ai catalog ships.
   *
   * It is not a closed set on purpose. The deck has to work on a network where
   * the provider of the moment does not answer — an offline machine, a local
   * endpoint, a company gateway — and the way out is pointing a harness at
   * another route, not editing the deck's source (owner's decision of
   * 13/10/2026). A route the catalog does not know is accepted too, as long as
   * {@link baseUrl} and {@link api} say what it speaks.
   */
  kind: string;
  /**
   * Model the harness starts on, as the provider names it
   * (e.g. `anthropic/claude-sonnet-5.5`).
   *
   * This is the *default*, not the only choice: {@link models} is what the
   * DSH model selector offers. Kept as its own field because it is also the
   * harness' initial selection and the value older registries carry alone.
   */
  model: string;
  /**
   * Every model the DSH model selector offers for this provider, as the
   * provider names them.
   *
   * The owner decided on 12/10/2026 that this list is the harness' own
   * settings — the deck is the source of truth, not the CLI's built-in
   * catalog. A missing list means "only {@link model}", so a registry written
   * before this field existed keeps working unchanged.
   */
  models?: string[];
  /** Environment variable holding the key. Never the key itself. */
  apiKeyEnv: string;
  /** Base URL; defaults to the well-known one for the kind. */
  baseUrl?: string;
  /**
   * Wire protocol for a route the installed catalog does not describe.
   *
   * `llm-pi-ai` refuses a model whose route it cannot place (`needs an api; the
   * installed catalog does not describe it`), so a local endpoint has to say
   * what it speaks. Omitted means `openai-completions`, which is what every
   * OpenAI-compatible server speaks.
   */
  api?: string;
}

/** What the deck knows about a provider route out of the box. */
export interface ProviderRoute {
  /** Default base URL, when the route has one. */
  baseUrl?: string;
  /** Default wire protocol. */
  api: string;
  /** Environment variable holding the key, when the route takes one. */
  apiKeyEnv?: string;
}

/**
 * Well-known provider routes, and the default wire protocol of everything else.
 *
 * The route list itself belongs to the installed pi-ai catalog and is not copied
 * here: a pi-ai upgrade that adds a route must not need a change in the deck.
 * This table only carries the defaults a route cannot be asked for at runtime.
 */
export const PROVIDER_ROUTES: Record<string, ProviderRoute> = {
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions', apiKeyEnv: 'OPENROUTER_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', apiKeyEnv: 'GEMINI_API_KEY' },
  // A local server usually wants no key at all; the harness passes whatever the
  // variable holds, and an empty one is what makes it work without credentials.
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', api: 'openai-completions' },
};

/** Wire protocol of a route, defaulting to the OpenAI-compatible one. */
export function providerApi(kind: string, declared?: string): string {
  return declared ?? PROVIDER_ROUTES[kind]?.api ?? 'openai-completions';
}

/** Well-known base URLs of each provider route. */
export const PROVIDER_BASE_URLS: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(PROVIDER_ROUTES).map(([kind, route]) => [kind, route.baseUrl]),
);

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
 * The list is the harness' own settings (owner's decision of 12/10/2026), so
 * the registry is what the DSH model selector shows. A block without
 * {@link HarnessProvider.models} yields exactly its {@link HarnessProvider.model},
 * which is how a registry written before that field existed keeps behaving.
 *
 * @param provider - the provider block of one harness.
 * @returns provider slugs in selector order; empty when the block has no model.
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
 * The CLI refuses any model id its own hardcoded catalog does not describe, so
 * `anthropic/claude-sonnet-5.5` never reaches the wire. It is handed a catalog
 * id (`claude-sonnet-5-5`) instead, and the loopback gateway maps it back to
 * the slug. One entry per offered model, plus the cheap background model.
 *
 * @param provider - the provider block of one harness.
 * @returns catalog id to provider slug; empty when the block has no model.
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

/**
 * Environment variable each provider route reads by default.
 *
 * A route outside the table has no convention to guess at, so the caller has to
 * name the variable with `--key-env`; `PROVIDER_KEY_ENV_FALLBACK` is what a
 * registry written without one reads.
 */
export const PROVIDER_KEY_ENV: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(PROVIDER_ROUTES).map(([kind, route]) => [kind, route.apiKeyEnv]),
);

/** Variable read when the route has no known convention. */
export const PROVIDER_KEY_ENV_FALLBACK = 'LLM_API_KEY';

/** The key variable of a route, falling back to the generic one. */
export function providerKeyEnv(kind: string): string {
  return PROVIDER_KEY_ENV[kind] ?? PROVIDER_KEY_ENV_FALLBACK;
}

/**
 * Environment a harness' child process needs, derived from its provider.
 *
 * `claude-agent-acp` speaks the Anthropic wire format, so a non-Anthropic
 * provider has to arrive through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
 * The DSH side of the same process reads the provider's own variable
 * (`llm-pi-ai`'s `apiKeyEnv`), which the child inherits from the launcher's
 * environment. When the harness has an Anthropic-shaped endpoint of its own
 * (`providerBaseUrl`), that wins.
 *
 * @param entry - the harness being started.
 * @param fromFile - variables read from the deck `.env`, which fill in a key the
 *   caller's own environment does not have.
 */
export function providerEnv(entry: HarnessEntry, fromFile: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (entry.providerBaseUrl) {
    env.ANTHROPIC_BASE_URL = entry.providerBaseUrl;
    return env;
  }
  if (entry.engine === 'gemini' && entry.provider) {
    const key = process.env[entry.provider.apiKeyEnv] ?? fromFile[entry.provider.apiKeyEnv];
    const baseUrl = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
    if (baseUrl) {
      env.GEMINI_BASE_URL = baseUrl;
      env.GOOGLE_BASE_URL = baseUrl;
      env.GOOGLE_GEMINI_BASE_URL = baseUrl;
    }
    if (key) {
      env.GEMINI_API_KEY = key;
      env.GOOGLE_API_KEY = key;
    }
    if (entry.provider.model) {
      env.GEMINI_MODEL = entry.provider.model;
      env.HARNESS_DECK_MODEL_MAP = JSON.stringify(modelMap(entry.provider));
      env.HARNESS_DECK_UPSTREAM_URL = baseUrl;
      if (key) env.HARNESS_DECK_UPSTREAM_KEY = key;
    }
    return env;
  }
  if (entry.engine !== 'claude-code' || !entry.provider) return env;
  const key = process.env[entry.provider.apiKeyEnv] ?? fromFile[entry.provider.apiKeyEnv];
  const baseUrl = entry.provider.baseUrl ?? PROVIDER_BASE_URLS[entry.provider.kind];
  env.ANTHROPIC_BASE_URL = baseUrl;
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

/** Environment variable each engine falls back to when no provider names one. */
export const DEFAULT_KEY_ENV: Record<HarnessEngine, string> = {
  dsh: 'DEEPSEEK_API_KEY',
  'claude-code': 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

/**
 * Environment variable that holds a harness' credential.
 *
 * The provider block wins (that is the route the DSH and the bridge actually
 * call); `providerApiKeyEnv` is the explicit per-harness override, and the
 * engine default is the last resort.
 *
 * @param entry - the harness whose credential variable is wanted.
 * @returns the name of the variable, never the value.
 */
export function credentialEnv(entry: HarnessEntry): string {
  return entry.providerApiKeyEnv ?? entry.provider?.apiKeyEnv ?? DEFAULT_KEY_ENV[entry.engine];
}

/** Absolute path of the log file of one harness. */
export function harnessLogPath(home: string, entry: HarnessEntry): string {
  return join(runtimeDir(home), entry.name, 'dsh.log');
}

/** Absolute path of the pid file of one harness. */
export function harnessPidPath(home: string, entry: HarnessEntry): string {
  return join(runtimeDir(home), entry.name, 'dsh.pid');
}

/** Absolute path of the Web GUI of one harness. */
export function harnessUrl(entry: HarnessEntry): string {
  return `http://127.0.0.1:${entry.port}`;
}

/** Default provider of a newly registered harness. */
export const DEFAULT_PROVIDER: HarnessProvider = {
  kind: 'openrouter',
  model: 'deepseek/deepseek-v4.1-flash',
  apiKeyEnv: 'OPENROUTER_API_KEY',
};

/** One registered harness. */
export interface HarnessEntry {
  /** Unique, human-typed name; also the DSH profile name and the log directory name. */
  name: string;
  /** DSH profile directory under `<home>/profiles/<profile>`. Defaults to `name`. */
  profile: string;
  /**
   * DSH_HOME of this harness. Defaults to `<deck home>/homes/<name>`.
   *
   * This — not the profile — is what isolates workspaces and sessions (REQ-02):
   * `storages/workspace.json`, `sessions/` and the session projection all hang
   * off `resolveDshHome()`, so two profiles inside one DSH_HOME share one
   * workspace list. See docs/plano.md item 2.2.
   */
  home?: string;
  /** Web GUI port of this harness' process. */
  port: number;
  /** Which engine backs the agent. */
  engine: HarnessEngine;
  /** Provider route written into the profile patch. */
  provider?: HarnessProvider;
  /** Optional base URL of the model provider (Anthropic-shaped, e.g. the OpenRouter endpoint). */
  providerBaseUrl?: string;
  /** Optional environment variable holding this harness' credential (never the value itself). */
  providerApiKeyEnv?: string;
  /** False keeps the entry in the registry but out of `up`/`down`. */
  enabled: boolean;
  /** Free-form note shown by `list`. */
  note?: string;
}

/** Whole registry document. */
export interface Registry {
  version: number;
  /** Absolute path of the harness-deck home this registry belongs to. */
  home: string;
  harnesses: HarnessEntry[];
}

/** Resolve the harness-deck home from the flag, the environment, or the default. */
export function resolveHome(home?: string): string {
  const fromFlag = home?.trim();
  if (fromFlag) return resolve(expandTilde(fromFlag));
  const fromEnv = process.env[HARNESS_DECK_HOME_ENV]?.trim();
  if (fromEnv) return resolve(expandTilde(fromEnv));
  return DEFAULT_HARNESS_DECK_HOME;
}

/** Expand a leading `~` (and `~/`) against the OS home. */
export function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** Absolute path of the registry file inside a harness-deck home. */
export function registryPath(home: string): string {
  return join(home, REGISTRY_FILE);
}

/** Absolute path of the credential file inside a harness-deck home. */
export function envFilePath(home: string): string {
  return join(home, ENV_FILE);
}

/**
 * Read the credential file of a harness-deck home.
 *
 * Format is the shell `KEY=value` one, which is what `.env` files already are;
 * `export` prefixes, surrounding quotes and `#` comments are accepted so a file
 * copied from a shell profile keeps working. A missing file is empty, not an
 * error: a harness with no provider needs no key.
 *
 * @param home - the harness-deck home.
 * @returns the parsed variables; never the file's own text.
 */
export async function loadEnvFile(home: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(envFilePath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new RegistryError(`cannot read ${envFilePath(home)}: ${(error as Error).message}`);
  }
  return parseEnvFile(raw);
}

/** Parse the `KEY=value` text of a `.env` file. */
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
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** Absolute path of the profiles directory inside a harness-deck home. */
export function profilesDir(home: string): string {
  return join(home, 'profiles');
}

/** Absolute path of the per-harness DSH_HOME directories inside a harness-deck home. */
export function harnessesHome(home: string): string {
  return join(home, 'homes');
}

/**
 * DSH_HOME of one harness: the registry value, or `<deck home>/homes/<name>`.
 *
 * One DSH_HOME per harness is what keeps workspaces and sessions apart
 * (REQ-02); see the {@link HarnessEntry.home} note.
 */
export function harnessHome(deckHome: string, entry: HarnessEntry): string {
  return entry.home?.trim() ? resolve(expandTilde(entry.home.trim())) : join(harnessesHome(deckHome), entry.name);
}

/** Absolute path of a harness' DSH profile directory (`<DSH_HOME>/profiles/<profile>`). */
export function harnessProfileDir(deckHome: string, entry: HarnessEntry): string {
  return join(harnessHome(deckHome, entry), 'profiles', entry.profile);
}

/** Absolute path of the runtime directory (pid and log files) inside a harness-deck home. */
export function runtimeDir(home: string): string {
  return join(home, '.run');
}

/** Thrown when the harness-deck home is missing or unreadable. */
export class RegistryError extends Error {}

/**
 * Read the registry. A missing file is an empty registry, not an error: the
 * first `harness-deck add` creates it.
 */
export async function loadRegistry(home: string): Promise<Registry> {
  const path = registryPath(home);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: REGISTRY_VERSION, home, harnesses: [] };
    }
    throw new RegistryError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  return normalizeRegistry(parsed, home, path);
}

/** Validate and complete a parsed registry document. */
export function normalizeRegistry(parsed: unknown, home: string, path = registryPath(home)): Registry {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RegistryError(`${path}: expected a JSON object`);
  }
  const document = parsed as Partial<Registry>;
  const harnesses = document.harnesses ?? [];
  if (!Array.isArray(harnesses)) throw new RegistryError(`${path}: "harnesses" must be an array`);
  const seen = new Set<string>();
  const normalized = harnesses.map((entry, index) => {
    const where = `${path}: harnesses[${index}]`;
    if (typeof entry !== 'object' || entry === null) throw new RegistryError(`${where}: expected an object`);
    const candidate = entry as Partial<HarnessEntry>;
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
      throw new RegistryError(`${where}: "name" must be a non-empty string`);
    }
    const name = candidate.name.trim();
    if (seen.has(name)) throw new RegistryError(`${where}: duplicate harness name "${name}"`);
    seen.add(name);
    const engine = candidate.engine ?? 'dsh';
    if (engine !== 'dsh' && engine !== 'claude-code' && engine !== 'gemini') {
      throw new RegistryError(`${where}: "engine" must be "dsh", "claude-code", or "gemini", got "${String(engine)}"`);
    }
    const port = candidate.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RegistryError(`${where}: "port" must be an integer between 1 and 65535`);
    }
    return {
      name,
      profile: typeof candidate.profile === 'string' && candidate.profile.trim() !== '' ? candidate.profile.trim() : name,
      home: typeof candidate.home === 'string' && candidate.home.trim() !== '' ? resolve(expandTilde(candidate.home.trim())) : undefined,
      port,
      engine,
      ...(normalizeProvider(candidate.provider, where) ?? {}),
      ...(candidate.providerBaseUrl ? { providerBaseUrl: candidate.providerBaseUrl } : {}),
      ...(candidate.providerApiKeyEnv ? { providerApiKeyEnv: candidate.providerApiKeyEnv } : {}),
      enabled: candidate.enabled !== false,
      ...(candidate.note ? { note: candidate.note } : {}),
    } satisfies HarnessEntry;
  });
  return { version: document.version ?? REGISTRY_VERSION, home, harnesses: normalized };
}

/** Write the registry back, creating the home directory when needed. */
export async function saveRegistry(registry: Registry): Promise<string> {
  const path = registryPath(registry.home);
  await mkdir(dirname(path), { recursive: true });
  const document: Registry = { ...registry, version: REGISTRY_VERSION, home: registry.home };
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

/** Validate the optional provider block of a registry entry. */
export function normalizeProvider(value: unknown, where: string): { provider: HarnessProvider } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new RegistryError(`${where}: "provider" must be an object`);
  const candidate = value as Partial<HarnessProvider>;
  const kind = candidate.kind;
  // A route id goes straight into the generated YAML as a key, so the shape is
  // checked even though the set of names is not.
  if (typeof kind !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(kind)) {
    throw new RegistryError(`${where}: provider.kind must be a route id like "openrouter" or "local-gw", got "${String(kind)}"`);
  }
  if (typeof candidate.model !== 'string' || candidate.model.trim() === '') {
    throw new RegistryError(`${where}: provider.model must be a non-empty string`);
  }
  const baseUrl = candidate.baseUrl;
  const api = candidate.api;
  // pi-ai refuses a model on a route its catalog does not describe unless the
  // route says where to call and what to speak. Catching it here turns a boot
  // failure inside the harness into a message naming the field at fault.
  if (PROVIDER_ROUTES[kind] === undefined && (!baseUrl || !api)) {
    throw new RegistryError(
      `${where}: provider.kind "${kind}" is not a route the installed catalog knows, so it needs "baseUrl" and "api"`,
    );
  }
  const apiKeyEnv = typeof candidate.apiKeyEnv === 'string' && candidate.apiKeyEnv.trim() !== ''
    ? candidate.apiKeyEnv.trim()
    : providerKeyEnv(kind);
  const models = normalizeModels(candidate.models, `${where}: provider.models`);
  return {
    provider: {
      kind,
      model: candidate.model.trim(),
      ...(models === undefined ? {} : { models }),
      apiKeyEnv,
      ...(baseUrl ? { baseUrl } : {}),
      ...(api ? { api } : {}),
    },
  };
}

/**
 * Validate the optional `provider.models` list.
 *
 * Absent means "only `provider.model`" and stays absent, so the registry keeps
 * the shape it had before the field existed. A present-but-empty list is a
 * mistake worth reporting rather than a silent fallback.
 */
function normalizeModels(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RegistryError(`${where} must be an array of model ids`);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new RegistryError(`${where}[${index}] must be a non-empty string`);
    }
    const slug = entry.trim();
    if (seen.has(slug)) continue;
    seen.add(slug);
    models.push(slug);
  }
  if (models.length === 0) throw new RegistryError(`${where} must not be empty (drop the field to offer only provider.model)`);
  return models;
}

/** Find one harness by name; returns undefined when absent. */
export function findHarness(registry: Registry, name: string): HarnessEntry | undefined {
  return registry.harnesses.find((entry) => entry.name === name);
}

/** Add or replace a harness entry. */
export function upsertHarness(registry: Registry, entry: HarnessEntry): Registry {
  const harnesses = registry.harnesses.filter((candidate) => candidate.name !== entry.name);
  harnesses.push(entry);
  harnesses.sort((a, b) => a.name.localeCompare(b.name));
  return { ...registry, harnesses };
}

/** Remove a harness by name; returns the removed entry when there was one. */
export function removeHarness(registry: Registry, name: string): { registry: Registry; removed?: HarnessEntry } {
  const removed = findHarness(registry, name);
  return {
    registry: { ...registry, harnesses: registry.harnesses.filter((entry) => entry.name !== name) },
    ...(removed ? { removed } : {}),
  };
}

/** True when the port is already taken by another enabled harness. */
export function portOwner(registry: Registry, port: number, exceptName?: string): HarnessEntry | undefined {
  return registry.harnesses.find((entry) => entry.port === port && entry.name !== exceptName);
}
