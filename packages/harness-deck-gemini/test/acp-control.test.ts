/**
 * ACP control tests for Gemini bridge — a real `ClientContext` and a scripted fake ACP agent
 * talking NDJSON over in-memory pipes.
 *
 * Verifies:
 * - Real cancellation (`session/cancel`) when stop is requested
 * - Wire protocol conformity (no `$/cancel_request`)
 * - Steering announcement and injection semantics
 */
import assert from 'node:assert/strict';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { LiveAcpSession, STEERING_METHOD, steeringSupported } from '../src/acp-control.js';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Ensure SDK methods match expectations
assert.equal(acp.methods.agent.session.cancel, 'session/cancel');
assert.deepEqual(Object.values(acp.methods.client.session), [
  'session/request_permission',
  'session/update',
]);
ok('o SDK instalado tem session/cancel do lado do agente');

assert.equal(steeringSupported({ _meta: { steering: { supported: true } } } as unknown as acp.InitializeResponse), true);
assert.equal(steeringSupported({ _meta: { steering: { supported: false } } } as unknown as acp.InitializeResponse), false);
assert.equal(steeringSupported({} as unknown as acp.InitializeResponse), false);
ok('a extensão de steering só vale quando o agente a anuncia em _meta.steering.supported');

// ---------------------------------------------------------------------------
// Wire harness
// ---------------------------------------------------------------------------

const clientToAgent = new PassThrough();
const agentToClient = new PassThrough();
const wire: string[] = [];
const tap = new Transform({
  transform(chunk: Buffer, _encoding, callback) {
    wire.push(chunk.toString('utf8'));
    callback(null, chunk);
  },
});
clientToAgent.pipe(tap);

const cancels: any[] = [];
const steers: any[] = [];
let resolvePrompt: ((response: any) => void) | undefined;

const agentApp = acp
  .agent({ name: 'fake-gemini-agent-acp' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    _meta: { steering: { supported: true } },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'fake-session' }))
  .onRequest(
    acp.methods.agent.session.prompt,
    () =>
      new Promise<any>((resolve) => {
        resolvePrompt = resolve;
      }),
  )
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    cancels.push(context.params);
    resolvePrompt?.({ stopReason: 'cancelled' });
  })
  .onRequest(
    STEERING_METHOD,
    (params: unknown) => params as any,
    (context) => {
      steers.push(context.params);
      return { outcome: 'injected' };
    },
  );

agentApp.connect(acp.ndJsonStream(Writable.toWeb(agentToClient), Readable.toWeb(tap)));

let promptResponse: unknown;
let discardedSteer: string | undefined;

await acp
  .client({ name: 'harness-deck-gemini-test' })
  .connectWith(
    acp.ndJsonStream(Writable.toWeb(clientToAgent), Readable.toWeb(agentToClient)),
    async (ctx) => {
      const initialize = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      assert.equal(steeringSupported(initialize), true);

      return ctx.buildSession(process.cwd()).withSession(async (active) => {
        const live = new LiveAcpSession(ctx, active, steeringSupported(initialize));
        assert.equal(live.sessionId, 'fake-session');

        const mute = new LiveAcpSession(ctx, active, false);
        discardedSteer = await mute.steer('não deve sair');
        assert.equal(discardedSteer, 'unsupported');
        assert.equal(steers.length, 0);

        void active.prompt('primeira').then((response) => {
          promptResponse = response;
        });

        // REQ-M4: Real cancellation (session/cancel)
        await live.cancel();
        await waitFor(() => cancels.length === 1, 'o session/cancel chegar no agente');
        await waitFor(() => promptResponse !== undefined, 'o prompt voltar como cancelled');

        // REQ-M3b: Steering injection
        assert.equal(await live.steer('steer injetado'), 'injected');
        await waitFor(() => steers.length === 1, 'o _session/steering chegar no agente');
        return 'ok';
      });
    },
  );

const raw = wire.join('');
assert.match(raw, /"method":"session\/cancel"/);
assert.doesNotMatch(raw, /\$\/cancel_request/);
ok('session/cancel cruza o fio como notificação; $/cancel_request não aparece');

assert.deepEqual(cancels, [{ sessionId: 'fake-session' }]);
ok('o agente recebe session/cancel com o sessionId vivo');

assert.deepEqual(promptResponse, { stopReason: 'cancelled' });
ok('o prompt pendente volta como cancelled depois do cancel');

assert.deepEqual(steers, [
  {
    sessionId: 'fake-session',
    prompt: [{ type: 'text', text: 'steer injetado' }],
    idleBehavior: 'promptRequired',
  },
]);
ok('_session/steering vai com promptRequired');
ok('agente sem steering anunciado não recebe nada');

// ---------------------------------------------------------------------------
// Model pinning (session/set_model)
// ---------------------------------------------------------------------------
const modelsPinned: any[] = [];
const agentWithModel = acp
  .agent({ name: 'gemini-agent-with-model' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'test-session-model' }))
  .onRequest(
    'session/set_model',
    (p: unknown) => p as any,
    (context) => {
      modelsPinned.push(context.params);
      return {};
    },
  );

const c2a = new PassThrough();
const a2c = new PassThrough();
agentWithModel.connect(acp.ndJsonStream(Writable.toWeb(a2c), Readable.toWeb(c2a)));

await acp
  .client({ name: 'gemini-test-client' })
  .connectWith(
    acp.ndJsonStream(Writable.toWeb(c2a), Readable.toWeb(a2c)),
    async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      return ctx.buildSession(process.cwd()).withSession(async (active) => {
        await (ctx as any).request('session/set_model', {
          sessionId: active.sessionId,
          modelId: 'google/gemini-2.5-pro',
        });
      });
    },
  );

assert.deepEqual(modelsPinned, [
  { sessionId: 'test-session-model', modelId: 'google/gemini-2.5-pro' },
]);
ok('session/set_model é suportado e envia sessionId e modelId corretamente');

process.stdout.write(`\ntudo ok em acp-control (${checks} verificações)\n`);
