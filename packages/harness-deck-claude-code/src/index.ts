/**
 * harness-deck Claude Code engine plugin.
 *
 * This cordis plugin registers an {@link AgentFactory} with the DSH
 * `ctx.agents` registry (`@deepseek-ai/dsh-agent`), the same extension point
 * `@deepseek-ai/dsh-agent-loop` uses to install the default engine. A DSH
 * process may only ever have ONE registered factory
 * (`AgentRegistry.setFactory` throws `an agent factory is already
 * registered` otherwise), so a profile that wants Claude Code as its engine
 * must run `dsh-agent-loop` disabled and this plugin in its place.
 *
 * SCOPE OF THIS FILE (docs/plano.md item 1.2 — scaffold only):
 * - Register the plugin and the factory.
 * - Satisfy the `AgentFactory` interface shape.
 * - Deliberately NOT implement agent creation/resume yet.
 *
 * What is intentionally missing, and where it is tracked in docs/plano.md:
 * - item 1.3: actually create an agent through the Claude Agent SDK and
 *   stream its response into the DSH session/chat.
 * - item 1.4: translate the Claude Agent SDK's tool-approval requests into
 *   DSH's own tool-approval UI flow.
 * - item 1.5: resume a persisted session (reconnect the SDK conversation
 *   after a process restart), mirroring `~/.claude/projects` state.
 *
 * Do not copy `dsh-agent-loop`'s internal engine logic (turn/step driving,
 * tool dispatch, session projections) — only its *registration* pattern.
 * This plugin's job is to be a different, independent engine, not a
 * reimplementation of the built-in one.
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { AgentFactory, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent';

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCodeAgentLoop: ClaudeCodeAgentLoop;
  }
}

/**
 * Minimal runtime configuration for this engine. Expanded in later items as
 * the Claude Agent SDK integration grows (model, permission mode, etc).
 *
 * TODO(1.3): this currently has no schema validation (no `zod`/`schemastery`
 * runtime check), unlike `dsh-agent-loop`'s `static Config = z.object(...)`.
 * Add one once there are real fields to validate.
 */
export interface ClaudeCodeAgentLoopConfig {
  /** Reserved for future engine options; empty until item 1.3 lands. */
  readonly placeholder?: never;
}

/**
 * Concrete `AgentFactory` for the Claude Code engine.
 *
 * Mirrors the registration pattern read from
 * `@deepseek-ai/dsh-agent-loop`'s `AgentLoop` class
 * (`lib/index.js`, around the `ctx.agents.setFactory(this)` call in its
 * constructor): a `Service` subclass that registers itself as the engine
 * factory through a `ctx.effect(...)` during construction, so the
 * registration is automatically undone if this plugin unloads.
 */
export class ClaudeCodeAgentLoop extends Service implements AgentFactory {
  static inject = ['agents'];

  constructor(ctx: Context, _config: ClaudeCodeAgentLoopConfig) {
    super(ctx, 'claudeCodeAgentLoop');

    // Register this engine as the sole AgentFactory for the process, the
    // same way `dsh-agent-loop` does. `ctx.effect` ties the registration's
    // lifetime to this plugin's scope: if the plugin unloads, the factory
    // slot is cleared automatically (see `AgentRegistry.setFactory`'s
    // returned disposer).
    ctx.effect(() => ctx.agents.setFactory(this), 'claudeCodeAgentLoop.setFactory()');
  }

  /**
   * @inheritdoc
   * TODO(1.3): drive the Claude Agent SDK here — start a conversation,
   * stream assistant/tool events into the DSH session log, and resolve once
   * both creation announcements complete (see the `AgentFactory.createAgent`
   * contract in `@deepseek-ai/dsh-agent`'s type declarations for the exact
   * ordering this must respect).
   */
  async createAgent(_ownerCtx: Context, _options: CreateAgentOptions): Promise<AgentHandle> {
    throw new Error('not implemented yet — item 1.3');
  }

  /**
   * @inheritdoc
   * TODO(1.5): reload the persisted session, reconnect (or replay) the
   * Claude Agent SDK conversation state, and reconcile it with whatever
   * `~/.claude/projects` holds for the same session (see docs/plano.md
   * item 3.2 for the longer-term dual-log concern).
   */
  async resume(_ownerCtx: Context, _options: ResumeAgentOptions): Promise<AgentHandle> {
    throw new Error('not implemented yet — item 1.3');
  }
}

export default ClaudeCodeAgentLoop;
