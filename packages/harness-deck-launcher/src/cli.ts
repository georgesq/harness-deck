/**
 * harness-deck CLI — the harness registry and launcher, from the shell.
 *
 * Commands (all accept `--home <dir>` to work on another harness-deck home):
 *   list    registered harnesses and what is actually running
 *   add     register a harness (and materialize its DSH profile)
 *   rm      unregister a harness
 *   up      start every enabled harness
 *   down    stop every enabled harness
 *   status  one harness, with its URL and log tail
 *   logs    print the log of one harness
 *   workspace  list or add workspace folders, per harness or in all of them
 *
 * The registry is `<home>/harnesses.json`; nothing here touches `~/.dsh`.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HARNESS_DECK_HOME,
  DEFAULT_PROVIDER,
  HARNESS_DECK_HOME_ENV,
  PROVIDER_KEY_ENV,
  RegistryError,
  envFilePath,
  findHarness,
  harnessHome,
  harnessesHome,
  loadEnvFile,
  loadRegistry,
  portOwner,
  registryPath,
  removeHarness,
  resolveHome,
  saveRegistry,
  upsertHarness,
  type HarnessEngine,
  type HarnessEntry,
  type HarnessProvider,
  type Registry,
} from './registry.ts';
import {
  LaunchError,
  appendLog,
  harnessLogPath,
  harnessUrl,
  inspect,
  inspectAll,
  startHarness,
  stopHarness,
  waitForPort,
  type HarnessState,
} from './launcher.ts';
import { materializeProfile, profileDir, type MaterializeResult } from './materialize.ts';
import { addWorkspace, listWorkspaces, readWorkspaces, removeWorkspace } from './workspaces.ts';

/** Default port of the first harness; the rest follow in sequence. */
const FIRST_PORT = 3100;

/** Engine used when `add` gets no `--engine`. */
const DEFAULT_ENGINE: HarnessEngine = 'dsh';

/** Environment variable read for a credential, per engine, when none is given. */
const DEFAULT_KEY_ENV: Record<HarnessEngine, string> = {
  dsh: 'DEEPSEEK_API_KEY',
  'claude-code': 'ANTHROPIC_API_KEY',
};

/** Where the plugin package lives, derived from this file's location. */
function repoRootFromThisFile(): string {
  // .../packages/harness-deck-launcher/src/cli.ts -> repo root
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)));
}

function defaultPluginPath(): string {
  return resolve(repoRootFromThisFile(), 'packages', 'harness-deck-claude-code');
}

/** Parsed command line. */
interface Options {
  command: string;
  positionals: string[];
  flags: Map<string, string[]>;
}

/** Parse `argv` into one command and its flags. */
function parseArgs(argv: string[]): Options {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let command = '';
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith('--')) {
      const [name, inline] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined];
      const key = (name as string).slice(2);
      if (inline !== undefined) {
        pushFlag(flags, key, inline);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        pushFlag(flags, key, next);
        index += 1;
      } else {
        pushFlag(flags, key, 'true');
      }
      continue;
    }
    if (command === '') command = token;
    else positionals.push(token);
  }
  return { command, positionals, flags };
}

function pushFlag(flags: Map<string, string[]>, key: string, value: string): void {
  const current = flags.get(key) ?? [];
  current.push(value);
  flags.set(key, current);
}

function flag(options: Options, key: string): string | undefined {
  return options.flags.get(key)?.at(-1);
}

function has(options: Options, key: string): boolean {
  return options.flags.has(key);
}

/** Home requested by the command line or the environment. */
function homeOf(options: Options): string {
  return resolveHome(flag(options, 'home'));
}

function fail(message: string): never {
  process.stderr.write(`erro: ${message}\n`);
  process.exit(1);
}

const HELP = `harness-deck — registro e lançador de harness

Uso:
  harness-deck list [--json]
  harness-deck add <nome> [--engine dsh|claude-code] [--port <porta>]
                          [--provider openrouter|deepseek] [--model <id>]...
                          [--key-env <VAR>] [--base-url <url>] [--note <texto>]
                          [--dsh-home <dir>] [--force]
  harness-deck rm <nome> [--purge]
  harness-deck up [<nome>...] [--wait <ms>]
  harness-deck down [<nome>...]
  harness-deck status <nome>
  harness-deck logs <nome> [--tail <linhas>]
  harness-deck workspace list [--harness <nome>]
  harness-deck workspace add <caminho> [--harness <nome>]... [--title <titulo>]
  harness-deck workspace remove <caminho> [--harness <nome>]...
                          (sem --harness, vale para todos os harnesses)

Flags globais:
  --home <dir>   raiz do harness-deck (padrão: $${HARNESS_DECK_HOME_ENV} ou ${DEFAULT_HARNESS_DECK_HOME})
  --json         saída em JSON (list, status)
  --plugin <dir> caminho do pacote harness-deck-claude-code

--model pode ser repetido: a lista inteira é o que o seletor de modelo do DSH
mostra dentro do harness, e o primeiro --model é o modelo inicial. Com um só
--model (ou nenhum) o harness oferece apenas esse modelo.

Cada harness é um perfil do DSH, um processo, uma porta e um DSH_HOME próprio
(<raiz>/homes/<nome>). É o DSH_HOME que separa workspaces e sessões (REQ-02);
o perfil separa o motor. O ~/.dsh nunca é tocado (REQ-03).`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === '' || has(options, 'help') || options.command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const home = homeOf(options);
  switch (options.command) {
    case 'list':
      await commandList(home, options);
      return;
    case 'add':
      await commandAdd(home, options);
      return;
    case 'rm':
      await commandRemove(home, options);
      return;
    case 'up':
      await commandUp(home, options);
      return;
    case 'down':
      await commandDown(home, options);
      return;
    case 'status':
      await commandStatus(home, options);
      return;
    case 'logs':
      await commandLogs(home, options);
      return;
    case 'workspace':
      await commandWorkspace(home, options);
      return;
    default:
      fail(`comando desconhecido "${options.command}" (veja \`harness-deck help\`)`);
  }
}

/** Render one line of the registry table. */
function stateLine(state: HarnessState): string {
  const status = state.listening ? 'no ar' : state.running ? 'subindo' : 'parado';
  const pid = state.pid !== undefined ? String(state.pid) : '-';
  const url = state.listening ? harnessUrl(state.entry) : '';
  return [
    state.entry.name.padEnd(16),
    state.entry.engine.padEnd(12),
    `porta ${String(state.entry.port).padEnd(6)}`,
    status.padEnd(8),
    `pid ${pid.padEnd(7)}`,
    state.entry.enabled ? '' : '(desativado)',
    url,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

async function commandList(home: string, options: Options): Promise<void> {
  const registry = await loadRegistry(home);
  const states = await inspectAll(home, registry);
  if (has(options, 'json')) {
    process.stdout.write(`${JSON.stringify({ home, registry: registryPath(home), states }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`harness-deck home: ${home}\n`);
  process.stdout.write(`registro: ${registryPath(home)}\n`);
  if (states.length === 0) {
    process.stdout.write('nenhum harness registrado (use `harness-deck add <nome>`)\n');
    return;
  }
  for (const state of states) process.stdout.write(`${stateLine(state)}\n`);
}

/**
 * Environment variable that holds this harness' credential.
 *
 * The provider block wins (that is the route the DSH and the bridge actually
 * call); `providerApiKeyEnv` is the explicit per-harness override, and the
 * engine default is the last resort.
 */
function credentialEnv(entry: HarnessEntry): string {
  return entry.providerApiKeyEnv ?? entry.provider?.apiKeyEnv ?? DEFAULT_KEY_ENV[entry.engine];
}

/** Build the provider block of a new entry from the flags. */
function buildProvider(options: Options): HarnessProvider {
  const kind = (flag(options, 'provider') ?? DEFAULT_PROVIDER.kind) as HarnessProvider['kind'];
  if (kind !== 'openrouter' && kind !== 'deepseek') {
    fail(`--provider aceita "openrouter" ou "deepseek", não "${String(kind)}"`);
  }
  const models = options.flags.get('model') ?? [];
  const model = models[0] ?? DEFAULT_PROVIDER.model;
  const apiKeyEnv = flag(options, 'key-env') ?? PROVIDER_KEY_ENV[kind];
  const baseUrl = flag(options, 'base-url');
  // `--model` repeated builds the list the DSH model selector offers; the
  // first one is also the harness' starting model. A single `--model` (or
  // none) leaves `models` absent, which means "only this one".
  const offered = models.length > 1 ? models : [];
  return {
    kind,
    model,
    ...(offered.length > 0 ? { models: offered } : {}),
    apiKeyEnv,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** Pick the port: the flag, or the first free one after the highest in use. */
function nextPort(existing: HarnessEntry[]): number {
  const used = new Set(existing.map((entry) => entry.port));
  let candidate = FIRST_PORT;
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

async function commandAdd(home: string, options: Options): Promise<void> {
  const name = options.positionals[0];
  if (name === undefined) fail('add precisa do nome do harness');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    fail(`nome inválido "${name}": use minúsculas, dígitos e hífen (o nome vira o perfil do DSH)`);
  }
  const engine = (flag(options, 'engine') ?? DEFAULT_ENGINE) as HarnessEngine;
  if (engine !== 'dsh' && engine !== 'claude-code') {
    fail(`--engine aceita "dsh" ou "claude-code", não "${engine}"`);
  }
  const registry = await loadRegistry(home);
  if (findHarness(registry, name) !== undefined && !has(options, 'force')) {
    fail(`harness "${name}" já existe (use --force para reescrever a entrada)`);
  }
  const portFlag = flag(options, 'port');
  const port = portFlag !== undefined ? Number.parseInt(portFlag, 10) : nextPort(registry.harnesses);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port inválido: "${String(portFlag)}"`);
  const clash = portOwner(registry, port, name);
  if (clash !== undefined) fail(`porta ${port} já é do harness "${clash.name}"`);

  const entry: HarnessEntry = {
    name,
    profile: name,
    home: flag(options, 'dsh-home') ?? join(harnessesHome(home), name),
    port,
    engine,
    provider: buildProvider(options),
    enabled: true,
    ...(flag(options, 'base-url') ? { providerBaseUrl: flag(options, 'base-url') } : {}),
    providerApiKeyEnv: flag(options, 'key-env') ?? DEFAULT_KEY_ENV[engine],
    ...(flag(options, 'note') ? { note: flag(options, 'note') } : {}),
  };

  const pluginPath = resolve(flag(options, 'plugin') ?? defaultPluginPath());
  const materialized = await materializeProfile(home, entry, { pluginPath });
  const path = await saveRegistry(upsertHarness(registry, entry));
  await writeEnvExample(home, entry);

  process.stdout.write(`harness "${name}" registrado (${entry.engine}, porta ${entry.port})\n`);
  process.stdout.write(`registro: ${path}\n`);
  process.stdout.write(`DSH_HOME: ${harnessHome(home, entry)}\n`);
  process.stdout.write(`perfil:   ${materialized.profileDir}\n`);
  for (const file of materialized.written) process.stdout.write(`escrito:  ${file}\n`);
  for (const link of materialized.linked) process.stdout.write(`link:     ${link} -> ${pluginPath}\n`);
  process.stdout.write(`\npróximo passo: exporte ${credentialEnv(entry)} e rode \`harness-deck up ${name}\`\n`);
}

/** Write `<profile>/.env.example` — the variable names a harness needs, never values. */
async function writeEnvExample(home: string, entry: HarnessEntry): Promise<void> {
  const lines = [
    `# Variáveis de ambiente do harness "${entry.name}" (${entry.engine}).`,
    '# Copie para um arquivo fora do git e exporte antes de `harness-deck up`.',
    '# Nenhuma chave é gravada pelo harness-deck.',
    `${credentialEnv(entry)}=`,
  ];
  if (entry.providerBaseUrl) lines.push(`ANTHROPIC_BASE_URL=${entry.providerBaseUrl}`);
  await appendLog(`${profileDir(home, entry)}/.env.example`, `${lines.join('\n')}\n`);
}

async function commandRemove(home: string, options: Options): Promise<void> {
  const name = options.positionals[0];
  if (name === undefined) fail('rm precisa do nome do harness');
  const registry = await loadRegistry(home);
  const { registry: next, removed } = removeHarness(registry, name);
  if (removed === undefined) fail(`harness "${name}" não está no registro`);
  if (removed !== undefined) {
    const state = await inspect(home, removed);
    if (state.running) fail(`harness "${name}" está no ar (pid ${String(state.pid)}); rode \`harness-deck down ${name}\` antes`);
  }
  await saveRegistry(next);
  process.stdout.write(`harness "${name}" removido do registro\n`);
  if (has(options, 'purge')) {
    const dir = profileDir(home, removed);
    process.stdout.write(`perfil preservado em ${dir} (apague à mão se quiser; o registro não o usa mais)\n`);
  }
}

/** Entries selected by positional names, or every enabled one. */
function select(registry: Registry, names: string[]): HarnessEntry[] {
  if (names.length === 0) return registry.harnesses.filter((entry) => entry.enabled);
  return names.map((name) => {
    const entry = findHarness(registry, name);
    if (entry === undefined) fail(`harness "${name}" não está no registro`);
    return entry;
  });
}

async function commandUp(home: string, options: Options): Promise<void> {
  const registry = await loadRegistry(home);
  const entries = select(registry, options.positionals);
  if (entries.length === 0) fail('nenhum harness para subir (registro vazio ou tudo desativado)');
  const pluginPath = resolve(flag(options, 'plugin') ?? defaultPluginPath());
  const waitMs = Number.parseInt(flag(options, 'wait') ?? '30000', 10);
  const envFile = await loadEnvFile(home);
  for (const entry of entries) {
    const keyEnv = credentialEnv(entry);
    if (!process.env[keyEnv] && !envFile[keyEnv]) {
      process.stderr.write(
        `aviso: ${keyEnv} não está no ambiente nem em ${envFilePath(home)} — o harness "${entry.name}" sobe, mas o modelo vai falhar\n`,
      );
    }
    const result = await startHarness(home, entry, { pluginPath });
    if (result.alreadyRunning) {
      process.stdout.write(`${entry.name}: já estava no ar (pid ${String(result.state.pid)})\n`);
      continue;
    }
    process.stdout.write(`${entry.name}: subindo na porta ${entry.port} (pid ${String(result.state.pid)})\n`);
    const ready = await waitForPort(entry, waitMs);
    process.stdout.write(
      ready
        ? `${entry.name}: pronto em ${harnessUrl(entry)}\n`
        : `${entry.name}: não respondeu em ${waitMs} ms — veja ${harnessLogPath(home, entry)}\n`,
    );
  }
}

async function commandDown(home: string, options: Options): Promise<void> {
  const registry = await loadRegistry(home);
  const entries = select(registry, options.positionals);
  for (const entry of entries) {
    const result = await stopHarness(home, entry);
    if (!result.stopped) {
      process.stdout.write(`${entry.name}: não estava rodando\n`);
      continue;
    }
    process.stdout.write(`${entry.name}: parado (${result.signal})\n`);
  }
}

async function commandStatus(home: string, options: Options): Promise<void> {
  const name = options.positionals[0];
  if (name === undefined) fail('status precisa do nome do harness');
  const registry = await loadRegistry(home);
  const entry = findHarness(registry, name);
  if (entry === undefined) fail(`harness "${name}" não está no registro`);
  const state = await inspect(home, entry);
  if (has(options, 'json')) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return;
  }
  process.stdout.write(`harness:  ${entry.name}\n`);
  process.stdout.write(`engine:   ${entry.engine}\n`);
  process.stdout.write(`DSH_HOME: ${harnessHome(home, entry)}\n`);
  process.stdout.write(`perfil:   ${profileDir(home, entry)}\n`);
  process.stdout.write(`porta:    ${entry.port}\n`);
  process.stdout.write(`url:      ${harnessUrl(entry)}\n`);
  process.stdout.write(`pid:      ${state.pid !== undefined ? state.pid : '-'}\n`);
  process.stdout.write(`processo: ${state.running ? 'vivo' : 'ausente'}\n`);
  process.stdout.write(`porta:    ${state.listening ? 'respondendo' : 'fechada'}\n`);
  process.stdout.write(`log:      ${state.logPath}\n`);
  if (entry.providerBaseUrl) process.stdout.write(`base-url: ${entry.providerBaseUrl}\n`);
  const keyEnv = credentialEnv(entry);
  process.stdout.write(`chave:    ${keyEnv} ${process.env[keyEnv] ? '(no ambiente)' : '(ausente do ambiente)'}\n`);
  if (entry.provider) {
    process.stdout.write(`provider: ${entry.provider.kind} / ${entry.provider.model}\n`);
  }
}

/**
 * Resolve which harnesses a command targets: the ones named by `--harness`
 * (repeatable), or every enabled harness in the registry.
 */
function targetHarnesses(registry: Registry, options: Options): HarnessEntry[] {
  const names = options.flags.get('harness') ?? [];
  if (names.length === 0) return registry.harnesses.filter((entry) => entry.enabled !== false);
  const chosen: HarnessEntry[] = [];
  for (const name of names) {
    const entry = findHarness(registry, name);
    if (entry === undefined) fail(`harness "${name}" não está no registro`);
    chosen.push(entry);
  }
  return chosen;
}

/**
 * `workspace list` and `workspace add`.
 *
 * One DSH_HOME per harness (REQ-02) means the workspace list lives inside each
 * harness: the folder has to be registered once per harness. Without
 * `--harness`, `add` registers it in all of them.
 *
 * A running harness keeps the unit in memory and writes the whole document
 * back, so a write while it runs is lost on the next mutation. The command
 * warns and asks for a restart instead of pretending it worked.
 */
async function commandWorkspace(home: string, options: Options): Promise<void> {
  const action = options.positionals[0] ?? 'list';
  if (action !== 'add' && action !== 'list' && action !== 'remove') {
    fail(`workspace aceita "add", "list" ou "remove", não "${action}"`);
  }
  const registry = await loadRegistry(home);
  const entries = targetHarnesses(registry, options);

  if (action === 'list') {
    for (const entry of entries) {
      const dshHome = harnessHome(home, entry);
      const unit = await readWorkspaces(dshHome);
      const workspaces = listWorkspaces(unit);
      process.stdout.write(`${entry.name}: ${workspaces.length} workspace(s)\n`);
      for (const workspace of workspaces) {
        process.stdout.write(`  ${workspace.path}  (${workspace.title})\n`);
      }
    }
    return;
  }

  const folder = options.positionals[1];
  if (folder === undefined) fail(`workspace ${action} precisa do caminho da pasta`);
  const title = flag(options, 'title');
  for (const entry of entries) {
    const state = await inspect(home, entry);
    if (action === 'remove') {
      const removed = await removeWorkspace(harnessHome(home, entry), folder);
      const what = removed.removed ? `removido (${removed.sessions} sessão(ões) saíram da lista)` : 'não estava';
      process.stdout.write(`${entry.name}: ${what} ${removed.path}\n`);
      continue;
    }
    const result = await addWorkspace(harnessHome(home, entry), folder, title);
    const what = result.existing ? 'já estava' : 'adicionado';
    process.stdout.write(`${entry.name}: ${what} ${result.path}\n`);
    if (!result.existing && state.running) {
      process.stdout.write(
        `  aviso: o harness ${entry.name} está no ar e mantém a lista em memória — ` +
          `rode \`harness-deck down ${entry.name}\` e de novo \`harness-deck up ${entry.name}\` ` +
          'para o workspace aparecer\n',
      );
    }
  }
}

async function commandLogs(home: string, options: Options): Promise<void> {
  const name = options.positionals[0];
  if (name === undefined) fail('logs precisa do nome do harness');
  const registry = await loadRegistry(home);
  const entry = findHarness(registry, name);
  if (entry === undefined) fail(`harness "${name}" não está no registro`);
  const path = harnessLogPath(home, entry);
  const tail = Number.parseInt(flag(options, 'tail') ?? '40', 10);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    process.stdout.write(`sem log em ${path} (o harness nunca subiu?)\n`);
    return;
  }
  const lines = raw.split('\n').filter((line) => line !== '');
  process.stdout.write(`${lines.slice(-tail).join('\n')}\n`);
}

try {
  await main();
} catch (error) {
  if (error instanceof RegistryError || error instanceof LaunchError) fail(error.message);
  if (error instanceof Error) fail(error.message);
  fail(String(error));
}

// Keep the exported helpers reachable for future commands without tree-shaking
// surprises in the type check.
export { materializeProfile, harnessHome, type MaterializeResult };
