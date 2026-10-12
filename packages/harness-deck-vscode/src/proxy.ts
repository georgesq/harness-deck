/**
 * Loopback proxy that lets the harness GUI live inside the panel.
 *
 * The DSH authenticates its Web GUI with a cookie it marks `SameSite=Strict`.
 * The panel iframe is cross-site to the VS Code webview, so that cookie is never
 * stored there and the GUI answers `401 dsh web authentication required` however
 * correct the token in the URL is — a top-level navigation in a real browser is
 * the only context that accepts it. This proxy mints the cookie on the Node side
 * and injects it into every request it forwards, so the iframe talks to a
 * loopback origin that needs no authentication at all.
 *
 * The token rotates with every restart of the harness, so a `401` from upstream
 * re-reads the token from the log and mints a fresh cookie once per request. The
 * `Origin` is rewritten too: the DSH answers `403` to anything else.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { guiUrlFromLogs } from './processes';
import type { HarnessEntry } from './registry';

/** Prefix of the DSH browser-session cookie. */
const COOKIE_PREFIX = 'dsh-auth-';

/** Answer headers the proxy never forwards. */
const DROPPED = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
  'x-frame-options',
]);

/** Mutable per-harness state the running server reads on every request. */
interface ProxyState {
  cookie: string;
}

/** One proxy server per harness. */
interface ProxyEntry {
  server: Server;
  port: number;
  state: ProxyState;
}

/** Drop only the `frame-ancestors` directive, keeping the rest of the policy. */
export function stripFrameAncestors(value: string): string {
  return value
    .split(';')
    .filter((directive) => !directive.trim().toLowerCase().startsWith('frame-ancestors'))
    .join(';');
}

/**
 * Headers the harness must see.
 *
 * The DSH answers `403 forbidden` to any request whose `Origin` is not its own
 * authority, and inside the panel that origin is the proxy — so both `Origin` and
 * `Referer` are rewritten to the harness ones, next to the cookie and the `Host`.
 */
function harnessHeaders(
  entry: HarnessEntry,
  cookie: string,
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const authority = `http://127.0.0.1:${entry.port}`;
  const rewritten: Record<string, string | string[] | undefined> = {
    ...headers,
    cookie,
    host: `127.0.0.1:${entry.port}`,
  };
  if (rewritten.origin !== undefined) rewritten.origin = authority;
  if (typeof rewritten.referer === 'string') {
    rewritten.referer = rewritten.referer.replace(/^https?:\/\/127\.0\.0\.1:\d+/, authority);
  }
  return rewritten;
}

/** Ask the DSH for the session cookie, using the token it printed at startup. */
function mintCookie(tokenUrl: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const request = httpRequest(tokenUrl, { method: 'GET', headers: { accept: 'text/html' } }, (answer) => {
      const raw = answer.headers['set-cookie'] ?? [];
      answer.resume();
      const pair = raw
        .map((line) => line.split(';')[0] ?? '')
        .find((candidate) => candidate.startsWith(COOKIE_PREFIX));
      resolve(pair === '' ? undefined : pair);
    });
    request.on('error', () => resolve(undefined));
    request.end();
  });
}

/** Proxies the Web GUI of every harness that has a panel. */
export class HarnessProxy {
  private readonly entries = new Map<string, ProxyEntry>();

  /**
   * Loopback URL the panel should load for one harness.
   *
   * Returns `undefined` when no cookie could be minted — a stopped harness, or a
   * log without a token yet — and the caller falls back to the direct URL.
   */
  async url(deckHome: string, entry: HarnessEntry): Promise<string | undefined> {
    const known = this.entries.get(entry.name);
    if (known !== undefined) return `http://127.0.0.1:${known.port}`;
    const cookie = await this.mint(deckHome, entry);
    if (cookie === undefined) return undefined;
    const port = await this.listen(deckHome, entry, { cookie });
    return port === undefined ? undefined : `http://127.0.0.1:${port}`;
  }

  /** Close every proxy server. */
  dispose(): void {
    for (const { server } of this.entries.values()) server.close();
    this.entries.clear();
  }

  /** Mint a cookie from the token the harness printed into its log. */
  private async mint(deckHome: string, entry: HarnessEntry): Promise<string | undefined> {
    const tokenUrl = guiUrlFromLogs(deckHome, entry);
    if (tokenUrl === undefined) return undefined;
    return mintCookie(tokenUrl);
  }

  /** Start the server for one harness and remember it. */
  private async listen(deckHome: string, entry: HarnessEntry, state: ProxyState): Promise<number | undefined> {
    const server = createServer((request, response) => {
      this.forward(deckHome, entry, state, request, response, false);
    });
    server.on('upgrade', (request, socket, head) => {
      this.relay(entry, state, request, socket, head);
    });
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, '127.0.0.1', () => resolve(true));
    });
    if (!listening) return undefined;
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      return undefined;
    }
    this.entries.set(entry.name, { server, port: address.port, state });
    return address.port;
  }

  /** Forward one HTTP request with the session cookie, retrying once on 401. */
  private forward(
    deckHome: string,
    entry: HarnessEntry,
    state: ProxyState,
    request: IncomingMessage,
    response: ServerResponse,
    retried: boolean,
  ): void {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: entry.port,
        path: request.url ?? '/',
        method: request.method,
        headers: harnessHeaders(entry, state.cookie, request.headers),
      },
      (answer) => {
        // A GET has no body to replay, so only a GET is worth a second attempt
        // after the token of a restarted harness has been read again.
        if (answer.statusCode === 401 && !retried && request.method === 'GET') {
          answer.resume();
          void this.mint(deckHome, entry).then((cookie) => {
            if (cookie === undefined) {
              response.writeHead(401, { 'content-type': 'text/plain' });
              response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
              return;
            }
            state.cookie = cookie;
            this.forward(deckHome, entry, state, request, response, true);
          });
          return;
        }
        const headers: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(answer.headers)) {
          if (value === undefined) continue;
          const lower = key.toLowerCase();
          if (DROPPED.has(lower)) continue;
          headers[key] =
            lower === 'content-security-policy'
              ? (Array.isArray(value) ? value : [value]).map(stripFrameAncestors)
              : value;
        }
        response.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('harness proxy: the harness did not answer on its port.\n');
    });
    request.pipe(upstream);
  }

  /**
   * Relay a WebSocket upgrade.
   *
   * The head is rebuilt by hand because the cookie and the `Host`/`Origin` the
   * DSH authenticates against have to be the harness ones, not the proxy ones.
   */
  private relay(
    entry: HarnessEntry,
    state: ProxyState,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const upstream = connect(entry.port, '127.0.0.1', () => {
      const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const key = request.rawHeaders[index] ?? '';
        const value = request.rawHeaders[index + 1] ?? '';
        const lower = key.toLowerCase();
        if (lower === 'cookie' || lower === 'host' || lower === 'origin' || lower === 'referer') continue;
        lines.push(`${key}: ${value}`);
      }
      lines.push(`host: 127.0.0.1:${entry.port}`);
      lines.push(`origin: http://127.0.0.1:${entry.port}`);
      lines.push(`cookie: ${state.cookie}`);
      const referer = request.headers.referer;
      if (typeof referer === 'string') {
        lines.push(`referer: ${referer.replace(/^https?:\/\/127\.0\.0\.1:\d+/, `http://127.0.0.1:${entry.port}`)}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  }
}
