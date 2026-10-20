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
  type InboxTarget,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import { SessionLogOffset, interruptedTurnClosers } from '@deepseek-ai/dsh-session';
import type { AgentCancelCause, Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval';
import {
  AssistantStreamAccumulator,
  BlockAssembler,
  LlmAttemptId,
  createAssistantMessage,
  errorChain,
  type AssistantStreamRecord,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import { createScope, type Scope } from '@deepseek-ai/dsh-scope';
import * as acp from '@agentclientprotocol/sdk';
import { ensureModelProxy } from './model-proxy.js';
import {
  SimpleInbox,
  decideDrain,
  runBridgeLoop,
  type LiveTurnControl,
  type LoopAttemptFactory,
} from './bridge-loop.js';
import { LiveAcpSession, steeringSupported } from './acp-control.js';

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
  /**
   * Inactivity ceiling for one ACP prompt, in milliseconds.
   *
   * A prompt that produces no update for this long is cancelled and its turn
   * is closed with a visible error, so a wedged agent cannot hold the inbox
   * forever (REQ-M5). It is an INACTIVITY ceiling, not a turn budget: every
   * delivered update restarts it, so a long turn that keeps streaming or
   * calling tools is never interrupted by it.
   */
  readonly promptIdleTimeoutMs?: number;
}

/** Default {@link ClaudeCodeAgentLoopConfig.promptIdleTimeoutMs}: 30 minutes. */
const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * How long the bridge waits for the stop after it sends `session/cancel`.
 *
 * The CLI itself arms a 30s floor before it forces a wedged prompt loop to
 * return `cancelled` (`DEFAULT_FORCE_CANCEL_GRACE_MS`,
 * `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:80`), so this stays
 * above it and the stop below is bounded in practice.
 */
const CANCEL_GRACE_MS = 35_000;

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

/** The `model` config option the ACP agent advertises on every session. */
const MODEL_CONFIG_ID = 'model';

/**
 * Point the ACP session at the model the DSH session selected.
 *
 * The DSH's own model selection and the Claude Code CLI's are two different
 * things, and only the DSH side knows what the owner picked. Left alone, the
 * CLI keeps its own default — and because the deck hands it a catalog id
 * (`claude-sonnet-5-5`), the CLI resolves that id against its own catalog and
 * can land on a different model than the selector shows. That is the whole of
 * "it always opens Opus": the alias wins, the selection is decoration.
 *
 * The model is looked up in `HARNESS_DECK_MODEL_MAP`, which the launcher built
 * from the registry, so a slug the registry does not offer is refused here
 * rather than silently sent to a provider that would reject it.
 *
 * Failure is not fatal: a session whose model could not be pinned still runs on
 * the CLI's default, and refusing the session would be worse than the drift.
 * The reason is logged so the drift is visible instead of silent.
 *
 * @param ctx - ACP client context, for the `session/set_config_option` call.
 * @param sessionId - the ACP session to configure.
 * @param slug - provider slug from the DSH selection, when there is one.
 */
async function applySelectedModel(
  ctx: acp.ClientContext,
  sessionId: string,
  slug: string | undefined,
): Promise<void> {
  if (slug === undefined) return;
  const rawMap = process.env.HARNESS_DECK_MODEL_MAP;
  if (!rawMap) return;
  let map: Record<string, string>;
  try {
    map = JSON.parse(rawMap) as Record<string, string>;
  } catch {
    return;
  }
  const catalog = Object.entries(map).find(([, value]) => value === slug)?.[0];
  if (catalog === undefined) {
    process.stderr.write(
      `[claude-code] model "${slug}" is not in the deck's model map; the session keeps the CLI default\n`,
    );
    return;
  }
  try {
    await ctx.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: MODEL_CONFIG_ID,
      value: catalog,
    });
  } catch (error) {
    process.stderr.write(
      `[claude-code] could not pin model "${slug}" (${catalog}): ${errorChain(error)}\n`,
    );
  }
}

/**
 * Minimal `Agent` facade satisfying `@deepseek-ai/dsh-agent`'s runtime
 * contract. Unlike `dsh-agent-loop`'s `ReactLoopAgent`, this has no turn/step
 * driving logic of its own: `whenIdle`/`runMaintenance` are thin, honest
 * implementations of the documented contract, `send`/`followup`/`steer`/
 * `inject` all funnel into the same `Inbox`, and the turn/step scheduling
 * lives in `bridge-loop.ts`.
 *
 * `cancel` aborts the ACP prompt for real: it hands the cause to the scheduler
 * and asks the live ACP session to send `session/cancel` (REQ-M4). It does NOT
 * flip `status` back to `idle` — the turn is still open on the ACP side, and
 * pretending otherwise would let the next turn start on top of it. The
 * scheduler closes the turn and goes idle.
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
   * Control of the ACP prompt currently in flight, attached by the scheduler
   * for the duration of one step. `cancel` reaches the ACP session through it.
   */
  private liveTurn: LiveTurnControl | undefined;

  /** Cancellation recorded by {@link cancel} and taken by the scheduler. */
  private cancelCause: AgentCancelCause | undefined;

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
    // Pending input is recorded durably as `agent/inbox/spliced`, the event
    // `dsh-agent` documents for exactly this queue, so a reload can
    // reconstruct what was still waiting instead of losing it with the
    // process. The `inbox` session projection that folds those events is NOT
    // registered here: only `dsh-agent-loop` registers it
    // (`dsh-agent-loop/lib/index.js:1559`) and that package is disabled in
    // this profile.
    this.inbox = new SimpleInbox(
      () => this.wake(),
      (splice) => {
        session.append('agent/inbox/spliced', splice);
      },
    );
  }

  /**
   * Provider slug this agent must run on, from the DSH model selection.
   *
   * `AgentOptions.model` is the slug the registry advertises
   * (`anthropic/claude-sonnet-5.5`), not the CLI's catalog id — the loopback
   * gateway is what turns one into the other. `undefined` means "whatever the
   * CLI was started with", which is the registry default.
   */
  get selectedModel(): string | undefined {
    const model = this.options.model;
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined;
  }

  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (!options?.keepInbox) this.inbox.clear();
    // Outside a turn there is nothing to abort, and recording the cause would
    // poison the next turn's `turn/end`.
    if (this.status !== 'running') return;
    this.cancelCause = cause;
    this.liveTurn?.requestCancel();
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

  /**
   * Resolve the next `waitForWork` call, or block until input arrives.
   *
   * The wake reports WHICH list woke it (`next-step` first), which is what
   * decides whether the turn about to open owns a queued turn or only a steered
   * message — the same classification `dsh-agent-loop` makes when it wakes.
   */
  async waitForWork(signal: AbortSignal): Promise<{ readonly target: InboxTarget } | undefined> {
    for (;;) {
      const decision = decideDrain(this.inbox, false);
      if (decision.kind === 'start-turn') return { target: decision.target };
      if (signal.aborted) return undefined;
      await this.waitForWake(signal);
    }
  }

  /** Block until `next-step` input arrives, or the signal aborts. */
  async waitForSteer(signal: AbortSignal): Promise<UserMessage | undefined> {
    for (;;) {
      const message = this.inbox.nextStep[0];
      if (message !== undefined) return message;
      if (signal.aborted) return undefined;
      await this.waitForWake(signal);
    }
  }

  /** Attach (or detach) the control of the ACP prompt currently in flight. */
  attachTurn(control: LiveTurnControl | undefined): void {
    this.liveTurn = control;
  }

  /** Take the recorded cancellation cause, if any, clearing it. */
  consumeCancelCause(): AgentCancelCause | undefined {
    const cause = this.cancelCause;
    this.cancelCause = undefined;
    return cause;
  }

  /** Sleep until `send`/`followup`/`steer` wakes this agent, or the signal aborts. */
  private async waitForWake(signal: AbortSignal): Promise<void> {
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

/** A session's owned durable-log handle and how many events it already holds. */
interface StoredSession {
  readonly handle: SessionHandle;
  storedCount: number;
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
  static inject = ['agents', 'sessions', 'approval', 'sandboxPolicy'];

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
      ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
    });

    const stored = await this.createStoredSession(session);
    return this.launch(ownerCtx, session, stored, options.agentOptions ?? {}, options.setup);
  }

  /**
   * Take write ownership of a fresh session's durable log, when a persistence
   * backend is mounted.
   *
   * Without this nothing reaches `DSH_HOME/sessions`: the JSONL backend only
   * routes a session's `session/event`s into a handle somebody opened for it,
   * and `dsh-agent-loop` is who opens it in the default engine. A bridge that
   * skips it keeps the session in memory and in the projection cache only, so
   * the session list is empty after a restart.
   *
   * @param session - the prepared, not yet entered session.
   * @returns the owned handle and stored cursor, or `undefined` without a backend.
   */
  private async createStoredSession(session: Session): Promise<StoredSession | undefined> {
    const persistence = this.runtime.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      process.stderr.write('[claude-code] no session persistence backend; the session will not survive a restart\n');
      return undefined;
    }
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
    });
    return { handle, storedCount: 0 };
  }

  /**
   * Store the events already in the session log that were appended before it
   * entered the store (the constructor seed). Those never re-emit through
   * `session/event`, so the live routing would miss them. Must run before
   * `sessions.enter`, otherwise the same events would be written twice.
   */
  private async appendUnstoredSuffix(stored: StoredSession | undefined, session: Session): Promise<void> {
    if (stored === undefined) return;
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount));
    if (suffix.length > 0) await stored.handle.append(suffix);
    stored.storedCount += suffix.length;
  }

  /**
   * Build, register and start one agent around a prepared session. Shared by
   * {@link createAgent} and {@link resume}; owns `stored` from here on and
   * closes it on every failure path and in the returned `dispose`.
   */
  private async launch(
    ownerCtx: Context,
    session: Session,
    stored: StoredSession | undefined,
    agentOptions: AgentOptions,
    setup: CreateAgentOptions['setup'],
  ): Promise<AgentHandle> {
    const sessions = this.runtime.ctx.sessions;
    const closeStored = async (): Promise<void> => {
      await stored?.handle.close().catch((error: unknown) => {
        ownerCtx.logger.warn(`claudeCodeAgentLoop: closing the log of session "${session.id}" failed: ${String(error)}`);
      });
    };

    let detachSession: () => void;
    try {
      await this.appendUnstoredSuffix(stored, session);
      detachSession = sessions.enter(session);
    } catch (error) {
      await closeStored();
      throw error;
    }
    try {
      sessions.announce(session);
    } catch (error) {
      detachSession();
      await closeStored();
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
      startedAgent = new ClaudeCodeAgent(loopCtx, session, agentOptions);
      yield startedAgent.scope.rawDispose;
    }, `claudeCodeAgentLoop.lifecycle(${session.id})`);
    if (startedAgent === undefined) {
      detachSession();
      await closeStored();
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
    if (setup !== undefined) {
      try {
        const result = await setup(agentScope.ctx, agent);
        if (result !== undefined) setupCommit = result;
      } catch (error) {
        detachSession();
        await agentScope.dispose();
        await closeStored();
        throw error;
      }
    }
    try {
      setupCommit?.commit();
    } catch (error) {
      detachSession();
      await agentScope.dispose();
      await closeStored();
      throw error;
    }

    const detachAgent = await this.runtime.ctx.agents.register(agent);

    const cwd = session.header.cwd ?? process.cwd();
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
        // `session/disposed` already starts the final drain; closing here makes
        // dispose wait for it, so a restart right after never loses the tail.
        await closeStored();
        await agentScope.dispose();
      },
    };
  }

  /**
   * Answer one ACP permission question with the DSH's own approval decision.
   *
   * The CLI asks before running a tool, and the client is who answers. Without
   * this handler the ACP connection answers `Method not found:
   * session/request_permission` and the tool never runs — observed on
   * 12/10/2026 as a web search that silently never happened.
   *
   * The question is routed through the DSH's `approval` service rather than
   * answered locally, so the GUI's approval panel is what decides, the ask and
   * its outcome land in the session's audit log, and the sandbox/approval
   * preset the owner picked keeps applying.
   *
   * Only `allowed-once` becomes a grant: `rejected`, `cancelled` and the
   * fail-closed `unavailable` all map onto ACP's `cancelled` outcome, which is
   * the protocol's way of saying "no option was chosen". A missing service is
   * therefore a refusal, never a silent allow.
   *
   * @param agent - the agent on whose behalf the tool would run.
   * @param request - the ACP permission request.
   * @returns the ACP outcome for the asked options.
   */
  private async decidePermission(
    agent: ClaudeCodeAgent,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const approval = this.runtime.ctx.get('approval');
    if (approval === undefined) {
      process.stderr.write(
        `[claude-code] no approval service; refusing "${request.toolCall.title ?? 'tool'}"\n`,
      );
      return { outcome: { outcome: 'cancelled' } };
    }
    if (this.isFullAccess(agent, approval)) return this.allowOnce(request);
    let outcome: ApprovalOutcome;
    try {
      outcome = await approval.request({
        agent,
        toolName: request.toolCall.title ?? 'tool',
        ...(request.toolCall.toolCallId === undefined ? {} : { callId: request.toolCall.toolCallId as ToolCallId }),
      });
    } catch (error) {
      // An ask outside an open turn rejects by contract; refusing the tool is
      // the correct reading of "we could not ask".
      process.stderr.write(`[claude-code] approval ask failed: ${errorChain(error)}\n`);
      return { outcome: { outcome: 'cancelled' } };
    }
    if (outcome !== 'allowed-once') return { outcome: { outcome: 'cancelled' } };
    return this.allowOnce(request);
  }

  /**
   * Whether the session runs the `danger-full-access` preset: sandbox off and
   * approval policy `never`.
   *
   * Under `never` the approval service rejects every ask before any answerer
   * runs, so asking would turn "full access, no prompts" into "everything is
   * blocked". Both knobs must match, so a lone `never` on a restricted sandbox
   * still refuses. Any failure reading the policy reads as "not full access".
   */
  private isFullAccess(agent: ClaudeCodeAgent, approval: ApprovalService): boolean {
    try {
      const policy = approval.overrideOf(agent.session) ?? approval.config.policy;
      if (policy !== 'never') return false;
      const sandbox = (this.runtime.ctx as unknown as {
        sandboxPolicy?: { resolve(req: { session: Session }): { mode: string } };
      }).sandboxPolicy;
      return sandbox?.resolve({ session: agent.session }).mode === 'danger-full-access';
    } catch (error) {
      process.stderr.write(`[claude-code] could not read permission policy: ${errorChain(error)}\n`);
      return false;
    }
  }

  /** Pick the protocol's "allow once" option so the CLI records a real grant. */
  private allowOnce(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
    // Fall back to the first option it offered.
    const allow = request.options.find((option) => option.kind === 'allow_once') ?? request.options[0];
    if (allow === undefined) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
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

    await acp
      .client({ name: 'harness-deck-claude-code' })
      .onRequest(acp.methods.client.session.requestPermission, (request) =>
        this.decidePermission(agent, request.params),
      )
      .connectWith(stream, async (ctx) => {
      // The response is kept, not discarded: it is where the CLI advertises
      // the vendor steering extension the bridge uses to shorten a steer's
      // wait (see acp-control.ts).
      const initialize = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      return ctx.buildSession(cwd).withSession(async (acpSession) => {
        // The model the DSH session is running on, applied to the ACP session
        // before the first prompt. Without this the CLI keeps its own
        // `ANTHROPIC_MODEL` default and resolves a family alias on its own —
        // observed on 12/10/2026 as `phase=set-model model=sonnet`, which the
        // CLI answered by running Opus regardless of what the DSH selector
        // showed.
        await applySelectedModel(ctx, acpSession.sessionId, agent.selectedModel);
        let attempt = 0;
        // One revision counter per agent lifecycle: the GUI's accumulator
        // rejects any frame that does not follow the previous one by exactly
        // one, so attempts share the counter instead of restarting it.
        let revision = 0;
        const nextRevision = () => (revision += 1);

        const live = new LiveAcpSession(ctx, acpSession, steeringSupported(initialize));
        const attempts: LoopAttemptFactory = (turn, step) => {
          const frame = new LiveAssistantAttempt(
            session.id,
            (attempt += 1),
            nextRevision,
            turn,
            step,
            (event) => dispatch.emit('agent/assistant-stream', { frame: event }),
          );
          return {
            start: () => frame.start(),
            pushText: (text) => frame.pushText(text),
            get hasVisibleText() {
              return frame.hasVisibleText;
            },
            // `settle` commits the durable event and only then publishes the
            // terminal frame carrying that event's seq, so a client can never
            // see the live stream end before the text it renders is durable.
            settleMessage: () =>
              frame.settle('assistant/message', () =>
                session.append(
                  'assistant/message',
                  {
                    turn,
                    step,
                    message: createAssistantMessage({
                      content: frame.blocks(),
                      source: { provider: 'claude-agent-acp', model: 'claude-code' },
                    }),
                    stream: frame.stream,
                  },
                  { surfaceOp: 'append' },
                ).seq,
              ),
            // Records the attempt without inventing model-visible history: the
            // same settlement the default engine uses for an attempt that never
            // became a message (`dsh-agent-loop/lib/index.js:1101`).
            settleAttempt: () =>
              frame.settle('assistant/attempt', () =>
                session.append('assistant/attempt', { turn, step, stream: frame.stream }).seq,
              ),
            abandon: () => frame.abandon(),
          };
        };

        // The scheduler owns the turn/step skeleton, the inbox boundary, the
        // cancel/timeout closers and the steering injection; see bridge-loop.ts.
        await runBridgeLoop({
          session,
          agent,
          dispatch,
          acp: live,
          attempts,
          signal,
          idleTimeoutMs: this.config.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
          cancelGraceMs: CANCEL_GRACE_MS,
        });
      });
    });
  }

  /**
   * @inheritdoc
   *
   * Reloads the session from the persistence backend (the same sequence as
   * `dsh-agent-loop`'s `resumeWith`): opens the write handle, reads the log,
   * closes a turn the previous process left open, and rebuilds the session
   * from that seed. The DSH side is fully restored — history, title, goal.
   *
   * The ACP side starts a NEW Claude Code session in the same `cwd`: the DSH
   * log does not record the CLI's own session id, so the model does not
   * remember the earlier turns (docs/plano.md item 3.2, dual-log concern).
   */
  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.runtime.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)');
    }
    const id = options.resumeSessionId;
    const handle = await persistence.open(id, 'write', options.signal === undefined ? {} : { signal: options.signal });
    let session: Session;
    let stored: StoredSession;
    try {
      const cold = await handle.read(0, undefined, options.signal === undefined ? {} : { signal: options.signal });
      const closers = interruptedTurnClosers(cold.events);
      if (closers.length > 0) await handle.append(closers);
      session = this.runtime.ctx.sessions.prepare(id, {
        seed: [...cold.events, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: cold.eventState,
      });
      stored = { handle, storedCount: cold.events.length + closers.length };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return this.launch(ownerCtx, session, stored, options.agentOptions ?? {}, options.setup);
  }
}

export default ClaudeCodeAgentLoop;
