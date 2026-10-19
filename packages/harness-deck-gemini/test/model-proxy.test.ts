/**
 * Model proxy and rewriting tests for Gemini bridge.
 *
 * Verifies:
 * - Model rewriting logic (mapping, default fallback, passing through prefixed models)
 * - Proxy forwarding and header injection (authorization, content-type)
 * - Error handling for malformed requests
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  rewriteModel,
  startModelProxy,
  MODEL_MAP_ENV,
  UPSTREAM_URL_ENV,
  UPSTREAM_KEY_ENV,
} from '../src/model-proxy.js';

let checks = 0;
function ok(label: string): void {
  checks += 1;
  process.stdout.write(`ok   ${label}\n`);
}

// ---------------------------------------------------------------------------
// Model rewriting logic
// ---------------------------------------------------------------------------

const map: Record<string, string> = {
  'gemini-2.5-pro': 'google/gemini-2.5-pro',
  'gemini-2.5-flash': 'google/gemini-2.5-flash',
};
const fallback = 'google/gemini-2.5-flash';

// 1. Mapped model
{
  const body = { model: 'gemini-2.5-pro', messages: [] };
  const res = rewriteModel(body, map, fallback);
  assert.equal(res, 'google/gemini-2.5-pro');
  assert.equal(body.model, 'google/gemini-2.5-pro');
  ok('reescreve modelo pelo mapa');
}

// 2. Unmapped model without slash falls back
{
  const body = { model: 'unknown-model', messages: [] };
  const res = rewriteModel(body, map, fallback);
  assert.equal(res, fallback);
  assert.equal(body.model, fallback);
  ok('modelo desconhecido sem slash cai no fallback');
}

// 3. Unmapped model with slash is preserved as-is
{
  const body = { model: 'custom-org/custom-model', messages: [] };
  const res = rewriteModel(body, map, fallback);
  assert.equal(res, 'custom-org/custom-model');
  assert.equal(body.model, 'custom-org/custom-model');
  ok('modelo com slash é preservado como provider/model');
}

// 4. Invalid bodies return undefined
{
  assert.equal(rewriteModel(null, map, fallback), undefined);
  assert.equal(rewriteModel({}, map, fallback), undefined);
  assert.equal(rewriteModel({ model: 123 }, map, fallback), undefined);
  ok('ignora corpos inválidos ou sem campo de modelo');
}

// ---------------------------------------------------------------------------
// Model proxy HTTP forwarding
// ---------------------------------------------------------------------------

let receivedAuth: string | undefined;
let receivedBody: any;
let upstreamReceivedRequests = 0;

const upstreamServer: Server = createServer((req, res) => {
  upstreamReceivedRequests += 1;
  receivedAuth = req.headers.authorization;
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      receivedBody = undefined;
    }
    const responsePayload = JSON.stringify({
      id: 'chatcmpl-test',
      model: receivedBody?.model ?? 'upstream-model',
      choices: [{ message: { content: 'hello from upstream' } }],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(responsePayload);
  });
});

await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', () => resolve()));
const upstreamAddr = upstreamServer.address();
assert(upstreamAddr && typeof upstreamAddr === 'object');
const upstreamUrl = `http://127.0.0.1:${upstreamAddr.port}`;

const proxyEnv: NodeJS.ProcessEnv = {
  ...process.env,
  [MODEL_MAP_ENV]: JSON.stringify(map),
  [UPSTREAM_URL_ENV]: upstreamUrl,
  [UPSTREAM_KEY_ENV]: 'secret-test-api-key',
};

const proxy = await startModelProxy(proxyEnv);
assert.ok(proxy, 'o proxy deve subir quando as envs estiverem configuradas');

try {
  // Make a request through the proxy
  const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.model, 'google/gemini-2.5-pro');

  assert.equal(upstreamReceivedRequests, 1);
  assert.equal(receivedAuth, 'Bearer secret-test-api-key');
  assert.equal(receivedBody?.model, 'google/gemini-2.5-pro');
  ok('proxy repassa requisição com headers, authorization e modelo reescrito');
} finally {
  proxy.dispose();
  upstreamServer.close();
}

// ---------------------------------------------------------------------------
// Protocol adaptation: Gemini generateContent to OpenAI chat completions
// ---------------------------------------------------------------------------

{
  let openAIReceivedBody: any;
  let openAIReceivedAuth: string | undefined;

  const mockOpenAIServer: Server = createServer((req, res) => {
    openAIReceivedAuth = req.headers.authorization;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      openAIReceivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (openAIReceivedBody.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunk1 = {
          choices: [{ delta: { content: 'chunk1 ' } }],
        };
        const chunk2 = {
          choices: [{ delta: { content: 'chunk2' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'non-stream response' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve) => mockOpenAIServer.listen(0, '127.0.0.1', () => resolve()));
  const oaiAddr = mockOpenAIServer.address();
  assert(oaiAddr && typeof oaiAddr === 'object');
  const oaiUrl = `http://127.0.0.1:${oaiAddr.port}/v1`;

  const oaiProxy = await startModelProxy({
    ...process.env,
    [MODEL_MAP_ENV]: JSON.stringify({
      'gemini-2.5-pro': 'custom-oai-model',
    }),
    [UPSTREAM_URL_ENV]: oaiUrl,
    [UPSTREAM_KEY_ENV]: 'test-bearer-token',
  });
  assert.ok(oaiProxy, 'proxy deve subir para upstream OpenAI');

  try {
    // 1. Non-streaming generateContent
    const postRes = await fetch(`${oaiProxy.baseUrl}/v1beta/models/gemini-2.5-pro:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hello gemini' }] }],
        systemInstruction: { parts: [{ text: 'you are a helpful assistant' }] },
      }),
    });
    assert.equal(postRes.status, 200);
    const postData = (await postRes.json()) as any;
    assert.equal(postData.candidates[0].content.parts[0].text, 'non-stream response');
    assert.equal(postData.usageMetadata.promptTokenCount, 8);
    assert.equal(openAIReceivedAuth, 'Bearer test-bearer-token');
    assert.equal(openAIReceivedBody.model, 'custom-oai-model');
    assert.equal(openAIReceivedBody.messages[0].role, 'system');
    assert.equal(openAIReceivedBody.messages[1].role, 'user');
    ok('adapta /v1beta/models/:generateContent para OpenAI /chat/completions não-streaming');

    // 2. Streaming streamGenerateContent
    const streamRes = await fetch(`${oaiProxy.baseUrl}/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'stream prompt' }] }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const textStream = await streamRes.text();
    assert.ok(textStream.includes('chunk1 '));
    assert.ok(textStream.includes('chunk2'));
    assert.ok(textStream.includes('finishReason'));
    ok('adapta /v1beta/models/:streamGenerateContent para SSE do OpenAI e converte chunks para Gemini SSE');
  } finally {
    oaiProxy.dispose();
    mockOpenAIServer.close();
  }
}

// Start proxy returns undefined when env is incomplete
{
  assert.equal(await startModelProxy({}), undefined);
  assert.equal(await startModelProxy({ [MODEL_MAP_ENV]: '{}' }), undefined);
  assert.equal(await startModelProxy({ [UPSTREAM_URL_ENV]: 'http://localhost' }), undefined);
  ok('proxy não sobe sem configuração de upstream e mapa');
}

process.stdout.write(`\ntudo ok em model-proxy (${checks} verificações)\n`);

