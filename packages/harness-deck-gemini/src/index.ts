/**
 * harness-deck Gemini engine plugin.
 *
 * Implements the AgentFactory interface for DSH, spawning an ACP-compliant
 * Gemini agent (`gemini --acp`) and bridging JSON-RPC ACP communication to DSH
 * sessions and the Web GUI.
 */
import { existsSync } from 'node:fs';
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
import type { AgentCancelCause, Session, SessionSeq } from '@deepseek-ai/dsh-session';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
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
  type LoopAgent,
  type LoopAttemptFactory,
} from './bridge-loop.js';
import { LiveAcpSession, steeringSupported } from './acp-control.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    geminiAgentLoop: GeminiAgentLoop;
  }
}

export interface GeminiAgentLoopConfig {
  readonly acpBinPath?: string;
  readonly acpArgs?: string[];
  readonly promptIdleTimeoutMs?: number;
}

const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 30 * 60_000;
const CANCEL_GRACE_MS = 35_000;

type AcpChildProcess = ChildProcessByStdio<NodeWritable, NodeReadable, null>;

function spawnAcpAgent(binPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): AcpChildProcess {
  return spawn(binPath, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
}

async function acpChildEnv(): Promise<NodeJS.ProcessEnv> {
  const proxy = await ensureModelProxy();
  if (!proxy) return process.env;
  return {
    ...process.env,
    GEMINI_BASE_URL: proxy.baseUrl,
    GOOGLE_BASE_URL: proxy.baseUrl,
    GOOGLE_GEMINI_BASE_URL: proxy.baseUrl,
  };
}

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
  const catalog = Object.entries(map).find(([, value]) => value === slug)?.[0] ?? slug;
  try {
    // gemini-cli implements session/set_model (unstable_setSessionModel)
    await (ctx as any).request('session/set_model', {
      sessionId,
      modelId: catalog,
    });
  } catch (error) {
    process.stderr.write(
      `[gemini] could not pin model "${slug}" (${catalog}): ${errorChain(error)}\n`,
    );
  }
}

class GeminiAgent implements Agent, LoopAgent {
  readonly id: Session['id'];
  readonly options: AgentOptions;
  readonly session: Session;
  readonly inbox: SimpleInbox;
  readonly ctx: Context;
  status: AgentStatus = 'idle';

  readonly scope: Scope;

  private liveTurn: LiveTurnControl | undefined;
  private cancelCause: AgentCancelCause | undefined;
  private idleWaiters: Array<() => void> = [];
  private wakeWaiters: Array<() => void> = [];

  constructor(loopCtx: Context, session: Session, options: AgentOptions) {
    this.id = session.id;
    this.options = options;
    this.session = session;
    this.scope = createScope(loopCtx, this);
    this.ctx = this.scope.ctx;
    this.inbox = new SimpleInbox(
      () => this.wake(),
      (splice) => this.session.append('agent/inbox/spliced', splice),
    );
  }

  get selectedModel(): string | undefined {
    const model = this.options.model;
    return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined;
  }

  async whenIdle(): Promise<void> {
    if (this.status === 'idle') return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return task(controller.signal);
  }

  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (!options?.keepInbox) this.inbox.clear();
    if (this.status !== 'running') return;
    this.cancelCause = cause;
    this.liveTurn?.requestCancel();
  }

  send(message: UserMessage, target: InboxTarget = 'next-turn', _wakeup?: boolean): void {
    this.inbox.append(target, message);
  }

  followup(message: UserMessage): void {
    this.inbox.append('next-turn', message);
  }

  steer(message: UserMessage): void {
    this.inbox.append('next-step', message);
  }

  inject(message: UserMessage, target: InboxTarget = 'next-step'): void {
    this.inbox.append(target, message);
  }

  async waitForWork(signal: AbortSignal): Promise<{ readonly target: InboxTarget } | undefined> {
    for (;;) {
      const decision = decideDrain(this.inbox, false);
      if (decision.kind === 'start-turn') return { target: decision.target };
      if (signal.aborted) return undefined;
      await this.waitForWake(signal);
    }
  }

  async waitForSteer(signal: AbortSignal): Promise<UserMessage | undefined> {
    for (;;) {
      const message = this.inbox.nextStep[0];
      if (message !== undefined) return message;
      if (signal.aborted) return undefined;
      await this.waitForWake(signal);
    }
  }

  attachTurn(control: LiveTurnControl | undefined): void {
    this.liveTurn = control;
  }

  consumeCancelCause(): AgentCancelCause | undefined {
    const cause = this.cancelCause;
    this.cancelCause = undefined;
    return cause;
  }

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

  start(): void {
    this.emit({
      type: 'start',
      attemptId: this.attemptId,
      revision: this.nextRevision(),
      turn: this.turn,
      step: this.step,
    });
  }

  pushText(text: string): void {
    if (!this.blockOpen) {
      this.blockOpen = true;
      this.push({ type: 'block-start', index: 0, blockType: 'text' });
    }
    this.text += text;
    this.push({ type: 'text-delta', index: 0, text });
  }

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

  get hasVisibleText(): boolean {
    return this.text.length > 0;
  }

  get stream(): AssistantStreamRecord[] {
    return [...this.accumulator.snapshot()];
  }

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

export class GeminiAgentLoop extends Service implements AgentFactory {
  static inject = ['agents', 'sessions', 'approval'];

  private readonly config: GeminiAgentLoopConfig;
  private readonly runtime: { ctx: Context };

  constructor(ctx: Context, config?: GeminiAgentLoopConfig) {
    super(ctx, 'geminiAgentLoop');
    this.config = config ?? {};
    this.runtime = { ctx };

    ctx.effect(() => ctx.agents.setFactory(this), 'geminiAgentLoop.setFactory()');
  }

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

    const loopCtx = this.runtime.ctx;
    let startedAgent: GeminiAgent | undefined;
    ownerCtx.effect(function* () {
      startedAgent = new GeminiAgent(loopCtx, session, options.agentOptions ?? {});
      yield startedAgent.scope.rawDispose;
    }, `geminiAgentLoop.lifecycle(${options.sessionId})`);

    if (startedAgent === undefined) {
      detachSession();
      throw new Error('geminiAgentLoop: the Agent did not start');
    }
    const agent: GeminiAgent = startedAgent;
    const agentScope = agent.scope;

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
    let bin = this.config.acpBinPath ?? process.env.GEMINI_ACP_BIN;
    if (!bin) {
      const localBin = new URL('../node_modules/.bin/gemini', import.meta.url).pathname;
      bin = existsSync(localBin) ? localBin : 'gemini';
    }
    const args = this.config.acpArgs ?? ['--acp'];
    const child = spawnAcpAgent(bin, args, cwd, await acpChildEnv());
    const bridgeAbort = new AbortController();

    const dispatch = agentEvents(this.runtime.ctx, agent);

    const bridgeDone = this.runBridge(agent, child, cwd, dispatch, bridgeAbort.signal).catch((error: unknown) => {
      ownerCtx.logger.error(`geminiAgentLoop: ACP bridge for session "${session.id}" failed: ${String(error)}`);
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

  private async decidePermission(
    agent: GeminiAgent,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const approval = this.runtime.ctx.get('approval');
    if (approval === undefined) {
      process.stderr.write(
        `[gemini] no approval service; refusing "${request.toolCall.title ?? 'tool'}"\n`,
      );
      return { outcome: { outcome: 'cancelled' } };
    }
    let outcome: ApprovalOutcome;
    try {
      outcome = await approval.request({
        agent,
        toolName: request.toolCall.title ?? 'tool',
        ...(request.toolCall.toolCallId === undefined ? {} : { callId: request.toolCall.toolCallId as any }),
      });
    } catch (error) {
      process.stderr.write(`[gemini] approval service failed: ${errorChain(error)}\n`);
      return { outcome: { outcome: 'cancelled' } };
    }
    if (outcome !== 'allowed-once') return { outcome: { outcome: 'cancelled' } };
    const allow = request.options.find((option) => option.kind === 'allow_once') ?? request.options[0];
    if (allow === undefined) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  private async runBridge(
    agent: GeminiAgent,
    child: AcpChildProcess,
    cwd: string,
    dispatch: AgentEventDispatch,
    signal: AbortSignal,
  ): Promise<void> {
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    const session = agent.session;

    await acp
      .client({ name: 'harness-deck-gemini' })
      .onRequest(acp.methods.client.session.requestPermission, (request) =>
        this.decidePermission(agent, request.params),
      )
      .connectWith(stream, async (ctx) => {
        const initialize = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        });

        return ctx.buildSession(cwd).withSession(async (acpSession) => {
          await applySelectedModel(ctx, acpSession.sessionId, agent.selectedModel);
          let attempt = 0;
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
              settleMessage: () =>
                frame.settle('assistant/message', () =>
                  session.append(
                    'assistant/message',
                    {
                      turn,
                      step,
                      message: createAssistantMessage({
                        content: frame.blocks(),
                        source: { provider: 'gemini-agent-acp', model: agent.selectedModel ?? 'gemini' },
                      }),
                      stream: frame.stream,
                    },
                    { surfaceOp: 'append' },
                  ).seq,
                ),
              settleAttempt: () =>
                frame.settle('assistant/attempt', () =>
                  session.append('assistant/attempt', { turn, step, stream: frame.stream }).seq,
                ),
              abandon: () => frame.abandon(),
            };
          };

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

  async resume(_ownerCtx: Context, _options: ResumeAgentOptions): Promise<AgentHandle> {
    throw new Error('resume not implemented yet');
  }
}

export default GeminiAgentLoop;
