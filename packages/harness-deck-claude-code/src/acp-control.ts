/**
 * ACP control surface of the bridge: cancellation and steering.
 *
 * Kept apart from `index.ts` on purpose. The two control calls are the only
 * place this plugin reaches back into the ACP connection after a prompt has
 * been sent, and the tests drive them against a real `ClientContext` over an
 * in-memory NDJSON stream (see `test/acp-cancel.test.ts`), which is only
 * possible when they are not entangled with the DSH plugin wiring.
 */
import * as acp from '@agentclientprotocol/sdk';
import type { LoopAcpSession, LoopAcpUpdate, SteeringOutcome } from './bridge-loop.js';

/**
 * Extension request the CLI uses to inject a message into the turn that is
 * currently running.
 *
 * Read from the installed CLI, not guessed: `STEER_METHOD` in
 * `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:202`, advertised to
 * clients through the top-level `InitializeResponse._meta.steering.supported`
 * (`acp-agent.js:1429`). It is an extension, so the bridge only ever calls it
 * after the agent advertised support.
 */
export const STEERING_METHOD = '_session/steering';

/** Whether the agent advertised the `_session/steering` extension. */
export function steeringSupported(initialize: acp.InitializeResponse): boolean {
  const meta = initialize._meta;
  if (meta === null || typeof meta !== 'object') return false;
  const steering = (meta as { steering?: unknown }).steering;
  if (steering === null || typeof steering !== 'object') return false;
  return (steering as { supported?: unknown }).supported === true;
}

/**
 * Live ACP session bound to one DSH agent.
 *
 * `ActiveSession` covers prompting and reading updates; cancellation is not on
 * it, so the `session/cancel` notification goes through the `ClientContext`
 * that owns the connection (`acp.d.ts:192`, `notify` at `acp.d.ts:221`).
 */
export class LiveAcpSession implements LoopAcpSession {
  private readonly ctx: acp.ClientContext;
  private readonly active: acp.ActiveSession;
  private readonly steering: boolean;

  /** The single in-flight update read, kept across timed-out steps. */
  private pending: Promise<LoopAcpUpdate> | undefined;

  /**
   * @param ctx - client context of the ACP connection.
   * @param active - the started session.
   * @param steering - whether the agent advertised `_session/steering`.
   */
  constructor(ctx: acp.ClientContext, active: acp.ActiveSession, steering: boolean) {
    this.ctx = ctx;
    this.active = active;
    this.steering = steering;
  }

  get sessionId(): string {
    return this.active.sessionId;
  }

  prompt(text: string): Promise<unknown> {
    return this.active.prompt(text);
  }

  /**
   * Read the next update of the session.
   *
   * At most one read is ever open: a read that a timed-out step left behind
   * still owns the session's next update, and opening a second one would
   * deliver the updates out of order — the orphan would take the update the
   * new step was waiting for.
   */
  nextUpdate(): Promise<LoopAcpUpdate> {
    const pending = this.pending ?? this.readUpdate();
    this.pending = pending;
    const clear = (): void => {
      if (this.pending === pending) this.pending = undefined;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async readUpdate(): Promise<LoopAcpUpdate> {
    const message = await this.active.nextUpdate();
    if (message.kind === 'stop') return { kind: 'stop', stopReason: message.stopReason };
    const update = message.update;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content;
      if (content.type === 'text') return { kind: 'text', text: content.text };
    }
    return { kind: 'other' };
  }

  /**
   * REQ-M4: cancel the in-flight prompt for real.
   *
   * The `session/cancel` NOTIFICATION is what the CLI handles
   * (`claude-agent-acp/dist/acp-agent.js:74`, `:3261`). Aborting the
   * `cancellationSignal` of `prompt()` would only send `$/cancel_request`,
   * which cancels the JSON-RPC request and not the agent's turn.
   */
  async cancel(): Promise<void> {
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.active.sessionId });
  }

  /**
   * Inject one message into the running ACP turn.
   *
   * `idleBehavior: 'promptRequired'` keeps turn ownership here: when the turn
   * already settled the CLI answers `promptRequired` WITHOUT starting a
   * detached turn, and the message stays in the inbox for the step boundary.
   */
  async steer(text: string): Promise<SteeringOutcome> {
    if (!this.steering) return 'unsupported';
    try {
      const response = await this.ctx.request<{ outcome?: unknown }>(STEERING_METHOD, {
        sessionId: this.active.sessionId,
        prompt: [{ type: 'text', text }],
        _meta: { steering: { idleBehavior: 'promptRequired' } },
      });
      return response?.outcome === 'injected' ? 'injected' : 'idle';
    } catch (error) {
      process.stderr.write(`[claude-code] steering refused, the message stays queued: ${String(error)}\n`);
      return 'unsupported';
    }
  }
}
