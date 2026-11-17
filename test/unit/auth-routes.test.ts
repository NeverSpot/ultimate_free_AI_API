import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import type { NewUser, User, UserModel } from '../../src/models/user';
import type {
  EmailVerificationModel,
  PendingVerification,
  StartVerificationInput,
} from '../../src/models/email-verification';
import type { Mailer, MailMessage } from '../../src/lib/mailer';
import { verifyPassword as verifyScrypt } from '../../src/lib/crypto';
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
  otpPepper: 'test-otp-pepper',
};

const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model' });
const credential: Credential = {
  id: 'credential-1',
  provider: 'mock',
  secret: 'not-a-real-key',
};

/** In-memory stand-in for `createUserModel`: no database, no scrypt. */
function createFakeUserStore(options: { legacyUsernames?: Iterable<string> } = {}): UserModel {
  const legacyUsernames = new Set(options.legacyUsernames ?? []);
  const usersByName = new Map<string, User>();
  const passwords = new Map<string, string>();
  // Stand-in for the AES-encrypted column: the fake store keeps the plaintext so
  // it can model "login re-issues the same key".
  const plaintextByUserId = new Map<string, string>();

  function findByEmailSync(email: string): User | null {
    for (const user of usersByName.values()) {
      if (user.email.toLowerCase() === email.toLowerCase()) return user;
    }
    return null;
  }

  async function findByUsername(username: string): Promise<User | null> {
    return usersByName.get(username) ?? null;
  }

  async function findByEmail(email: string): Promise<User | null> {
    return findByEmailSync(email);
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

  function insertUser(input: {
    username: string;
    email: string;
    passwordHash: string | null;
    password?: string;
  }): { user: User; gatewayApiKeyPlaintext: string } {
    if (usersByName.has(input.username) || findByEmailSync(input.email) !== null) {
      throw new Error('duplicate user');
    }
    const gatewayApiKeyPlaintext = `gk_${randomBytes(32).toString('hex')}`;
    const user: User = {
      id: randomUUID(),
      username: input.username,
      email: input.email,
      password_hash: input.passwordHash,
      gateway_api_key_hash: `hash_${gatewayApiKeyPlaintext}`,
      created_at: new Date(),
    };
    // A legacy row has the hash but no recoverable copy, like users created
    // before migration 039.
    if (!legacyUsernames.has(input.username)) {
      plaintextByUserId.set(user.id, gatewayApiKeyPlaintext);
    }
    usersByName.set(input.username, user);
    if (input.password !== undefined) {
      passwords.set(input.username, input.password);
    }
    return { user, gatewayApiKeyPlaintext };
  }

  async function createUser({ username, email, password }: NewUser): Promise<{
    user: User;
    gatewayApiKeyPlaintext: string;
  }> {
    if (usersByName.has(username) || (await findByEmail(email)) !== null) {
      throw new Error('duplicate user');
    }
    return insertUser({ username, email, passwordHash: 'fake-hash', password });
  }

  async function createUserWithHash(input: {
    username: string;
    email: string;
    passwordHash: string;
  }): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    if (usersByName.has(input.username) || (await findByEmail(input.email)) !== null) {
      throw new Error('duplicate user');
    }
    return insertUser(input);
  }

  async function createOAuthUser(input: {
    username: string;
    email: string;
  }): Promise<{ user: User; gatewayApiKeyPlaintext: string }> {
    if (usersByName.has(input.username) || (await findByEmail(input.email)) !== null) {
      throw new Error('duplicate user');
    }
    return insertUser({ ...input, passwordHash: null });
  }

  async function markEmailVerified(): Promise<void> {
    // No-op: the fake has no verified column.
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
    // OAuth-only rows have a null hash and must never authenticate by password.
    if (!user || user.password_hash === null) return null;
    // The OTP route stores a real scrypt hash, so verify it rather than replaying
    // a plaintext copy that production never keeps.
    const ok =
      user.password_hash === 'fake-hash'
        ? passwords.get(username) === password
        : await verifyScrypt(password, user.password_hash);
    return ok ? { id: user.id, username: user.username, email: user.email } : null;
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

  async function getGatewayApiKey(userId: string): Promise<string | null> {
    return plaintextByUserId.get(userId) ?? null;
  }

  return {
    createUser,
    createUserWithHash,
    createOAuthUser,
    findByUsername,
    findByEmail,
    findById,
    findByGatewayApiKeyHash,
    verifyPassword,
    markEmailVerified,
    setGatewayApiKeyHash,
    getGatewayApiKey,
  };
}

interface FakeVerificationStore extends EmailVerificationModel {
  rows: Map<string, PendingVerification>;
}

/** Mirrors the SQL semantics the routes depend on: atomic cooldown + attempt counter. */
function createFakeVerificationStore(): FakeVerificationStore {
  const rows = new Map<string, PendingVerification>();
  const now = (): number => Date.now();

  async function start(input: StartVerificationInput): Promise<{ expiresAt: Date } | null> {
    const existing = rows.get(input.email);
    if (
      existing !== undefined &&
      now() - existing.last_sent_at.getTime() < input.cooldownSeconds * 1000
    ) {
      return null;
    }
    const expiresAt = new Date(now() + input.ttlSeconds * 1000);
    rows.set(input.email, {
      email: input.email,
      username: input.username,
      password_hash: input.passwordHash,
      code_hash: input.codeHash,
      attempts: 0,
      expires_at: expiresAt,
      last_sent_at: new Date(),
    });
    return { expiresAt };
  }

  async function resend(input: {
    email: string;
    codeHash: string;
    ttlSeconds: number;
    cooldownSeconds: number;
  }): Promise<{ expiresAt: Date } | null> {
    const existing = rows.get(input.email);
    if (existing === undefined) return null;
    if (now() - existing.last_sent_at.getTime() < input.cooldownSeconds * 1000) return null;
    const expiresAt = new Date(now() + input.ttlSeconds * 1000);
    existing.code_hash = input.codeHash;
    existing.attempts = 0;
    existing.expires_at = expiresAt;
    existing.last_sent_at = new Date();
    return { expiresAt };
  }

  async function find(email: string): Promise<PendingVerification | null> {
    return rows.get(email) ?? null;
  }

  async function recordFailure(email: string): Promise<number> {
    const row = rows.get(email);
    if (row === undefined) return 0;
    row.attempts += 1;
    return row.attempts;
  }

  async function remove(email: string): Promise<void> {
    rows.delete(email);
  }

  async function purgeExpired(): Promise<number> {
    return 0;
  }

  return { start, resend, find, recordFailure, remove, purgeExpired, rows };
}

interface FakeMailer extends Mailer {
  sent: MailMessage[];
  codeFor(email: string): string | undefined;
}

/** Captures the six-digit code out of the subject, exactly as a human would read it. */
function createFakeMailer(): FakeMailer {
  const sent: MailMessage[] = [];
  const codes = new Map<string, string>();

  return {
    transport: 'console',
    sent,
    codeFor: (email) => codes.get(email.toLowerCase()),
    async send(message) {
      sent.push(message);
      const match = /^(\d{6})\b/.exec(message.subject);
      if (match?.[1]) codes.set(message.to.toLowerCase(), match[1]);
    },
  };
}

interface Harness {
  app: FastifyInstance;
  mailer: FakeMailer;
  verifications: FakeVerificationStore;
}

function makeHarness(userStore?: UserModel): Harness {
  const mailer = createFakeMailer();
  const verifications = createFakeVerificationStore();
  const app = buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore,
    mailer,
    emailVerificationStore: verifications,
  });
  return { app, mailer, verifications };
}

function post(app: FastifyInstance, url: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: payload as string,
  });
}

/** Drive the two-step signup the way the UI does: start, read the mail, verify. */
async function register(
  harness: Harness,
  input: { username: string; email: string; password: string },
) {
  const start = await post(harness.app, '/v1/auth/register', input);
  const code = harness.mailer.codeFor(input.email);
  const verify =
    code === undefined
      ? null
      : await post(harness.app, '/v1/auth/register/verify', { email: input.email, code });
  return { start, verify };
}

describe('POST /v1/auth/register (email OTP)', () => {
  test('sends a code, creates nothing yet, then 201 with the user and gateway key', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const start = await post(harness.app, '/v1/auth/register', {
        username: 'alice',
        email: 'Alice@Example.com',
        password: 'password123',
      });

      assert.equal(start.statusCode, 202, start.body);
      assert.deepEqual(start.json(), {
        otp_required: true,
        email: 'alice@example.com',
        expires_in_seconds: 600,
      });
      assert.equal(harness.mailer.sent.length, 1);
      assert.match(harness.mailer.sent[0]?.text ?? '', /verification code is \d{6}/);

      // Nothing is created (and no session issued) before the code is accepted.
      const tooEarly = await post(harness.app, '/v1/auth/login', {
        username: 'alice',
        password: 'password123',
      });
      assert.equal(tooEarly.statusCode, 401, tooEarly.body);

      const code = harness.mailer.codeFor('alice@example.com');
      assert.match(String(code), /^\d{6}$/);
      const verify = await post(harness.app, '/v1/auth/register/verify', {
        email: 'alice@example.com',
        code,
      });

      assert.equal(verify.statusCode, 201, verify.body);
      const body = verify.json();
      assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'username']);
      assert.equal(body.user.username, 'alice');
      assert.equal(body.user.email, 'alice@example.com');
      assert.match(body.gateway_api_key, /^gk_[0-9a-f]{64}$/);

      const cookie = verify.headers['set-cookie'];
      assert.equal(typeof cookie, 'string');
      assert.match(String(cookie), /^jwt=/);
      assert.match(String(cookie), /HttpOnly/);
      assert.match(String(cookie), /SameSite=Strict/);

      const me = await harness.app.inject({
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

      // The pending row is consumed, so the same code cannot be replayed.
      const replay = await post(harness.app, '/v1/auth/register/verify', {
        email: 'alice@example.com',
        code,
      });
      assert.equal(replay.statusCode, 400, replay.body);
    } finally {
      await harness.app.close();
    }
  });

  test('never echoes the code unless dev return is enabled', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const res = await post(harness.app, '/v1/auth/register', {
        username: 'grace',
        email: 'grace@example.com',
        password: 'password123',
      });
      assert.equal(res.statusCode, 202, res.body);
      assert.equal(res.json().dev_code, undefined);
    } finally {
      await harness.app.close();
    }
  });

  test('rejects a wrong code with the remaining attempt count', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      await post(harness.app, '/v1/auth/register', {
        username: 'bob',
        email: 'bob@example.com',
        password: 'password123',
      });

      const wrong = await post(harness.app, '/v1/auth/register/verify', {
        email: 'bob@example.com',
        code: '000000',
      });
      assert.equal(wrong.statusCode, 400, wrong.body);
      assert.match(wrong.json().error.message, /4 attempts left/);

      // A correct code still works after one typo.
      const code = harness.mailer.codeFor('bob@example.com');
      const ok = await post(harness.app, '/v1/auth/register/verify', {
        email: 'bob@example.com',
        code,
      });
      assert.equal(ok.statusCode, 201, ok.body);
    } finally {
      await harness.app.close();
    }
  });

  test('locks the pending code after the attempt budget is spent', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      await post(harness.app, '/v1/auth/register', {
        username: 'mallory',
        email: 'mallory@example.com',
        password: 'password123',
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await post(harness.app, '/v1/auth/register/verify', {
          email: 'mallory@example.com',
          code: '111111',
        });
      }
      const code = harness.mailer.codeFor('mallory@example.com');
      const locked = await post(harness.app, '/v1/auth/register/verify', {
        email: 'mallory@example.com',
        code,
      });
      assert.equal(locked.statusCode, 429, locked.body);
    } finally {
      await harness.app.close();
    }
  });

  test('rejects an expired code and drops the pending registration', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      await post(harness.app, '/v1/auth/register', {
        username: 'eve',
        email: 'eve@example.com',
        password: 'password123',
      });
      const row = harness.verifications.rows.get('eve@example.com');
      assert.ok(row);
      row.expires_at = new Date(Date.now() - 1000);

      const code = harness.mailer.codeFor('eve@example.com');
      const res = await post(harness.app, '/v1/auth/register/verify', {
        email: 'eve@example.com',
        code,
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.match(res.json().error.message, /expired/);
      assert.equal(harness.verifications.rows.has('eve@example.com'), false);
    } finally {
      await harness.app.close();
    }
  });

  test('resends with a new code but not inside the cooldown window', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      await post(harness.app, '/v1/auth/register', {
        username: 'frank',
        email: 'frank@example.com',
        password: 'password123',
      });
      const first = harness.mailer.codeFor('frank@example.com');

      const blocked = await post(harness.app, '/v1/auth/register/resend', {
        email: 'frank@example.com',
      });
      assert.equal(blocked.statusCode, 429, blocked.body);
      assert.equal(blocked.headers['retry-after'], '60');

      // Age the row past the cooldown, as 60 seconds of wall clock would.
      const row = harness.verifications.rows.get('frank@example.com');
      assert.ok(row);
      row.last_sent_at = new Date(Date.now() - 61_000);

      const resent = await post(harness.app, '/v1/auth/register/resend', {
        email: 'frank@example.com',
      });
      assert.equal(resent.statusCode, 202, resent.body);
      assert.equal(harness.mailer.sent.length, 2);

      // The old code must stop working once the row's hash is replaced.
      const stale = await post(harness.app, '/v1/auth/register/verify', {
        email: 'frank@example.com',
        code: first,
      });
      assert.equal(stale.statusCode, 400, stale.body);
    } finally {
      await harness.app.close();
    }
  });

  test('rejects a duplicate username with 409 before sending mail', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const first = await register(harness, {
        username: 'carol',
        email: 'carol@example.com',
        password: 'password123',
      });
      assert.equal(first.verify?.statusCode, 201, first.verify?.body);

      const second = await post(harness.app, '/v1/auth/register', {
        username: 'carol',
        email: 'other@example.com',
        password: 'password123',
      });
      assert.equal(second.statusCode, 409, second.body);
      assert.equal(harness.mailer.sent.length, 1);
    } finally {
      await harness.app.close();
    }
  });

  test('rejects a JSON null body with 400, not 500', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const res = await post(harness.app, '/v1/auth/register', 'null');
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error.code, 'invalid_request');
    } finally {
      await harness.app.close();
    }
  });

  test('rejects missing fields with 400', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const res = await post(harness.app, '/v1/auth/register', { username: 'carol' });
      assert.equal(res.statusCode, 400, res.body);
    } finally {
      await harness.app.close();
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

  test('fails at startup when production has no email verification store', () => {
    assert.throws(
      () =>
        buildServer({
          config: { ...config, nodeEnv: 'production' },
          provider,
          credential,
          logger: false,
          userStore: createFakeUserStore(),
        }),
      /emailVerificationStore is required/,
    );
  });
});

describe('POST /v1/auth/login and /v1/auth/regenerate-key', () => {
  test('login re-issues the same gateway key on every login', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const registered = await register(harness, {
        username: 'dave',
        email: 'dave@example.com',
        password: 'password123',
      });
      assert.equal(registered.verify?.statusCode, 201, registered.verify?.body);

      const first = await post(harness.app, '/v1/auth/login', {
        username: 'dave',
        password: 'password123',
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().username, 'dave');
      assert.match(String(first.json().gateway_api_key), /^gk_/);
      assert.match(String(first.headers['set-cookie']), /^jwt=.*HttpOnly/);

      // Logging in again must hand back the identical key, not a rotated one.
      const second = await post(harness.app, '/v1/auth/login', {
        username: 'dave',
        password: 'password123',
      });
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().gateway_api_key, first.json().gateway_api_key);

      const bad = await post(harness.app, '/v1/auth/login', {
        username: 'dave',
        password: 'wrong-password',
      });
      assert.equal(bad.statusCode, 401, bad.body);
    } finally {
      await harness.app.close();
    }
  });

  test('regenerate-key issues a fresh key for the right password only', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const registered = await register(harness, {
        username: 'erin',
        email: 'erin@example.com',
        password: 'password123',
      });
      const originalKey = registered.verify?.json().gateway_api_key as string;

      const regenerated = await post(harness.app, '/v1/auth/regenerate-key', {
        username: 'erin',
        password: 'password123',
      });
      assert.equal(regenerated.statusCode, 200, regenerated.body);
      assert.match(regenerated.json().gateway_api_key, /^gk_[0-9a-f]{64}$/);
      assert.notEqual(regenerated.json().gateway_api_key, originalKey);

      const rejected = await post(harness.app, '/v1/auth/regenerate-key', {
        username: 'erin',
        password: 'wrong-password',
      });
      assert.equal(rejected.statusCode, 401, rejected.body);
    } finally {
      await harness.app.close();
    }
  });

  test('logout clears the session cookie', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const res = await post(harness.app, '/v1/auth/logout', {});
      assert.equal(res.statusCode, 200, res.body);
      const cookie = String(res.headers['set-cookie']);
      assert.match(cookie, /^jwt=;/);
      assert.match(cookie, /Max-Age=0/);
      assert.match(cookie, /HttpOnly/);
    } finally {
      await harness.app.close();
    }
  });
});

describe('GET /v1/user/gateway-key', () => {
  test('returns the same key the server re-issues, and the new key after rotation', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const registered = await register(harness, {
        username: 'gwen',
        email: 'gwen@example.com',
        password: 'password123',
      });
      assert.equal(registered.verify?.statusCode, 201, registered.verify?.body);
      const cookie = String(registered.verify?.headers['set-cookie']).split(';')[0];
      const key = registered.verify?.json().gateway_api_key as string;

      const first = await harness.app.inject({
        method: 'GET',
        url: '/v1/user/gateway-key',
        headers: { cookie },
      });
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(first.json(), { gateway_api_key: key });
      assert.equal(first.headers['cache-control'], 'no-store');

      const rotated = await post(harness.app, '/v1/auth/regenerate-key', {
        username: 'gwen',
        password: 'password123',
      });
      const second = await harness.app.inject({
        method: 'GET',
        url: '/v1/user/gateway-key',
        headers: { cookie },
      });
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().gateway_api_key, rotated.json().gateway_api_key);
      assert.notEqual(second.json().gateway_api_key, key);
    } finally {
      await harness.app.close();
    }
  });

  test('returns null for a legacy row, and login omits the key', async () => {
    const harness = makeHarness(createFakeUserStore({ legacyUsernames: ['legacy'] }));
    try {
      await register(harness, {
        username: 'legacy',
        email: 'legacy@example.com',
        password: 'password123',
      });

      const login = await post(harness.app, '/v1/auth/login', {
        username: 'legacy',
        password: 'password123',
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(login.json().gateway_api_key, undefined);

      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const res = await harness.app.inject({
        method: 'GET',
        url: '/v1/user/gateway-key',
        headers: { cookie },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json(), { gateway_api_key: null });
    } finally {
      await harness.app.close();
    }
  });

  test('requires a session', async () => {
    const harness = makeHarness(createFakeUserStore());
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/v1/user/gateway-key' });
      assert.equal(res.statusCode, 401, res.body);
    } finally {
      await harness.app.close();
    }
  });
});
