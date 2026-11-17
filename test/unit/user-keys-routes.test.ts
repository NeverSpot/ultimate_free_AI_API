import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';
import type { UserModel } from '../../src/models/user';
import type {
  NewUserProviderKey,
  UserProviderKey,
  UserProviderKeyModel,
} from '../../src/models/user-provider-key';

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

/**
 * An in-memory store that really stores. The route's behaviour *is* the append,
 * so a stub returning canned rows could not tell "appended" from "replaced" —
 * the exact distinction this task exists to make.
 */
function makeMemoryStore(): { store: UserProviderKeyModel; rows: UserProviderKey[] } {
  const rows: UserProviderKey[] = [];
  let counter = 0;

  const store: UserProviderKeyModel = {
    async createUserProviderKey(key: NewUserProviderKey): Promise<UserProviderKey> {
      counter += 1;
      const now = new Date();
      const row: UserProviderKey = {
        id: `key-${counter}`,
        user_id: key.user_id,
        provider: key.provider,
        label: key.label ?? key.provider,
        ciphertext: key.ciphertext,
        iv: key.iv,
        auth_tag: key.auth_tag,
        fingerprint: key.fingerprint,
        created_at: now,
        updated_at: now,
      };
      rows.push(row);
      return row;
    },
    async findByUserIdAndProvider(userId, providerId) {
      return rows.find((r) => r.user_id === userId && r.provider === providerId) ?? null;
    },
    async findByFingerprint(fingerprint) {
      return rows.find((r) => r.fingerprint === fingerprint) ?? null;
    },
    async updateKey() {
      return false;
    },
    async listKeys(userId) {
      return rows.filter((r) => r.user_id === userId);
    },
    async listKeysByProvider(userId, providerId) {
      return rows.filter((r) => r.user_id === userId && r.provider === providerId);
    },
    async deleteKeyById(userId, keyId) {
      const index = rows.findIndex((r) => r.user_id === userId && r.id === keyId);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
    async getDecryptedKey() {
      return null;
    },
    async removeKey(userId, providerId) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row && row.user_id === userId && row.provider === providerId) rows.splice(i, 1);
      }
      return rows.length !== before;
    },
  };

  return { store, rows };
}

function makeApp(store: UserProviderKeyModel, userId = 'u1'): FastifyInstance {
  return buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: fakeUserStore(),
    providerKeyStore: store,
    jwtCookieAuth: {
      tryAuthenticate: async (req: { headers: { cookie?: string } }) =>
        req.headers.cookie === 'jwt=valid' ? { userId, username: 'alice' } : null,
    },
  });
}

const SESSION = { cookie: 'jwt=valid' };

test('POST /v1/user/keys appends a second key for the same provider', async (t) => {
  const { store, rows } = makeMemoryStore();
  const app = makeApp(store);
  t.after(async () => {
    await app.close();
  });

  const first = await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-first' },
  });
  const second = await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-second' },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(rows.length, 2, 'the second key must append, not replace');

  const listed = await app.inject({ method: 'GET', url: '/v1/user/keys', headers: SESSION });
  const body = listed.json() as { keys: { id: string; provider: string; label: string }[] };
  assert.equal(body.keys.length, 2);
  assert.equal(new Set(body.keys.map((k) => k.id)).size, 2, 'each key needs its own id');
});

test('POST /v1/user/keys rejects the same key twice with 409', async (t) => {
  const { store, rows } = makeMemoryStore();
  const app = makeApp(store);
  t.after(async () => {
    await app.close();
  });

  const payload = { provider: 'openrouter', providerKey: 'sk-or-duplicate' };
  const first = await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload,
  });
  const second = await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload,
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409, 'a duplicate must be a conflict, not a silent replace');
  assert.equal(rows.length, 1, 'the duplicate must not create a second row');
});

test('POST /v1/user/keys accepts two different users holding the same secret', async (t) => {
  const { store, rows } = makeMemoryStore();
  const appA = makeApp(store, 'u1');
  const appB = makeApp(store, 'u2');
  t.after(async () => {
    await appA.close();
    await appB.close();
  });

  // The same secret from two users. The fingerprint is user-scoped, so the second
  // insert must not collide on the unique index.
  const payload = { provider: 'openrouter', providerKey: 'sk-or-shared' };
  const first = await appA.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload,
  });
  const second = await appB.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload,
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200, 'a second user must be able to register the same secret');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.user_id).sort(), ['u1', 'u2']);
});
