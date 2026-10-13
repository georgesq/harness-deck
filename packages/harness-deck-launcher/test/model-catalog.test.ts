/**
 * The model list a harness offers comes from the deck's own settings, not from
 * the Claude Code CLI's built-in catalog (owner's decision of 12/10/2026).
 *
 * Two places have to agree on that list: the profile patch, whose `llm-pi-ai`
 * `models` array is what the DSH model selector is built from, and the
 * `HARNESS_DECK_MODEL_MAP` handed to the ACP bridge, which turns each offered
 * catalog id back into the provider slug. This checks both, plus the registry
 * validation that keeps a malformed list from reaching either.
 *
 * Usage: node --experimental-strip-types --no-warnings test/model-catalog.test.ts
 */
import { mergeProfilePatch, profilePatchYml } from '../src/materialize.ts';
import { providerEnv } from '../src/registry.ts';
import { catalogModelId, modelMap, normalizeRegistry, providerModels, type HarnessEntry } from '../src/registry.ts';

const CLAUDE_MODELS = [
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
];

const base = {
  name: 'claude',
  profile: 'claude',
  port: 3131,
  engine: 'claude-code',
  enabled: true,
  home: '/tmp/homes/claude',
  provider: {
    kind: 'openrouter',
    model: 'anthropic/claude-sonnet-5.5',
    models: CLAUDE_MODELS,
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
} as unknown as HarnessEntry;

const checks: [string, boolean][] = [];

// --- providerModels: the default comes first, nothing repeats ----------------
checks.push(['offers every model', providerModels(base.provider).length === 3]);
checks.push(['starts on the registry default', providerModels(base.provider)[0] === 'anthropic/claude-sonnet-5.5']);
checks.push([
  'keeps the whole list',
  CLAUDE_MODELS.every((slug) => providerModels(base.provider).includes(slug)),
]);
checks.push([
  'de-duplicates the default when it repeats in the list',
  providerModels({ ...base.provider, models: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5'] }).length === 2,
]);
// A registry written before `models` existed must behave exactly as it used to.
checks.push(['a block with no list offers only its model', providerModels({ ...base.provider, models: undefined }).length === 1]);

// --- the profile patch: every model reaches the DSH selector -----------------
const patch = profilePatchYml(base);
for (const slug of CLAUDE_MODELS) {
  checks.push([`patch registers ${slug}`, patch.includes(`- id: ${slug}`)]);
}
checks.push(['patch keeps one default row', patch.includes('    model: anthropic/claude-sonnet-5.5')]);
checks.push([
  'patch registers three rows',
  (patch.match(/^ {10}- id: /gm) ?? []).length === 3,
]);
// The old shape: the generated default is the only offered model.
const single = profilePatchYml({ ...base, provider: { ...base.provider, models: undefined } } as HarnessEntry);
checks.push([
  'a single-model harness still generates one row',
  (single.match(/^ {10}- id: /gm) ?? []).length === 1,
]);

// Merging must not resurrect a model the owner dropped from the list: the
// `llm-pi-ai` row belongs to the harness once it ran, but the list is settings.
const merged = mergeProfilePatch(patch, patch);
checks.push(['the generated list survives a merge', CLAUDE_MODELS.every((slug) => merged.includes(`- id: ${slug}`))]);

// The two defects found by running the real harness on 12/10/2026, both of
// which produced a profile with a single model and no error anywhere:
//   1. the whole `llm-pi-ai` row was kept from disk, so a list added to the
//      registry afterwards never reached the profile;
//   2. the row's own structure was treated as "extra keys" and spliced into
//      itself, so the second `up` duplicated the block.
const profileOnDisk = profilePatchYml({ ...base, provider: { ...base.provider, models: undefined } } as HarnessEntry);
const upgraded = mergeProfilePatch(patch, profileOnDisk);
for (const slug of CLAUDE_MODELS) {
  checks.push([`an upgraded profile gains ${slug}`, upgraded.includes(`- id: ${slug}`)]);
}
checks.push(['an upgraded profile has no duplicate row', (upgraded.match(/- id: llm-pi-ai/g) ?? []).length === 1]);
checks.push(['an upgraded profile has no duplicate name', (upgraded.match(/name: "@deepseek-ai\/dsh-llm-pi-ai"/g) ?? []).length === 1]);
checks.push([
  'an upgraded profile has one apiKeyEnv',
  (upgraded.match(/apiKeyEnv: OPENROUTER_API_KEY/g) ?? []).length === 1,
]);
// Repeated `up` must converge: the registry is the source of truth for the list.
checks.push(['the upgrade is idempotent', mergeProfilePatch(patch, upgraded) === upgraded]);

// A key the harness itself wrote into the route must survive the merge.
const withHarnessKey = patch.replace(
  '        api: openai-completions',
  '        api: openai-completions\n        retryPolicy: aggressive',
);
const kept = mergeProfilePatch(patch, withHarnessKey);
checks.push(['keeps a key the harness added to the route', kept.includes('retryPolicy: aggressive')]);
checks.push([
  'keeps exactly one retryPolicy',
  (kept.match(/retryPolicy: aggressive/g) ?? []).length === 1,
]);
checks.push(['stays idempotent with that key', mergeProfilePatch(patch, kept) === kept]);

// --- the bridge map: catalog id in, provider slug out ------------------------
const map = modelMap(base.provider);
checks.push(['maps every offered model', CLAUDE_MODELS.every((slug) => map[catalogModelId(slug)] === slug)]);
checks.push(['keeps the background model', map[catalogModelId('anthropic/claude-haiku-5.5')] === 'anthropic/claude-haiku-5.5']);
checks.push(['catalogModelId strips the vendor and the dots', catalogModelId('anthropic/claude-sonnet-5.5') === 'claude-sonnet-5-5']);
// Every value must be a slug the provider accepts, never a bare catalog id.
checks.push(['every mapped value carries its vendor', Object.values(map).every((slug) => slug.includes('/'))]);

// --- providerEnv: the map reaches the child process --------------------------
const env = providerEnv(base, { OPENROUTER_API_KEY: 'test-key' });
const childMap = JSON.parse(String(env.HARNESS_DECK_MODEL_MAP)) as Record<string, string>;
checks.push(['the child receives the whole map', Object.keys(childMap).length >= CLAUDE_MODELS.length]);
checks.push([
  'the child can resolve any offered model',
  CLAUDE_MODELS.every((slug) => childMap[catalogModelId(slug)] === slug),
]);
checks.push(['the child starts on the registry default', env.ANTHROPIC_MODEL === catalogModelId('anthropic/claude-sonnet-5.5')]);

// --- registry validation -----------------------------------------------------
const registryWith = (provider: unknown): unknown => ({
  version: 1,
  home: '/tmp/deck',
  harnesses: [{ name: 'claude', port: 3131, engine: 'claude-code', provider }],
});
const parsed = normalizeRegistry(registryWith({ kind: 'openrouter', model: 'a/b', models: ['a/b', 'c/d', 'c/d'] }), '/tmp/deck');
checks.push(['keeps the declared list', parsed.harnesses[0]!.provider?.models?.length === 2]);
checks.push([
  'an absent list stays absent',
  normalizeRegistry(registryWith({ kind: 'openrouter', model: 'a/b' }), '/tmp/deck').harnesses[0]!.provider?.models === undefined,
]);

const rejects: [string, unknown][] = [
  ['rejects a non-array list', 'a/b'],
  ['rejects an empty list', []],
  ['rejects a blank entry', ['a/b', '  ']],
  ['rejects a non-string entry', ['a/b', 7]],
];
for (const [label, models] of rejects) {
  let threw = false;
  try {
    normalizeRegistry(registryWith({ kind: 'openrouter', model: 'a/b', models }), '/tmp/deck');
  } catch {
    threw = true;
  }
  checks.push([label, threw]);
}

let failed = 0;
for (const [label, pass] of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'ok  ' : 'FALHA'} ${label}`);
}
if (failed > 0) {
  console.log('--- patch ---');
  console.log(patch);
  console.log('--- map ---');
  console.log(JSON.stringify(map, undefined, 2));
}
console.log(failed === 0 ? 'tudo ok' : `${failed} falha(s)`);
process.exitCode = failed === 0 ? 0 : 1;
