/**
 * Turn/step scheduling tests — no DSH service, no ACP process, no network.
 *
 * Run with:
 *   node --experimental-strip-types --no-warnings test/bridge-loop.test.ts
 *
 * These checks are the contract of section 3 of
 * `.spec/spec-feat-parar-e-enviar.md` (REQ-M1, REQ-M2, REQ-M3, REQ-M4, REQ-M5,
 * REQ-M6) exercised through the real scheduler with a fake session, a fake
 * agent and a fake ACP session. The wire-level `session/cancel` is checked
 * separately in `test/acp-control.test.ts`.
 */
import assert from 'node:assert/strict';
import {
  ACP_TIMEOUT_CODE,
  SimpleInbox,
  decideDrain,
  runBridgeLoop,
  type LiveTurnControl,
  type LoopAcpSession,
  type LoopAcpUpdate,
  type LoopAgent,
  type LoopAttempt,
  type SteeringOutcome,
} from '../src/bridge-loop.ts';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

/** One user message with a text block; the only shape the scheduler reads. */
function message(id: string, text: string): any {
  return { id, content: [{ type: 'text', text }] };
}

/** One durable event of the fake session. */
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
      id: 'session-test',
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

/** Attempts factory that records the terminal frame of every step. */
function fakeAttempts(log: string[]) {
  return (turn: number, step: number): LoopAttempt => {
    let text = '';
    return {
      start: () => {
        log.push(`start:${turn}.${step}`);
      },
      pushText: (chunk: string) => {
        text += chunk;
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

/** Minimal `LoopAgent` with the same wake semantics as `ClaudeCodeAgent`. */
class FakeAgent {
  readonly inbox: SimpleInbox;
  running = false;
  private wakeWaiters: Array<() => void> = [];
  private liveTurn: LiveTurnControl | undefined;
  private cancelCause: unknown;

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

  consumeCancelCause(): unknown {
    const cause = this.cancelCause;
    this.cancelCause = undefined;
    return cause;
  }

  /** What the real `ClaudeCodeAgent.cancel()` does. */
  requestCancel(cause: unknown): void {
    this.inbox.clear();
    if (!this.running) return;
    this.cancelCause = cause;
    this.liveTurn?.requestCancel();
  }

  async waitForWork(signal: AbortSignal): Promise<{ target: string } | undefined> {
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

/** Minimal `LoopAcpSession` the test drives update by update. */
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

  /** The normal, healthy answer: some text and then the stop. */
  answer(text: string, reason = 'end_turn'): void {
    this.text(text);
    this.stop(reason);
  }
}

/** Poll until `predicate` holds, so a wedged scheduler fails instead of hanging. */
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
// REQ-M2/REQ-M3: the boundary decision itself, with no ACP involved.
// ---------------------------------------------------------------------------

const steerOnly = { nextStep: [message('s', 'steer')], nextTurn: [] };
const turnOnly = { nextStep: [], nextTurn: [message('t', 'turn')] };
const both = { nextStep: [message('s', 'steer')], nextTurn: [message('t', 'turn')] };

assert.deepEqual(decideDrain({ nextStep: [], nextTurn: [] }, false), { kind: 'wait' });
assert.deepEqual(decideDrain(steerOnly, false), { kind: 'start-turn', target: 'next-step' });
assert.deepEqual(decideDrain(turnOnly, false), { kind: 'start-turn', target: 'next-turn' });
assert.deepEqual(decideDrain(both, false), { kind: 'start-turn', target: 'next-step' });
ok('inbox vazia espera; next-step abre turno antes de next-turn');

assert.deepEqual(decideDrain(steerOnly, true), { kind: 'next-step' });
// The key REQ-M3 distinction: a `followup` must NOT be pulled into the turn
// that is already open — it owns a turn of its own.
assert.deepEqual(decideDrain(turnOnly, true), { kind: 'end-turn' });
ok('turno aberto: next-step vira outro passo, next-turn NÃO entra no turno');

// ---------------------------------------------------------------------------
// REQ-M6: one message enters the session once, and the queue is durable.
// ---------------------------------------------------------------------------

const splices: any[] = [];
const inbox = new SimpleInbox(
  () => {},
  (splice) => splices.push(splice),
);
const queuedTurn = message('t1', 'turno');
const steerA = message('s1', 'steer A');
const steerB = message('s2', 'steer B');
inbox.append('next-turn', queuedTurn);
inbox.append('next-step', steerA);
inbox.append('next-step', steerB);
assert.equal(splices.length, 3);
assert.equal(splices[0].target, 'next-turn');
assert.deepEqual(
  splices[1].inserted.map((m: any) => m.id),
  ['s1'],
);
ok('append grava um agent/inbox/spliced por mensagem, na lista certa');

const claimed = inbox.claim('next-turn');
assert.deepEqual(
  claimed.map((m: any) => m.id),
  ['s1', 's2', 't1'],
);
assert.equal(inbox.nextStep.length, 0);
assert.equal(inbox.nextTurn.length, 0);
assert.equal(splices.length, 5);
assert.equal(splices[3].removedCount, 2);
assert.equal(splices[3].outcome, undefined);
ok('claim leva todo next-step mais UM next-turn, e o consumo não é "canceled"');

const removedSplices: any[] = [];
const inbox2 = new SimpleInbox(
  () => {},
  (splice) => removedSplices.push(splice),
);
const dropped = message('d1', 'dropada');
inbox2.append('next-step', dropped);
assert.equal(inbox2.remove(dropped.id), true);
assert.equal(removedSplices[1].outcome, 'canceled');
assert.equal(removedSplices[1].removedCount, 1);
ok('remove marca a remoção como canceled, a forma durável de cancelar input');

// ---------------------------------------------------------------------------
// REQ-M2: a steer that arrives mid-step is consumed at the STEP boundary,
// inside the same turn, and never only at the end of the turn.
// ---------------------------------------------------------------------------

{
  const { session, events } = fakeSession();
  const { dispatch } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];
  agent.inbox.append('next-turn', message('u1', 'primeira'));

  let prompt = 0;
  acp.onPrompt = (self) => {
    prompt += 1;
    if (prompt === 1) {
      // Both arrive while step 1 is in flight.
      agent.inbox.append('next-step', message('u2', 'steer no meio do passo'));
      agent.inbox.append('next-turn', message('u3', 'followup no meio do passo'));
    }
    self.answer(`resposta ${prompt}`);
  };

  const loop = runBridgeLoop({
    session,
    agent: agent as unknown as LoopAgent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 1000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 2, 'os dois turnos fecharem');
  controller.abort();
  await loop;

  // Turn 1 owns two steps: the one it opened with, plus the steered message.
  assert.equal(eventsOf(events, 'turn/start').length, 2);
  assert.equal(eventsOf(events, 'step/start').filter((event) => event.data.turn === 1).length, 2);
  assert.equal(eventsOf(events, 'step/start').filter((event) => event.data.turn === 2).length, 1);
  assert.deepEqual(acp.prompts, ['primeira', 'steer no meio do passo', 'followup no meio do passo']);
  // No steering extension here: the injection is attempted and refused, so the
  // message stays queued and waits for the boundary — and the boundary is the
  // STEP, not the end of the turn.
  assert.deepEqual(acp.steers, ['steer no meio do passo']);
  assert.deepEqual(userMessages(events), ['u1', 'u2', 'u3']);
  assert.equal(eventsOf(events, 'user/message').length, 3);
  assert.ok(
    events.indexOf(eventsOf(events, 'user/message')[1]) < events.indexOf(turnEnds(events)[0]),
    'o user/message do steer entra ANTES do turn/end (REQ-M1)',
  );
  assert.deepEqual(
    turnEnds(events).map((event) => event.data.reason.kind),
    ['completed', 'completed'],
  );
  assert.equal(agent.inbox.hasPending, false);
  ok('steer no meio do passo vira o passo 2 do MESMO turno, sem esperar o turno acabar');
  ok('followup que chega no meio do passo abre turno próprio, depois do turn/end');
}

// ---------------------------------------------------------------------------
// REQ-M1/REQ-M3b: with the steering extension, the message enters the session
// AT SEND TIME, inside the in-flight turn, and shortens the wait.
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
    if (acp.prompts.length === 1) agent.inbox.append('next-step', message('u2', 'steer injetado'));
  };
  acp.onSteer = (_text, self) => {
    // The injected turn keeps running and answers later, as the CLI does.
    setTimeout(() => self.answer('resposta com o steer'), 0);
  };

  const loop = runBridgeLoop({
    session,
    agent: agent as unknown as LoopAgent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 1000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno fechar');
  controller.abort();
  await loop;

  assert.deepEqual(acp.steers, ['steer injetado']);
  assert.deepEqual(acp.prompts, ['primeira']);
  assert.equal(eventsOf(events, 'turn/start').length, 1);
  assert.equal(eventsOf(events, 'step/start').length, 1);
  assert.deepEqual(userMessages(events), ['u1', 'u2']);
  assert.ok(
    events.indexOf(eventsOf(events, 'user/message')[1]) < events.indexOf(turnEnds(events)[0]),
    'o steer injetado entra na trajetória antes do turn/end',
  );
  assert.equal(agent.inbox.nextStep.length, 0);
  assert.equal(turnEnds(events)[0].data.reason.kind, 'completed');
  ok('steer injetado entra no turno em curso, no instante do envio, e não vira passo novo');
}

// ---------------------------------------------------------------------------
// REQ-M4: cancel aborts the ACP prompt and closes the turn as aborted.
// ---------------------------------------------------------------------------

{
  const { session, events } = fakeSession();
  const { dispatch } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];
  agent.inbox.append('next-turn', message('u1', 'primeira'));

  acp.onPrompt = () => {
    agent.requestCancel({ kind: 'user' });
  };
  acp.onCancel = (self) => {
    // The CLI answers `session/cancel` by forcing the prompt loop to return.
    setTimeout(() => self.stop('cancelled'), 0);
  };

  const loop = runBridgeLoop({
    session,
    agent: agent as unknown as LoopAgent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 5000,
    cancelGraceMs: 1000,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno cancelado fechar');
  assert.equal(acp.cancels, 1);
  assert.deepEqual(turnEnds(events)[0].data.reason, {
    kind: 'aborted',
    reason: { kind: 'user' },
  });
  assert.equal(agent.inbox.hasPending, false);
  assert.equal(agent.running, false);
  ok('cancel aborta o prompt ACP e fecha o turno como aborted, liberando a fila');

  // The queue is usable right after: the abort did not wedge the agent.
  acp.onPrompt = (self) => self.answer('depois do cancel');
  agent.inbox.append('next-turn', message('u2', 'depois do cancel'));
  await waitFor(() => turnEnds(events).length >= 2, 'o turno seguinte fechar');
  controller.abort();
  await loop;
  assert.equal(turnEnds(events)[1].data.reason.kind, 'completed');
  assert.deepEqual(userMessages(events), ['u1', 'u2']);
  ok('o agente volta a aceitar trabalho depois do cancel');
}

// ---------------------------------------------------------------------------
// REQ-M5: a prompt that never answers does not wedge the queue.
// ---------------------------------------------------------------------------

{
  const { session, events } = fakeSession();
  const { dispatch } = fakeDispatch();
  const agent = new FakeAgent();
  const acp = new FakeAcp();
  const controller = new AbortController();
  const log: string[] = [];
  agent.inbox.append('next-turn', message('u1', 'nunca responde'));

  // Never answers the first prompt; answers `session/cancel` the way the real
  // CLI does (it forces a `cancelled` stop).
  acp.onPrompt = () => {};
  acp.onCancel = (self) => {
    setTimeout(() => self.stop('cancelled'), 5);
  };

  const loop = runBridgeLoop({
    session,
    agent: agent as unknown as LoopAgent,
    dispatch,
    acp,
    attempts: fakeAttempts(log),
    signal: controller.signal,
    idleTimeoutMs: 25,
    cancelGraceMs: 500,
  });

  await waitFor(() => turnEnds(events).length >= 1, 'o turno travado fechar por timeout');
  assert.equal(acp.cancels, 1);
  const reason = turnEnds(events)[0].data.reason;
  assert.equal(reason.kind, 'error');
  assert.equal(reason.error.code, ACP_TIMEOUT_CODE);
  assert.match(reason.error.message, /no update for 25 ms/);
  ok('turno que nunca responde fecha com erro visível e manda session/cancel');

  // And the queue moves on: the very next message opens a new turn.
  acp.onPrompt = (self) => self.answer('respondido');
  agent.inbox.append('next-turn', message('u2', 'depois do timeout'));
  await waitFor(() => turnEnds(events).length >= 2, 'o turno seguinte fechar');
  controller.abort();
  await loop;
  assert.equal(turnEnds(events)[1].data.reason.kind, 'completed');
  assert.deepEqual(userMessages(events), ['u1', 'u2']);
  ok('a fila destrava depois do timeout: o próximo turno roda normalmente');
}

process.stdout.write(`\ntudo ok (${checks} verificações)\n`);
