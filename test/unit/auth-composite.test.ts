import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import { createGatewayKeyAuth } from '../../src/http/middleware/gateway-key-auth';
import { sha256Hex } from '../../src/lib/crypto';
import { signJwt } from '../../src/lib/jwt';
import type { UserModel } from '../../src/models/user';
import type { UserProviderKeyModel } from '../../src/models/user-provider-key';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

const GATEWAY_KEY = 'gk_test';
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
const credential: Credential = {
  id: 'credential-1',
  provider: 'mock',
  secret: 'not-a-real-key',
};

function fakeUserStore(): UserModel {
  return {
    createUser: async () => {
      throw new Error('not used');
    },
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

function fakeProviderKeyStore(): UserProviderKeyModel {
  return {
    createUserProviderKey: async () => {
      throw new Error('not used');
    },
    findByUserIdAndProvider: async () => null,
    findByFingerprint: async () => null,
    updateKey: async () => false,
    listKeys: async () => [],
    getDecryptedKey: async () => null,
    removeKey: async () => false,
  };
}

const gatewayKeyAuth = createGatewayKeyAuth({
  adminToken: config.adminToken,
  findUserByGatewayKey: async (hash) =>
    hash === sha256Hex(GATEWAY_KEY) ? { id: 'u1', username: 'alice' } : null,
});

const jwtCookieAuth = {
  tryAuthenticate: async (req: { headers: { cookie?: string } }) =>
    req.headers.cookie === 'jwt=valid' ? { userId: 'u1', username: 'alice' } : null,
};

function makeApp(): FastifyInstance {
  return buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: fakeUserStore(),
    providerKeyStore: fakeProviderKeyStore(),
    gatewayKeyAuth,
    jwtCookieAuth,
  });
}

test('composite auth: JWT cookie only reaches /v1/user/keys', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/user/keys',
    headers: { cookie: 'jwt=valid' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { keys: [] });
});

test('composite auth: gateway key only reaches /v1/user/keys', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/user/keys',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('composite auth: no credentials -> 401', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/v1/user/keys' });
  assert.equal(res.statusCode, 401, res.body);
});

test('composite auth: admin token never becomes a user on /v1/user/keys', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/user/keys',
    headers: { authorization: `Bearer ${config.adminToken}` },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('composite auth: JWT cookie only is rejected on /v1/chat/completions', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', cookie: 'jwt=valid' },
    payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('composite auth: invalid JWT + invalid gateway key -> 401', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/user/keys',
    headers: { cookie: 'jwt=bad', authorization: 'Bearer gk_wrong' },
  });
  assert.equal(res.statusCode, 401, res.body);
});

test('composite auth: JWT session reaches /v1/user/me with email', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: 'GET',
    url: '/v1/user/me',
    headers: { cookie: 'jwt=valid' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { id: 'u1', username: 'alice', email: 'alice@example.com' });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('composite auth: real signed JWT reaches /v1/user/keys', async (t) => {
  const app = buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: fakeUserStore(),
    providerKeyStore: fakeProviderKeyStore(),
    gatewayKeyAuth,
  });
  t.after(async () => {
    await app.close();
  });

  const token = signJwt({ userId: 'u1', username: 'alice' }, config.jwtSecret!);
  const res = await app.inject({
    method: 'GET',
    url: '/v1/user/keys',
    headers: { cookie: `jwt=${token}` },
  });
  assert.equal(res.statusCode, 200, res.body);

  const tampered = await app.inject({
    method: 'GET',
    url: '/v1/user/keys',
    headers: { cookie: `jwt=${token}tampered` },
  });
  assert.equal(tampered.statusCode, 401, tampered.body);
});

test('composite auth: /v1/user/me without a session -> 401', async (t) => {
  const app = makeApp();
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({ method: 'GET', url: '/v1/user/me' });
  assert.equal(res.statusCode, 401, res.body);
});
