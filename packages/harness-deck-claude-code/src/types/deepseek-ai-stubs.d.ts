/**
 * TODO(1.2 cleanup): minimal local stand-ins for `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-agent` types.
 *
 * This package deliberately has no `node_modules` (no `npm install` was run
 * for this scaffold — see packages/harness-deck-claude-code/README.md).
 * Without the real packages installed, `tsc` cannot resolve
 * `@deepseek-ai/cordis` / `@deepseek-ai/dsh-agent` module specifiers, so this
 * file declares just enough of their shape — copied by hand from the
 * installed reference at
 * `/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/{cordis,dsh-agent}/lib/types/`
 * — for `src/index.ts` to type-check in isolation.
 *
 * DELETE this file once the real packages are installed as dependencies
 * (`npm install` in a networked environment); the ambient declarations below
 * will then conflict with / be shadowed by the real `.d.ts` files and are no
 * longer needed.
 */
declare module '@deepseek-ai/cordis' {
  /** Stand-in for cordis's `Context`; real shape has many more members. */
  export class Context {
    agents: {
      setFactory(factory: unknown): () => void;
    };
    effect<T>(callback: () => T, name?: string): T;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
  }

  /** Stand-in for cordis's abstract `Service<T>` base class. */
  export abstract class Service<T = never> {
    static inject?: string[];
    protected ctx: Context;
    constructor(ctx: Context, name: string, immediate?: boolean);
  }
}

declare module '@deepseek-ai/dsh-agent' {
  import type { Context } from '@deepseek-ai/cordis';

  /** Opaque branded session id; real type lives in `@deepseek-ai/dsh-session`. */
  export type SessionId = string & { readonly __brand: 'SessionId' };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface Agent {
    [key: string]: any;
  }

  export interface CreateAgentOptions {
    readonly sessionId: SessionId;
    readonly parentAgent?: Agent;
    readonly meta?: {
      readonly cwd?: string;
      readonly parentSession?: SessionId;
      readonly isSeeded?: boolean;
      readonly origin?: 'subagent';
      readonly delegationDepth?: number;
      readonly agentPreset?: string;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly [key: string]: any;
  }

  export interface ResumeAgentOptions {
    readonly resumeSessionId: SessionId;
    readonly parentAgent?: Agent;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly [key: string]: any;
  }

  export interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
  }

  export interface AgentFactory {
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
  }
}
