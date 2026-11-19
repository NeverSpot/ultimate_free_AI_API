import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../../src/config/env';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from '../../src/core/types';
import { buildServer } from '../../src/http/server';
import type { UserModel } from '../../src/models/user';
import type {
  NewUserProviderKey,
  UserProviderKey,
  UserProviderKeyModel,
} from '../../src/models/user-provider-key';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential, ModelInfo, ProviderAdapter } from '../../src/providers/types';

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
const SECRET = 'sk-or-stored-secret';

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

/** One pre-seeded openrouter row owned by u1. */
function makeStore(): UserProviderKeyModel {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const row: UserProviderKey = {
    id: 'key-1',
    user_id: 'u1',
    provider: 'openrouter',
    label: 'openrouter',
    ciphertext: Buffer.from('cipher'),
    iv: Buffer.from('iv'),
    auth_tag: Buffer.from('tag'),
    fingerprint: 'fp-1',
    created_at: now,
    updated_at: now,
  };

  return {
    async createUserProviderKey(_key: NewUserProviderKey): Promise<UserProviderKey> {
      return row;
    },
    async findByUserIdAndProvider(userId, providerId) {
      return row.user_id === userId && row.provider === providerId ? row : null;
    },
    async findByFingerprint(fingerprint) {
      return row.fingerprint === fingerprint ? row : null;
    },
    async updateKey() {
      return false;
    },
    async listKeys(userId) {
      return row.user_id === userId ? [row] : [];
    },
    async listKeysByProvider(userId, providerId) {
      return row.user_id === userId && row.provider === providerId ? [row] : [];
    },
    async deleteKeyById() {
      return false;
    },
    async getDecryptedKey(userId, keyId) {
      return userId === row.user_id && keyId === row.id ? SECRET : null;
    },
    async removeKey() {
      return false;
    },
  };
}

interface ChatCall {
  model: string | undefined;
  secret: string;
}

function fakeOpenRouter(calls: ChatCall[], chatError?: unknown): ProviderAdapter {
  return {
    id: 'openrouter',
    supportsStreaming: true,
    async listModels(): Promise<ModelInfo[]> {
      return [{ id: 'free/model', is_free: true }];
    },
    async chat(req: CanonicalRequest, cred: Credential): Promise<CanonicalResponse> {
      calls.push({ model: req.model, secret: cred.secret });
      if (chatError !== undefined) throw chatError;
      return {
        id: 'chatcmpl-test',
        model: req.model ?? 'free/model',
        created: 1_700_000_000,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      };
    },
    stream(): AsyncIterable<CanonicalChunk> {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true as const, value: undefined }),
        }),
      };
    },
  };
}

function makeApp(adapter: ProviderAdapter): ReturnType<typeof buildServer> {
  return buildServer({
    config,
    provider,
    credential,
    adapters: [adapter],
    logger: false,
    userStore: fakeUserStore(),
    providerKeyStore: makeStore(),
    jwtCookieAuth: {
      tryAuthenticate: async (req: { headers: { cookie?: string } }) =>
        req.headers.cookie === 'jwt=valid'
          ? { userId: 'u1', username: 'alice' }
          : req.headers.cookie === 'jwt=other'
            ? { userId: 'u2', username: 'bob' }
            : null,
    },
  });
}

test('POST key test exercises the stored key through its own provider', async (t) => {
  const calls: ChatCall[] = [];
  const app = makeApp(fakeOpenRouter(calls));
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/user/keys/openrouter/key-1/test',
    headers: SESSION,
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    ok: boolean;
    provider: string;
    model: string | null;
    error: string | null;
  };
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'openrouter');
  assert.equal(body.model, 'free/model');
  assert.equal(body.error, null);
  assert.deepEqual(calls, [{ model: 'free/model', secret: SECRET }]);
});

test('POST key test answers 200 with ok:false when the key is rejected upstream', async (t) => {
  const calls: ChatCall[] = [];
  const app = makeApp(
    fakeOpenRouter(
      calls,
      new ProviderError('auth', `invalid key ${SECRET}`, { status: 401, provider: 'openrouter' }),
    ),
  );
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/user/keys/openrouter/key-1/test',
    headers: SESSION,
  });

  assert.equal(response.statusCode, 200, 'the test request succeeded; the key did not');
  const body = response.json() as { ok: boolean; error: string | null; error_kind: string | null };
  assert.equal(body.ok, false);
  assert.equal(body.error_kind, 'auth');
  assert.equal(body.error?.includes(SECRET), false, 'the secret must never be echoed back');
});

test('POST key test refuses a key owned by another user', async (t) => {
  const calls: ChatCall[] = [];
  const app = makeApp(fakeOpenRouter(calls));
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/user/keys/openrouter/key-1/test',
    headers: { cookie: 'jwt=other' },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(calls, []);
});

test('POST key test refuses a provider that does not own the key', async (t) => {
  const calls: ChatCall[] = [];
  const app = makeApp(fakeOpenRouter(calls));
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/user/keys/nvidia/key-1/test',
    headers: SESSION,
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(calls, [], 'a mismatched provider must not spend the key');
});

test('POST key test requires a session', async (t) => {
  const app = makeApp(fakeOpenRouter([]));
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/user/keys/openrouter/key-1/test',
  });

  assert.equal(response.statusCode, 401);
});
