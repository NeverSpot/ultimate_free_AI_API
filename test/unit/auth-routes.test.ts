import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import type { NewUser, User, UserModel } from '../../src/models/user';
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
const credential: Credential = {
  id: 'credential-1',
  provider: 'mock',
  secret: 'not-a-real-key',
};

/** In-memory stand-in for `createUserModel`: no database, no scrypt. */
function createFakeUserStore(): UserModel {
  const usersByName = new Map<string, User>();
  const passwords = new Map<string, string>();
  // Stand-in for the AES-encrypted column: the fake store keeps the plaintext so
  // it can model "login re-issues the same key".
  const plaintextByUserId = new Map<string, string>();

  async function findByUsername(username: string): Promise<User | null> {
    return usersByName.get(username) ?? null;
  }

  async function findByEmail(email: string): Promise<User | null> {
    for (const user of usersByName.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async function findById(
    userId: string,
  ): Promise<{ id: string; username: string; email: string } | null> {
    for (const user of usersByName.values()) {
      if (user.id === userId) {
        return { id: user.id, username: user.username, email: user.email };
      }
    }
    return null;
  }

  async function createUser({
    username,
    email,
    password,
  }: NewUser): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    if (usersByName.has(username) || (await findByEmail(email)) !== null) {
      throw new Error('duplicate user');
    }
    const gatewayApiKeyPlaintext = `gk_${randomBytes(32).toString('hex')}`;
    const user: User = {
      id: randomUUID(),
      username,
      email,
      password_hash: 'fake-hash',
      gateway_api_key_hash: `hash_${gatewayApiKeyPlaintext}`,
      created_at: new Date(),
    };
    usersByName.set(username, user);
    passwords.set(username, password);
    return { user, gatewayApiKeyPlaintext };
  }

  async function findByGatewayApiKeyHash(
    gatewayApiKeyHash: string,
  ): Promise<{ id: string; username: string } | null> {
    for (const user of usersByName.values()) {
      if (user.gateway_api_key_hash === gatewayApiKeyHash) {
        return { id: user.id, username: user.username };
      }
    }
    return null;
  }

  async function verifyPassword(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string; email: string } | null> {
    const user = usersByName.get(username);
    if (!user || passwords.get(username) !== password) return null;
    return { id: user.id, username: user.username, email: user.email };
  }

  async function setGatewayApiKeyHash(userId: string): Promise<string> {
    for (const user of usersByName.values()) {
      if (user.id !== userId) continue;
      const newPlaintext = `gk_${randomBytes(32).toString('hex')}`;
      user.gateway_api_key_hash = `hash_${newPlaintext}`;
      plaintextByUserId.set(userId, newPlaintext);
      return newPlaintext;
    }
    throw new Error('setGatewayApiKeyHash: user not found');
  }

  async function getOrCreateGatewayApiKey(userId: string): Promise<string | null> {
    const exists = [...usersByName.values()].some((user) => user.id === userId);
    if (!exists) {
      return null;
    }
    return plaintextByUserId.get(userId) ?? (await setGatewayApiKeyHash(userId));
  }

  return {
    createUser,
    findByUsername,
    findByEmail,
    findById,
    findByGatewayApiKeyHash,
    verifyPassword,
    setGatewayApiKeyHash,
    getOrCreateGatewayApiKey,
  };
}

function makeApp(userStore?: UserModel): FastifyInstance {
  return buildServer({ config, provider, credential, logger: false, userStore });
}

function post(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: payload as string,
  });
}

describe('POST /v1/auth/register', () => {
  test('returns 201 with the user and a gateway API key', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      const res = await post(app, '/v1/auth/register', {
        username: 'alice',
        email: 'alice@example.com',
        password: 'password123',
      });

      assert.equal(res.statusCode, 201, res.body);
      const body = res.json();
      assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'username']);
      assert.equal(body.user.username, 'alice');
      assert.equal(body.user.email, 'alice@example.com');
      assert.match(body.gateway_api_key, /^gk_[0-9a-f]{64}$/);

      const cookie = res.headers['set-cookie'];
      assert.equal(typeof cookie, 'string');
      assert.match(String(cookie), /^jwt=/);
      assert.match(String(cookie), /HttpOnly/);
      assert.match(String(cookie), /SameSite=Strict/);

      const me = await app.inject({
        method: 'GET',
        url: '/v1/user/me',
        headers: { cookie: String(cookie).split(';')[0] },
      });
      assert.equal(me.statusCode, 200, me.body);
      assert.deepEqual(me.json(), {
        id: body.user.id,
        username: 'alice',
        email: 'alice@example.com',
      });
    } finally {
      await app.close();
    }
  });

  test('rejects a duplicate username with 409', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      const first = await post(app, '/v1/auth/register', {
        username: 'bob',
        email: 'bob@example.com',
        password: 'password123',
      });
      assert.equal(first.statusCode, 201);

      const second = await post(app, '/v1/auth/register', {
        username: 'bob',
        email: 'other@example.com',
        password: 'password123',
      });
      assert.equal(second.statusCode, 409, second.body);
    } finally {
      await app.close();
    }
  });

  test('rejects a JSON null body with 400, not 500', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      const res = await post(app, '/v1/auth/register', 'null');
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error.code, 'invalid_request');
    } finally {
      await app.close();
    }
  });

  test('rejects missing fields with 400', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      const res = await post(app, '/v1/auth/register', { username: 'carol' });
      assert.equal(res.statusCode, 400, res.body);
    } finally {
      await app.close();
    }
  });

  test('fails at startup, not at request time, when production has no user store', () => {
    assert.throws(
      () =>
        buildServer({
          config: { ...config, nodeEnv: 'production' },
          provider,
          credential,
          logger: false,
        }),
      /userStore is required/,
    );
  });
});

describe('POST /v1/auth/login and /v1/auth/regenerate-key', () => {
  test('login re-issues the same gateway key on every login', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      await post(app, '/v1/auth/register', {
        username: 'dave',
        email: 'dave@example.com',
        password: 'password123',
      });

      const first = await post(app, '/v1/auth/login', {
        username: 'dave',
        password: 'password123',
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().username, 'dave');
      assert.match(String(first.json().gateway_api_key), /^gk_/);
      assert.match(String(first.headers['set-cookie']), /^jwt=.*HttpOnly/);

      // Logging in again must hand back the identical key, not a rotated one.
      const second = await post(app, '/v1/auth/login', {
        username: 'dave',
        password: 'password123',
      });
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().gateway_api_key, first.json().gateway_api_key);

      const bad = await post(app, '/v1/auth/login', {
        username: 'dave',
        password: 'wrong-password',
      });
      assert.equal(bad.statusCode, 401, bad.body);
    } finally {
      await app.close();
    }
  });

  test('regenerate-key issues a fresh key for the right password only', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      const registered = await post(app, '/v1/auth/register', {
        username: 'erin',
        email: 'erin@example.com',
        password: 'password123',
      });
      const originalKey = registered.json().gateway_api_key as string;

      const regenerated = await post(app, '/v1/auth/regenerate-key', {
        username: 'erin',
        password: 'password123',
      });
      assert.equal(regenerated.statusCode, 200, regenerated.body);
      assert.match(regenerated.json().gateway_api_key, /^gk_[0-9a-f]{64}$/);
      assert.notEqual(regenerated.json().gateway_api_key, originalKey);

      const rejected = await post(app, '/v1/auth/regenerate-key', {
        username: 'erin',
        password: 'wrong-password',
      });
      assert.equal(rejected.statusCode, 401, rejected.body);
    } finally {
      await app.close();
    }
  });

  test('logout clears the session cookie', async () => {
    const app = makeApp(createFakeUserStore());
    try {
      const res = await post(app, '/v1/auth/logout', {});
      assert.equal(res.statusCode, 200, res.body);
      const cookie = String(res.headers['set-cookie']);
      assert.match(cookie, /^jwt=;/);
      assert.match(cookie, /Max-Age=0/);
      assert.match(cookie, /HttpOnly/);
    } finally {
      await app.close();
    }
  });
});
