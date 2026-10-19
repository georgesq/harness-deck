/**
 * ACP control tests — a real `ClientContext` and a scripted fake ACP agent
 * talking NDJSON over in-memory pipes. No DSH service, no network, no process.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/acp-control.test.ts
 *
 * REQ-M4 says cancel must abort the ACP prompt through the `session/cancel`
 * NOTIFICATION. That is a claim about the wire, so this test puts the real SDK
 * connection on both ends of the stream, taps the bytes, and checks what
 * actually crossed: `session/cancel`, and NOT `$/cancel_request`.
 */
import assert from 'node:assert/strict';
import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { LiveAcpSession, STEERING_METHOD, steeringSupported } from '../src/acp-control.ts';

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

// The method names are read from the installed SDK, never guessed: if the
// bridge used the wrong one, these two checks would fail before any wire test.
assert.equal(acp.methods.agent.session.cancel, 'session/cancel');
assert.deepEqual(Object.values(acp.methods.client.session), [
  'session/request_permission',
  'session/update',
]);
ok('o SDK instalado só tem session/cancel do lado do agente; o cliente não tem cancel');

assert.equal(steeringSupported({ _meta: { steering: { supported: true } } } as acp.InitializeResponse), true);
assert.equal(steeringSupported({ _meta: { steering: { supported: false } } } as acp.InitializeResponse), false);
assert.equal(steeringSupported({} as acp.InitializeResponse), false);
ok('a extensão de steering só vale quando o agente a anuncia em _meta.steering.supported');

// ---------------------------------------------------------------------------
// Wire harness: the client end is the real one the bridge uses.
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
let resolvePrompt: ((response: unknown) => void) | undefined;

const agentApp = acp
  .agent({ name: 'fake-claude-agent-acp' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    _meta: { steering: { supported: true } },
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'fake-session' }))
  // The prompt answers only when the cancel arrives, like the real CLI.
  .onRequest(
    acp.methods.agent.session.prompt,
    () =>
      new Promise<unknown>((resolve) => {
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
  .client({ name: 'harness-deck-claude-code-test' })
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

        // An agent that did NOT advertise steering must never be asked: the
        // message stays in the inbox for the step boundary instead.
        const mute = new LiveAcpSession(ctx, active, false);
        discardedSteer = await mute.steer('não deve sair');
        assert.equal(discardedSteer, 'unsupported');
        assert.equal(steers.length, 0);

        void active.prompt('primeira').then((response) => {
          promptResponse = response;
        });

        // REQ-M4: the cancel the bridge sends.
        await live.cancel();
        await waitFor(() => cancels.length === 1, 'o session/cancel chegar no agente');
        await waitFor(() => promptResponse !== undefined, 'o prompt voltar como cancelled');

        // REQ-M3b: the injection the bridge sends when it is advertised.
        assert.equal(await live.steer('steer injetado'), 'injected');
        await waitFor(() => steers.length === 1, 'o _session/steering chegar no agente');
        return 'ok';
      });
    },
  );

// ---------------------------------------------------------------------------
// What actually crossed the wire.
// ---------------------------------------------------------------------------

const raw = wire.join('');
assert.match(raw, /"method":"session\/cancel"/);
assert.doesNotMatch(raw, /\$\/cancel_request/);
ok('session/cancel cruza o fio como notificação; $/cancel_request não aparece');

assert.deepEqual(cancels, [{ sessionId: 'fake-session' }]);
ok('o agente recebe session/cancel com o sessionId vivo');

assert.deepEqual(promptResponse, { stopReason: 'cancelled' });
ok('o prompt pendente volta como cancelled depois do cancel (REQ-M4)');

assert.deepEqual(steers, [
  {
    sessionId: 'fake-session',
    prompt: [{ type: 'text', text: 'steer injetado' }],
    _meta: { steering: { idleBehavior: 'promptRequired' } },
  },
]);
ok('_session/steering vai com promptRequired, sem abrir turno destacado (REQ-M3b)');
ok('agente sem steering anunciado não recebe nada e a mensagem fica na fila');

process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
