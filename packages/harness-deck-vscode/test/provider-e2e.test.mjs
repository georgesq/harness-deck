/**
 * Configuring a provider route from the panel — end to end (REQ-C2, C3, C6, C7, C10).
 *
 * `provider.test.mjs` proves the shape of the conversation and of the arguments
 * with a fake CLI runner and a fabricated catalog. This suite closes the loop:
 * it answers the real conversation with a stub of `vscode`, hands the answers to
 * the **real** launcher CLI (`spawnLauncher(launcherCli())`), and then reads back
 * what landed on disk — the registry and the materialized profile patch.
 *
 * The catalog is the one installed on this machine, never a fabricated one: the
 * point of this slice is that the route and the models the panel offers are the
 * ones the harness will really accept. The runner is the real one too; it is
 * only wrapped so the assertions can see the arguments that were handed over.
 *
 * REQ-C10 is checked from both ends: a sentinel key value is put in the test
 * process environment, and it may not appear in any argument handed to the CLI
 * nor in any file the CLI writes.
 *
 * Run: node test/provider-e2e.test.mjs  (after `npm run build`)
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, Module } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'lib');

/** REQ-C10: the value that must never leave the environment. */
const SENTINEL_KEY = 'valor-de-teste';
process.env.GEMINI_API_KEY = SENTINEL_KEY;

const shown = { info: [], warning: [], error: [] };
/** Boxes the flow opened, with what came pre-filled. */
const asked = [];
/** Every list the flow put on screen: its labels and the options behind them. */
const offered = [];
/** What the owner answers, per case. Set before each run. */
let script = {};
/** What the information notification returns; the restart action, or nothing. */
let action;

/** The `vscode` surface the flow touches, answering from `script`. */
const vscodeStub = {
  window: {
    showInformationMessage: async (message) => {
      shown.info.push(message);
      return action;
    },
    showWarningMessage: async (message) => {
      shown.warning.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      shown.error.push(message);
      return undefined;
    },
    showQuickPick: async (items, options = {}) => {
      const labels = items.map((item) => (typeof item === 'string' ? item : item.label));
      offered.push({ labels, options });
      const answer = script.pick?.(labels, options);
      if (answer === undefined) return undefined;
      if (options.canPickMany) {
        return answer.map((label) => items.find((item) => typeof item !== 'string' && item.label === label));
      }
      if (typeof items[0] === 'string') return answer;
      return items.find((item) => typeof item !== 'string' && item.label === answer);
    },
    showInputBox: async (options = {}) => {
      asked.push({ prompt: options.prompt, value: options.value, placeHolder: options.placeHolder });
      return script.input?.(options.prompt, options.value);
    },
  },
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return load.call(Module, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const provider = require(join(lib, 'provider.js'));
const { configureProvider, launcherCli, piAiCatalogFile, spawnLauncher } = provider;
const { providerKeyEnv } = require(join(lib, 'registry.js'));

let failures = 0;
let checks = 0;
function ok(label) {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}
function skip(label, why) {
  process.stdout.write(`skip ${label} -- ${why}\n`);
}
async function check(label, body) {
  try {
    await body();
    ok(label);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${label}\n     ${error?.message ?? String(error)}\n`);
  }
}

/** Forget everything the previous case put on screen. */
function reset() {
  shown.info.length = 0;
  shown.warning.length = 0;
  shown.error.length = 0;
  asked.length = 0;
  offered.length = 0;
  action = undefined;
}

/** The list offered under one place holder; `undefined` when it never came up. */
function listFor(placeHolder) {
  return offered.find((entry) => entry.options.placeHolder === placeHolder);
}

/** The input box opened under one prompt; `undefined` when it never came up. */
function inputFor(prompt) {
  return asked.find((entry) => entry.prompt === prompt);
}

/** Route catalog of the pi-ai the installed `dsh` ships; `undefined` when absent. */
const catalogFile = piAiCatalogFile('dsh');

if (catalogFile === undefined) {
  skip('ponta a ponta (REQ-C2/C3/C6/C7/C10)', 'nenhum pi-ai instalado nesta maquina');
} else {
  const all = await import(pathToFileURL(catalogFile).href);
  const googleIds = all.getBuiltinModels('google').map((model) => model.id);
  assert.ok(googleIds.length > 0, 'o catalogo instalado nao lista modelos para google');
  /** The models the owner ticks in the multi-select; the first is the default. */
  const chosenModels = googleIds.slice(0, 2);

  const deck = await mkdtemp(join(tmpdir(), 'harness-deck-provider-e2e-'));
  const name = 'gemini';
  /** Fields the flow does not manage must not be lost when it rewrites the entry. */
  const entry = {
    name,
    profile: name,
    home: '',
    port: 3199,
    engine: 'dsh',
    enabled: true,
    note: 'anotacao-de-teste',
    providerApiKeyEnv: 'GEMINI_API_KEY',
  };
  await writeFile(
    join(deck, 'harnesses.json'),
    JSON.stringify({ version: 1, home: deck, harnesses: [entry] }),
  );

  // The real launcher CLI, recorded on the way in so the arguments are visible.
  const cli = launcherCli();
  assert.ok(cli !== undefined, 'CLI do harness-deck nao encontrado a partir da extensao');
  const calls = [];
  const realRun = spawnLauncher(cli);
  const run = async (call) => {
    calls.push(call);
    return await realRun(call);
  };

  reset();
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'google';
      if (options.placeHolder === 'Escolha os modelos de google') return chosenModels;
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    // Enter on the key box: whatever came pre-filled (the route's own variable).
    input: (prompt, value) => (prompt === 'Variavel da chave' ? value : undefined),
  };

  let outcome;
  let runError;
  try {
    outcome = await configureProvider({ entry }, { home: deck, dshCommand: 'dsh', run });
  } catch (error) {
    runError = error;
  }

  const registryText = await readFile(join(deck, 'harnesses.json'), 'utf8').catch(() => '');
  const saved = JSON.parse(registryText === '' ? '{"harnesses":[]}' : registryText).harnesses.find(
    (harness) => harness.name === name,
  );
  const patchPath = join(deck, 'homes', name, 'profiles', name, 'cordis.patch.yml');
  const patchText = await readFile(patchPath, 'utf8').catch(() => '');

  // REQ-C7: the real CLI accepted the arguments and the flow reported success.
  await check('ponta a ponta: o CLI real grava a rota google e a resposta volta ao painel', async () => {
    assert.equal(runError, undefined, `configureProvider lancou: ${runError?.message}`);
    assert.ok(outcome !== undefined, 'a configuracao nao terminou sobre um harness de teste');
    assert.equal(outcome.kind, 'google');
    assert.equal(outcome.apiKeyEnv, providerKeyEnv('google'));
    assert.deepEqual(shown.error, []);
    assert.deepEqual(shown.warning, []);
  });

  // REQ-C2/C3: what went up on screen is the installed catalog, not a list of ours.
  await check('REQ-C2/C3: a rota e os modelos oferecidos sao os do catalogo instalado', async () => {
    assert.deepEqual(listFor('Escolha a rota do provedor')?.labels, [
      ...all.getBuiltinProviders(),
      'outra rota (informar URL e protocolo)',
    ]);
    assert.deepEqual(listFor('Escolha os modelos de google')?.labels, [
      ...googleIds,
      'outro id (digitar)',
    ]);
    assert.equal(listFor('Escolha os modelos de google')?.options.canPickMany, true);
  });

  // REQ-C6: the key variable suggested for `google` is the route's own.
  await check('REQ-C6: a variavel sugerida para google e GEMINI_API_KEY', async () => {
    assert.equal(inputFor('Variavel da chave')?.value, 'GEMINI_API_KEY');
    assert.equal(providerKeyEnv('google'), 'GEMINI_API_KEY');
  });

  // REQ-C7: one `add --force` against the temporary deck home, no other child.
  await check('REQ-C7: o CLI real foi chamado uma vez com `add --force` e o deck home no ambiente', async () => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.args[0], 'add');
    assert.equal(calls[0]?.args[1], name);
    assert.equal(calls[0]?.args[2], '--force');
    assert.equal(calls[0]?.args[3], '--provider');
    assert.equal(calls[0]?.args[4], 'google');
    assert.equal(calls[0]?.env.HARNESS_DECK_HOME, deck);
  });

  // REQ-C2/C3/C6/C7: the registry the harness boots from, read back from disk.
  await check('REQ-C7: o harnesses.json gravado tem a rota, os modelos, a chave e a URL do google', async () => {
    assert.ok(saved !== undefined, 'a entrada nao esta no registro gravado');
    assert.equal(saved.provider.kind, 'google');
    assert.equal(saved.provider.model, chosenModels[0]);
    assert.deepEqual(saved.provider.models, chosenModels);
    assert.equal(saved.provider.apiKeyEnv, 'GEMINI_API_KEY');
    assert.equal(saved.provider.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  });

  // REQ-C7: the write does not lose what the entry already carried.
  await check('REQ-C7: a entrada preserva o note e o providerApiKeyEnv que ja existiam', async () => {
    assert.equal(saved.note, 'anotacao-de-teste');
    assert.equal(saved.providerApiKeyEnv, 'GEMINI_API_KEY');
    assert.equal(saved.port, entry.port);
    assert.equal(saved.engine, entry.engine);
  });

  // REQ-C10: the sentinel value never reaches an argument handed to the CLI.
  await check('REQ-C10: nenhum valor de chave aparece nos argumentos passados ao CLI', async () => {
    const args = calls.flatMap((call) => call.args).join('\n');
    assert.ok(args.includes('GEMINI_API_KEY'), 'a variavel da chave deveria estar nos argumentos');
    assert.equal(args.includes(SENTINEL_KEY), false, 'o valor da chave vazou para os argumentos do CLI');
  });

  // REQ-C10: and it never reaches the registry either.
  await check('REQ-C10: nenhum valor de chave aparece no harnesses.json', async () => {
    assert.ok(registryText.includes('GEMINI_API_KEY'), 'a variavel da chave deveria estar no registro');
    assert.equal(registryText.includes(SENTINEL_KEY), false, 'o valor da chave vazou para o registro');
  });

  // REQ-C2/C3/C6: the materialized profile patch is what the DSH will boot from.
  await check('REQ-C3: o perfil materializado carrega a rota, a chave e a api do google', async () => {
    assert.ok(patchText !== '', `perfil materializado ausente em ${patchPath}`);
    assert.ok(patchText.includes('provider: google'), 'a rota nao esta no perfil');
    assert.ok(patchText.includes('apiKeyEnv: GEMINI_API_KEY'), 'a variavel da chave nao esta no perfil');
    assert.ok(patchText.includes('api: google-generative-ai'), 'a api do google nao esta no perfil');
  });

  // REQ-C3: every model the owner ticked is registered, not just the first.
  await check('REQ-C3: o perfil materializado lista os modelos escolhidos', async () => {
    for (const model of chosenModels) {
      assert.ok(patchText.includes(`- id: ${model}`), `modelo "${model}" nao esta no perfil`);
    }
  });

  // REQ-C10: the materialized profile holds variable names, never values.
  await check('REQ-C10: nenhum valor de chave aparece no perfil materializado', async () => {
    assert.equal(patchText.includes(SENTINEL_KEY), false, 'o valor da chave vazou para o perfil');
  });

  await rm(deck, { recursive: true, force: true });
}

process.stdout.write(failures === 0 ? `\ntudo ok (${checks} verificacoes)\n` : `\n${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
