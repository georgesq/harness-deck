/**
 * Gemini engine tests for harness-deck-launcher.
 *
 * Verifies:
 * - normalizeRegistry accepts engine: 'gemini'
 * - DEFAULT_KEY_ENV['gemini'] === 'GEMINI_API_KEY'
 * - credentialEnv resolves GEMINI_API_KEY for gemini engine
 * - profilePatchYml generates agent-loop disabled and harness-deck-gemini insert
 * - providerEnv sets GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL, etc.
 * - materializeProfile creates the symlink to harness-deck-gemini
 */
import { mkdtemp, lstat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  DEFAULT_KEY_ENV,
  credentialEnv,
  normalizeRegistry,
  providerEnv,
  type HarnessEntry,
} from '../src/registry.ts';
import {
  GEMINI_PLUGIN,
  materializeProfile,
  profilePatchYml,
} from '../src/materialize.ts';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

// 1. normalizeRegistry accepts engine: 'gemini'
const rawRegistry = {
  version: 1,
  harnesses: [
    {
      name: 'gemini-worker',
      port: 3140,
      engine: 'gemini',
      provider: {
        kind: 'google',
        model: 'gemini-2.5-flash',
        apiKeyEnv: 'GEMINI_API_KEY',
      },
    },
  ],
};

const normalized = normalizeRegistry(rawRegistry, '/tmp/deck-home');
assert.equal(normalized.harnesses.length, 1);
assert.equal(normalized.harnesses[0].engine, 'gemini');
assert.equal(normalized.harnesses[0].name, 'gemini-worker');
assert.equal(normalized.harnesses[0].port, 3140);
assert.equal(normalized.harnesses[0].provider?.kind, 'google');
assert.equal(normalized.harnesses[0].provider?.model, 'gemini-2.5-flash');
ok('normalizeRegistry accepts engine: "gemini"');

// 2. DEFAULT_KEY_ENV['gemini'] === 'GEMINI_API_KEY'
assert.equal(DEFAULT_KEY_ENV.gemini, 'GEMINI_API_KEY');
ok('DEFAULT_KEY_ENV["gemini"] === "GEMINI_API_KEY"');

const geminiEntryNoKeyEnv = {
  name: 'gemini-simple',
  profile: 'gemini-simple',
  port: 3141,
  engine: 'gemini',
  enabled: true,
} satisfies HarnessEntry;
assert.equal(credentialEnv(geminiEntryNoKeyEnv), 'GEMINI_API_KEY');
ok('credentialEnv falls back to GEMINI_API_KEY for gemini engine');

// 3. profilePatchYml generates the correct agent-loop disabled and insert blocks
const patch = profilePatchYml(normalized.harnesses[0]);
assert.ok(patch.includes('- id: agent-loop'), 'patch must contain - id: agent-loop');
assert.ok(patch.includes('disabled: true'), 'patch must disable agent-loop');
assert.ok(patch.includes('- insert:'), 'patch must have an insert block');
assert.ok(
  patch.includes(`- id: ${GEMINI_PLUGIN}`),
  `patch insert must contain - id: ${GEMINI_PLUGIN}`,
);
assert.ok(
  patch.includes(`name: ${GEMINI_PLUGIN}`),
  `patch insert must contain name: ${GEMINI_PLUGIN}`,
);
assert.ok(patch.includes('Gemini engine disables the'), 'patch comment mentions Gemini engine');
ok('profilePatchYml generates agent-loop disabled: true and harness-deck-gemini insert');

// 4. providerEnv sets GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL, etc.
const envFromEmpty = providerEnv(normalized.harnesses[0], {});
assert.equal(envFromEmpty.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta');
assert.equal(envFromEmpty.GOOGLE_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta');
assert.equal(envFromEmpty.GOOGLE_GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta');
assert.equal(envFromEmpty.GEMINI_MODEL, 'gemini-2.5-flash');
assert.equal(envFromEmpty.HARNESS_DECK_UPSTREAM_URL, 'https://generativelanguage.googleapis.com/v1beta');
assert.equal(envFromEmpty.GEMINI_API_KEY, undefined);

const envWithFileKey = providerEnv(normalized.harnesses[0], {
  GEMINI_API_KEY: 'secret-gemini-token',
});
assert.equal(envWithFileKey.GEMINI_API_KEY, 'secret-gemini-token');
assert.equal(envWithFileKey.GOOGLE_API_KEY, 'secret-gemini-token');
assert.equal(envWithFileKey.HARNESS_DECK_UPSTREAM_KEY, 'secret-gemini-token');
assert.ok(envWithFileKey.HARNESS_DECK_MODEL_MAP !== undefined);
assert.ok(envWithFileKey.HARNESS_DECK_MODEL_MAP.includes('gemini-2.5-flash'));
ok('providerEnv sets GEMINI_API_KEY, GEMINI_BASE_URL, and model environment variables');

// Custom base URL overrides default route base URL
const customGeminiEntry: HarnessEntry = {
  name: 'gemini-custom',
  profile: 'gemini-custom',
  port: 3142,
  engine: 'gemini',
  enabled: true,
  provider: {
    kind: 'google',
    model: 'gemini-2.5-pro',
    apiKeyEnv: 'CUSTOM_GEMINI_KEY',
    baseUrl: 'https://custom.gemini.proxy/v1beta',
  },
};
const customEnv = providerEnv(customGeminiEntry, { CUSTOM_GEMINI_KEY: 'custom-key' });
assert.equal(customEnv.GEMINI_BASE_URL, 'https://custom.gemini.proxy/v1beta');
assert.equal(customEnv.GOOGLE_BASE_URL, 'https://custom.gemini.proxy/v1beta');
assert.equal(customEnv.GOOGLE_GEMINI_BASE_URL, 'https://custom.gemini.proxy/v1beta');
assert.equal(customEnv.GEMINI_API_KEY, 'custom-key');
assert.equal(customEnv.GOOGLE_API_KEY, 'custom-key');
assert.equal(customEnv.GEMINI_MODEL, 'gemini-2.5-pro');
ok('providerEnv supports custom baseUrl and custom apiKeyEnv for gemini');

// 5. materializeProfile creates the symlink to harness-deck-gemini
const tmpHome = await mkdtemp(join(tmpdir(), 'harness-deck-gemini-materialize-'));
try {
  // Use packages/harness-deck-gemini as the plugin path
  const pluginDir = resolve(fileURLToPath(import.meta.url), '../../..', 'harness-deck-gemini');
  const result = await materializeProfile(tmpHome, normalized.harnesses[0], {
    pluginPath: pluginDir,
    geminiPluginPath: pluginDir,
  });

  const expectedLink = join(result.profileDir, 'node_modules', GEMINI_PLUGIN);
  assert.ok(result.linked.includes(expectedLink), 'result.linked must include gemini plugin path');

  const stats = await lstat(expectedLink);
  assert.ok(stats.isSymbolicLink(), 'created link must be a symbolic link');

  const patchContent = await readFile(join(result.profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patchContent.includes(GEMINI_PLUGIN), 'cordis.patch.yml must contain gemini plugin');
  assert.ok(patchContent.includes('disabled: true'), 'cordis.patch.yml must contain disabled: true');

  ok('materializeProfile creates the symlink to harness-deck-gemini and writes cordis.patch.yml');
} finally {
  await rm(tmpHome, { recursive: true, force: true });
}

process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
