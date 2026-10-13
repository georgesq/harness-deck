/**
 * Configuring a provider route from the panel (REQ-R1..R9).
 *
 * The panel must reach the same profile the CLI would write, without a terminal
 * and without the owner typing a model slug the installed catalog already
 * knows. So this suite loads `lib/provider.js` with a stub of the `vscode`
 * module, answers the conversation the way the owner would, and asserts on
 * three things: the lists that went up on screen, what the CLI was called with
 * (a fake runner, no child), and what the owner was told.
 *
 * Two cases read the real pi-ai catalog of the DSH installed on this machine
 * and are skipped — loudly — when there is none: a fabricated catalog would
 * prove nothing about what the panel offers.
 *
 * Run: node test/provider.test.mjs  (after `npm run build`)
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, Module } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, '..', 'lib');
const repoRoot = join(here, '..', '..', '..');

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
const { configureProvider, piAiCatalogFile, readInstalledProtocols } = provider;
const { PROVIDER_ROUTES, providerKeyEnv } = require(join(lib, 'registry.js'));

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

const entry = { name: 'teste', profile: 'teste', home: '', port: 3199, engine: 'dsh', enabled: true };
const deck = await mkdtemp(join(tmpdir(), 'harness-deck-provider-'));
await writeFile(
  join(deck, 'harnesses.json'),
  JSON.stringify({
    version: 1,
    home: deck,
    harnesses: [entry, { ...entry, name: 'beta', profile: 'beta', port: 3200 }],
  }),
);

/** A catalog shaped exactly like the one the flow reads from pi-ai. */
const fakeCatalog = {
  providers: ['deepseek', 'google', 'xai', 'nope-rota'],
  models: {
    deepseek: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
    google: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }],
    // In the catalog and not in the deck's table: the flow has to ask for the
    // endpoint and the protocol, and both answers come from here.
    xai: [{ id: 'grok-4', name: 'Grok 4', api: 'openai-responses', baseUrl: 'https://api.x.ai/v1' }],
    'nope-rota': [],
  },
};

/** Every CLI call the flow made; the real runner is never used here. */
const calls = [];
const run = async (call) => {
  calls.push(call);
  return { code: 0, stdout: 'ok\n', stderr: '' };
};
const baseOptions = { home: deck, repoRoot, run };

/** Ask for the key variable by taking the default the box came pre-filled with. */
const acceptDefault = (prompt, value) => (prompt === 'Variavel da chave' ? value : undefined);

// REQ-R1/R5/R6/R8: the harness comes from the registry when the command did not
// come from the tree, the route from the catalog, and the write goes through
// the CLI with the deck home in the environment.
await check('catalogo: rota conhecida vira `add --force` com os modelos escolhidos', async () => {
  reset();
  calls.length = 0;
  action = 'Reiniciar agora';
  const refreshed = [];
  const restarted = [];
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha o harness') return 'beta';
      if (options.placeHolder === 'Escolha a rota do provedor') return 'deepseek';
      if (options.placeHolder === 'Escolha os modelos de deepseek') return ['deepseek-chat', 'deepseek-reasoner'];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: acceptDefault,
  };
  const outcome = await configureProvider(undefined, {
    ...baseOptions,
    loadCatalog: async () => fakeCatalog,
    refresh: () => refreshed.push(true),
    restart: (target) => restarted.push(target.name),
  });

  assert.deepEqual(listFor('Escolha o harness')?.labels, ['teste', 'beta']);
  assert.deepEqual(listFor('Escolha a rota do provedor')?.labels, [
    ...fakeCatalog.providers,
    'outra rota (informar URL e protocolo)',
  ]);
  assert.deepEqual(listFor('Escolha os modelos de deepseek')?.labels, [
    'deepseek-chat',
    'deepseek-reasoner',
    'outro id (digitar)',
  ]);
  assert.equal(listFor('Escolha os modelos de deepseek')?.options.canPickMany, true);
  // One `--model` per chosen model, in the order the list returned them: the
  // first is the harness' starting model.
  assert.deepEqual(calls[0]?.args, [
    'add',
    'beta',
    '--force',
    '--provider',
    'deepseek',
    '--model',
    'deepseek-chat',
    '--model',
    'deepseek-reasoner',
    '--key-env',
    providerKeyEnv('deepseek'),
  ]);
  assert.equal(calls[0]?.env.HARNESS_DECK_HOME, deck);
  assert.equal(outcome?.kind, 'deepseek');
  assert.equal(outcome?.apiKeyEnv, providerKeyEnv('deepseek'));
  assert.deepEqual(refreshed, [true]);
  assert.equal(outcome?.restarted, true);
  assert.deepEqual(restarted, ['beta']);
  assert.match(shown.info[0] ?? '', /rota "deepseek"/);
  assert.match(shown.info[0] ?? '', new RegExp(providerKeyEnv('deepseek')));
  assert.match(shown.info[0] ?? '', /Reinicie o harness/);
  assert.deepEqual(shown.error, []);
});

// REQ-R3/R4: a route the catalog describes and the deck's table does not. The
// panel has to ask where to call and what to speak — and both boxes open on the
// catalog's own answer, so the owner accepts them with Enter instead of typing
// a URL and a protocol the machine already knows.
await check('rota so do catalogo: endpoint e protocolo vem pre-preenchidos do catalogo', async () => {
  reset();
  calls.length = 0;
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'xai';
      if (options.placeHolder === 'Escolha o protocolo (api)') return labels[0];
      if (options.placeHolder === 'Escolha os modelos de xai') return ['grok-4'];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    // Enter on both boxes: whatever came pre-filled is the answer.
    input: (prompt, value) => (prompt === 'Outros modelos' ? '' : value),
  };
  const outcome = await configureProvider({ entry }, {
    ...baseOptions,
    loadCatalog: async () => fakeCatalog,
    loadProtocols: () => ['openai-completions', 'anthropic-messages'],
  });

  assert.equal(PROVIDER_ROUTES['xai'], undefined, 'o teste pressupoe xai fora da tabela do deck');
  assert.equal(inputFor('URL base da rota')?.value, 'https://api.x.ai/v1');
  assert.deepEqual(listFor('Escolha o protocolo (api)')?.labels, [
    'openai-responses',
    'openai-completions',
    'anthropic-messages',
  ]);
  assert.deepEqual(calls[0]?.args, [
    'add',
    'teste',
    '--force',
    '--provider',
    'xai',
    '--base-url',
    'https://api.x.ai/v1',
    '--api',
    'openai-responses',
    '--model',
    'grok-4',
    '--key-env',
    providerKeyEnv('xai'),
  ]);
  assert.equal(outcome?.kind, 'xai');
  assert.deepEqual(shown.error, []);
});

// REQ-R7: the route the catalog does not describe and that says no endpoint is
// refused here, naming the field, before any child is spawned.
await check('rota de fora sem URL: nenhuma chamada ao CLI e erro nomeando "baseUrl"', async () => {
  reset();
  calls.length = 0;
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'outra rota (informar URL e protocolo)';
      if (options.placeHolder === 'Escolha o protocolo (api)') return labels[0];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: (prompt, value) =>
      prompt === 'Id da rota'
        ? 'gateway-da-casa'
        : prompt === 'URL base da rota'
          ? '   '
          : prompt === 'Id do modelo'
            ? 'modelo-x'
            : prompt === 'Outros modelos'
              ? ''
              : acceptDefault(prompt, value),
  };
  const outcome = await configureProvider({ entry }, {
    ...baseOptions,
    loadCatalog: async () => fakeCatalog,
    loadProtocols: () => ['openai-completions'],
  });

  assert.equal(calls.length, 0);
  assert.equal(outcome, undefined);
  assert.deepEqual(shown.error, [
    'harness "teste": provider.kind "gateway-da-casa" is not a route the installed catalog knows, so it needs "baseUrl"',
  ]);
});

// REQ-R7, the other field: a route that reaches the protocol step without one.
await check('rota de fora sem protocolo: erro nomeando "api"', async () => {
  reset();
  calls.length = 0;
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'outra rota (informar URL e protocolo)';
      if (options.placeHolder === 'Escolha o protocolo (api)') return undefined;
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: (prompt, value) =>
      prompt === 'Id da rota'
        ? 'gateway-da-casa'
        : prompt === 'URL base da rota'
          ? 'https://llm.interno/v1'
          : prompt === 'Id do modelo'
            ? 'modelo-x'
            : prompt === 'Outros modelos'
              ? ''
              : acceptDefault(prompt, value),
  };
  const outcome = await configureProvider({ entry }, {
    ...baseOptions,
    loadCatalog: async () => fakeCatalog,
    loadProtocols: () => ['openai-completions'],
  });

  assert.equal(calls.length, 0);
  assert.equal(outcome, undefined);
  assert.deepEqual(shown.error, [
    'harness "teste": provider.kind "gateway-da-casa" is not a route the installed catalog knows, so it needs "api"',
  ]);
});

// REQ-R3: a route outside the catalog carries both its endpoint and its wire
// protocol to the CLI, and the protocol list is the one the installed adapter
// names.
await check('rota de fora com URL e protocolo: `--base-url` e `--api` no CLI', async () => {
  reset();
  calls.length = 0;
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'outra rota (informar URL e protocolo)';
      if (options.placeHolder === 'Escolha o protocolo (api)') return labels[1];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: (prompt, value) =>
      prompt === 'Id da rota'
        ? 'gateway-da-casa'
        : prompt === 'URL base da rota'
          ? 'https://llm.interno/v1'
          : prompt === 'Id do modelo'
            ? 'time-interno-70b'
            : prompt === 'Outros modelos'
              ? 'backup-70b'
              : acceptDefault(prompt, value),
  };
  const outcome = await configureProvider({ entry }, {
    ...baseOptions,
    loadCatalog: async () => fakeCatalog,
    loadProtocols: () => ['openai-completions', 'anthropic-messages'],
  });

  assert.deepEqual(listFor('Escolha o protocolo (api)')?.labels, ['openai-completions', 'anthropic-messages']);
  assert.deepEqual(calls[0]?.args, [
    'add',
    'teste',
    '--force',
    '--provider',
    'gateway-da-casa',
    '--base-url',
    'https://llm.interno/v1',
    '--api',
    'anthropic-messages',
    '--model',
    'time-interno-70b',
    '--model',
    'backup-70b',
    '--key-env',
    providerKeyEnv('gateway-da-casa'),
  ]);
  assert.equal(outcome?.kind, 'gateway-da-casa');
  assert.equal(outcome?.restarted, false);
});

// REQ-R3, with the catalog this machine actually has: the offers of `google`
// are the ones the installed pi-ai lists, plus the "type another id" door.
const catalogFile = piAiCatalogFile('dsh');
if (catalogFile === undefined) {
  skip('REQ-R3: modelos de `google` vem do catalogo instalado', 'nenhum pi-ai instalado nesta maquina');
} else {
  await check('REQ-R3: os modelos oferecidos para `google` sao os do catalogo instalado', async () => {
    const all = await import(pathToFileURL(catalogFile).href);
    const expected = all.getBuiltinModels('google').map((model) => model.id);
    assert.ok(expected.length > 0, 'o catalogo instalado nao lista modelos para google');

    reset();
    calls.length = 0;
    script = {
      pick: (labels, options) => {
        if (options.placeHolder === 'Escolha a rota do provedor') return 'google';
        if (options.placeHolder === 'Escolha os modelos de google') return [expected[1]];
        throw new Error(`lista inesperada: ${options.placeHolder}`);
      },
      input: acceptDefault,
    };
    await configureProvider({ entry }, { ...baseOptions, dshCommand: 'dsh' });

    assert.deepEqual(listFor('Escolha a rota do provedor')?.labels, [
      ...all.getBuiltinProviders(),
      'outra rota (informar URL e protocolo)',
    ]);
    assert.deepEqual(listFor('Escolha os modelos de google')?.labels, [...expected, 'outro id (digitar)']);
    assert.deepEqual(calls[0]?.args, [
      'add',
      'teste',
      '--force',
      '--provider',
      'google',
      '--model',
      expected[1],
      '--key-env',
      providerKeyEnv('google'),
    ]);
  });
}

// REQ-R4 with the catalog this machine actually has: a route the deck's table
// does not carry arrives with its endpoint and protocol already answered.
if (catalogFile === undefined) {
  skip('REQ-R4: endpoint e protocolo sugeridos pelo catalogo instalado', 'nenhum pi-ai instalado nesta maquina');
} else {
  await check('REQ-R4: o catalogo instalado responde endpoint e protocolo de quem o deck nao conhece', async () => {
    const installed = await provider.loadPiAiCatalog('dsh');
    const outside = installed?.providers.filter((id) => PROVIDER_ROUTES[id] === undefined) ?? [];
    assert.ok(outside.length > 0, 'todo id do catalogo instalado esta na tabela do deck');
    const [route] = outside;
    const [model] = installed.models[route] ?? [];
    assert.equal(typeof model?.api, 'string', `sem protocolo no catalogo para "${route}"`);
    assert.match(model?.baseUrl ?? '', /^https:\/\//, `sem endpoint no catalogo para "${route}"`);
  });
}

// REQ-R3, the explicit fallback: with no catalog to read, the flow says so and
// asks for the id — it never offers an empty list, and never one of its own.
await check('sem pi-ai: avisa, pede o id do modelo e nunca oferece lista vazia', async () => {
  reset();
  calls.length = 0;
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'google';
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: (prompt, value) =>
      prompt === 'Id do modelo' ? 'gemini-3.7-flash' : prompt === 'Outros modelos' ? '' : acceptDefault(prompt, value),
  };
  const outcome = await configureProvider({ entry }, {
    ...baseOptions,
    loadCatalog: async () => undefined,
    loadProtocols: () => undefined,
  });

  assert.deepEqual(listFor('Escolha a rota do provedor')?.labels, [
    ...Object.keys(PROVIDER_ROUTES),
    'outra rota (informar URL e protocolo)',
  ]);
  assert.match(shown.warning[0] ?? '', /catalogo de modelos do pi-ai/);
  assert.equal(listFor('Escolha os modelos de google'), undefined);
  assert.equal(offered.filter((item) => item.options.canPickMany === true).length, 0);
  assert.ok(inputFor('Id do modelo') !== undefined, `boxes abertos: ${asked.map((item) => item.prompt).join(' | ')}`);
  assert.deepEqual(calls[0]?.args, [
    'add',
    'teste',
    '--force',
    '--provider',
    'google',
    '--model',
    'gemini-3.7-flash',
    '--key-env',
    providerKeyEnv('google'),
  ]);
  assert.equal(outcome?.kind, 'google');
});

// REQ-R3 (protocol list): the options of a hand-declared route come from the
// installed adapter, never from a list written here.
const protocols = readInstalledProtocols('dsh');
if (protocols === undefined) {
  skip('REQ-R3: protocolos lidos do dsh-llm-pi-ai instalado', 'nenhum dsh-llm-pi-ai instalado nesta maquina');
} else {
  await check('REQ-R3: os protocolos vem da constante do dsh-llm-pi-ai instalado', () => {
    assert.ok(protocols.length > 0);
    assert.ok(
      protocols.includes('openai-completions'),
      `protocolos lidos: ${protocols.join(', ')}`,
    );
    for (const protocol of protocols) assert.equal(typeof protocol, 'string');
  });
}

// REQ-R5/R6, end to end: the arguments the panel builds are handed to the real
// CLI, which writes the registry the harness boots from. The fake runner above
// proves the shape; only this proves the CLI accepts it.
const e2eDeck = await mkdtemp(join(tmpdir(), 'harness-deck-provider-e2e-'));
await check('ponta a ponta: o CLI real aceita os argumentos e grava o provedor', async () => {
  reset();
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'deepseek';
      if (options.placeHolder === 'Escolha os modelos de deepseek') return ['deepseek-chat', 'deepseek-reasoner'];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: acceptDefault,
  };
  const outcome = await configureProvider({ entry }, {
    home: e2eDeck,
    repoRoot,
    loadCatalog: async () => fakeCatalog,
  });

  assert.equal(outcome?.kind, 'deepseek');
  const registry = JSON.parse(await readFile(join(e2eDeck, 'harnesses.json'), 'utf8'));
  const saved = registry.harnesses.find((harness) => harness.name === 'teste');
  assert.equal(saved?.provider.kind, 'deepseek');
  assert.equal(saved?.provider.model, 'deepseek-chat');
  assert.deepEqual(saved?.provider.models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal(saved?.provider.apiKeyEnv, providerKeyEnv('deepseek'));
});

// The other end of the same run: a route the deck's table has no defaults for,
// written with the catalog's endpoint and protocol. Switching route drops what
// the old one remembered, and a single model stays a single model.
await check('ponta a ponta: trocar de rota grava endpoint, protocolo e um modelo so', async () => {
  reset();
  script = {
    pick: (labels, options) => {
      if (options.placeHolder === 'Escolha a rota do provedor') return 'xai';
      if (options.placeHolder === 'Escolha o protocolo (api)') return labels[0];
      if (options.placeHolder === 'Escolha os modelos de xai') return ['grok-4'];
      throw new Error(`lista inesperada: ${options.placeHolder}`);
    },
    input: (prompt, value) => (prompt === 'Outros modelos' ? '' : value),
  };
  const outcome = await configureProvider({ entry }, {
    home: e2eDeck,
    repoRoot,
    loadCatalog: async () => fakeCatalog,
    loadProtocols: () => ['openai-completions'],
  });

  assert.equal(outcome?.kind, 'xai');
  const registry = JSON.parse(await readFile(join(e2eDeck, 'harnesses.json'), 'utf8'));
  const saved = registry.harnesses.find((harness) => harness.name === 'teste');
  assert.equal(saved?.provider.kind, 'xai');
  assert.equal(saved?.provider.model, 'grok-4');
  // The chosen list IS the list: one model chosen means one model offered, so
  // the registry spells it out instead of leaving the previous list behind.
  assert.deepEqual(saved?.provider.models, ['grok-4']);
  assert.equal(saved?.provider.baseUrl, 'https://api.x.ai/v1');
  assert.equal(saved?.provider.api, 'openai-responses');
  assert.equal(saved?.provider.apiKeyEnv, providerKeyEnv('xai'));
});

await rm(e2eDeck, { recursive: true, force: true });
await rm(deck, { recursive: true, force: true });

process.stdout.write(failures === 0 ? `\ntudo ok (${checks} verificacoes)\n` : `\n${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
