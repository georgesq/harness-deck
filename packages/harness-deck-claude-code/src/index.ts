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
import {
  agentEvents,
  type Agent,
  type AgentEventDispatch,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type AgentStatus,
  type AssistantStreamFrame,
  type CreateAgentOptions,
  type Inbox,
  type InboxTarget,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import type { Session, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session';
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  EMPTY_RESPONSE_CODE,
  LlmAttemptId,
  LlmError,
  createAssistantMessage,
  errorChain,
  type AssistantStreamRecord,
  type LlmFailure,
  type MessageId,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import { createScope, type Scope } from '@deepseek-ai/dsh-scope';
import * as acp from '@agentclientprotocol/sdk';
import { ensureModelProxy } from './model-proxy.js';

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
function spawnAcpAgent(binPath: string, cwd: string, env: NodeJS.ProcessEnv): AcpChildProcess {
  return spawn(process.execPath, [binPath], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
}

/**
 * Environment for the ACP child.
 *
 * When the deck configured a model mapping (`HARNESS_DECK_MODEL_MAP`), the CLI
 * is pointed at the loopback gateway instead of the provider: the CLI only
 * accepts model ids its own catalog describes, and the provider only accepts
 * its own slugs. `model-proxy.ts` bridges the two.
 */
async function acpChildEnv(): Promise<NodeJS.ProcessEnv> {
  const proxy = await ensureModelProxy();
  if (!proxy) return process.env;
  return { ...process.env, ANTHROPIC_BASE_URL: proxy.baseUrl };
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

  /**
   * This Agent's own registration scope, minted here and keyed BY THIS
   * INSTANCE.
   *
   * The key cannot be an arbitrary object: several DSH services resolve the
   * Agent out of its scope, and they compare against the Agent itself. The
   * file-upload service is the one that bit us —
   * `assertAgentScope` (`dsh-client-file-upload/lib/index.js:297`) rejects
   * anything whose `scopeOf(agent.ctx) !== agent`, and a rejected prompt
   * reaches the user as `prompt rejected (session/agent-busy)`, which names
   * neither the service nor the real cause. `dsh-agent-loop` mints its scope
   * the same way, keyed by the driver instance
   * (`dsh-agent-loop/lib/index.js:778`).
   */
  readonly scope: Scope;

  private idleWaiters: Array<() => void> = [];
  private wakeWaiters: Array<() => void> = [];

  /**
   * @param loopCtx - the engine plugin's own (live) context; the scope is
   * minted under it, so the Agent inherits the engine's dependency API.
   */
  constructor(loopCtx: Context, session: Session, options: AgentOptions) {
    this.session = session;
    this.id = session.id;
    this.options = options;
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx;
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
 * Live framing for one assistant attempt, reproducing the shape the default
 * engine publishes through its private `AssistantStreamAttempt`
 * (`dsh-agent-loop/lib/index.js:354`).
 *
 * The Web GUI folds these frames into a reconnect baseline and requires them
 * to be DENSE: `revision` must grow by exactly one per frame, and `index`
 * must be the zero-based position within the attempt — a gap makes the
 * consumer drop the attempt (`dsh-api-session-controller/lib/index.js:1254`
 * and `:1275`). Both counters therefore live here and are never reused
 * across attempts.
 *
 * The same chunk sequence feeds two outputs: the transient frames above and
 * the compact `stream` the durable `assistant/message` embeds, so a client
 * that reloads the session reconstructs the same text it saw live.
 */
class LiveAssistantAttempt {
  private readonly attemptId: LlmAttemptId;
  private readonly accumulator = new AssistantStreamAccumulator();
  private readonly assembler = new BlockAssembler();
  private readonly nextRevision: () => number;
  private readonly turn: number;
  private readonly step: number;
  private readonly emit: (frame: AssistantStreamFrame) => void;
  private index = 0;
  private text = '';
  private blockOpen = false;
  private terminal = false;

  /**
   * @param sessionId - identity embedded in the attempt id.
   * @param attempt - attached-session-local attempt counter.
   * @param nextRevision - allocates the next frame revision.
   * @param turn - durable turn owning the attempt.
   * @param step - durable step owning the attempt.
   * @param emit - agent-scoped frame publisher.
   */
  constructor(
    sessionId: Session['id'],
    attempt: number,
    nextRevision: () => number,
    turn: number,
    step: number,
    emit: (frame: AssistantStreamFrame) => void,
  ) {
    this.attemptId = LlmAttemptId(`${sessionId}:${attempt}`);
    this.nextRevision = nextRevision;
    this.turn = turn;
    this.step = step;
    this.emit = emit;
  }

  /** Publish the opening marker before the first delivered chunk. */
  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    });
  }

  /**
   * Publish one visible text delta.
   *
   * ACP reports text as bare deltas with no block structure, so this opens
   * the single text block on the first delta and keeps `index` at 0 for all
   * of them — one assistant message carries one text block here.
   */
  pushText(text: string): void {
    if (!this.blockOpen) {
      this.blockOpen = true;
      this.push({ type: 'block-start', index: 0, blockType: 'text' });
    }
    this.text += text;
    this.push({ type: 'text-delta', index: 0, text });
  }

  /**
   * Close the stream, commit the durable settlement, and publish its seq.
   * @param eventType - durable event type this attempt settles into:
   * `assistant/message` when the turn produced model-visible text,
   * `assistant/attempt` when it did not.
   * @param append - synchronous durable append returning its committed seq.
   */
  settle(eventType: 'assistant/message' | 'assistant/attempt', append: () => SessionSeq): void {
    if (this.blockOpen) {
      this.push({ type: 'block-end', index: 0, block: { type: 'text', text: this.text } });
    }
    this.push({ type: 'finish', reason: { kind: 'stop' } });
    let seq: SessionSeq;
    try {
      seq = append();
    } catch (error) {
      this.abandon();
      throw error;
    }
    this.terminal = true;
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'committed', eventType, seq },
    });
  }

  /** Publish abandonment when no durable settlement can be committed. */
  abandon(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.emit({
      type: 'end',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index,
      outcome: { kind: 'abandoned' },
    });
  }

  /** Whether any model-visible text was streamed during this attempt. */
  get hasVisibleText(): boolean {
    return this.text.length > 0;
  }

  /** Compact stream for the durable settlement event. */
  get stream(): AssistantStreamRecord[] {
    return [...this.accumulator.snapshot()];
  }

  /** Canonical completed-message blocks assembled from the same chunks. */
  blocks(): ReturnType<BlockAssembler['blocks']> {
    return this.assembler.blocks();
  }

  private push(chunk: StreamChunk): void {
    const timed = this.accumulator.push({ time: Date.now(), chunk });
    this.assembler.push(timed.chunk);
    this.emit({
      type: 'chunk',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      index: this.index++,
      time: timed.time,
      chunk: timed.chunk,
    });
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

    // The Agent must run on a *scoped* context, and the scope key must be the
    // Agent itself — `ownerCtx.extend()` copies the context chain but not the
    // scope tag, and an arbitrarily keyed scope fails the services that look
    // the Agent up through its scope. Both mistakes are invisible until a real
    // session runs: the first surfaces as "Agent preset binding requires a
    // scoped context" while creating the session, the second as
    // "prompt rejected (session/agent-busy)" while sending the first message.
    // `dsh-agent-loop` builds driver and scope in the same order inside an
    // effect on the owner (`lib/index.js:778` and `:1714`); this mirrors it.
    const loopCtx = this.runtime.ctx;
    let startedAgent: ClaudeCodeAgent | undefined;
    ownerCtx.effect(function* () {
      startedAgent = new ClaudeCodeAgent(loopCtx, session, options.agentOptions ?? {});
      yield startedAgent.scope.rawDispose;
    }, `claudeCodeAgentLoop.lifecycle(${options.sessionId})`);
    if (startedAgent === undefined) {
      detachSession();
      throw new Error('claudeCodeAgentLoop: the Agent did not start');
    }
    // Bound once: TypeScript cannot see through the closure above.
    const agent: ClaudeCodeAgent = startedAgent;
    const agentScope = agent.scope;

    // Honor `options.setup`'s documented contract: run it on the unpublished
    // agent/session before `register()` publishes either, and apply its
    // commit (if any) immediately before publication. A throw here rolls
    // the whole creation back instead of leaking a half-set-up agent.
    let setupCommit: { commit(): void } | undefined;
    if (options.setup !== undefined) {
      try {
        const result = await options.setup(agentScope.ctx, agent);
        if (result !== undefined) setupCommit = result;
      } catch (error) {
        detachSession();
        await agentScope.dispose();
        throw error;
      }
    }
    try {
      setupCommit?.commit();
    } catch (error) {
      detachSession();
      await agentScope.dispose();
      throw error;
    }

    const detachAgent = await this.runtime.ctx.agents.register(agent);

    const cwd = options.meta?.cwd ?? process.cwd();
    const binPath = await resolveAcpBinPath(this.config.acpBinPath);
    const child = spawnAcpAgent(binPath, cwd, await acpChildEnv());
    const bridgeAbort = new AbortController();

    // Agent-scoped dispatcher, built once per agent like `dsh-agent-loop`
    // does (`lib/index.js:777`). It is what carries `agent/assistant-stream`
    // — and, later, the tool approval events of item B.4 — to the process,
    // where the session controller listens with `{ global: true }`.
    const dispatch = agentEvents(this.runtime.ctx, agent);

    const bridgeDone = this.runBridge(agent, child, cwd, dispatch, bridgeAbort.signal).catch((error: unknown) => {
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
        await agentScope.dispose();
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
   * (`turn/start` -> `step/start` -> live frames -> `assistant/message` ->
   * `step/end` -> `turn/end`). Tool calls are intentionally ignored here
   * (B.4).
   */
  private async runBridge(
    agent: ClaudeCodeAgent,
    child: AcpChildProcess,
    cwd: string,
    dispatch: AgentEventDispatch,
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
        let attempt = 0;
        // One revision counter per agent lifecycle: the GUI's accumulator
        // rejects any frame that does not follow the previous one by exactly
        // one, so attempts share the counter instead of restarting it.
        let revision = 0;
        const nextRevision = () => (revision += 1);
        for (;;) {
          const userMessage = await agent.waitForWork(signal);
          if (userMessage === undefined) return;

          agent.markRunning();
          // The session controller only learns that a turn is in flight from
          // `agent/status` (`dsh-api-session-controller/lib/index.js:2884`), which
          // the default engine emits and this bridge did not — without it the GUI
          // never mounts its running indicator.
          dispatch.emit('agent/status', { status: 'running' });
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
          const live = new LiveAssistantAttempt(
            session.id,
            (attempt += 1),
            nextRevision,
            turn,
            step,
            (frame) => dispatch.emit('agent/assistant-stream', { frame }),
          );
          live.start();

          // Records the attempt without inventing model-visible history: the
          // same settlement the default engine uses for an attempt that never
          // became a message (`dsh-agent-loop/lib/index.js:1101`).
          const settleAttempt = () =>
            live.settle('assistant/attempt', () =>
              session.append('assistant/attempt', { turn, step, stream: live.stream }).seq,
            );

          // `settle` commits the durable event and only then publishes the
          // terminal frame carrying that event's seq, so a client can never
          // see the live stream end before the text it renders is durable.
          const settleMessage = () =>
            live.settle('assistant/message', () =>
              session.append(
                'assistant/message',
                {
                  turn,
                  step,
                  message: createAssistantMessage({
                    content: live.blocks(),
                    source: { provider: 'claude-agent-acp', model: 'claude-code' },
                  }),
                  stream: live.stream,
                },
                { surfaceOp: 'append' },
              ).seq,
            );

          let turnEnds: TurnEndReason = { kind: 'completed' };
          try {
            acpSession.prompt(promptText);

            for (;;) {
              const update = await acpSession.nextUpdate();
              if (update.kind === 'stop') break;
              if (update.update.sessionUpdate === 'agent_message_chunk' && update.update.content.type === 'text') {
                live.pushText(update.update.content.text);
              }
            }

            if (live.hasVisibleText) {
              settleMessage();
            } else {
              // An empty turn is a failure, not a success: Claude Code
              // resolves its pending prompt when its own process dies
              // mid-turn, and calling that `completed` would draw an empty
              // answer in the chat as if it had worked. `EMPTY_RESPONSE` is
              // the code the default engine already uses for this case, and
              // its retry policy already treats it as safe to repeat.
              settleAttempt();
              turnEnds = {
                kind: 'error',
                error: {
                  message: 'the ACP agent ended the turn without producing any text',
                  code: EMPTY_RESPONSE_CODE,
                },
              };
            }
          } catch (error) {
            // An attempt that never publishes its terminal frame leaves the
            // GUI holding an open live stream forever, so every failure has
            // to close it here.
            if (live.hasVisibleText) settleAttempt();
            else live.abandon();
            turnEnds = {
              kind: 'error',
              error:
                error instanceof LlmError ? error.failure : { message: errorChain(error), code: 'UNKNOWN' },
            };
          } finally {
            session.append('step/end', { turn, step });
            session.append('turn/end', { turn, reason: turnEnds });
            agent.markIdle();
            dispatch.emit('agent/status', { status: 'idle' });
          }
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
