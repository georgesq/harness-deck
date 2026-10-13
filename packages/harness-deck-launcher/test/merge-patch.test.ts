/**
 * The profile patch is shared with the running harness: the DSH config editor
 * writes the model the user picked in the harness UI into its
 * `agent-default-model` row. Regenerating the file wholesale on the next `up`
 * would silently undo that choice, so this checks the merge keeps it.
 *
 * Usage: node --experimental-strip-types --no-warnings test/merge-patch.test.ts
 */
import { profilePatchYml, mergeProfilePatch } from '../src/materialize.ts';
import type { HarnessEntry } from '../src/registry.ts';

const claude = {
  name: 'claude',
  profile: 'claude',
  port: 3131,
  engine: 'claude-code',
  enabled: true,
  home: '/tmp/homes/claude',
  provider: { kind: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', apiKeyEnv: 'OPENROUTER_API_KEY' },
} as unknown as HarnessEntry;

const generated = profilePatchYml(claude);
// What the DSH config editor writes when the user picks another model.
const edited = generated.replace(
  '    model: deepseek/deepseek-v4.1-flash',
  '    model: anthropic/claude-sonnet-4.5\n    reasoningEffort: high',
);
if (edited === generated) throw new Error('the simulated edit did not apply');

const merged = mergeProfilePatch(generated, edited);
const checks: [string, boolean][] = [
  ['keeps the chosen model', merged.includes('model: anthropic/claude-sonnet-4.5')],
  ['keeps reasoningEffort', merged.includes('reasoningEffort: high')],
  ['does not duplicate agent-default-model', (merged.match(/- id: agent-default-model/g) ?? []).length === 1],
  ['does not duplicate llm-pi-ai', (merged.match(/- id: llm-pi-ai/g) ?? []).length === 1],
  ['keeps the engine row', merged.includes('- id: agent-loop') && merged.includes('disabled: true')],
  ['keeps the plugin insert', merged.includes('id: harness-deck-claude-code')],
  ['drops the registry default', !merged.includes('model: deepseek/deepseek-v4.1-flash')],
];

const again = mergeProfilePatch(generated, merged);
checks.push(['is idempotent', again === merged]);

const dsh = { ...claude, name: 'dsh', engine: 'dsh', provider: undefined } as unknown as HarnessEntry;
checks.push(['keeps an empty patch empty', mergeProfilePatch(profilePatchYml(dsh), profilePatchYml(dsh)).endsWith('[]\n')]);

// Switching the provider is the case the deck exists for: a machine on a
// network where OpenRouter does not answer has to be able to move to another
// route. Nothing of the old route may survive — not the endpoint, not the
// credential variable, not the model list, and not the route named in
// `agent-default-model`, which would otherwise keep the engine on a provider
// that is no longer configured.
const switched = { ...claude, provider: { ...claude.provider!, kind: 'ollama', model: 'qwen3-coder:30b', apiKeyEnv: 'LLM_API_KEY', baseUrl: 'http://127.0.0.1:11434/v1' } } as unknown as HarnessEntry;
const afterSwitch = mergeProfilePatch(profilePatchYml(switched), generated);
checks.push(['a troca de rota remove o provedor antigo', !afterSwitch.includes('openrouter')]);
checks.push(['a troca de rota grava o provedor novo', afterSwitch.includes('provider: ollama')]);
checks.push(['a troca de rota grava o endpoint novo', afterSwitch.includes('baseURL: http://127.0.0.1:11434/v1')]);
checks.push(['a troca de rota grava o modelo novo', afterSwitch.includes('model: qwen3-coder:30b')]);

// Same route: the user's model choice is still the user's.
const sameRoute = mergeProfilePatch(profilePatchYml(claude), edited);
checks.push(['mesma rota mantém o modelo escolhido', sameRoute.includes('model: anthropic/claude-sonnet-4.5')]);

let failed = 0;
for (const [label, pass] of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'ok  ' : 'FALHA'} ${label}`);
}
if (failed > 0) {
  console.log('--- merged ---');
  console.log(merged);
}
console.log(failed === 0 ? 'tudo ok' : `${failed} falha(s)`);
process.exitCode = failed === 0 ? 0 : 1;
