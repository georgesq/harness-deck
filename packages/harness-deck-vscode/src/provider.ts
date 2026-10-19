/**
 * Configuring a provider route from the panel — route, models and key
 * variable, without a terminal.
 *
 * The panel does not write the registry: the CLI owns that file and the profile
 * patch next to it, and `harness-deck add --force` is what re-materializes the
 * profile. This module only drives the conversation and hands the answers to
 * the CLI, so the next start of the harness already boots on the new route.
 *
 * Two lists are read from the DSH installed on this machine instead of being
 * copied here, because a catalog written twice is how the panel starts offering
 * a route, a model or a protocol the harness cannot serve:
 *
 * - the **route catalog** comes from the `@earendil-works/pi-ai` build the DSH
 *   ships (`getBuiltinProviders` / `getBuiltinModels`). That package is ESM
 *   only and the extension host is CommonJS, so the catalog is read by a child
 *   process — never by importing it here;
 * - the **wire protocols** of a hand-declared route come from the `PROTOCOLS`
 *   table of the installed `@deepseek-ai/dsh-llm-pi-ai`.
 *
 * When the catalog cannot be read the flow says so and falls back to typing the
 * model id: it never puts an empty list on screen and never invents one.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { window } from 'vscode';
import {
  PROVIDER_BASE_URLS,
  PROVIDER_ROUTES,
  loadRegistry,
  providerKeyEnv,
  type HarnessEntry,
} from './registry';

/** Last option of the route pick: any route the catalog does not describe. */
const OTHER_ROUTE_LABEL = 'outra rota (informar URL e protocolo)';

/** Last option of the model pick: a slug the installed catalog does not have. */
const OTHER_MODEL_LABEL = 'outro id (digitar)';

/** Action offered once the registry has the new route. */
const RESTART_ACTION = 'Reiniciar agora';

/** Place holders that identify each step of the conversation. */
const ROUTE_PICK = 'Escolha a rota do provedor';
const PROTOCOL_PICK = 'Escolha o protocolo (api)';
const MODEL_PICK_PREFIX = 'Escolha os modelos de ';
const HARNESS_PICK = 'Escolha o harness';

/** Prompts of the input boxes, in flow order. */
const ROUTE_ID_PROMPT = 'Id da rota';
const BASE_URL_PROMPT = 'URL base da rota';
const MODEL_PROMPT = 'Id do modelo';
const MORE_MODELS_PROMPT = 'Outros modelos';
const KEY_ENV_PROMPT = 'Variavel da chave';

/** Message a required input box shows while it is empty. */
const REQUIRED_FIELD = 'Campo obrigatorio';

/** Said once when the installed pi-ai catalog cannot be read. */
const CATALOG_MISSING =
  'Nao consegui ler o catalogo de modelos do pi-ai instalado; informe o id do modelo a mao.';

/** Said when the launcher CLI is not next to this extension. */
const LAUNCHER_MISSING =
  'Nao encontrei o CLI do harness-deck (packages/harness-deck-launcher/src/cli.ts) a partir desta extensao.';

/** Said when the owner closed the model pick without choosing anything. */
const NO_MODEL = 'Nenhum modelo escolhido; nada foi gravado.';

/** Environment variable that points the launcher at the deck home. */
const HOME_ENV = 'HARNESS_DECK_HOME';

/** Relative path of the pi-ai catalog module inside a DSH installation. */
const PI_AI_CATALOG = join('node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js');

/** Relative path of the wire-protocol table inside a DSH installation. */
const PI_AI_PROTOCOLS = join('node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js');

/**
 * Child script that prints the installed catalog as one JSON document.
 *
 * The module path arrives as `argv[1]` because `-e` leaves the extra arguments
 * where a normal script would expect the first one.
 */
const CATALOG_PROBE = `const all = await import(process.argv[1]);
const providers = all.getBuiltinProviders();
const models = {};
for (const provider of providers) {
  try {
    models[provider] = all.getBuiltinModels(provider).map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
    }));
  } catch {
    models[provider] = [];
  }
}
process.stdout.write(JSON.stringify({ providers, models }));
`;

/** One model of the installed catalog, as the panel shows it. */
export interface CatalogModel {
  /** Id the provider names the model by; this is what `--model` takes. */
  id: string;
  /** Human name of the model, when the catalog has one. */
  name?: string;
  /** Wire protocol the catalog serves this model with. */
  api?: string;
  /** Endpoint the catalog calls for this model. */
  baseUrl?: string;
}

/** Route catalog of the installed pi-ai, as read at configuration time. */
export interface ProviderCatalog {
  /** Route ids the installed pi-ai ships. */
  providers: string[];
  /** Offers of each route, in catalog order. A route with no offer is absent. */
  models: Record<string, CatalogModel[]>;
}

/** What one run of the launcher CLI returned. */
export interface LauncherResult {
  /** Exit code; `-1` when the process could not even be spawned. */
  code: number;
  stdout: string;
  stderr: string;
}

/** One call of the launcher CLI: its arguments after the script path, and its env. */
export interface LauncherCall {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Runs the launcher CLI. Injected by the tests, so no child is needed. */
export type LauncherRunner = (call: LauncherCall) => Promise<LauncherResult>;

/** Reads the installed pi-ai catalog; `undefined` when it is not there. */
export type CatalogLoader = (dshCommand?: string) => Promise<ProviderCatalog | undefined>;

/** Reads the protocols the installed adapter accepts; `undefined` when absent. */
export type ProtocolLoader = (dshCommand?: string) => string[] | undefined;

/** The answers one configuration writes into the registry. */
export interface ProviderDraft {
  /** Route id, as `llm-pi-ai` names it. */
  kind: string;
  /**
   * Models the harness offers, most important first. The first is also the
   * harness' starting model; a route the catalog describes needs at least one.
   */
  models: string[];
  /** Environment variable that holds the key of that route. */
  apiKeyEnv: string;
  /** Endpoint of a route outside the catalog. */
  baseUrl?: string;
  /** Wire protocol of a route outside the catalog. */
  api?: string;
}

/** What a finished configuration did. */
export interface ConfigureOutcome {
  entry: HarnessEntry;
  /** Route now written in the registry. */
  kind: string;
  /** Variable that now holds the key of that route. */
  apiKeyEnv: string;
  /** True when the owner took the "Reiniciar agora" action. */
  restarted: boolean;
}

/** Everything the flow needs from its host window. */
export interface ConfigureOptions {
  /** Deck home whose registry and CLI the run touches. */
  home: string;
  /** Command whose installation holds the pi-ai catalog (default: `dsh`). */
  dshCommand?: string;
  /** Repo root holding `packages/harness-deck-launcher`; resolved when omitted. */
  repoRoot?: string;
  /** Node that runs the CLI. Defaults to the node running the extension host. */
  nodePath?: string;
  /** Catalog reader; the tests inject one to stand in for an install. */
  loadCatalog?: CatalogLoader;
  /** Protocol reader; the tests inject one to stand in for an install. */
  loadProtocols?: ProtocolLoader;
  /** CLI runner; the tests inject one so no child is spawned. */
  run?: LauncherRunner;
  /** Repaints the tree after a successful write. */
  refresh?: () => Promise<void> | void;
  /** Restarts a harness so the new route is what it boots with. */
  restart?: (entry: HarnessEntry) => Promise<void> | void;
}

/** Harness entry of a tree node, a bare entry, or nothing. */
function entryOf(argument: unknown): HarnessEntry | undefined {
  if (argument === undefined || argument === null || typeof argument === 'string') return undefined;
  const candidate = argument as { entry?: HarnessEntry };
  if (candidate.entry !== undefined && typeof candidate.entry.name === 'string') return candidate.entry;
  return undefined;
}

/** Keys of the deck's own route table, in table order. */
export function knownRoutes(): string[] {
  return Object.keys(PROVIDER_ROUTES);
}

/**
 * Fields `normalizeProvider` demands of a route the table does not describe.
 *
 * Empty for a route the deck knows: its endpoint and protocol come from
 * {@link PROVIDER_ROUTES}.
 */
export function missingRouteFields(kind: string, baseUrl?: string, api?: string): string[] {
  if (PROVIDER_ROUTES[kind] !== undefined) return [];
  const missing: string[] = [];
  if (baseUrl === undefined || baseUrl === '') missing.push('baseUrl');
  if (api === undefined || api === '') missing.push('api');
  return missing;
}

/**
 * Message of a route that declares too little — word for word the one the CLI
 * refuses it with, prefix included, so the panel and the CLI never explain the
 * same refusal differently.
 */
export function routeFieldsMessage(kind: string, missing: readonly string[], where?: string): string {
  const fields = missing.map((field) => `"${field}"`).join(' and ');
  return `${where === undefined ? '' : `${where}: `}provider.kind "${kind}" is not a route the installed catalog knows, so it needs ${fields}`;
}

/** The `where` the CLI labels a harness refusal with, mirrored here. */
function harnessWhere(entry: HarnessEntry): string {
  return `harness "${entry.name}"`;
}

/** Models of a draft, without duplicates and without empty ids. */
export function draftModels(models: readonly string[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of models) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Arguments of `harness-deck add --force` for one provider draft. */
export function addArguments(name: string, draft: ProviderDraft): string[] {
  const args = ['add', name, '--force', '--provider', draft.kind];
  if (draft.baseUrl !== undefined && draft.baseUrl !== '') args.push('--base-url', draft.baseUrl);
  if (draft.api !== undefined && draft.api !== '') args.push('--api', draft.api);
  for (const model of draftModels(draft.models)) args.push('--model', model);
  args.push('--key-env', draft.apiKeyEnv);
  return args;
}

/** First `<dir>/<relative>` found while walking up from `start`. */
function findUp(start: string, relative: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Directory of the file a command really is, symlinks resolved.
 *
 * `dsh` on `PATH` is usually a symlink into the package tree (`/usr/local/bin`
 * pointing at `lib/node_modules/...`), and the catalog lives in the *target's*
 * neighbours. Walking up from the shim's directory finds nothing.
 */
function commandDir(command: string): string | undefined {
  const trimmed = command.trim();
  if (trimmed === '') return undefined;
  const candidates: string[] = [];
  if (isAbsolute(trimmed) || trimmed.includes('/')) candidates.push(trimmed);
  else {
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (entry === '') continue;
      const candidate = join(entry, trimmed);
      if (existsSync(candidate)) {
        candidates.push(candidate);
        break;
      }
    }
  }
  const found = candidates[0];
  if (found === undefined) return undefined;
  try {
    return dirname(realpathSync(found));
  } catch {
    return dirname(found);
  }
}

/**
 * Directories the DSH installation is searched from, most specific first.
 *
 * The DSH command is what names the installation the harness itself will run,
 * so its directory leads; the extension's own directory is the fallback, for a
 * checkout that has the packages as dependencies.
 */
function installRoots(dshCommand?: string): string[] {
  const roots: string[] = [];
  const fromCommand = dshCommand === undefined ? undefined : commandDir(dshCommand);
  if (fromCommand !== undefined) roots.push(fromCommand);
  roots.push(__dirname);
  return roots;
}

/** Absolute path of the pi-ai catalog module the installed DSH ships. */
export function piAiCatalogFile(dshCommand?: string): string | undefined {
  for (const root of installRoots(dshCommand)) {
    const file = findUp(root, PI_AI_CATALOG);
    if (file !== undefined) return file;
  }
  return undefined;
}

/** Absolute path of the installed wire-protocol table. */
function protocolTableFile(dshCommand?: string): string | undefined {
  for (const root of installRoots(dshCommand)) {
    const file = findUp(root, PI_AI_PROTOCOLS);
    if (file !== undefined) return file;
  }
  return undefined;
}

/**
 * Protocol names of the installed adapter's `PROTOCOLS` table.
 *
 * The table is that module's own constant and its keys stay quoted in the build
 * this reads, so the names come from the artifact instead of being copied here.
 * A read that finds nothing is not an error: the caller falls back.
 */
function parseProtocolTable(source: string): string[] {
  const table = /const\s+PROTOCOLS\s*=\s*\{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (table === undefined) return [];
  const names: string[] = [];
  for (const match of table.matchAll(/"([^"]+)"\s*:/g)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** Protocols the installed `dsh-llm-pi-ai` accepts for a hand-declared route. */
export function readInstalledProtocols(dshCommand?: string): string[] | undefined {
  const file = protocolTableFile(dshCommand);
  if (file === undefined) return undefined;
  try {
    const protocols = parseProtocolTable(readFileSync(file, 'utf8'));
    return protocols.length === 0 ? undefined : protocols;
  } catch {
    return undefined;
  }
}

/**
 * Protocols the deck's own route table names, for an install that cannot be
 * read. They are the table's real values — a fallback, not a second opinion.
 */
export function fallbackProtocols(): string[] {
  return [...new Set(Object.values(PROVIDER_ROUTES).map((route) => route.api))];
}

/** Run one node child and collect its output. */
function runNode(args: string[], nodePath: string, env?: NodeJS.ProcessEnv): Promise<LauncherResult> {
  return new Promise((settle) => {
    const child = spawn(nodePath, args, {
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error: Error) => {
      settle({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (code: number | null) => {
      settle({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Read the installed pi-ai catalog in a child process.
 *
 * `undefined` means the catalog could not be read — no install, a module that
 * will not load, or output that is not the expected JSON. The flow treats all
 * three the same way: it says so and asks for the model id.
 */
export async function loadPiAiCatalog(dshCommand?: string): Promise<ProviderCatalog | undefined> {
  const file = piAiCatalogFile(dshCommand);
  if (file === undefined) return undefined;
  const result = await runNode(
    ['--input-type=module', '-e', CATALOG_PROBE, pathToFileURL(file).href],
    process.execPath,
  );
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as Partial<ProviderCatalog>;
    if (!Array.isArray(parsed.providers)) return undefined;
    const models = parsed.models;
    return {
      providers: parsed.providers.filter((id): id is string => typeof id === 'string'),
      models: typeof models === 'object' && models !== null ? (models as Record<string, CatalogModel[]>) : {},
    };
  } catch {
    return undefined;
  }
}

/** Runner that spawns `node <cli> <args>`; the launcher CLI is TypeScript. */
export function spawnLauncher(cliPath: string, nodePath: string = process.execPath): LauncherRunner {
  return (call) =>
    runNode(['--experimental-strip-types', '--no-warnings', cliPath, ...call.args], nodePath, call.env);
}

/** Absolute path of the launcher CLI, walking up from the extension's directory. */
export function launcherCli(start: string = __dirname): string | undefined {
  return findUp(start, join('packages', 'harness-deck-launcher', 'src', 'cli.ts'));
}

/** Ask for one line of text; `required` refuses to hand back an empty answer. */
async function askText(
  prompt: string,
  placeHolder: string,
  required: boolean,
  value?: string,
): Promise<string | undefined> {
  const options: {
    prompt: string;
    placeHolder: string;
    value?: string;
    ignoreFocusOut: boolean;
    validateInput?: (input: string) => string | undefined;
  } = {
    prompt,
    placeHolder,
    ignoreFocusOut: true,
    ...(value === undefined ? {} : { value }),
    ...(required
      ? { validateInput: (input: string) => (input.trim() === '' ? REQUIRED_FIELD : undefined) }
      : {}),
  };
  return await window.showInputBox(options);
}

/** The harness the command runs for: the tree node, or one picked from the registry. */
async function pickHarness(argument: unknown, options: ConfigureOptions): Promise<HarnessEntry | undefined> {
  const direct = entryOf(argument);
  if (direct !== undefined) return direct;
  let entries: readonly HarnessEntry[];
  try {
    entries = (await loadRegistry(options.home)).harnesses;
  } catch (error) {
    await window.showErrorMessage(`Registro ilegivel: ${String(error)}`);
    return undefined;
  }
  const only = entries[0];
  if (only === undefined) {
    await window.showWarningMessage('Nenhum harness registrado; rode `harness-deck add <nome>` no terminal.');
    return undefined;
  }
  if (entries.length === 1) return only;
  const picked = await window.showQuickPick(
    entries.map((entry) => ({ label: entry.name, description: entry.engine })),
    { placeHolder: HARNESS_PICK, ignoreFocusOut: true },
  );
  if (picked === undefined) return undefined;
  return entries.find((entry) => entry.name === picked.label);
}

/** What the route line says under the id: the deck's URL, and what it knows. */
function routeDescription(kind: string, catalogued: boolean): string {
  const known = PROVIDER_ROUTES[kind] !== undefined;
  const parts = [PROVIDER_BASE_URLS[kind], known ? 'o deck ja configura' : catalogued ? 'rota do catalogo' : ''];
  return parts.filter((part) => part !== undefined && part !== '').join(' - ');
}

/** The route of the new provider: a catalog id, or a hand-declared one. */
async function pickRoute(catalog: ProviderCatalog | undefined): Promise<string | undefined> {
  const ids = catalog === undefined ? knownRoutes() : catalog.providers;
  const items = ids.map((id) => ({ label: id, description: routeDescription(id, catalog !== undefined) }));
  items.push({ label: OTHER_ROUTE_LABEL, description: 'rota fora do catalogo instalado' });
  const picked = await window.showQuickPick(items, { placeHolder: ROUTE_PICK, ignoreFocusOut: true });
  return picked?.label;
}

/** The wire protocol of a route the deck's table does not describe. */
async function pickProtocol(options: ConfigureOptions, suggested?: string): Promise<string | undefined> {
  const load = options.loadProtocols ?? readInstalledProtocols;
  const protocols = protocolChoices(load(options.dshCommand) ?? fallbackProtocols(), suggested);
  return (await window.showQuickPick(protocols, { placeHolder: PROTOCOL_PICK, ignoreFocusOut: true })) ?? undefined;
}

/**
 * Protocol options of a hand-declared route: what the adapter accepts, with the
 * one the catalog names put first when the adapter does not list it. The first
 * option is what the list opens on, so the catalog's own answer is one Enter.
 */
export function protocolChoices(installed: readonly string[], suggested?: string): string[] {
  const names = [...installed];
  if (suggested !== undefined && suggested !== '' && !names.includes(suggested)) names.unshift(suggested);
  return names;
}

/** Model ids typed by hand: the path for a route the catalog does not describe. */
async function askModelsByHand(): Promise<string[] | undefined> {
  const first = await askText(MODEL_PROMPT, 'nome-do-modelo', true);
  if (first === undefined) return undefined;
  const more = await askText(MORE_MODELS_PROMPT, 'id1, id2 (vazio encerra)', false);
  if (more === undefined) return undefined;
  return draftModels([first, ...more.split(',')]);
}

/**
 * Models the harness will offer.
 *
 * A route the catalog describes is a multi-select of that route's offers, plus
 * one last item for a slug the installed build does not have yet. Every other
 * route — and any run where the catalog could not be read — is an input box:
 * an empty list is never put on screen.
 */
async function askModels(kind: string, catalog: ProviderCatalog | undefined): Promise<string[] | undefined> {
  const offered = catalog?.models[kind] ?? [];
  if (offered.length === 0) return await askModelsByHand();
  const items = offered.map((model) => ({ label: model.id, description: model.name ?? '' }));
  items.push({ label: OTHER_MODEL_LABEL, description: 'slug que o catalogo instalado ainda nao tem' });
  const picked = await window.showQuickPick(items, {
    placeHolder: `${MODEL_PICK_PREFIX}${kind}`,
    canPickMany: true,
    ignoreFocusOut: true,
  });
  if (picked === undefined) return undefined;
  const ids: string[] = [];
  let typed = false;
  for (const item of picked) {
    if (item.label === OTHER_MODEL_LABEL) typed = true;
    else ids.push(item.label);
  }
  if (typed) {
    const other = await askText(MODEL_PROMPT, 'nome-do-modelo', true);
    if (other === undefined) return undefined;
    ids.push(other);
  }
  return draftModels(ids);
}

/** First non-empty line of a launcher answer, for one-line error messages. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  return line ?? 'sem saida';
}

/** What the panel says once the registry has the new route. */
function configuredMessage(entry: HarnessEntry, kind: string, apiKeyEnv: string): string {
  return `Harness "${entry.name}": rota "${kind}", chave em ${apiKeyEnv}. Reinicie o harness para a rota valer.`;
}

/**
 * Run the whole configuration: pick the harness, pick the route and its models,
 * pick the key variable, then let the CLI write it.
 *
 * Every step that the owner cancels returns `undefined` and writes nothing; so
 * does a draft the CLI would refuse, and that refusal is shown before the CLI
 * is ever called.
 */
export async function configureProvider(
  argument: unknown,
  options: ConfigureOptions,
): Promise<ConfigureOutcome | undefined> {
  const entry = await pickHarness(argument, options);
  if (entry === undefined) return undefined;

  const loadCatalog = options.loadCatalog ?? loadPiAiCatalog;
  const catalog = await loadCatalog(options.dshCommand);
  if (catalog === undefined) await window.showWarningMessage(CATALOG_MISSING);

  const route = await pickRoute(catalog);
  if (route === undefined) return undefined;

  let kind = route;
  if (route === OTHER_ROUTE_LABEL) {
    const typed = await askText(ROUTE_ID_PROMPT, 'gateway-da-casa', true);
    if (typed === undefined) return undefined;
    kind = typed.trim();
  }

  // A route the deck's table does not describe has to say where to call and
  // what to speak: without them the CLI refuses the entry. The installed
  // catalog answers both when it knows the route — `xai`, `groq` and the rest
  // are in it and not in the table — so the box opens with that answer and the
  // protocol list starts on it. Nothing is written that the catalog did not
  // say or the owner did not choose.
  let baseUrl: string | undefined;
  let api: string | undefined;
  if (PROVIDER_ROUTES[kind] === undefined) {
    const catalogued = catalog?.models[kind]?.[0];
    baseUrl = (await askText(BASE_URL_PROMPT, 'https://llm.interno/v1', true, catalogued?.baseUrl))?.trim();
    api = await pickProtocol(options, catalogued?.api);
  }

  const models = await askModels(kind, catalog);
  if (models === undefined) return undefined;
  if (models.length === 0) {
    await window.showWarningMessage(NO_MODEL);
    return undefined;
  }

  const defaultKeyEnv = providerKeyEnv(kind);
  const typedKeyEnv = await askText(KEY_ENV_PROMPT, defaultKeyEnv, false, defaultKeyEnv);
  if (typedKeyEnv === undefined) return undefined;
  const apiKeyEnv = typedKeyEnv.trim() === '' ? defaultKeyEnv : typedKeyEnv.trim();

  // The CLI refuses this too, but only after a child has started and read the
  // registry. Saying it here names the field while the answers are still on
  // screen, and keeps the panel's wording identical to `normalizeProvider`'s.
  const missing = missingRouteFields(kind, baseUrl, api);
  if (missing.length > 0) {
    await window.showErrorMessage(routeFieldsMessage(kind, missing, harnessWhere(entry)));
    return undefined;
  }

  const cli =
    options.repoRoot === undefined
      ? launcherCli()
      : join(options.repoRoot, 'packages', 'harness-deck-launcher', 'src', 'cli.ts');
  if (cli === undefined) {
    await window.showErrorMessage(LAUNCHER_MISSING);
    return undefined;
  }

  const draft: ProviderDraft = {
    kind,
    models,
    apiKeyEnv,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(api === undefined ? {} : { api }),
  };
  const run = options.run ?? spawnLauncher(cli, options.nodePath);
  const result = await run({ args: addArguments(entry.name, draft), env: { ...process.env, [HOME_ENV]: options.home } });
  if (result.code !== 0) {
    await window.showErrorMessage(
      `O CLI recusou a configuracao de "${entry.name}": ${firstLine(result.stderr !== '' ? result.stderr : result.stdout)}`,
    );
    return undefined;
  }

  await options.refresh?.();
  const answer = await window.showInformationMessage(
    configuredMessage(entry, kind, apiKeyEnv),
    RESTART_ACTION,
  );
  const restarted = answer === RESTART_ACTION;
  if (restarted) await options.restart?.(entry);
  return { entry, kind, apiKeyEnv, restarted };
}