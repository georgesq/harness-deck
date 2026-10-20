/**
 * Turn/step scheduling and bridge loop tests for the Gemini bridge.
 *
 * Verifies:
 * - Real cancellation (`session/cancel`) when stop is requested
 * - Dense revision streaming and status transitions (running/idle)
 * - Rejection of empty turns (EMPTY_RESPONSE)
 * - Boundary scheduling (next-step vs next-turn, drainage)
 * - In-flight steering injection
 * - Timeout cancellation
 */
import assert from 'node:assert/strict';
import { EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm';
import {
  ACP_TIMEOUT_CODE,
  SimpleInbox,
  decideDrain,
  runBridgeLoop,
  type LiveTurnControl,
  type LoopAcpSession,
  type LoopAcpUpdate,
  type LoopAgent,
  type LiveAssistantAttemptSink,
  type LoopAttemptFactory,
  type SteeringOutcome,
} from '../src/bridge-loop.js';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

/** One user message with a text block. */
function message(id: string, text: string): any {
  return { id, content: [{ type: 'text', text }] };
}

interface Recorded {
  type: string;
  data: any;
  options: any;
}

function fakeSession(): { session: any; events: Recorded[] } {
  const events: Recorded[] = [];
  return {
    events,
    session: {
      id: 'session-gemini-test',
      append(type: string, data: unknown, options?: unknown) {
        events.push({ type, data, options });
        return { seq: events.length };
      },
    },
  };
}

function fakeDispatch(): { dispatch: any; frames: Recorded[] } {
  const frames: Recorded[] = [];
  return {
    frames,
    dispatch: {
      emit(type: string, payload: unknown) {
        frames.push({ type, data: payload, options: undefined });
      },
    },
  };
}

/** Attempt factory recording attempts, streaming text chunks, and settlement */
function fakeAttempts(log: string[]) {
  return (turn: number, step: number): LiveAssistantAttemptSink => {
    let text = '';
    return {
      start: () => {
        log.push(`start:${turn}.${step}`);
      },
      pushText: (chunk: string) => {
        text += chunk;
        log.push(`chunk:${turn}.${step}:${chunk}`);
      },
      get hasVisibleText() {
        return text.length > 0;
      },
      settleMessage: () => {
        log.push(`message:${turn}.${step}`);
      },
      settleAttempt: () => {
        log.push(`attempt:${turn}.${step}`);
      },
      abandon: () => {
        log.push(`abandon:${turn}.${step}`);
      },
    };
  };
}

/** Minimal `LoopAgent` with Gemini wake semantics. */
class FakeAgent implements LoopAgent {
  readonly inbox: SimpleInbox;
  running = false;
  private wakeWaiters: Array<() => void> = [];
  private liveTurn: LiveTurnControl | undefined;
  private cancelCause: any;

  constructor() {
    this.inbox = new SimpleInbox(() => this.wake());
  }

  markRunning(): void {
    this.running = true;
  }

  markIdle(): void {
    this.running = false;
  }

  attachTurn(control: LiveTurnControl | undefined): void {
    this.liveTurn = control;
  }

  consumeCancelCause(): any {
    const cause = this.cancelCause;
    this.cancelCause = undefined;
    return cause;
  }

  requestCancel(cause: any): void {
    this.inbox.clear();
    if (!this.running) return;
    this.cancelCause = cause;
    this.liveTurn?.requestCancel();
  }

  async waitForWork(signal: AbortSignal): Promise<{ target: any } | undefined> {
    for (;;) {
      const decision = decideDrain(this.inbox, false);
      if (decision.kind === 'start-turn') return { target: decision.target };
      if (signal.aborted) return undefined;
      await this.waitForWake(signal);
    }
  }

  async waitForSteer(signal: AbortSignal): Promise<any> {
    for (;;) {
      const pending = this.inbox.nextStep[0];
      if (pending !== undefined) return pending;
      if (signal.aborted) return undefined;
      await this.waitForWake(signal);
    }
  }

  private async waitForWake(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      this.wakeWaiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
      signal.addEventListener('abort', onAbort);
    });
  }

  private wake(): void {
    const waiters = this.wakeWaiters;
    this.wakeWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Minimal `LoopAcpSession` driven by test */
class FakeAcp implements LoopAcpSession {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  cancels = 0;
  steering: SteeringOutcome = 'unsupported';
  onPrompt: ((self: FakeAcp) => void) | undefined;
  onCancel: ((self: FakeAcp) => void) | undefined;
  onSteer: ((text: string, self: FakeAcp) => void) | undefined;
  private queue: LoopAcpUpdate[] = [];
  private waiters: Array<(update: LoopAcpUpdate) => void> = [];

  prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    this.onPrompt?.(this);
    return Promise.resolve({});
  }

  nextUpdate(): Promise<LoopAcpUpdate> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise<LoopAcpUpdate>((resolve) => this.waiters.push(resolve));
  }

  async cancel(): Promise<void> {
    this.cancels += 1;
    this.onCancel?.(this);
  }

  async steer(text: string): Promise<SteeringOutcome> {
    this.steers.push(text);
    this.onSteer?.(text, this);
    return this.steering;
  }

  push(update: LoopAcpUpdate): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(update);
    else this.queue.push(update);
  }

  stop(reason = 'end_turn'): void {
    this.push({ kind: 'stop', stopReason: reason });
  }

  text(text: string): void {
    this.push({ kind: 'text', text });
  }

  answer(text: string, reason = 'end_turn'): void {
    this.text(text);
    this.stop(reason);
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function eventsOf(events: Recorded[], type: string): Recorded[] {
  return events.filter((event) => event.type === type);
}

function turnEnds(events: Recorded[]): Recorded[] {
  return eventsOf(events, 'turn/end');
}

function userMessages(events: Recorded[]): string[] {
  return eventsOf(events, 'user/message').map((event) => event.data.id);
}

// ---------------------------------------------------------------------------
// 1. Drain decisions
// ---------------------------------------------------------------------------
{
  const steerOnly = { nextStep: [message('s', 'steer')], nextTurn: [] };
  const turnOnly = { nextStep: [], nextTurn: [message('t', 'turn')] };
  const both = { nextStep: [message('s', 'steer')], nextTurn: [message('t', 'turn')] };

  assert.deepEqual(decideDrain({ nextStep: [], nextTurn: [] }, false), { kind: 'wait' });
  assert.deepEqual(decideDrain(steerOnly, false), { kind: 'start-turn', target: 'next-step' });
  assert.deepEqual(decideDrain(turnOnly, false), { kind: 'start-turn', target: 'next-turn' });
  assert.deepEqual(decideDrain(both, false), { kind: 'start-turn', target: 'next-step' });

  assert.deepEqual(decideDrain(steerOnly, true), { kind: 'next-step' });
  assert.deepEqual(decideDrain(turnOnly, true), { kind: 'end-turn' });
  ok('decideDrain respeita prioridade de next-step e fronteiras de turno');
}

// ---------------------------------------------------------------------------
// 2. Dense streaming and status transitions (running/idle)
// ---------------------------------------------------------------------------
{
  const { session, events } = fakeSession();
  const { dispatch, frames } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];

  agent.inbox.append('next-turn', message('u1', 'primeira'));

  acp.onPrompt = (self) => {
    // Deliver dense text updates
    self.text('chunk 1, ');
    self.text('chunk 2, ');
    self.push({ kind: 'subagent_activity', description: 'tool_call' });
    self.text('done.');
    self.stop('end_turn');
  };

  const loop = runBridgeLoop({
    session,
    agent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 2000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno fechar com sucesso');
  controller.abort();
  await loop;

  // Check status transitions emitted through dispatch
  const statusEvents = frames.filter((f) => f.type === 'agent/status').map((f) => f.data.status);
  assert.deepEqual(statusEvents, ['running', 'running', 'idle']);
  assert.equal(agent.running, false);

  // Check dense streaming chunks in log
  assert.ok(log.includes('start:1.1'));
  assert.ok(log.includes('chunk:1.1:chunk 1, '));
  assert.ok(log.includes('chunk:1.1:chunk 2, '));
  // a tool call in between starts a new paragraph instead of gluing the prose together
  assert.ok(log.includes('chunk:1.1:\n\ndone.'));
  assert.ok(log.includes('message:1.1'));

  // Check turn completed
  assert.equal(turnEnds(events)[0].data.reason.kind, 'completed');
  ok('emite transições de status (running/idle) e streaming denso de chunks');
}

// ---------------------------------------------------------------------------
// 3. Rejection of empty turns (EMPTY_RESPONSE)
// ---------------------------------------------------------------------------
{
  const { session, events } = fakeSession();
  const { dispatch } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];

  agent.inbox.append('next-turn', message('u1', 'sem texto'));

  acp.onPrompt = (self) => {
    // Agent stops immediately without pushing any text
    self.stop('end_turn');
  };

  const loop = runBridgeLoop({
    session,
    agent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 2000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno vazio fechar');
  controller.abort();
  await loop;

  assert.equal(log.includes('attempt:1.1'), true);
  assert.equal(log.includes('message:1.1'), false);

  const reason = turnEnds(events)[0].data.reason;
  assert.equal(reason.kind, 'error');
  assert.equal(reason.error.code, EMPTY_RESPONSE_CODE);
  assert.match(reason.error.message, /ended the turn without producing any text/);
  assert.equal(agent.running, false);
  ok('rejeita turno vazio com EMPTY_RESPONSE e não grava mensagem visível');
}

// ---------------------------------------------------------------------------
// 4. Real cancellation (session/cancel) when stop is requested
// ---------------------------------------------------------------------------
{
  const { session, events } = fakeSession();
  const { dispatch, frames } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];

  agent.inbox.append('next-turn', message('u1', 'vai ser cancelado'));

  acp.onPrompt = (self) => {
    self.text('começando a responder...');
    // Request cancel while in-flight
    agent.requestCancel({ kind: 'user' });
  };
  acp.onCancel = (self) => {
    setTimeout(() => self.stop('cancelled'), 10);
  };

  const loop = runBridgeLoop({
    session,
    agent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 3000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno cancelado fechar');
  controller.abort();
  await loop;

  assert.equal(acp.cancels, 1);
  const endReason = turnEnds(events)[0].data.reason;
  assert.deepEqual(endReason, {
    kind: 'aborted',
    reason: { kind: 'user' },
  });
  // Since text was produced before cancel, message is settled
  assert.ok(log.includes('message:1.1'));
  assert.equal(agent.running, false);

  const finalStatuses = frames.filter((f) => f.type === 'agent/status').map((f) => f.data.status);
  assert.equal(finalStatuses[finalStatuses.length - 1], 'idle');
  ok('cancelamento real (session/cancel) fecha turno como aborted e volta para idle');
}

// ---------------------------------------------------------------------------
// 5. Steering injection mid-step
// ---------------------------------------------------------------------------
{
  const { session, events } = fakeSession();
  const { dispatch } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];

  agent.inbox.append('next-turn', message('u1', 'primeira'));
  acp.steering = 'injected';

  acp.onPrompt = () => {
    if (acp.prompts.length === 1) {
      agent.inbox.append('next-step', message('u2', 'steer injetado'));
    }
  };
  acp.onSteer = (_text, self) => {
    setTimeout(() => self.answer('resposta com steer injetado'), 5);
  };

  const loop = runBridgeLoop({
    session,
    agent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 3000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno fechar com steer');
  controller.abort();
  await loop;

  assert.deepEqual(acp.steers, ['steer injetado']);
  assert.deepEqual(acp.prompts, ['primeira']);
  assert.deepEqual(userMessages(events), ['u1', 'u2']);
  assert.equal(turnEnds(events)[0].data.reason.kind, 'completed');
  ok('steer injetado é absorvido no mesmo turno');
}

// ---------------------------------------------------------------------------
// 6. Timeout handling
// ---------------------------------------------------------------------------
{
  const { session, events } = fakeSession();
  const { dispatch } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];

  agent.inbox.append('next-turn', message('u1', 'timeout test'));

  acp.onPrompt = () => {
    // Hangs
  };
  acp.onCancel = (self) => {
    setTimeout(() => self.stop('cancelled'), 5);
  };

  const loop = runBridgeLoop({
    session,
    agent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 30,
    cancelGraceMs: 200,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno fechar por timeout');
  controller.abort();
  await loop;

  assert.equal(acp.cancels, 1);
  const reason = turnEnds(events)[0].data.reason;
  assert.equal(reason.kind, 'error');
  assert.equal(reason.error.code, ACP_TIMEOUT_CODE);
  assert.match(reason.error.message, /produced no update for 30 ms/);
  assert.equal(agent.running, false);
  ok('timeout cancela o turno com erro ACP_TIMEOUT e fecha como idle');
}

process.stdout.write(`\ntudo ok em bridge-loop (${checks} verificações)\n`);
