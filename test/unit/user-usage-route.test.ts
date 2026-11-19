import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import type { UsageModel, UsageSummary } from '../../src/models/usage';
import type { UserModel } from '../../src/models/user';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

const config: Config = {
  port: 0,
  adminToken: 'test-admin-token',
  encryptionKey: 'test-master-key-32-chars-minimum!',
  maxBodyBytes: 2 * 1024 * 1024,
  attemptTimeoutMs: 10_000,
  requestDeadlineMs: 30_000,
  logLevel: 'silent',
  nodeEnv: 'test',
  jwtSecret: 'test-secret',
};

const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model' });
const credential: Credential = { id: 'credential-1', provider: 'mock', secret: 'not-a-real-key' };

const SESSION = { cookie: 'jwt=valid' };

function fakeUserStore(): UserModel {
  return {
    createUser: async () => {
      throw new Error('not used');
    },
    createUserWithHash: async () => {
      throw new Error('not used');
    },
    createOAuthUser: async () => {
      throw new Error('not used');
    },
    markEmailVerified: async () => undefined,
    findByUsername: async () => null,
    findByEmail: async () => null,
    findById: async (id: string) =>
      id === 'u1' ? { id: 'u1', username: 'alice', email: 'alice@example.com' } : null,
    findByGatewayApiKeyHash: async () => null,
    verifyPassword: async () => null,
    setGatewayApiKeyHash: async () => {
      throw new Error('not used');
    },
    getGatewayApiKey: async () => 'gk_test-key',
  };
}

const SUMMARY: UsageSummary = {
  window_days: 30,
  requests: 7,
  prompt_tokens: 700,
  completion_tokens: 300,
  total_tokens: 1_000,
  cost_usd: 0.001,
  failovers: 2,
  last_request_at: '2026-01-02T03:04:05.000Z',
};

function fakeUsageStore(calls: string[]): UsageModel {
  return {
    async getUsage(userId: string) {
      calls.push(userId);
      return SUMMARY;
    },
  };
}

function makeApp(usageStore?: UsageModel) {
  return buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: fakeUserStore(),
    ...(usageStore === undefined ? {} : { usageStore }),
    jwtCookieAuth: {
      tryAuthenticate: async (req: { headers: { cookie?: string } }) =>
        req.headers.cookie === 'jwt=valid' ? { userId: 'u1', username: 'alice' } : null,
    },
  });
}

test('GET /v1/user/usage returns the caller’s rolling summary', async (t) => {
  const calls: string[] = [];
  const app = makeApp(fakeUsageStore(calls));
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({ method: 'GET', url: '/v1/user/usage', headers: SESSION });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, ['u1'], 'usage must be read for the authenticated user only');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(response.json(), { usage: SUMMARY });
});

test('GET /v1/user/usage requires a session', async (t) => {
  const calls: string[] = [];
  const app = makeApp(fakeUsageStore(calls));
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({ method: 'GET', url: '/v1/user/usage' });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(calls, [], 'an unauthenticated request must never reach the store');
});

test('GET /v1/user/usage is absent when accounting is not wired', async (t) => {
  const app = makeApp(undefined);
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({ method: 'GET', url: '/v1/user/usage', headers: SESSION });

  assert.equal(response.statusCode, 404, 'no store means 404, not invented zeros');
});
