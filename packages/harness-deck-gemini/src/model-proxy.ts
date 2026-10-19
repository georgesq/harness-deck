/**
 * Model proxy and protocol adapter for Gemini ACP integration.
 *
 * Provides:
 * 1. Loopback model rewriting for custom aliases / multi-model catalogs.
 * 2. Protocol translation between Google Generative AI wire format
 *    (/v1beta/models/...:generateContent and :streamGenerateContent)
 *    and OpenAI Chat Completions wire format (/chat/completions)
 *    when targeting OpenAI-compatible providers like OpenRouter.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

export const MODEL_MAP_ENV = 'HARNESS_DECK_MODEL_MAP';
export const UPSTREAM_URL_ENV = 'HARNESS_DECK_UPSTREAM_URL';
export const UPSTREAM_KEY_ENV = 'HARNESS_DECK_UPSTREAM_KEY';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ModelProxyHandle {
  baseUrl: string;
  dispose(): void;
}

export function rewriteModel(
  body: unknown,
  map: Record<string, string>,
  fallback: string | undefined,
): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as { model?: unknown };
  if (typeof record.model !== 'string') return undefined;
  const before = record.model;
  const after = map[before] ?? (before.includes('/') ? before : fallback);
  if (after !== undefined && after !== before) record.model = after;
  return after;
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  response.end(payload);
}

/** Check if the upstream URL is an OpenAI-compatible endpoint like OpenRouter */
export function isOpenAIUpstream(upstream: string): boolean {
  return (
    upstream.includes('openrouter.ai') ||
    upstream.endsWith('/v1') ||
    upstream.endsWith('/v1/') ||
    upstream.includes('/chat/completions')
  );
}

/** Convert Gemini contents + systemInstruction to OpenAI messages */
export function geminiToOpenAIMessages(geminiBody: any): any[] {
  const messages: any[] = [];

  // 1. System instructions
  if (geminiBody.systemInstruction?.parts) {
    const systemText = geminiBody.systemInstruction.parts
      .map((p: any) => p.text ?? '')
      .filter(Boolean)
      .join('\n\n');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  // 2. Chat contents
  const contents = Array.isArray(geminiBody.contents) ? geminiBody.contents : [];
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(c.parts) ? c.parts : [];

    let textAcc = '';
    const toolCalls: any[] = [];

    for (const part of parts) {
      if (part.text) {
        textAcc += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: part.functionCall.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        });
      }
      if (part.functionResponse) {
        // Response to a tool call
        messages.push({
          role: 'tool',
          tool_call_id: part.functionResponse.id ?? part.functionResponse.name,
          name: part.functionResponse.name,
          content: typeof part.functionResponse.response === 'string'
            ? part.functionResponse.response
            : JSON.stringify(part.functionResponse.response ?? {}),
        });
      }
    }

    if (textAcc || toolCalls.length > 0) {
      const msg: any = { role, content: textAcc || null };
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      messages.push(msg);
    }
  }

  return messages;
}

/** Convert Gemini tools (functionDeclarations) to OpenAI tools */
export function geminiToOpenAITools(geminiTools: any[] | undefined): any[] | undefined {
  if (!Array.isArray(geminiTools) || geminiTools.length === 0) return undefined;
  const tools: any[] = [];
  for (const item of geminiTools) {
    if (Array.isArray(item.functionDeclarations)) {
      for (const fn of item.functionDeclarations) {
        tools.push({
          type: 'function',
          function: {
            name: fn.name,
            description: fn.description,
            parameters: fn.parametersJsonSchema ?? fn.parameters ?? { type: 'object', properties: {} },
          },
        });
      }
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/** Convert an OpenAI non-streaming chat completion to Gemini generateContent response */
export function openAIToGeminiResponse(data: any): any {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const parts: any[] = [];

  if (message?.content) {
    parts.push({ text: message.content });
  }

  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      let args: any = {};
      try {
        args = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        args = {};
      }
      parts.push({
        functionCall: {
          id: tc.id,
          name: tc.function?.name,
          args,
        },
      });
    }
  }

  const finishReason = choice?.finish_reason === 'tool_calls' ? 'STOP' : 'STOP';

  return {
    candidates: [
      {
        content: {
          parts: parts.length > 0 ? parts : [{ text: '' }],
          role: 'model',
        },
        finishReason,
      },
    ],
    usageMetadata: {
      promptTokenCount: data.usage?.prompt_tokens ?? 0,
      candidatesTokenCount: data.usage?.completion_tokens ?? 0,
      totalTokenCount: data.usage?.total_tokens ?? 0,
    },
  };
}

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

  const upstreamKey = env[UPSTREAM_KEY_ENV];
  const fallbackModel = Object.values(map)[0];
  const isOpenAI = isOpenAIUpstream(upstream);

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = req.url ?? '/';
      const isGenerateContent = url.includes(':generateContent');
      const isStreamGenerateContent = url.includes(':streamGenerateContent');

      // If this is a Gemini CLI model call and upstream is OpenAI-compatible (like OpenRouter):
      if ((isGenerateContent || isStreamGenerateContent) && isOpenAI) {
        const body = await readBody(req);
        let parsed: any;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          parsed = {};
        }

        // Extract model name from URL (e.g. /v1beta/models/gemini-2.5-pro:generateContent)
        const match = url.match(/\/models\/([^:]+):/);
        const urlModel = match ? match[1] : undefined;
        let targetModel = (urlModel ? map[urlModel] : undefined) ?? fallbackModel;
        if (!targetModel && urlModel) {
          targetModel = urlModel;
        }

        const messages = geminiToOpenAIMessages(parsed);
        const tools = geminiToOpenAITools(parsed.tools);

        const openAIBody: any = {
          model: targetModel,
          messages,
          stream: isStreamGenerateContent,
        };
        if (tools) {
          openAIBody.tools = tools;
        }
        if (parsed.generationConfig?.temperature !== undefined) {
          openAIBody.temperature = parsed.generationConfig.temperature;
        }
        if (parsed.generationConfig?.topP !== undefined) {
          openAIBody.top_p = parsed.generationConfig.topP;
        }
        if (parsed.generationConfig?.maxOutputTokens !== undefined) {
          openAIBody.max_tokens = parsed.generationConfig.maxOutputTokens;
        }

        // Determine completions URL
        let completionsUrl = upstream;
        if (completionsUrl.endsWith('/')) {
          completionsUrl = completionsUrl.slice(0, -1);
        }
        if (!completionsUrl.endsWith('/chat/completions')) {
          completionsUrl = `${completionsUrl}/chat/completions`;
        }

        const headers: Record<string, string> = {
          'content-type': 'application/json',
        };
        if (upstreamKey) {
          headers.authorization = `Bearer ${upstreamKey}`;
        }

        const upstreamRes = await fetch(completionsUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(openAIBody),
        });

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          res.writeHead(upstreamRes.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: upstreamRes.status, message: errText } }));
          return;
        }

        if (isStreamGenerateContent) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });

          const webStream = upstreamRes.body;
          if (!webStream) {
            res.end();
            return;
          }

          const nodeStream = Readable.fromWeb(webStream as import('node:stream/web').ReadableStream);
          let sseBuffer = '';

          // Track accumulated tool calls across delta chunks
          const accumulatedToolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

          nodeStream.on('data', (chunk: Buffer) => {
            sseBuffer += chunk.toString('utf8');
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;

              try {
                const chunkData = JSON.parse(payload);
                const choice = chunkData.choices?.[0];
                const delta = choice?.delta;

                // 1. Text delta
                if (delta?.content) {
                  const geminiChunk = {
                    candidates: [
                      {
                        content: {
                          parts: [{ text: delta.content }],
                          role: 'model',
                        },
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(geminiChunk)}\n\n`);
                }

                // 2. Tool calls delta
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    let existing = accumulatedToolCalls.get(idx);
                    if (!existing) {
                      existing = {
                        id: tc.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
                        name: tc.function?.name ?? '',
                        args: '',
                      };
                      accumulatedToolCalls.set(idx, existing);
                    }
                    if (tc.function?.name) existing.name = tc.function.name;
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                  }
                }

                // 3. Choice finish reason
                if (choice?.finish_reason) {
                  const parts: any[] = [];

                  // Flush accumulated tool calls if any
                  for (const [, tc] of accumulatedToolCalls) {
                    let parsedArgs: any = {};
                    try {
                      parsedArgs = JSON.parse(tc.args || '{}');
                    } catch {
                      parsedArgs = {};
                    }
                    parts.push({
                      functionCall: {
                        id: tc.id,
                        name: tc.name,
                        args: parsedArgs,
                      },
                    });
                  }
                  accumulatedToolCalls.clear();

                  const finalChunk: any = {
                    candidates: [
                      {
                        content: {
                          parts: parts.length > 0 ? parts : [{ text: '' }],
                          role: 'model',
                        },
                        finishReason: 'STOP',
                      },
                    ],
                  };
                  if (chunkData.usage) {
                    finalChunk.usageMetadata = {
                      promptTokenCount: chunkData.usage.prompt_tokens ?? 0,
                      candidatesTokenCount: chunkData.usage.completion_tokens ?? 0,
                      totalTokenCount: chunkData.usage.total_tokens ?? 0,
                    };
                  }
                  res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                }
              } catch {
                // Ignore parse errors on individual SSE lines
              }
            }
          });

          nodeStream.on('end', () => {
            res.end();
          });
          nodeStream.on('error', (err) => {
            res.destroy(err);
          });
          return;
        }

        // Non-streaming generateContent
        const data = await upstreamRes.json();
        const geminiResponse = openAIToGeminiResponse(data);
        sendJson(res, 200, geminiResponse);
        return;
      }

      // Default: Direct passthrough with model rewriting
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        parsed = undefined;
      }

      if (parsed) {
        rewriteModel(parsed, map, fallbackModel);
      }

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (upstreamKey) {
        headers.authorization = `Bearer ${upstreamKey}`;
      }

      const upstreamUrl = new URL(url, upstream).toString();
      const upstreamRes = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: parsed ? JSON.stringify(parsed) : body,
      });

      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
      });
      if (upstreamRes.body) {
        Readable.fromWeb(upstreamRes.body as import('node:stream/web').ReadableStream).pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      sendJson(res, 500, { error: { message: String(err) } });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    server.close();
    return undefined;
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    dispose: () => server.close(),
  };
}

let sharedProxy: ModelProxyHandle | undefined;

export async function ensureModelProxy(): Promise<ModelProxyHandle | undefined> {
  if (sharedProxy) return sharedProxy;
  sharedProxy = await startModelProxy();
  return sharedProxy;
}
