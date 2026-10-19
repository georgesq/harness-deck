/**
 * Turn/step scheduling for the Claude Code ACP bridge.
 *
 * This plugin replaces `@deepseek-ai/dsh-agent-loop`, so it owns the two
 * behaviours the default engine gets from its driver loop:
 *
 * - the INBOX BOUNDARY: `next-step` input (a `steer`) is claimed at the end of
 *   every step, inside the turn it belongs to, while `next-turn` input (a
 *   `followup`) only ever starts a new turn. `dsh-agent-loop` does the same
 *   (`dsh-agent-loop/lib/index.js:998-1006`).
 * - the TURN/STEP EVENT SKELETON (`turn/start`, `step/start`, `user/message`,
 *   `step/end`, `turn/end`) plus the abort and timeout closers that keep a
 *   wedged ACP prompt from freezing the queue forever.
 *
 * Everything here is driven through structural interfaces, so the scheduler
 * can be tested with fakes: no DSH service, no ACP process, no child process.
 */
import type { AgentEventDispatch, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent';
import type { AgentCancelCause, Session, TurnEndReason } from '@deepseek-ai/dsh-session';
import { EMPTY_RESPONSE_CODE, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Payload of the durable `agent/inbox/spliced` event.
 *
 * The event type is declared by `@deepseek-ai/dsh-agent` and is the only
 * durable record of pending input; `dsh-agent-loop` reconstructs its whole
 * inbox from it (`dsh-agent-loop/lib/index.js:26-75`). Mirrored here so the
 * bridge's pending queue is reconstructible after a reload instead of living
 * only in memory.
 */
export interface InboxSplice {
  target: InboxTarget;
  start: number;
  removedCount?: number;
  inserted: UserMessage[];
  outcome?: 'canceled';
}

/** Sink that durably records one normalized inbox mutation. */
export type InboxSpliceSink = (splice: InboxSplice) => void;

/**
 * Durable inbox for one agent.
 *
 * Unlike `dsh-agent-loop`'s projection-backed inbox this keeps its state in
 * memory and records every mutation as an `agent/inbox/spliced` event, which
 * is what the queue UI and a future resume both read.
 */
export class SimpleInbox implements Inbox {
  private nextTurnQueue: UserMessage[] = [];
  private nextStepQueue: UserMessage[] = [];
  private readonly onWake: () => void;
  private readonly onSplice: InboxSpliceSink | undefined;

  /**
   * @param onWake - called whenever input becomes available.
   * @param onSplice - durable recorder for every normalized mutation.
   */
  constructor(onWake: () => void, onSplice?: InboxSpliceSink) {
    this.onWake = onWake;
    this.onSplice = onSplice;
  }

  get nextTurn(): readonly UserMessage[] {
    return this.nextTurnQueue;
  }

  get nextStep(): readonly UserMessage[] {
    return this.nextStepQueue;
  }

  /** Whether either pending list holds work. */
  get hasPending(): boolean {
    return this.nextTurnQueue.length > 0 || this.nextStepQueue.length > 0;
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStepQueue.length, []);
    this.splice('next-turn', 0, this.nextTurnQueue.length, []);
  }

  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.listFor(target).length, 0, [message]);
  }

  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message]);
  }

  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const found = this.locate(messageId);
    if (found === undefined) return false;
    this.splice(found.target, found.index, 1, [newMessage]);
    return true;
  }

  remove(messageId: MessageId): boolean {
    const found = this.locate(messageId);
    if (found === undefined) return false;
    this.splice(found.target, found.index, 1, []);
    return true;
  }

  /**
   * Apply splice semantics and durably record the normalized result.
   *
   * A removed message is recorded as `canceled`: the DSH treats a splice that
   * drops input as the durable cancellation of that input, exactly like
   * `dsh-agent-loop`'s `ReactLoopInbox.splice`
   * (`dsh-agent-loop/lib/index.js:150-165`).
   */
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true);
  }

  /**
   * Remove and return the batch proposed for one step.
   *
   * Mirrors `dsh-agent-loop`'s `claim` (`lib/index.js:97-105`): every pending
   * `next-step` message joins the step, and a `next-turn` target additionally
   * consumes one queued turn.
   *
   * @param target - whether this boundary also consumes one queued turn.
   */
  claim(target: InboxTarget): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStepQueue.length, [], false);
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false));
    return claimed;
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.listFor(target).findIndex((message) => message.id === messageId);
      if (index !== -1) return { target, index };
    }
    return undefined;
  }

  /** Commit one normalized mutation and record it durably. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const list = this.listFor(target);
    const actualStart = Math.min(Math.max(Math.trunc(start), 0), list.length);
    const actualDeleteCount = Math.min(Math.max(Math.trunc(deleteCount), 0), list.length - actualStart);
    if (actualDeleteCount === 0 && inserted.length === 0) return [];
    const removed = list.splice(actualStart, actualDeleteCount, ...inserted);
    this.onSplice?.({
      target,
      start: actualStart,
      ...(removed.length === 0 ? {} : { removedCount: removed.length }),
      inserted,
      ...(discardRemoved && removed.length > 0 ? { outcome: 'canceled' } : {}),
    });
    if (inserted.length > 0) this.onWake();
    return removed;
  }

  private listFor(target: InboxTarget): UserMessage[] {
    return target === 'next-step' ? this.nextStepQueue : this.nextTurnQueue;
  }
}

/**
 * What the scheduler does at a turn/step boundary.
 *
 * Pure and exported so the boundary contract is testable without an ACP
 * session — it is the whole of REQ-M2/M3.
 */
export type DrainDecision =
  | { readonly kind: 'start-turn'; readonly target: InboxTarget }
  | { readonly kind: 'next-step' }
  | { readonly kind: 'end-turn' }
  | { readonly kind: 'wait' };

/**
 * Decide the next scheduling move from the inbox state.
 *
 * @param inbox - the two pending lists.
 * @param turnOpen - whether a turn is currently open.
 */
export function decideDrain(
  inbox: { readonly nextStep: readonly UserMessage[]; readonly nextTurn: readonly UserMessage[] },
  turnOpen: boolean,
): DrainDecision {
  if (turnOpen) {
    // Inside a turn, only `next-step` may extend it. A pending `next-turn`
    // message must NOT be pulled in here: it owns a turn of its own.
    return inbox.nextStep.length > 0 ? { kind: 'next-step' } : { kind: 'end-turn' };
  }
  // `next-step` first, like the default engine's `waitForWork`.
  if (inbox.nextStep.length > 0) return { kind: 'start-turn', target: 'next-step' };
  if (inbox.nextTurn.length > 0) return { kind: 'start-turn', target: 'next-turn' };
  return { kind: 'wait' };
}

/** How the ACP session exposes one steered message to the running turn. */
export type SteeringOutcome = 'injected' | 'idle' | 'unsupported';

/** Normalized ACP update the scheduler cares about. */
export type LoopAcpUpdate =
  | { readonly kind: 'stop'; readonly stopReason: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'other' };

/** Live ACP session, narrowed to what the scheduler needs. */
export interface LoopAcpSession {
  /** Send one prompt; the returned promise settles with the final response. */
  prompt(text: string): Promise<unknown>;
  /** Read the next update or stop for this session. */
  nextUpdate(): Promise<LoopAcpUpdate>;
  /** Send the `session/cancel` notification for the in-flight prompt. */
  cancel(): Promise<void>;
  /** Inject one message into the running ACP turn, when the agent supports it. */
  steer(text: string): Promise<SteeringOutcome>;
}

/** Control the scheduler hands the agent so `cancel()` can reach the ACP prompt. */
export interface LiveTurnControl {
  requestCancel(): void;
}

/** Agent-side surface the scheduler drives. */
export interface LoopAgent {
  readonly inbox: SimpleInbox;
  markRunning(): void;
  markIdle(): void;
  /** Block until any input is pending, and report which list woke it. */
  waitForWork(signal: AbortSignal): Promise<{ readonly target: InboxTarget } | undefined>;
  /** Block until a `next-step` message is pending, or the signal aborts. */
  waitForSteer(signal: AbortSignal): Promise<UserMessage | undefined>;
  /** Attach (or detach) the control for the prompt currently in flight. */
  attachTurn(control: LiveTurnControl | undefined): void;
  /** Take the pending cancellation cause, if one was recorded. */
  consumeCancelCause(): AgentCancelCause | undefined;
}

/** One live assistant attempt, as the scheduler sees it. */
export interface LoopAttempt {
  start(): void;
  pushText(text: string): void;
  readonly hasVisibleText: boolean;
  settleMessage(): void;
  settleAttempt(): void;
  abandon(): void;
}

/** Allocates one attempt per step. */
export type LoopAttemptFactory = (turn: number, step: number) => LoopAttempt;

/** Everything the scheduler needs from the host plugin. */
export interface BridgeLoopOptions {
  readonly session: Session;
  readonly agent: LoopAgent;
  readonly dispatch: AgentEventDispatch;
  readonly acp: LoopAcpSession;
  readonly attempts: LoopAttemptFactory;
  readonly signal: AbortSignal;
  /** Inactivity ceiling for one ACP prompt, in milliseconds. */
  readonly idleTimeoutMs: number;
  /** How long to wait for the stop after sending `session/cancel`. */
  readonly cancelGraceMs: number;
}

/** Failure code for an ACP prompt that stopped answering. */
export const ACP_TIMEOUT_CODE = 'ACP_TURN_TIMEOUT';

/** Text blocks of a user message, joined the way the CLI expects one prompt. */
export function promptTextOf(messages: readonly UserMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Outcome of waiting for one ACP update. */
type StepWait =
  | { readonly kind: 'update'; readonly update: LoopAcpUpdate }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly error: unknown };

/** Wait for one ACP update, bounded by `timeoutMs` and the abort signal. */
function waitForUpdate(update: Promise<LoopAcpUpdate>, timeoutMs: number, signal: AbortSignal): Promise<StepWait> {
  return new Promise<StepWait>((resolve) => {
    let settled = false;
    const finish = (value: StepWait): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish({ kind: 'aborted' });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    signal.addEventListener('abort', onAbort);
    update.then(
      (value) => finish({ kind: 'update', update: value }),
      (error: unknown) => finish({ kind: 'failed', error }),
    );
  });
}

/**
 * Drive the inbox through turns and steps until the signal aborts.
 *
 * The outer loop opens one turn per `waitForWork` wake; the inner loop runs
 * one step per claimed batch and only closes the turn when `decideDrain` says
 * no `next-step` input is waiting.
 */
export async function runBridgeLoop(options: BridgeLoopOptions): Promise<void> {
  const { session, agent, dispatch, acp, attempts, signal, idleTimeoutMs, cancelGraceMs } = options;
  let turn = 0;

  for (;;) {
    const work = await agent.waitForWork(signal);
    if (work === undefined) return;

    agent.markRunning();
    dispatch.emit('agent/status', { status: 'running' });
    turn += 1;
    session.append('turn/start', { turn });

    let target: InboxTarget = work.target;
    let step = 0;
    let turnEnds: TurnEndReason = { kind: 'completed' };

    for (;;) {
      const claimed = agent.inbox.claim(target);
      if (claimed.length === 0) break;

      step += 1;
      session.append('step/start', { turn, step });
      // The default engine appends the user's messages itself when it consumes
      // the inbox (`dsh-agent-loop/lib/index.js:1061`). With the default engine
      // replaced, nobody else does it — without this the chat would show the
      // answer with no question above it.
      for (const message of claimed) {
        session.append('user/message', message, { surfaceOp: 'append' });
      }

      const stepEnds = await runStep({
        session,
        agent,
        dispatch,
        acp,
        attempts,
        signal,
        idleTimeoutMs,
        cancelGraceMs,
        turn,
        step,
        claimed,
      });

      session.append('step/end', { turn, step });

      // A cancellation is checked first: it is the only reason that must win
      // over the step's own outcome, because it is what released the queue.
      const cancelCause = agent.consumeCancelCause();
      if (cancelCause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cancelCause };
        break;
      }
      if (stepEnds.kind !== 'completed') {
        turnEnds = stepEnds;
        break;
      }
      if (decideDrain(agent.inbox, true).kind !== 'next-step') break;
      target = 'next-step';
    }

    session.append('turn/end', { turn, reason: turnEnds });
    agent.markIdle();
    dispatch.emit('agent/status', { status: 'idle' });
  }
}

/** Run one step: one ACP prompt, its updates, and its durable settlement. */
async function runStep(params: {
  session: Session;
  agent: LoopAgent;
  dispatch: AgentEventDispatch;
  acp: LoopAcpSession;
  attempts: LoopAttemptFactory;
  signal: AbortSignal;
  idleTimeoutMs: number;
  cancelGraceMs: number;
  turn: number;
  step: number;
  claimed: UserMessage[];
}): Promise<TurnEndReason> {
  const { session, agent, dispatch, acp, attempts, signal, idleTimeoutMs, cancelGraceMs, turn, step, claimed } =
    params;

  const live = attempts(turn, step);
  live.start();

  const stepAbort = new AbortController();
  const abortStep = (): void => stepAbort.abort();
  signal.addEventListener('abort', abortStep);
  // REQ-M4: while this prompt is in flight, `cancel()` has to reach the ACP
  // session, not just the inbox.
  agent.attachTurn({ requestCancel: () => void acp.cancel() });
  const steerTask = watchSteers({ session, agent, dispatch, acp, signal: stepAbort.signal });

  const promptText = promptTextOf(claimed);
  let turnEnds: TurnEndReason = { kind: 'completed' };
  let timedOut = false;
  let disposed = false;
  let stopReason: string | undefined;

  try {
    // The prompt response is delivered through `nextUpdate()` as the `stop`
    // message; the promise is kept only so a rejection is not unhandled.
    acp.prompt(promptText).catch((error: unknown) => {
      process.stderr.write(`[claude-code] ACP prompt rejected: ${String(error)}\n`);
    });

    for (;;) {
      // The read is kept in a variable: it owns the session's next update, and
      // abandoning it would let it steal the first update of the next step.
      const pending = acp.nextUpdate();
      const wait = await waitForUpdate(pending, idleTimeoutMs, stepAbort.signal);
      if (wait.kind === 'aborted') {
        disposed = true;
        break;
      }
      if (wait.kind === 'failed') throw wait.error;
      if (wait.kind === 'timeout') {
        // REQ-M5: a prompt that stopped answering must not hold the queue. Ask
        // the agent to cancel the turn; the CLI forces its prompt loop to
        // return "cancelled" after `DEFAULT_FORCE_CANCEL_GRACE_MS` (30s), so
        // the stop below is bounded.
        timedOut = true;
        await acp.cancel();
        const grace = await waitForUpdate(pending, cancelGraceMs, stepAbort.signal);
        if (grace.kind === 'update' && grace.update.kind === 'stop') stopReason = grace.update.stopReason;
        break;
      }
      const update = wait.update;
      if (update.kind === 'stop') {
        stopReason = update.stopReason;
        break;
      }
      if (update.kind === 'text') live.pushText(update.text);
    }

    if (disposed) {
      // The plugin is unloading and the child is being killed: close the turn
      // as disposed instead of leaving an open live stream behind.
      live.abandon();
      turnEnds = { kind: 'aborted', reason: { kind: 'disposed' } };
      return turnEnds;
    }

    // The owner's cancellation wins over the timeout it may have caused: the
    // turn was aborted on purpose, and reporting a timeout would misname it.
    const cancelCause = agent.consumeCancelCause();
    if (cancelCause !== undefined) {
      // REQ-M4: the owner's cancel aborts the ACP prompt for real; the turn
      // closes as aborted and the queue is released.
      if (live.hasVisibleText) live.settleMessage();
      else live.settleAttempt();
      turnEnds = { kind: 'aborted', reason: cancelCause };
      return turnEnds;
    }

    if (timedOut) {
      // REQ-M5: visible in the trajectory instead of a silent hang. The stop
      // the bridge forced above is deliberately reported as a failure: the
      // turn did not finish, and `completed` would hide that.
      if (live.hasVisibleText) live.settleMessage();
      else live.settleAttempt();
      turnEnds = {
        kind: 'error',
        error: {
          message: `the ACP agent produced no update for ${idleTimeoutMs} ms and the turn was cancelled`,
          code: ACP_TIMEOUT_CODE,
        },
      };
      return turnEnds;
    }

    if (live.hasVisibleText) {
      live.settleMessage();
    } else {
      // An empty turn is a failure, not a success: Claude Code resolves its
      // pending prompt when its own process dies mid-turn, and calling that
      // `completed` would draw an empty answer in the chat as if it had
      // worked. `EMPTY_RESPONSE` is the code the default engine already uses.
      live.settleAttempt();
      turnEnds = {
        kind: 'error',
        error: {
          message: 'the ACP agent ended the turn without producing any text',
          code: EMPTY_RESPONSE_CODE,
        },
      };
    }
    return turnEnds;
  } catch (error) {
    // An attempt that never publishes its terminal frame leaves the GUI
    // holding an open live stream forever, so every failure closes it here.
    if (live.hasVisibleText) live.settleMessage();
    else live.abandon();
    return { kind: 'error', error: { message: errorText(error), code: 'UNKNOWN' } };
  } finally {
    stepAbort.abort();
    agent.attachTurn(undefined);
    signal.removeEventListener('abort', abortStep);
    await steerTask;
  }
}

/**
 * Inject `next-step` input into the ACP turn while it is still running.
 *
 * This is what actually shortens the wait for a `steer` (REQ-M3b): the message
 * joins the in-flight ACP turn instead of waiting for its end. When the agent
 * does not support steering the message is left in the inbox, and the step
 * boundary claims it as the next step of the same turn (REQ-M2).
 */
async function watchSteers(params: {
  session: Session;
  agent: LoopAgent;
  dispatch: AgentEventDispatch;
  acp: LoopAcpSession;
  signal: AbortSignal;
}): Promise<void> {
  const { session, agent, dispatch, acp, signal } = params;
  try {
    for (;;) {
      const message = await agent.waitForSteer(signal);
      if (message === undefined) return;
      const outcome = await acp.steer(promptTextOf([message]));
      process.stderr.write(`[claude-code] steering outcome=${outcome} message=${message.id}\n`);
      if (outcome !== 'injected') return;
      // The running ACP turn owns the message now: drop it from the pending
      // queue (durably) and record it once, at the instant it was injected.
      if (!agent.inbox.remove(message.id)) return;
      session.append('user/message', message, { surfaceOp: 'append' });
      dispatch.emit('agent/status', { status: 'running' });
    }
  } catch (error) {
    process.stderr.write(`[claude-code] steering failed, the message stays queued: ${String(error)}\n`);
  }
}

/** Flatten any thrown value into a message, without inventing fields. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
