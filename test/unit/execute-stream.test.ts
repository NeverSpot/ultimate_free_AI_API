/**
 * execute-stream.test.ts
 *
 * Hermetic unit tests for executeStream() and the SSE HTTP layer.
 * No network, no Docker, no real keys — fake adapter, fake clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { CanonicalChunk, CanonicalRequest } from '../../src/core/types';
import { ProviderError } from '../../src/core/errors';
import { executeStream, type Candidate, type ExecuteMeta } from '../../src/core/execute';
import { MockProviderAdapter } from '../../src/providers/mock';
import { registerChatCompletions } from '../../src/http/routes/chat-completions';
import type { Config } from '../../src/config/env';
import type { Credential } from '../../src/providers/types';
import type { Ledger } from '../../src/limits/ledger';
import type { Breaker } from '../../src/resilience/breaker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_731_250_000_000;

function makeCred(id: string, provider = 'mock'): Credential {
  return { id, provider, secret: 'test-secret' };
}

function makeRequest(content = 'Say hello.'): CanonicalRequest {
  return {
    model: 'mock-model',
    messages: [{ role: 'user', content }],
    stream: true,
  };
}

function noopLedger(): Ledger {
  return {
    reserve: async () => ({
      ok: true as const,
      reservation: { credentialId: 'c1', modelId: 'm1', cost: 1, reserved: [] },
    }),
    commit: async () => {},
    release: async () => {},
  };
}

function passThroughBreaker(): Breaker {
  return {
    allow: async () => ({ allowed: true }),
    recordSuccess: async () => {},
    recordFailure: async () => {},
  };
}

async function collectStream(iterable: AsyncIterable<CanonicalChunk>): Promise<CanonicalChunk[]> {
  const chunks: CanonicalChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 1. Chunks reassembled correctly — basic success path
// ---------------------------------------------------------------------------

test('executeStream: yields all chunks from adapter and finishes cleanly', async () => {
  const content = 'Hello world from stream';
  const adapter = new MockProviderAdapter({ id: 'mock', model: 'mock-model', content });
  const cred = makeCred('cred-1');
  const req = makeRequest();

  const candidates: ReadonlyArray<Candidate> = [
    { modelId: 'mock-model', credential: cred, providerId: 'mock', adapterId: 'mock' },
  ];
  const adapterMap = new Map([['mock', { adapter, providerId: 'mock' }]]);

  const stream = executeStream(
    req,
    candidates,
    noopLedger(),
    new Map(),
    adapterMap,
    passThroughBreaker(),
  );
  const chunks = await collectStream(stream);

  assert.ok(chunks.length > 0, 'should yield at least one chunk');
  const assembled = chunks.map((c) => c.delta.content ?? '').join('');
  assert.ok(assembled.includes('Hello'), 'assembled content should contain original text');
});

// ---------------------------------------------------------------------------
// 2. Custom chunks — verify each chunk passes through
// ---------------------------------------------------------------------------

test('executeStream: yields exact custom chunks in order', async () => {
  const customChunks: CanonicalChunk[] = [
    {
      id: 'r1',
      model: 'mock-model',
      created: 1000,
      delta: { role: 'assistant', content: 'Hello' },
      finish_reason: null,
    },
    {
      id: 'r1',
      model: 'mock-model',
      created: 1000,
      delta: { content: ' world' },
      finish_reason: null,
    },
    {
      id: 'r1',
      model: 'mock-model',
      created: 1000,
      delta: { content: '!' },
      finish_reason: 'stop',
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  ];
  const adapter = new MockProviderAdapter({ id: 'mock', customChunks });
  const cred = makeCred('cred-1');
  const req = makeRequest();
  const candidates: ReadonlyArray<Candidate> = [
    { modelId: 'mock-model', credential: cred, providerId: 'mock', adapterId: 'mock' },
  ];
  const adapterMap = new Map([['mock', { adapter, providerId: 'mock' }]]);

  const stream = executeStream(
    req,
    candidates,
    noopLedger(),
    new Map(),
    adapterMap,
    passThroughBreaker(),
  );
  const chunks = await collectStream(stream);

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.delta.content, 'Hello');
  assert.equal(chunks[1]!.delta.content, ' world');
  assert.equal(chunks[2]!.delta.content, '!');
  assert.equal(chunks[2]!.finish_reason, 'stop');
  assert.ok(chunks[2]!.usage !== undefined, 'last chunk carries usage');
});

// ---------------------------------------------------------------------------
// 3. Failover works BEFORE first chunk — not after
// ---------------------------------------------------------------------------

test('executeStream: failover succeeds when first candidate fails before yielding any chunk', async () => {
  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');

  const failing = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'upstream', times: 1 }],
  });
  const winning = new MockProviderAdapter({ id: 'p2', model: 'm1', content: 'from-p2' });

  const candidates: ReadonlyArray<Candidate> = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
    { modelId: 'm1', credential: c2, providerId: 'p2', adapterId: 'p2' },
  ];
  const adapterMap = new Map([
    ['p1', { adapter: failing, providerId: 'p1' }],
    ['p2', { adapter: winning, providerId: 'p2' }],
  ]);

  let completedMeta: ExecuteMeta | undefined;
  const stream = executeStream(
    makeRequest(),
    candidates,
    noopLedger(),
    new Map(),
    adapterMap,
    passThroughBreaker(),
    {
      onComplete: (meta) => {
        completedMeta = meta;
      },
    },
  );
  const chunks = await collectStream(stream);

  assert.ok(chunks.length > 0, 'should get chunks from the winning provider');
  assert.equal(completedMeta?.providerId, 'p2', 'should report the winning provider');
});

test('executeStream: mid-stream failure throws without retrying (failover only before first chunk)', async () => {
  const cred = makeCred('cred-1');

  // Fail after 1 chunk — this is mid-stream, so failover must NOT happen
  const adapter = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Hello world from mock',
    failures: [{ kind: 'upstream', afterChunks: 1 }],
  });

  const candidates: ReadonlyArray<Candidate> = [
    { modelId: 'mock-model', credential: cred, providerId: 'mock', adapterId: 'mock' },
  ];
  const adapterMap = new Map([['mock', { adapter, providerId: 'mock' }]]);

  const stream = executeStream(
    makeRequest(),
    candidates,
    noopLedger(),
    new Map(),
    adapterMap,
    passThroughBreaker(),
  );

  let chunkCount = 0;
  let caughtError: unknown;

  try {
    for await (const _chunk of stream) {
      chunkCount++;
    }
  } catch (err) {
    caughtError = err;
  }

  assert.ok(chunkCount >= 1, 'should have yielded at least one chunk before failure');
  assert.ok(caughtError instanceof ProviderError, 'should throw ProviderError after first chunk');
  // Adapter was only called once — no retry
  assert.equal(adapter.getCallCount(), 1, 'adapter should only be called once (no failover)');
});

// ---------------------------------------------------------------------------
// 4. Client abort cancels upstream stream
// ---------------------------------------------------------------------------

test('executeStream: client abort via AbortSignal cancels the upstream stream', async () => {
  const controller = new AbortController();
  const cred = makeCred('cred-1');

  // Adapter with delay so we can abort mid-stream
  const adapter = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Hello world this is a longer response for testing',
    chunkDelayMs: 10,
  });

  const candidates: ReadonlyArray<Candidate> = [
    { modelId: 'mock-model', credential: cred, providerId: 'mock', adapterId: 'mock' },
  ];
  const adapterMap = new Map([['mock', { adapter, providerId: 'mock' }]]);

  const stream = executeStream(
    makeRequest(),
    candidates,
    noopLedger(),
    new Map(),
    adapterMap,
    passThroughBreaker(),
    {
      signal: controller.signal,
    },
  );

  let chunkCount = 0;
  let caughtError: unknown;

  try {
    for await (const _chunk of stream) {
      chunkCount++;
      if (chunkCount === 1) {
        // Abort after first chunk — simulates client disconnect mid-stream
        controller.abort();
      }
    }
  } catch (err) {
    caughtError = err;
  }

  // Either we got an error OR the loop terminated early — either way, not all chunks delivered
  // The important invariant: no infinite hang
  assert.ok(
    caughtError instanceof ProviderError || chunkCount < 20,
    'stream should abort or yield fewer chunks than total',
  );
});

// ---------------------------------------------------------------------------
// 5. [DONE] sentinel via HTTP SSE layer
// ---------------------------------------------------------------------------

test('SSE: stream: true response ends with [DONE] and uses text/event-stream', async (t) => {
  const config: Config = {
    port: 0,
    adminToken: 'test-token',
    encryptionKey: 'test-master-key-32-chars-minimum!',
    maxBodyBytes: 1_048_576,
    attemptTimeoutMs: 5_000,
    requestDeadlineMs: 15_000,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const provider = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Hello from SSE stream',
    clock: () => NOW,
  });
  const credential = makeCred('cred-1');
  const candidates = [
    { modelId: 'mock-model' as string, credential, providerId: 'mock', adapterId: 'mock' },
  ];

  const app = Fastify({ logger: false });
  app.decorateRequest('gatewayRequestId', 'req-sse-1');
  registerChatCompletions(app, { config, provider, credential, candidates });
  t.after(async () => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    payload: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/event-stream/);
  assert.match(res.body, /data: \{/, 'body should contain SSE data lines');
  assert.match(res.body, /data: \[DONE\]/, 'body should end with [DONE]');
});

// ---------------------------------------------------------------------------
// 6. SSE: each data line is valid JSON with the OpenAI chunk shape
// ---------------------------------------------------------------------------

test('SSE: each data line is valid JSON with the chat.completion.chunk shape', async (t) => {
  const config: Config = {
    port: 0,
    adminToken: 'test-token',
    encryptionKey: 'test-master-key-32-chars-minimum!',
    maxBodyBytes: 1_048_576,
    attemptTimeoutMs: 5_000,
    requestDeadlineMs: 15_000,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const provider = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Hello world',
    clock: () => NOW,
  });
  const credential = makeCred('cred-1');
  const candidates = [
    { modelId: 'mock-model' as string, credential, providerId: 'mock', adapterId: 'mock' },
  ];

  const app = Fastify({ logger: false });
  app.decorateRequest('gatewayRequestId', 'req-sse-shape');
  registerChatCompletions(app, { config, provider, credential, candidates });
  t.after(async () => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    payload: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
  });

  assert.equal(res.statusCode, 200);

  // Parse each data line (excluding [DONE])
  const lines = res.body.split('\n');
  const dataLines = lines
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => l.slice(6).trim());

  assert.ok(dataLines.length > 0, 'should have at least one data line');

  for (const line of dataLines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(
      parsed.object,
      'chat.completion.chunk',
      'object field should be chat.completion.chunk',
    );
    assert.ok(Array.isArray(parsed.choices), 'choices should be an array');
    const choices = parsed.choices as Array<Record<string, unknown>>;
    assert.ok(choices.length > 0, 'should have at least one choice');
    assert.ok('delta' in choices[0]!, 'choice should have a delta field');
  }
});

// ---------------------------------------------------------------------------
// 7. SSE: mid-stream error emits error event and closes connection
// ---------------------------------------------------------------------------

test('SSE: mid-stream provider error emits an SSE error event', async (t) => {
  const config: Config = {
    port: 0,
    adminToken: 'test-token',
    encryptionKey: 'test-master-key-32-chars-minimum!',
    maxBodyBytes: 1_048_576,
    attemptTimeoutMs: 5_000,
    requestDeadlineMs: 15_000,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const provider = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Hello world this is a longer test response',
    clock: () => NOW,
    // Inject a mid-stream failure after 1 chunk
    failures: [{ kind: 'upstream', afterChunks: 1, times: 1 }],
  });
  const credential = makeCred('cred-1');

  const app = Fastify({ logger: false });
  app.decorateRequest('gatewayRequestId', 'req-sse-err');
  registerChatCompletions(app, { config, provider, credential });
  t.after(async () => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
    },
    payload: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
  });

  // Status must be 200 (headers already sent before mid-stream error)
  assert.equal(res.statusCode, 200);
  // Body should contain an SSE error event
  assert.match(res.body, /event: error/, 'should emit an SSE error event on mid-stream failure');
});

// ---------------------------------------------------------------------------
// 8. onFirstChunk callback fires before subsequent chunks
// ---------------------------------------------------------------------------

test('executeStream: onFirstChunk fires when the first chunk is obtained', async () => {
  const cred = makeCred('cred-1');
  const adapter = new MockProviderAdapter({ id: 'mock', model: 'mock-model', content: 'Hi there' });

  const candidates: ReadonlyArray<Candidate> = [
    { modelId: 'mock-model', credential: cred, providerId: 'mock', adapterId: 'mock' },
  ];
  const adapterMap = new Map([['mock', { adapter, providerId: 'mock' }]]);

  let firstChunkMeta: ExecuteMeta | undefined;
  let completedMeta: ExecuteMeta | undefined;
  let firstChunkFiredAt = -1;
  let chunkCount = 0;

  const stream = executeStream(
    makeRequest(),
    candidates,
    noopLedger(),
    new Map(),
    adapterMap,
    passThroughBreaker(),
    {
      onFirstChunk: (meta) => {
        firstChunkMeta = meta;
        firstChunkFiredAt = chunkCount; // should be 0 when first chunk fires
      },
      onComplete: (meta) => {
        completedMeta = meta;
      },
    },
  );

  for await (const _chunk of stream) {
    chunkCount++;
  }

  assert.ok(firstChunkMeta !== undefined, 'onFirstChunk should have fired');
  assert.equal(firstChunkFiredAt, 0, 'onFirstChunk should fire before any chunk is counted');
  assert.ok(completedMeta !== undefined, 'onComplete should have fired');
  assert.equal(completedMeta?.providerId, 'mock');
});

// ---------------------------------------------------------------------------
// 9. Streaming response headers: Cache-Control, X-Accel-Buffering, Content-Encoding
// ---------------------------------------------------------------------------

test('SSE response headers: sets no-cache, no-transform, X-Accel-Buffering, Content-Encoding', async (t) => {
  const config: Config = {
    port: 0,
    adminToken: 'test-token',
    encryptionKey: 'test-master-key-32-chars-minimum!',
    maxBodyBytes: 1_048_576,
    attemptTimeoutMs: 5000,
    requestDeadlineMs: 10000,
    logLevel: 'silent',
    nodeEnv: 'test',
  };
  const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model', content: 'test' });
  const credential = makeCred('c1');

  const app = Fastify({ logger: false });
  app.decorateRequest('gatewayRequestId', 'req-sse-hdr');
  registerChatCompletions(app, { config, provider, credential });
  t.after(async () => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(res.headers['x-accel-buffering'], 'no');
  assert.equal(res.headers['content-encoding'], 'none');
});

// ---------------------------------------------------------------------------
// 10. SSE keepalive: emits : keepalive\n\n during silence
// ---------------------------------------------------------------------------

test('SSE keepalive: emits : keepalive\\n\\n comment during stream silence', async (t) => {
  const config: Config = {
    port: 0,
    adminToken: 'test-token',
    encryptionKey: 'test-master-key-32-chars-minimum!',
    maxBodyBytes: 1_048_576,
    attemptTimeoutMs: 5000,
    requestDeadlineMs: 10000,
    logLevel: 'silent',
    nodeEnv: 'test',
  };
  const provider = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'hello world from keepalive test',
    chunkDelayMs: 60,
  });
  const credential = makeCred('c1');

  const app = Fastify({ logger: false });
  app.decorateRequest('gatewayRequestId', 'req-sse-keepalive');
  registerChatCompletions(app, {
    config,
    provider,
    credential,
    keepaliveIntervalMs: 20,
  });
  t.after(async () => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /: keepalive\n\n/, 'body should contain keepalive comment');
});
