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
 * ARCHITECTURE (decided 2026-10-12, see docs/plano.md "Decisão do dono"):
 * this is an ACP BRIDGE, not a reimplementation of `dsh-agent-loop`'s LLM
 * calling internals. `@deepseek-ai/dsh-agent`'s own `AgentFactory` JSDoc
 * anticipates this: "consumers (e.g. the ACP bridge) program against
 * `ctx.agents` without depending on the concrete `dsh-agent-loop` package."
 * This plugin spawns `@agentclientprotocol/claude-agent-acp` as a child
 * process and speaks ACP JSON-RPC to it via `@agentclientprotocol/sdk`.
 *
 * ONE CORRECTION vs the original plan (found by running real `tsc`, not by
 * reading alone): `ctx.agents.register()` requires a full `Agent` object —
 * `options`, `session`, `inbox`, `status`, `ctx`, `cancel`, `whenIdle`,
 * `runMaintenance`, `send`, `followup`, `steer`, `inject` — not a bare
 * `{ id }`. `ClaudeCodeAgent` below is that facade: a thin implementation of
 * the contract that queues incoming messages and lets `runBridge` drain them
 * through the ACP subprocess. It is NOT a second `dsh-agent-loop` — there is
 * no turn/step driving logic of its own, no LLM call, no tool dispatch; all
 * of that lives in the spawned `claude-agent-acp` process.
 *
 * See packages/harness-deck-claude-code/docs/event-sequence.md for the exact
 * `SessionEvent` sequence this reproduces, and docs/plano.md items B.1-B.5
 * for scope (B.1-B.3 here: handshake + one-way text streaming; B.4 tool-call
 * approval and B.5 resume are deliberately deferred).
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Writable as NodeWritable, Readable as NodeReadable } from 'node:stream';
import { Readable, Writable } from 'node:stream';
import { Context, Service } from '@deepseek-ai/cordis';
import type {
  Agent,
  AgentFactory,
  AgentHandle,
  AgentOptions,
  AgentStatus,
  CreateAgentOptions,
  Inbox,
  InboxTarget,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import * as acp from '@agentclientprotocol/sdk';

declare module '@deepseek-ai/cordis' {
  interface Context {
    claudeCodeAgentLoop: ClaudeCodeAgentLoop;
  }
}

/**
 * Minimal runtime configuration for this engine.
 *
 * TODO(B.4+): no schema validation (no `zod`/`schemastery` runtime check)
 * yet, unlike `dsh-agent-loop`'s `static Config = z.object(...)`. Add one
 * once there are more fields.
 */
export interface ClaudeCodeAgentLoopConfig {
  /**
   * Path to the `claude-agent-acp` executable's entrypoint (its
   * `dist/index.js`). Defaults to resolving
   * `@agentclientprotocol/claude-agent-acp`'s own package from this
   * package's dependencies.
   */
  readonly acpBinPath?: string;
}

/** Resolve the bundled `claude-agent-acp` executable's JS entrypoint. */
async function resolveAcpBinPath(configured: string | undefined): Promise<string> {
  if (configured !== undefined) return configured;
  const pkgUrl = await import.meta.resolve('@agentclientprotocol/claude-agent-acp/package.json');
  const pkgPath = new URL(pkgUrl).pathname;
  const pkgDir = pkgPath.slice(0, pkgPath.lastIndexOf('/'));
  return `${pkgDir}/dist/index.js`;
}

/** The spawned ACP agent's stdio shape: piped stdin/stdout, inherited stderr. */
type AcpChildProcess = ChildProcessByStdio<NodeWritable, NodeReadable, null>;

/** Spawn `claude-agent-acp` as a child process speaking ACP over stdio. */
function spawnAcpAgent(binPath: string, cwd: string): AcpChildProcess {
  return spawn(process.execPath, [binPath], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: process.env,
  });
}

/**
 * In-memory, non-durable `Inbox`. Real durability (surviving a process
 * restart) is item B.5's job — this queue only needs to survive for the
 * life of one `ClaudeCodeAgent`, so `send`/`followup` can hand work to
 * `runBridge` without the caller blocking.
 *
 * TODO(B.5): back this with `session.append('agent/inbox/spliced', ...)`
 * (the durable event `dsh-agent`'s `types.ts` documents) once resume needs
 * to reconstruct pending input after a restart.
 */
class SimpleInbox implements Inbox {
  private nextTurnQueue: UserMessage[] = [];
  private nextStepQueue: UserMessage[] = [];
  private readonly onWake: () => void;

  constructor(onWake: () => void) {
    this.onWake = onWake;
  }

  get nextTurn(): readonly UserMessage[] {
    return this.nextTurnQueue;
  }

  get nextStep(): readonly UserMessage[] {
    return this.nextStepQueue;
  }

  clear(): void {
    this.nextStepQueue = [];
    this.nextTurnQueue = [];
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.listFor(target).push(message);
    this.onWake();
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.listFor(target).unshift(message);
    this.onWake();
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    for (const list of [this.nextTurnQueue, this.nextStepQueue]) {
      const index = list.findIndex((message) => message.id === messageId);
      if (index !== -1) {
        list[index] = newMessage;
        return true;
      }
    }
    return false;
  }

  remove(messageId: MessageId): boolean {
    for (const list of [this.nextTurnQueue, this.nextStepQueue]) {
      const index = list.findIndex((message) => message.id === messageId);
      if (index !== -1) {
        list.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    const removed = this.listFor(target).splice(start, deleteCount, ...inserted);
    if (inserted.length > 0) this.onWake();
    return removed;
  }

  /** Pull the next pending message across both lists, next-step first. */
  shift(): UserMessage | undefined {
    return this.nextStepQueue.shift() ?? this.nextTurnQueue.shift();
  }

  private listFor(target: InboxTarget): UserMessage[] {
    return target === 'next-step' ? this.nextStepQueue : this.nextTurnQueue;
  }
}

/**
 * Minimal `Agent` facade satisfying `@deepseek-ai/dsh-agent`'s runtime
 * contract. Unlike `dsh-agent-loop`'s `ReactLoopAgent`, this has no turn/step
 * driving logic of its own: `cancel`/`whenIdle`/`runMaintenance` are thin,
 * honest implementations of the documented contract, and `send`/`followup`/
 * `steer`/`inject` all funnel into the same `Inbox` that `runBridge` drains.
 *
 * TODO(B.4): `cancel` does not yet abort an in-flight ACP prompt — it only
 * flips `status` back to `idle` and clears queued input when `keepInbox` is
 * not set. Wiring real abort needs the ACP `session/cancel` request, which
 * calls into `ctx.agent` from `runBridge`'s closure; deferred with tool-call
 * approval since both need the live `ActiveSession`.
 */
class ClaudeCodeAgent implements Agent {
  readonly id: Session['id'];
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: SimpleInbox;
  readonly ctx: Context;
  status: AgentStatus = 'idle';

  private idleWaiters: Array<() => void> = [];
  private wakeWaiters: Array<() => void> = [];

  constructor(ctx: Context, session: Session, options: AgentOptions) {
    this.ctx = ctx;
    this.session = session;
    this.id = session.id;
    this.options = options;
    this.inbox = new SimpleInbox(() => this.wake());
  }

  cancel(_cause: unknown, options?: { keepInbox?: boolean }): void {
    if (!options?.keepInbox) this.inbox.clear();
    this.status = 'idle';
    this.settleIdle();
  }

  async whenIdle(): Promise<void> {
    if (this.status === 'idle') return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return task(controller.signal);
  }

  send(message: UserMessage, target: InboxTarget, _wakeup: boolean): void {
    this.inbox.append(target, message);
  }

  followup(message: UserMessage): void {
    this.inbox.append('next-turn', message);
  }

  steer(message: UserMessage): void {
    this.inbox.append('next-step', message);
  }

  inject(message: UserMessage): void {
    this.inbox.append('next-step', message);
  }

  /** Resolve the next `waitForWork` call, or block until `send`/`followup` wakes it. */
  async waitForWork(signal: AbortSignal): Promise<UserMessage | undefined> {
    for (;;) {
      const message = this.inbox.shift();
      if (message !== undefined) return message;
      if (signal.aborted) return undefined;
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort);
        };
        this.wakeWaiters.push(() => {
          cleanup();
          resolve();
        });
        signal.addEventListener('abort', onAbort);
      });
    }
  }

  markRunning(): void {
    this.status = 'running';
  }

  markIdle(): void {
    this.status = 'idle';
    this.settleIdle();
  }

  private settleIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private wake(): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const resolve of waiters) resolve();
  }
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
  static inject = ['agents', 'sessions'];

  private readonly config: ClaudeCodeAgentLoopConfig;

  /**
   * Plain holder around the plugin's own context.
   *
   * Same trick as `dsh-agent-loop` (`lib/index.js:1573`, "Plain holder
   * prevents Cordis from re-tracing the factory's dependency context through
   * a caller shadow"): `createAgent` runs synchronously inside
   * `AgentRegistry.create`, reached through the caller's shadow context. A
   * bare `this.ctx.sessions` read would then be resolved in the *caller's*
   * fiber — which does not declare `sessions` — and cordis answers
   * `cannot get property "sessions" without inject`. Going through this
   * holder keeps the read on the context that actually declared the inject.
   */
  private readonly runtime: { readonly ctx: Context };

  constructor(ctx: Context, config?: ClaudeCodeAgentLoopConfig) {
    super(ctx, 'claudeCodeAgentLoop');
    // The loader instantiates the plugin with `undefined` when the cordis
    // entry carries no `config:` block, so the default has to be applied
    // here — a `static Config` schema (the `dsh-agent-loop` pattern) is the
    // later, better home for this once there are real fields to validate.
    this.config = config ?? {};
    this.runtime = { ctx };

    // Register this engine as the sole AgentFactory for the process, the
    // same way `dsh-agent-loop` does. `ctx.effect` ties the registration's
    // lifetime to this plugin's scope: if the plugin unloads, the factory
    // slot is cleared automatically (see `AgentRegistry.setFactory`'s
    // returned disposer).
    ctx.effect(() => ctx.agents.setFactory(this), 'claudeCodeAgentLoop.setFactory()');
  }

  /**
   * @inheritdoc
   *
   * Items B.1-B.2: prepares the DSH session, builds the minimal
   * {@link ClaudeCodeAgent} facade, registers it, spawns `claude-agent-acp`,
   * performs the ACP handshake, and starts translating `session/update`
   * notifications (text chunks only, no tool calls yet) into DSH
   * `SessionEvent`s as `send`/`followup` deliver prompts.
   */
  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const sessions = this.runtime.ctx.sessions;

    const session = sessions.prepare(options.sessionId, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    });

    const detachSession = sessions.enter(session);
    try {
      sessions.announce(session);
    } catch (error) {
      detachSession();
      throw error;
    }

    const agentCtx = ownerCtx.extend();
    const agent = new ClaudeCodeAgent(agentCtx, session, options.agentOptions ?? {});

    // Honor `options.setup`'s documented contract: run it on the unpublished
    // agent/session before `register()` publishes either, and apply its
    // commit (if any) immediately before publication. A throw here rolls
    // the whole creation back instead of leaking a half-set-up agent.
    let setupCommit: { commit(): void } | undefined;
    if (options.setup !== undefined) {
      try {
        const result = await options.setup(agentCtx, agent);
        if (result !== undefined) setupCommit = result;
      } catch (error) {
        detachSession();
        throw error;
      }
    }
    try {
      setupCommit?.commit();
    } catch (error) {
      detachSession();
      throw error;
    }

    const detachAgent = await this.runtime.ctx.agents.register(agent);

    const cwd = options.meta?.cwd ?? process.cwd();
    const binPath = await resolveAcpBinPath(this.config.acpBinPath);
    const child = spawnAcpAgent(binPath, cwd);
    const bridgeAbort = new AbortController();

    const bridgeDone = this.runBridge(agent, child, cwd, bridgeAbort.signal).catch((error: unknown) => {
      ownerCtx.logger.error(`claudeCodeAgentLoop: ACP bridge for session "${session.id}" failed: ${String(error)}`);
    });

    return {
      agent,
      async dispose() {
        bridgeAbort.abort();
        child.kill();
        await bridgeDone;
        await detachAgent?.();
        detachSession();
      },
    };
  }

  /**
   * Connect to the spawned ACP agent, open one session on it scoped to
   * `cwd`, and drive it from `agent`'s inbox: each pending `UserMessage`
   * becomes one ACP `prompt`, whose `session/update` notifications are
   * translated into one DSH turn.
   *
   * Item B.2 scope: only `agent_message_chunk` text updates are translated
   * (`turn/start` -> `step/start` -> `assistant/message` -> `step/end` ->
   * `turn/end`). Tool calls are intentionally ignored here (B.4).
   */
  private async runBridge(
    agent: ClaudeCodeAgent,
    child: AcpChildProcess,
    cwd: string,
    signal: AbortSignal,
  ): Promise<void> {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const session = agent.session;

    await acp.client({ name: 'harness-deck-claude-code' }).connectWith(stream, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      return ctx.buildSession(cwd).withSession(async (acpSession) => {
        let turn = 0;
        for (;;) {
          const userMessage = await agent.waitForWork(signal);
          if (userMessage === undefined) return;

          agent.markRunning();
          turn += 1;
          const step = 1;
          session.append('turn/start', { turn });
          session.append('step/start', { turn, step });
          // The default engine appends the user's message itself when it
          // consumes the inbox (dsh-agent-loop/lib/index.js:1061). With the
          // default engine replaced, nobody else does it — without this the
          // chat would show the answer with no question above it.
          session.append('user/message', userMessage, { surfaceOp: 'append' });

          const promptText = userMessage.content
            .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
          acpSession.prompt(promptText);

          const chunks: string[] = [];
          for (;;) {
            const update = await acpSession.nextUpdate();
            if (update.kind === 'stop') break;
            if (update.update.sessionUpdate === 'agent_message_chunk' && update.update.content.type === 'text') {
              chunks.push(update.update.content.text);
            }
          }

          session.append(
            'assistant/message',
            {
              turn,
              step,
              message: createAssistantMessage({
                content: [{ type: 'text', text: chunks.join('') }],
                source: { provider: 'claude-agent-acp', model: 'claude-code' },
              }),
              stream: [],
            },
            { surfaceOp: 'append' },
          );
          session.append('step/end', { turn, step });
          session.append('turn/end', { turn, reason: { kind: 'completed' } });
          agent.markIdle();
        }
      });
    });
  }

  /**
   * @inheritdoc
   * TODO(B.5): reload the persisted session, reconnect (or replay) the ACP
   * session, and reconcile it with whatever `~/.claude/projects` holds for
   * the same session (see docs/plano.md item 3.2 for the longer-term
   * dual-log concern).
   */
  async resume(_ownerCtx: Context, _options: ResumeAgentOptions): Promise<AgentHandle> {
    throw new Error('not implemented yet — item B.5');
  }
}

export default ClaudeCodeAgentLoop;
