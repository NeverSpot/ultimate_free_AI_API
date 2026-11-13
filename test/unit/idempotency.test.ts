import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { ApiError } from '../../src/http/errors';
import {
  createMemoryIdempotencyService,
  extractIdempotencyKey,
  IdempotencyService,
  MemoryIdempotencyStorage,
  type StoredResponse,
} from '../../src/http/middleware/idempotency';
import { buildServer } from '../../src/http/server';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

const NOW = 1_731_250_000_000;

const config: Config = {
  port: 0,
  adminToken: 'test-admin-token',
  encryptionKey: 'test-master-key-32-chars-minimum!',
  maxBodyBytes: 2 * 1024 * 1024,
  attemptTimeoutMs: 10_000,
  requestDeadlineMs: 30_000,
  logLevel: 'silent',
  nodeEnv: 'test',
};

const credential: Credential = {
  id: 'credential-1',
  provider: 'mock',
  secret: 'not-a-real-key',
};

const validBody = {
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Say hello.' }],
};

const authorized = { authorization: `Bearer ${config.adminToken}` };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('idempotency service: acquire, complete and replay cache hit', async () => {
  const service = createMemoryIdempotencyService({ lockTtlMs: 5_000 });

  const first = await service.process('req-1');
  assert.equal(first.type, 'leader');

  const storedResponse: StoredResponse = {
    statusCode: 200,
    headers: { 'x-test': 'val' },
    isStream: false,
    body: { hello: 'world' },
  };

  await service.complete('req-1', first.lockToken, storedResponse);

  const second = await service.process('req-1');
  assert.equal(second.type, 'replay');
  assert.deepEqual(second.response, storedResponse);
});

test('idempotency service: error release allows subsequent flight', async () => {
  const storage = new MemoryIdempotencyStorage();
  const service = new IdempotencyService({ storage, lockTtlMs: 5_000 });

  const first = await service.process('req-fail');
  assert.equal(first.type, 'leader');

  // Error occurs, leader releases lock
  await service.release('req-fail', first.lockToken);

  // Subsequent call can now acquire and become leader
  const second = await service.process('req-fail');
  assert.equal(second.type, 'leader');
  assert.notEqual(second.lockToken, first.lockToken);
});

test('idempotency service: concurrent duplicate awaits pending flight', async () => {
  const storage = new MemoryIdempotencyStorage();
  const service = new IdempotencyService({
    storage,
    lockTtlMs: 5_000,
    pollIntervalMs: 10,
    waitTimeoutMs: 1_000,
  });

  const storedResponse: StoredResponse = {
    statusCode: 200,
    headers: { 'x-done': 'true' },
    isStream: false,
    body: { message: 'success' },
  };

  const p1 = service.process('conc-1');
  // Small tick to ensure p1 claims lock first
  await sleep(5);
  const p2 = service.process('conc-1');

  const res1 = await p1;
  assert.equal(res1.type, 'leader');

  // Simulate in-flight delay before completion
  await sleep(25);
  await service.complete('conc-1', res1.lockToken, storedResponse);

  const res2 = await p2;
  assert.equal(res2.type, 'replay');
  assert.deepEqual(res2.response, storedResponse);
});

test('idempotency service: abort signal terminates waiting duplicate', async () => {
  const storage = new MemoryIdempotencyStorage();
  const service = new IdempotencyService({
    storage,
    lockTtlMs: 5_000,
    pollIntervalMs: 20,
    waitTimeoutMs: 5_000,
  });

  const first = await service.process('abort-test');
  assert.equal(first.type, 'leader');

  const controller = new AbortController();
  const duplicatePromise = service.process('abort-test', { signal: controller.signal });

  setTimeout(() => controller.abort(), 20);

  await assert.rejects(duplicatePromise, (err: Error) => {
    return err.name === 'AbortError' || err.message.includes('aborted');
  });

  await service.release('abort-test', first.lockToken);
});

test('idempotency service: timeout when pending flight never completes', async () => {
  const storage = new MemoryIdempotencyStorage();
  const service = new IdempotencyService({
    storage,
    lockTtlMs: 10_000,
    pollIntervalMs: 10,
    waitTimeoutMs: 50,
  });

  const first = await service.process('timeout-test');
  assert.equal(first.type, 'leader');

  await assert.rejects(
    service.process('timeout-test'),
    (err: unknown) => err instanceof ApiError && err.status === 504,
  );
});

test('extractIdempotencyKey helper handles various formats', () => {
  assert.equal(extractIdempotencyKey(undefined), undefined);
  assert.equal(extractIdempotencyKey({}), undefined);
  assert.equal(extractIdempotencyKey({ 'idempotency-key': '' }), undefined);
  assert.equal(extractIdempotencyKey({ 'idempotency-key': '  ' }), undefined);
  assert.equal(extractIdempotencyKey({ 'idempotency-key': 'abc' }), 'abc');
  assert.equal(extractIdempotencyKey({ 'idempotency-key': '  xyz  ' }), 'xyz');
  assert.equal(extractIdempotencyKey({ 'x-idempotency-key': 'def' }), 'def');
  assert.equal(extractIdempotencyKey({ 'idempotency-key': ['item-1'] }), 'item-1');
});

test('http route: non-streaming cache hit replays identical response and idempotency-replay header', async (t) => {
  let callCount = 0;
  const mock = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Unique generated response',
    now: () => NOW,
  });
  const originalChat = mock.chat.bind(mock);
  mock.chat = async (req, cred, opts) => {
    callCount++;
    return originalChat(req, cred, opts);
  };

  const app: FastifyInstance = buildServer({
    config,
    provider: mock,
    credential,
    now: () => NOW,
    logger: false,
  });
  t.after(() => app.close());

  const key = 'test-nonstream-key';

  const res1 = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
    payload: validBody,
  });

  assert.equal(res1.statusCode, 200);
  assert.equal(res1.headers['idempotency-replay'], undefined);
  assert.equal(callCount, 1);

  const res2 = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
    payload: validBody,
  });

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.headers['idempotency-replay'], 'true');
  assert.equal(callCount, 1); // Upstream was NOT called again
  assert.deepEqual(res1.json(), res2.json());
});

test('http route: streaming cache hit replays identical SSE chunks and idempotency-replay header', async (t) => {
  let streamCount = 0;
  const mock = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Streamed content payload',
    now: () => NOW,
  });
  const originalStream = mock.stream.bind(mock);
  mock.stream = async function* (req, cred, opts) {
    streamCount++;
    yield* originalStream(req, cred, opts);
  };

  const app: FastifyInstance = buildServer({
    config,
    provider: mock,
    credential,
    now: () => NOW,
    logger: false,
  });
  t.after(() => app.close());

  const key = 'test-stream-key';

  const res1 = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
    payload: { ...validBody, stream: true },
  });

  assert.equal(res1.statusCode, 200);
  assert.equal(res1.headers['idempotency-replay'], undefined);
  assert.match(String(res1.headers['content-type']), /text\/event-stream/);
  assert.equal(streamCount, 1);

  const res2 = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
    payload: { ...validBody, stream: true },
  });

  assert.equal(res2.statusCode, 200);
  assert.equal(res2.headers['idempotency-replay'], 'true');
  assert.match(String(res2.headers['content-type']), /text\/event-stream/);
  assert.equal(streamCount, 1); // Stream called only once
  assert.equal(res1.body, res2.body); // Chunks and [DONE] match identically
});

test('http route: concurrent duplicates await pending flight and single-flight upstream', async (t) => {
  let callCount = 0;
  const mock = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Concurrent response content',
    now: () => NOW,
  });
  const originalChat = mock.chat.bind(mock);
  mock.chat = async (req, cred, opts) => {
    callCount++;
    await sleep(40); // Simulate network latency
    return originalChat(req, cred, opts);
  };

  const app: FastifyInstance = buildServer({
    config,
    provider: mock,
    credential,
    now: () => NOW,
    logger: false,
  });
  t.after(() => app.close());

  const key = 'test-concurrent-key';

  const [resA, resB] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
      payload: validBody,
    }),
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
      payload: validBody,
    }),
  ]);

  assert.equal(resA.statusCode, 200);
  assert.equal(resB.statusCode, 200);
  assert.equal(callCount, 1); // Single-flight!
  assert.deepEqual(resA.json(), resB.json());

  // One response is leader, one is replay
  const replays = [resA.headers['idempotency-replay'], resB.headers['idempotency-replay']];
  assert.ok(replays.includes(undefined));
  assert.ok(replays.includes('true'));
});

test('http route: upstream error releases lock and allows subsequent success', async (t) => {
  let attempts = 0;
  const mock = new MockProviderAdapter({
    id: 'mock',
    model: 'mock-model',
    content: 'Healthy response after error',
    now: () => NOW,
  });
  const originalChat = mock.chat.bind(mock);
  mock.chat = async (req, cred, opts) => {
    attempts++;
    if (attempts === 1) {
      throw new Error('temporary upstream explosion');
    }
    return originalChat(req, cred, opts);
  };

  const app: FastifyInstance = buildServer({
    config,
    provider: mock,
    credential,
    now: () => NOW,
    logger: false,
  });
  t.after(() => app.close());

  const key = 'test-error-release-key';

  const res1 = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
    payload: validBody,
  });

  assert.equal(res1.statusCode, 502);

  // Second request with same key should NOT replay error; it should execute fresh and succeed
  const res2 = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
    payload: validBody,
  });

  assert.equal(res2.statusCode, 200);
  assert.equal(attempts, 2);
  assert.equal(res2.json().choices[0].message.content, 'Healthy response after error');
});
