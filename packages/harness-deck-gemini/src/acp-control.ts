/**
 * ACP control surface for the Gemini bridge: cancellation, session handling and updates.
 */
import * as acp from '@agentclientprotocol/sdk';
import type { LoopAcpSession, LoopAcpUpdate, SteeringOutcome } from './bridge-loop.js';

export const STEERING_METHOD = '_session/steering';

export function steeringSupported(initialize: acp.InitializeResponse): boolean {
  const meta = initialize._meta;
  if (meta === null || typeof meta !== 'object') return false;
  const steering = (meta as { steering?: unknown }).steering;
  if (steering === null || typeof steering !== 'object') return false;
  return (steering as { supported?: unknown }).supported === true;
}

export class LiveAcpSession implements LoopAcpSession {
  private readonly ctx: acp.ClientContext;
  private readonly active: acp.ActiveSession;
  private readonly steering: boolean;
  private pending: Promise<LoopAcpUpdate> | undefined;

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
    // Track tool calls or subagent activity
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      return { kind: 'subagent_activity', description: 'tool_call' };
    }
    return { kind: 'other' };
  }

  async cancel(): Promise<void> {
    await this.ctx.notify(acp.methods.agent.session.cancel, { sessionId: this.active.sessionId });
  }

  async steer(text: string): Promise<SteeringOutcome> {
    if (!this.steering) return 'unsupported';
    try {
      const response = await this.ctx.request<{ outcome?: unknown }>(STEERING_METHOD, {
        sessionId: this.active.sessionId,
        prompt: [{ type: 'text', text }],
        idleBehavior: 'promptRequired',
      });
      return response.outcome === 'injected' ? 'injected' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
