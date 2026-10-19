/**
 * Turn/step scheduling for the Gemini ACP bridge.
 */
import type { AgentEventDispatch, Inbox, InboxTarget } from '@deepseek-ai/dsh-agent';
import type { AgentCancelCause, Session, TurnEndReason } from '@deepseek-ai/dsh-session';
import { EMPTY_RESPONSE_CODE, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';

export interface InboxSplice {
  target: InboxTarget;
  start: number;
  removedCount?: number;
  inserted: UserMessage[];
  outcome?: 'canceled';
}

export type InboxSpliceSink = (splice: InboxSplice) => void;

export class SimpleInbox implements Inbox {
  private nextTurnQueue: UserMessage[] = [];
  private nextStepQueue: UserMessage[] = [];
  private readonly onWake: () => void;
  private readonly onSplice: InboxSpliceSink | undefined;

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

  get hasPending(): boolean {
    return this.nextTurnQueue.length > 0 || this.nextStepQueue.length > 0;
  }

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

  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true);
  }

  claim(target: InboxTarget): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStepQueue.length, [], false);
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false));
    return claimed;
  }

  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-step', 'next-turn'] as const) {
      const index = this.listFor(target).findIndex((message) => message.id === messageId);
      if (index !== -1) return { target, index };
    }
    return undefined;
  }

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

export type DrainDecision =
  | { readonly kind: 'start-turn'; readonly target: InboxTarget }
  | { readonly kind: 'next-step' }
  | { readonly kind: 'end-turn' }
  | { readonly kind: 'wait' };

export function decideDrain(inbox: { nextStep: readonly unknown[]; nextTurn: readonly unknown[] }, hasRunningTurn: boolean): DrainDecision {
  if (hasRunningTurn) {
    if (inbox.nextStep.length > 0) return { kind: 'next-step' };
    return { kind: 'end-turn' };
  }
  if (inbox.nextStep.length > 0) return { kind: 'start-turn', target: 'next-step' };
  if (inbox.nextTurn.length > 0) return { kind: 'start-turn', target: 'next-turn' };
  return { kind: 'wait' };
}

export type LoopAcpUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'stop'; stopReason?: string }
  | { kind: 'subagent_activity'; description: string }
  | { kind: 'other' };

export interface LoopAcpSession {
  prompt(text: string): Promise<unknown>;
  nextUpdate(): Promise<LoopAcpUpdate>;
  cancel(): Promise<void>;
  steer(text: string): Promise<SteeringOutcome>;
}

export type SteeringOutcome = 'injected' | 'unsupported' | 'failed';

export interface LiveTurnControl {
  requestCancel(): void;
}

export interface LoopAgent {
  readonly inbox: SimpleInbox;
  consumeCancelCause(): AgentCancelCause | undefined;
  attachTurn(control: LiveTurnControl | undefined): void;
  waitForWork(signal: AbortSignal): Promise<{ readonly target: InboxTarget } | undefined>;
  waitForSteer(signal: AbortSignal): Promise<UserMessage | undefined>;
  markRunning(): void;
  markIdle(): void;
}

export interface LiveAssistantAttemptSink {
  start(): void;
  pushText(text: string): void;
  readonly hasVisibleText: boolean;
  settleMessage(): void;
  settleAttempt(): void;
  abandon(): void;
}

export type LoopAttemptFactory = (turn: number, step: number) => LiveAssistantAttemptSink;

export const ACP_TIMEOUT_CODE = 'ACP_TIMEOUT';

export async function runBridgeLoop(options: {
  session: Session;
  agent: LoopAgent;
  dispatch: AgentEventDispatch;
  acp: LoopAcpSession;
  attempts: LoopAttemptFactory;
  signal: AbortSignal;
  idleTimeoutMs: number;
  cancelGraceMs: number;
}): Promise<void> {
  const { session, agent, dispatch, acp, attempts, signal, idleTimeoutMs, cancelGraceMs } = options;

  let turn = 0;
  for (;;) {
    if (signal.aborted) return;
    const work = await agent.waitForWork(signal);
    if (work === undefined || signal.aborted) return;

    turn += 1;
    agent.markRunning();
    dispatch.emit('agent/status', { status: 'running' });

    let step = 0;
    session.append('turn/start', { turn });

    let turnEnds: TurnEndReason = { kind: 'completed' };
    try {
      for (;;) {
        step += 1;
        const target: InboxTarget = step === 1 ? work.target : 'next-step';
        const claimed = agent.inbox.claim(target);
        if (claimed.length === 0) break;

        session.append('step/start', { turn, step });
        for (const message of claimed) {
          session.append('user/message', message, { surfaceOp: 'append' });
        }

        const stepResult = await runSingleStep({
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
        if (stepResult.kind !== 'completed') {
          turnEnds = stepResult;
          break;
        }

        if (agent.inbox.nextStep.length === 0) break;
      }

      const cancelCause = agent.consumeCancelCause();
      if (cancelCause !== undefined) {
        turnEnds = { kind: 'aborted', reason: cancelCause };
      }
    } finally {
      session.append('turn/end', { turn, reason: turnEnds });
      agent.markIdle();
      dispatch.emit('agent/status', { status: 'idle' });
    }
  }
}

async function runSingleStep(params: {
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
  const { session, agent, dispatch, acp, attempts, signal, idleTimeoutMs, cancelGraceMs, turn, step, claimed } = params;

  const live = attempts(turn, step);
  live.start();

  const stepAbort = new AbortController();
  const abortStep = (): void => stepAbort.abort();
  signal.addEventListener('abort', abortStep);

  agent.attachTurn({ requestCancel: () => void acp.cancel() });
  const steerTask = watchSteers({ session, agent, dispatch, acp, signal: stepAbort.signal });

  const promptText = promptTextOf(claimed);
  let turnEnds: TurnEndReason = { kind: 'completed' };
  let timedOut = false;
  let disposed = false;

  try {
    acp.prompt(promptText).catch((error: unknown) => {
      process.stderr.write(`[gemini] ACP prompt rejected: ${String(error)}\n`);
    });

    for (;;) {
      const pending = acp.nextUpdate();
      const wait = await waitForUpdate(pending, idleTimeoutMs, stepAbort.signal);
      if (wait.kind === 'aborted') {
        disposed = true;
        break;
      }
      if (wait.kind === 'failed') throw wait.error;
      if (wait.kind === 'timeout') {
        timedOut = true;
        await acp.cancel();
        await waitForUpdate(pending, cancelGraceMs, stepAbort.signal);
        break;
      }
      const update = wait.update;
      if (update.kind === 'stop') break;
      if (update.kind === 'text') live.pushText(update.text);
      if (update.kind === 'subagent_activity') {
        dispatch.emit('agent/status', { status: 'running' });
      }
    }

    if (disposed) {
      live.abandon();
      return { kind: 'aborted', reason: { kind: 'disposed' } };
    }

    const cancelCause = agent.consumeCancelCause();
    if (cancelCause !== undefined) {
      if (live.hasVisibleText) live.settleMessage();
      else live.settleAttempt();
      return { kind: 'aborted', reason: cancelCause };
    }

    if (timedOut) {
      if (live.hasVisibleText) live.settleMessage();
      else live.settleAttempt();
      return {
        kind: 'error',
        error: {
          message: `the ACP agent produced no update for ${idleTimeoutMs} ms and the turn was cancelled`,
          code: ACP_TIMEOUT_CODE,
        },
      };
    }

    if (live.hasVisibleText) {
      live.settleMessage();
    } else {
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
      process.stderr.write(`[gemini] steering outcome=${outcome} message=${message.id}\n`);
      if (outcome !== 'injected') return;
      if (!agent.inbox.remove(message.id)) return;
      session.append('user/message', message, { surfaceOp: 'append' });
      dispatch.emit('agent/status', { status: 'running' });
    }
  } catch (error) {
    process.stderr.write(`[gemini] steering failed, message kept queued: ${String(error)}\n`);
  }
}

export function promptTextOf(messages: UserMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'text') parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

type UpdateWait =
  | { kind: 'update'; update: LoopAcpUpdate }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed'; error: unknown };

async function waitForUpdate(promise: Promise<LoopAcpUpdate>, timeoutMs: number, signal: AbortSignal): Promise<UpdateWait> {
  if (signal.aborted) return { kind: 'aborted' };
  let timer: NodeJS.Timeout | undefined;
  return new Promise<UpdateWait>((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve({ kind: 'aborted' });
    };
    const onTimeout = () => {
      cleanup();
      resolve({ kind: 'timeout' });
    };
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    timer = setTimeout(onTimeout, timeoutMs);
    signal.addEventListener('abort', onAbort);
    promise.then(
      (update) => {
        cleanup();
        resolve({ kind: 'update', update });
      },
      (error) => {
        cleanup();
        resolve({ kind: 'failed', error });
      },
    );
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
