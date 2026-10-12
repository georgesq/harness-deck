/**
 * Loopback gateway for the Claude Code CLI.
 *
 * The CLI refuses any model id its own hardcoded catalog does not describe, so
 * a provider slug such as `anthropic/claude-sonnet-5.5` never reaches the wire:
 * the turn dies with "There's an issue with the selected model". The deck knows
 * the mapping (registry `provider.model`) and hands it over in
 * `HARNESS_DECK_MODEL_MAP`; this server applies it, forwards the call in the
 * Anthropic wire format the CLI already speaks, and answers `count_tokens`
 * locally because OpenRouter has no such route.
 *
 * The CLI sees a catalog id (`claude-sonnet-5-5`); the provider sees the slug.
 */
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';

/** Where the deck leaves the mapping for this harness. */
export const MODEL_MAP_ENV = 'HARNESS_DECK_MODEL_MAP';
/** Upstream base URL the CLI would have used without the proxy. */
export const UPSTREAM_URL_ENV = 'HARNESS_DECK_UPSTREAM_URL';
/** Bearer token sent upstream, so the CLI's own header shape does not matter. */
export const UPSTREAM_KEY_ENV = 'HARNESS_DECK_UPSTREAM_KEY';

/** Largest request body accepted; a conversation can be large but not unbounded. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Headers copied from the CLI request to the upstream call. */
const FORWARDED_HEADERS = [
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
  'x-app',
] as const;

export interface ModelProxyHandle {
  /** Base URL the CLI must be pointed at, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /** Stops the listener; safe to call more than once. */
  dispose(): void;
}

/** Rewrite the model field in place: catalog id in, provider slug out. */
export function rewriteModel(
  body: unknown,
  map: Record<string, string>,
  fallback: string | undefined,
): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as { model?: unknown };
  if (typeof record.model !== 'string') return undefined;
  const before = record.model;
  // A slug already carries its vendor and needs no mapping; an id the map does
  // not know (a subagent model, say) falls back to the harness model so the
  // upstream never sees an id it cannot serve.
  const after = map[before] ?? (before.includes('/') ? before : fallback);
  if (after !== undefined && after !== before) record.model = after;
  return after;
}

/** Cheap local stand-in for the missing `count_tokens` route. */
function estimateTokens(body: Buffer): number {
  return Math.max(1, Math.ceil(body.length / 4));
}

function readBody(request: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  response.end(payload);
}

/**
 * Starts the gateway described by the environment. Returns `undefined` when the
 * deck configured no mapping, in which case the CLI keeps its own base URL.
 */
export async function startModelProxy(env: NodeJS.ProcessEnv = process.env): Promise<ModelProxyHandle | undefined> {
  const rawMap = env[MODEL_MAP_ENV];
  const upstream = env[UPSTREAM_URL_ENV];
  if (!rawMap || !upstream) return undefined;

  let map: Record<string, string>;
  try {
    map = JSON.parse(rawMap) as Record<string, string>;
  } catch {
    return undefined;
  }
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;
  const apiKey = env[UPSTREAM_KEY_ENV];
  const fallback = entries[0]?.[1];
  const debug = env.HARNESS_DECK_DEBUG === '1';
  // The CLI appends `/v1/messages` to the base URL it is given, while the deck
  // hands over the provider base (`https://openrouter.ai/api/v1`). Keep one
  // `/v1`, not two.
  const upstreamRoot = upstream.replace(/\/+$/, '').replace(/\/v1$/, '');

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const path = request.url ?? '/v1/messages';
        const method = request.method ?? 'POST';
        if (path.includes('/count_tokens')) {
          sendJson(response, 200, { input_tokens: estimateTokens(body) });
          return;
        }
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        for (const name of FORWARDED_HEADERS) {
          const value = request.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        let payload: string | undefined;
        if (method === 'POST') {
          let parsed: unknown;
          try {
            parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(response, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'invalid JSON body' },
            });
            return;
          }
          const sent = (parsed as { model?: unknown }).model;
          const used = rewriteModel(parsed, map, fallback);
          if (debug) console.error(`[model-proxy] ${method} ${path} model=${String(sent)} -> ${String(used)}`);
          payload = JSON.stringify(parsed);
        } else if (debug) {
          console.error(`[model-proxy] ${method} ${path}`);
        }
        const upstreamResponse = await fetch(`${upstreamRoot}${path}`, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
        });
        if (debug) console.error(`[model-proxy] upstream ${upstreamResponse.status} ${path}`);
        const outHeaders: Record<string, string> = {};
        const contentType = upstreamResponse.headers.get('content-type');
        if (contentType) outHeaders['content-type'] = contentType;
        response.writeHead(upstreamResponse.status, outHeaders);
        if (upstreamResponse.body) {
          Readable.fromWeb(upstreamResponse.body as import('node:stream/web').ReadableStream).pipe(response);
        } else {
          response.end();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          sendJson(response, 502, { type: 'error', error: { type: 'api_error', message } });
        } else {
          response.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dispose: () => server.close(),
  };
}

/** Cached handle: one gateway per harness process, started on first use. */
let proxyPromise: Promise<ModelProxyHandle | undefined> | undefined;

/** The gateway for this process, started once. */
export function ensureModelProxy(env: NodeJS.ProcessEnv = process.env): Promise<ModelProxyHandle | undefined> {
  proxyPromise ??= startModelProxy(env);
  return proxyPromise;
}
