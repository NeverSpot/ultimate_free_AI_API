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

function makeApp(
  store: UserProviderKeyModel,
  userId = 'u1',
  isParked?: (credentialId: string) => Promise<{ parked: boolean; retryAfterMs: number }>,
): FastifyInstance {
  return buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: fakeUserStore(),
    providerKeyStore: store,
    ...(isParked === undefined ? {} : { isParked }),
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

test('DELETE /v1/user/keys/:provider/:keyId removes exactly one key', async (t) => {
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
  await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-second' },
  });

  const doomedId = (first.json() as { id: string }).id;
  const survivors = rows.filter((row) => row.id !== doomedId);
  assert.equal(survivors.length, 1);
  const survivor = survivors[0];
  assert.ok(survivor, 'the second key must still exist');

  const deleted = await app.inject({
    method: 'DELETE',
    url: `/v1/user/keys/openrouter/${doomedId}`,
    headers: SESSION,
  });
  assert.equal(deleted.statusCode, 200);

  const listed = await app.inject({ method: 'GET', url: '/v1/user/keys', headers: SESSION });
  const body = listed.json() as { keys: { id: string }[] };
  assert.equal(body.keys.length, 1, 'exactly one key must be removed');
  assert.equal(body.keys[0]?.id, survivor.id);
});

test('DELETE /v1/user/keys/:provider/:keyId cannot delete another user key', async (t) => {
  const { store, rows } = makeMemoryStore();
  const appA = makeApp(store, 'u1');
  const appB = makeApp(store, 'u2');
  t.after(async () => {
    await appA.close();
    await appB.close();
  });

  const created = await appA.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-owned-by-u1' },
  });
  const keyId = (created.json() as { id: string }).id;

  const blocked = await appB.inject({
    method: 'DELETE',
    url: `/v1/user/keys/openrouter/${keyId}`,
    headers: SESSION,
  });

  assert.equal(blocked.statusCode, 404, "another user's key must not be deletable");
  assert.equal(rows.length, 1, "the owner's key must survive");

  // The owner can delete it — without this, a 404 from a missing route would
  // satisfy the assertion above for the wrong reason.
  const allowed = await appA.inject({
    method: 'DELETE',
    url: `/v1/user/keys/openrouter/${keyId}`,
    headers: SESSION,
  });
  assert.equal(allowed.statusCode, 200, 'the owner must be able to delete their own key');
  assert.equal(rows.length, 0);
});

test('GET /v1/user/keys reports parked keys with a retry after', async (t) => {
  const { store } = makeMemoryStore();
  const app = makeApp(store, 'u1', async (credentialId) =>
    credentialId === 'key-1'
      ? { parked: true, retryAfterMs: 900_000 }
      : { parked: false, retryAfterMs: 0 },
  );
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-a' },
  });

  const listed = await app.inject({ method: 'GET', url: '/v1/user/keys', headers: SESSION });
  assert.equal(listed.statusCode, 200);
  const body = listed.json() as {
    keys: { id: string; parked: boolean; retry_after_ms: number }[];
  };
  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0]?.parked, true);
  assert.equal(body.keys[0]?.retry_after_ms, 900_000);
});

test('GET /v1/user/keys returns 200 when no parking instance is wired', async (t) => {
  const { store } = makeMemoryStore();
  // No `isParked` and no `parking`: the route must degrade, not throw. This is the
  // real deployment risk — `configureParking` has no caller, so the module-level
  // helper always throws and must never be reached from here.
  const app = makeApp(store);
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-a' },
  });

  const listed = await app.inject({ method: 'GET', url: '/v1/user/keys', headers: SESSION });
  assert.equal(listed.statusCode, 200, 'a missing parking instance must not 500 the keys list');
  const body = listed.json() as { keys: { parked: boolean; retry_after_ms: number }[] };
  assert.equal(body.keys[0]?.parked, false);
  assert.equal(body.keys[0]?.retry_after_ms, 0);
});

test('GET /v1/user/keys reads health from the parking instance the server was given', async (t) => {
  const { store } = makeMemoryStore();
  const parkedIds = new Set(['key-1']);
  const app = buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: fakeUserStore(),
    providerKeyStore: store,
    // The composition path, not a bespoke isParked callback: production must get
    // its reader from the same parking the router uses, or the display is inert.
    parking: {
      park: async () => {},
      unpark: async () => {},
      applyDecision: async () => {},
      isParked: async (credentialId: string) => ({
        parked: parkedIds.has(credentialId),
        retryAfterMs: parkedIds.has(credentialId) ? 900_000 : 0,
      }),
    },
    jwtCookieAuth: {
      tryAuthenticate: async (req: { headers: { cookie?: string } }) =>
        req.headers.cookie === 'jwt=valid' ? { userId: 'u1', username: 'alice' } : null,
    },
  });
  t.after(async () => {
    await app.close();
  });

  await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-a' },
  });

  const listed = await app.inject({ method: 'GET', url: '/v1/user/keys', headers: SESSION });
  assert.equal(listed.statusCode, 200);
  const body = listed.json() as { keys: { id: string; parked: boolean; retry_after_ms: number }[] };
  assert.equal(body.keys[0]?.parked, true, 'the wired parking instance must reach the keys list');
  assert.equal(body.keys[0]?.retry_after_ms, 900_000);
});

test('POST /v1/user/keys maps a concurrent unique violation to 409', async (t) => {
  const { store } = makeMemoryStore();
  // Two simultaneous submissions both pass the pre-check, so the second INSERT is
  // what collides. Postgres reports that as SQLSTATE 23505, not an ApiError.
  store.findByFingerprint = async () => null;
  store.createUserProviderKey = async () => {
    const error = new Error(
      'duplicate key value violates unique constraint "idx_user_provider_keys_fingerprint"',
    ) as Error & { code?: string };
    error.code = '23505';
    throw error;
  };

  const app = makeApp(store);
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/user/keys',
    headers: SESSION,
    payload: { provider: 'openrouter', providerKey: 'sk-or-race' },
  });

  assert.equal(response.statusCode, 409, 'a lost race is a conflict, not a 500');
});
