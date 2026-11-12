import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import type { Config } from '../../src/config/env';
import {
  createRedisIdempotencyService,
  idempotencyLockKey,
  idempotencyResultKey,
} from '../../src/http/middleware/idempotency';
import { buildServer } from '../../src/http/server';
import { createLedgerClient, type LedgerClient } from '../../src/limits/redis';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

/**
 * Real Redis only. `npm test` never sets REDIS_URL, so this suite reports as skipped
 * inside `npm run verify`; `npm run test:int` runs it with Redis up.
 */
const redisUrl = process.env.REDIS_URL?.trim() ?? '';
const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn
  ? 'RUN_INTEGRATION !== 1'
  : redisUrl.length === 0
    ? 'REDIS_URL is not set'
    : false;

function isolatedRedisUrl(url: string): string {
  const parsed = new URL(url);
  const current = Number(parsed.pathname.replace(/^\//, '') || '0');
  parsed.pathname = `/${Number.isInteger(current) && current >= 0 ? current + 3 : 3}`;
  return parsed.toString();
}

const testRedisUrl = redisUrl.length === 0 ? redisUrl : isolatedRedisUrl(redisUrl);

const NOW = 1_731_250_000_000;

const config: Config = {
  port: 0,
  adminToken: 'test-admin-token',
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

describe('idempotency keys (redis)', { skip }, () => {
  let redis: Redis;
  let client: LedgerClient;

  before(async () => {
    redis = new Redis(testRedisUrl);
    await redis.ping();
    client = createLedgerClient(testRedisUrl);
  });

  after(async () => {
    client?.disconnect();
    await redis?.quit();
  });

  it('same key twice = 1 upstream call, 2 identical responses (non-streaming)', async () => {
    let callCount = 0;
    const mock = new MockProviderAdapter({
      id: 'mock',
      model: 'mock-model',
      content: 'Redis non-streaming idempotency test',
      now: () => NOW,
    });
    const originalChat = mock.chat.bind(mock);
    mock.chat = async (req, cred, opts) => {
      callCount++;
      return originalChat(req, cred, opts);
    };

    const idempotencyService = createRedisIdempotencyService(client);
    const app: FastifyInstance = buildServer({
      config,
      provider: mock,
      credential,
      now: () => NOW,
      logger: false,
      idempotencyService,
    });

    const key = `redis-idem-${randomUUID()}`;

    try {
      // First request: hits upstream
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
        payload: validBody,
      });

      assert.equal(res1.statusCode, 200);
      assert.equal(res1.headers['idempotency-replay'], undefined);
      assert.equal(callCount, 1);

      // Verify stored in Redis
      const storedJson = await redis.get(idempotencyResultKey(key));
      assert.ok(storedJson, 'response must be cached in Redis');

      // Second request: replayed from Redis
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
        payload: validBody,
      });

      assert.equal(res2.statusCode, 200);
      assert.equal(res2.headers['idempotency-replay'], 'true');
      assert.equal(callCount, 1, 'upstream must be called exactly once');
      assert.deepEqual(res1.json(), res2.json(), 'responses must be identical');
    } finally {
      await app.close();
      await redis.del(idempotencyLockKey(key), idempotencyResultKey(key));
    }
  });

  it('same key twice = 1 upstream call, 2 identical responses (streaming)', async () => {
    let streamCount = 0;
    const mock = new MockProviderAdapter({
      id: 'mock',
      model: 'mock-model',
      content: 'Redis streaming idempotency response',
      now: () => NOW,
    });
    const originalStream = mock.stream.bind(mock);
    mock.stream = async function* (req, cred, opts) {
      streamCount++;
      yield* originalStream(req, cred, opts);
    };

    const idempotencyService = createRedisIdempotencyService(client);
    const app: FastifyInstance = buildServer({
      config,
      provider: mock,
      credential,
      now: () => NOW,
      logger: false,
      idempotencyService,
    });

    const key = `redis-stream-${randomUUID()}`;

    try {
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

      // Replay streaming request
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
        payload: { ...validBody, stream: true },
      });

      assert.equal(res2.statusCode, 200);
      assert.equal(res2.headers['idempotency-replay'], 'true');
      assert.match(String(res2.headers['content-type']), /text\/event-stream/);
      assert.equal(streamCount, 1, 'upstream stream must be called exactly once');
      assert.equal(res1.body, res2.body, 'replayed stream chunks must match identically');
    } finally {
      await app.close();
      await redis.del(idempotencyLockKey(key), idempotencyResultKey(key));
    }
  });

  it('concurrent duplicates await single-flight lock in Redis and share response', async () => {
    let callCount = 0;
    const mock = new MockProviderAdapter({
      id: 'mock',
      model: 'mock-model',
      content: 'Concurrent Redis content',
      now: () => NOW,
    });
    const originalChat = mock.chat.bind(mock);
    mock.chat = async (req, cred, opts) => {
      callCount++;
      await sleep(50); // Simulate network latency
      return originalChat(req, cred, opts);
    };

    const idempotencyService = createRedisIdempotencyService(client, { pollIntervalMs: 15 });
    const app: FastifyInstance = buildServer({
      config,
      provider: mock,
      credential,
      now: () => NOW,
      logger: false,
      idempotencyService,
    });

    const key = `redis-concurrent-${randomUUID()}`;

    try {
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
      assert.equal(callCount, 1, 'concurrent requests must result in exactly 1 upstream call');
      assert.deepEqual(resA.json(), resB.json(), 'concurrent responses must be identical');

      const replays = [resA.headers['idempotency-replay'], resB.headers['idempotency-replay']];
      assert.ok(replays.includes(undefined));
      assert.ok(replays.includes('true'));
    } finally {
      await app.close();
      await redis.del(idempotencyLockKey(key), idempotencyResultKey(key));
    }
  });

  it('upstream failure in Redis releases single-flight lock and allows retry', async () => {
    let attempts = 0;
    const mock = new MockProviderAdapter({
      id: 'mock',
      model: 'mock-model',
      content: 'Success after Redis error release',
      now: () => NOW,
    });
    const originalChat = mock.chat.bind(mock);
    mock.chat = async (req, cred, opts) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('transient upstream error');
      }
      return originalChat(req, cred, opts);
    };

    const idempotencyService = createRedisIdempotencyService(client);
    const app: FastifyInstance = buildServer({
      config,
      provider: mock,
      credential,
      now: () => NOW,
      logger: false,
      idempotencyService,
    });

    const key = `redis-err-release-${randomUUID()}`;

    try {
      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
        payload: validBody,
      });

      assert.equal(res1.statusCode, 502);

      // Assert lock was released in Redis
      const lockVal = await redis.get(idempotencyLockKey(key));
      assert.equal(lockVal, null, 'lock must be deleted on error');

      // Subsequent attempt with same key succeeds
      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authorized },
        payload: validBody,
      });

      assert.equal(res2.statusCode, 200);
      assert.equal(attempts, 2);
      assert.equal(res2.json().choices[0].message.content, 'Success after Redis error release');
    } finally {
      await app.close();
      await redis.del(idempotencyLockKey(key), idempotencyResultKey(key));
    }
  });
});
