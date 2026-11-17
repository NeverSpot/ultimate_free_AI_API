import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign as signWithKey, type JsonWebKey } from 'node:crypto';
import { before, describe, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import type { User, UserModel } from '../../src/models/user';
import type {
  NewOAuthAccount,
  OAuthAccount,
  OAuthAccountModel,
} from '../../src/models/oauth-account';
import { resetGoogleJwksCache } from '../../src/lib/oauth/providers';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

const GOOGLE_CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
const GITHUB_CLIENT_ID = 'github-client-id';

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
  googleClientId: GOOGLE_CLIENT_ID,
  googleClientSecret: 'google-client-secret',
  githubClientId: GITHUB_CLIENT_ID,
  githubClientSecret: 'github-client-secret',
  oauthCallbackBase: 'http://localhost:8080',
  frontendUrl: 'http://localhost:3000',
};

const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model' });
const credential: Credential = { id: 'credential-1', provider: 'mock', secret: 'not-a-real-key' };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk: JsonWebKey = {
  ...(publicKey.export({ format: 'jwk' }) as JsonWebKey),
  kid: 'test-kid',
  alg: 'RS256',
  use: 'sig',
};

interface GoogleClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  aud?: string;
  iss?: string;
  exp?: number;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Mint a real RS256 ID token, so the verifier's signature check is actually exercised. */
function signIdToken(claims: GoogleClaims): string {
  const header = base64urlJson({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
  const payload = base64urlJson({
    iss: 'https://accounts.google.com',
    aud: GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  });
  const signature = signWithKey('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function decodeStateCookie(cookie: string): {
  provider: string;
  state: string;
  verifier?: string;
  nonce?: string;
} {
  const match = /oauth_state=([^;]+)/.exec(cookie);
  assert.ok(match?.[1], `state cookie missing in ${cookie}`);
  return JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
}

interface FakeUserStore extends UserModel {
  users: Map<string, User>;
}

function createFakeUserStore(): FakeUserStore {
  const users = new Map<string, User>();

  async function findByUsername(username: string): Promise<User | null> {
    return users.get(username) ?? null;
  }
  async function findByEmail(email: string): Promise<User | null> {
    for (const user of users.values()) {
      if (user.email.toLowerCase() === email.toLowerCase()) return user;
    }
    return null;
  }
  async function findById(
    id: string,
  ): Promise<{ id: string; username: string; email: string } | null> {
    const user = [...users.values()].find((candidate) => candidate.id === id);
    if (!user) return null;
    return { id: user.id, username: user.username, email: user.email };
  }
  async function createOAuthUser(input: { username: string; email: string }) {
    const user: User = {
      id: randomUUID(),
      username: input.username,
      email: input.email,
      password_hash: null,
      gateway_api_key_hash: `hash_${randomUUID()}`,
      created_at: new Date(),
    };
    users.set(user.username, user);
    return { user, gatewayApiKeyPlaintext: 'gk_placeholder' };
  }

  return {
    users,
    createOAuthUser,
    findByUsername,
    findByEmail,
    findById,
    createUser: async () => {
      throw new Error('not used');
    },
    createUserWithHash: async () => {
      throw new Error('not used');
    },
    findByGatewayApiKeyHash: async () => null,
    verifyPassword: async () => null,
    markEmailVerified: async () => undefined,
    setGatewayApiKeyHash: async () => 'gk_unused',
    getGatewayApiKey: async () => null,
  };
}

interface FakeAccounts extends OAuthAccountModel {
  links: Map<string, OAuthAccount>;
}

function createFakeAccounts(): FakeAccounts {
  const links = new Map<string, OAuthAccount>();

  async function createAccount(input: NewOAuthAccount): Promise<OAuthAccount> {
    const account: OAuthAccount = {
      id: randomUUID(),
      user_id: input.user_id,
      provider: input.provider,
      provider_user_id: input.provider_user_id,
      provider_email: input.provider_email,
      access_token_encrypted: 'enc',
      raw_profile: input.raw_profile,
      created_at: new Date(),
      updated_at: new Date(),
    };
    links.set(`${input.provider}:${input.provider_user_id}`, account);
    return account;
  }

  async function findByProviderUserId(
    providerName: string,
    providerUserId: string,
  ): Promise<OAuthAccount | null> {
    return links.get(`${providerName}:${providerUserId}`) ?? null;
  }

  async function linkAccount(input: NewOAuthAccount): Promise<OAuthAccount> {
    const key = `${input.provider}:${input.provider_user_id}`;
    const existing = links.get(key);
    if (existing) {
      const updated: OAuthAccount = {
        ...existing,
        provider_email: input.provider_email,
        raw_profile: input.raw_profile,
        updated_at: new Date(),
      };
      links.set(key, updated);
      return updated;
    }
    return createAccount(input);
  }

  return {
    links,
    createAccount,
    findByProviderUserId,
    linkAccount,
    findById: async () => null,
    findByUserId: async (userId: string) =>
      [...links.values()].filter((account) => account.user_id === userId),
    unlink: async (userId: string, providerName: string) => {
      for (const [key, account] of links) {
        if (account.user_id === userId && account.provider === providerName) {
          links.delete(key);
          return true;
        }
      }
      return false;
    },
    getAccessToken: async () => 'access-token',
  };
}

type FetchRoute = (url: string, init?: Parameters<typeof fetch>[1]) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Harness {
  app: FastifyInstance;
  users: FakeUserStore;
  accounts: FakeAccounts;
}

function makeHarness(users = createFakeUserStore()): Harness {
  const accounts = createFakeAccounts();
  const app = buildServer({
    config,
    provider,
    credential,
    logger: false,
    userStore: users,
    oauthAccounts: accounts,
  });
  return { app, users, accounts };
}

/** `globalThis.fetch` is the only seam server-built routes expose; restore it after each test. */
const realFetch = globalThis.fetch;
before(() => {
  resetGoogleJwksCache();
});

async function withFetch<T>(route: FetchRoute, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return route(url, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    resetGoogleJwksCache();
  }
}

function googleRoute(
  options: {
    claims?: GoogleClaims;
    nonce?: string;
    tokenStatus?: number;
  } = {},
): FetchRoute {
  return (url) => {
    if (url.includes('/oauth2/v3/certs')) return jsonResponse({ keys: [publicJwk] });
    if (url === 'https://oauth2.googleapis.com/token') {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return jsonResponse({ error: 'invalid_grant' }, options.tokenStatus);
      }
      return jsonResponse({
        access_token: 'google-access-token',
        token_type: 'Bearer',
        id_token: signIdToken({
          sub: 'google-sub-1',
          email: 'ada@example.com',
          email_verified: true,
          ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
          ...options.claims,
        }),
      });
    }
    return jsonResponse({ error: 'unexpected url' }, 404);
  };
}

function githubRoute(
  options: { emails?: unknown[]; user?: Record<string, unknown> } = {},
): FetchRoute {
  return (url) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return jsonResponse({ access_token: 'github-access-token', token_type: 'bearer' });
    }
    if (url === 'https://api.github.com/user') {
      return jsonResponse(
        options.user ?? { id: 42, login: 'octocat', name: 'The Octocat', email: null },
      );
    }
    if (url === 'https://api.github.com/user/emails') {
      return jsonResponse(
        options.emails ?? [
          { email: 'octocat@example.com', primary: true, verified: true },
          { email: 'other@example.com', primary: false, verified: true },
        ],
      );
    }
    return jsonResponse({ error: 'unexpected url' }, 404);
  };
}

async function startFlow(app: FastifyInstance, providerName: 'google' | 'github') {
  const res = await app.inject({ method: 'GET', url: `/v1/auth/oauth/${providerName}/start` });
  const cookie = String(res.headers['set-cookie']);
  return { res, cookie, pending: decodeStateCookie(cookie) };
}

function callbackUrl(providerName: 'google' | 'github', code: string, state: string): string {
  return `/v1/auth/oauth/${providerName}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
}

describe('GET /v1/auth/providers', () => {
  test('lists the providers that are fully configured', async () => {
    const harness = makeHarness();
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/v1/auth/providers' });
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(res.json(), { providers: ['github', 'google'] });
    } finally {
      await harness.app.close();
    }
  });
});

describe('GET /v1/auth/oauth/:provider/start', () => {
  test('redirects to Google with PKCE, state and nonce, and sets a Lax state cookie', async () => {
    const harness = makeHarness();
    try {
      const { res, cookie, pending } = await startFlow(harness.app, 'google');
      assert.equal(res.statusCode, 302, res.body);

      const location = new URL(String(res.headers['location']));
      assert.equal(
        location.origin + location.pathname,
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      assert.equal(location.searchParams.get('client_id'), GOOGLE_CLIENT_ID);
      assert.equal(
        location.searchParams.get('redirect_uri'),
        'http://localhost:8080/v1/auth/oauth/google/callback',
      );
      assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(location.searchParams.get('state'), pending.state);
      assert.ok(pending.verifier && pending.verifier.length >= 43);
      assert.ok(location.searchParams.get('nonce'));
      assert.equal(pending.nonce, location.searchParams.get('nonce'));

      // The state cookie must be scoped to the callback path and survivable on a
      // top-level cross-site navigation — SameSite=Strict would silently break login.
      assert.match(cookie, /Path=\/v1\/auth\/oauth/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.doesNotMatch(cookie, /Secure/);
    } finally {
      await harness.app.close();
    }
  });

  test('404s an unknown provider', async () => {
    const harness = makeHarness();
    try {
      const res = await harness.app.inject({ method: 'GET', url: '/v1/auth/oauth/facebook/start' });
      assert.equal(res.statusCode, 404, res.body);
    } finally {
      await harness.app.close();
    }
  });
});

describe('GET /v1/auth/oauth/:provider/callback', () => {
  test('creates an account from a verified Google identity and starts a session', async () => {
    const harness = makeHarness();
    try {
      const { cookie, pending } = await startFlow(harness.app, 'google');
      // The ID token must carry the nonce from the state cookie; a token minted
      // for another request must not be accepted.
      const route = googleRoute({ nonce: pending.nonce });
      const res = await withFetch(route, () =>
        harness.app.inject({
          method: 'GET',
          url: callbackUrl('google', 'auth-code', pending.state),
          headers: { cookie: cookie.split(';')[0] ?? '' },
        }),
      );

      assert.equal(res.statusCode, 302, res.body);
      assert.equal(res.headers['location'], 'http://localhost:3000/keys');
      assert.match(String(res.headers['set-cookie']), /jwt=[^;]+; Path=\/; HttpOnly/);
      assert.match(String(res.headers['set-cookie']), /jwt=[^;]+; Path=\/; HttpOnly/);
      assert.match(String(res.headers['set-cookie']), /oauth_state=; Path=\/v1\/auth\/oauth/);

      const created = harness.users.users.get('ada');
      assert.ok(created, 'expected username derived from the email local part');
      assert.equal(harness.accounts.links.size, 1);
      assert.equal([...harness.accounts.links.values()][0]?.provider, 'google');
    } finally {
      await harness.app.close();
    }
  });

  test('links a verified Google email to an existing account instead of duplicating it', async () => {
    const users = createFakeUserStore();
    // Pre-existing password account with the same address.
    users.users.set('ada', {
      id: 'existing-user',
      username: 'ada',
      email: 'ada@example.com',
      password_hash: 'scrypt',
      gateway_api_key_hash: 'hash',
      created_at: new Date(),
    });
    const harness = makeHarness(users);
    try {
      const { cookie, pending } = await startFlow(harness.app, 'google');
      const route = googleRoute({ nonce: pending.nonce });
      const res = await withFetch(route, () =>
        harness.app.inject({
          method: 'GET',
          url: callbackUrl('google', 'auth-code', pending.state),
          headers: { cookie: cookie.split(';')[0] ?? '' },
        }),
      );

      assert.equal(res.statusCode, 302, res.body);
      assert.equal(harness.users.users.size, 1, 'must not create a second account');
      assert.equal([...harness.accounts.links.values()][0]?.user_id, 'existing-user');
    } finally {
      await harness.app.close();
    }
  });

  test('refuses to link an account on an unverified provider email', async () => {
    const harness = makeHarness();
    try {
      const { cookie, pending } = await startFlow(harness.app, 'google');
      const route = googleRoute({
        nonce: pending.nonce,
        claims: { sub: 'g-2', email: 'ada@example.com', email_verified: false },
      });
      const res = await withFetch(route, () =>
        harness.app.inject({
          method: 'GET',
          url: callbackUrl('google', 'auth-code', pending.state),
          headers: { cookie: cookie.split(';')[0] ?? '' },
        }),
      );

      assert.equal(res.statusCode, 302, res.body);
      assert.equal(res.headers['location'], 'http://localhost:3000/login?error=email_unverified');
      assert.equal(harness.users.users.size, 0);
      assert.equal(harness.accounts.links.size, 0);
    } finally {
      await harness.app.close();
    }
  });

  test('rejects a callback whose state does not match the cookie', async () => {
    const harness = makeHarness();
    try {
      const { cookie } = await startFlow(harness.app, 'google');
      const res = await harness.app.inject({
        method: 'GET',
        url: callbackUrl('google', 'auth-code', 'forged-state'),
        headers: { cookie: cookie.split(';')[0] ?? '' },
      });
      assert.equal(res.statusCode, 302, res.body);
      assert.equal(
        res.headers['location'],
        'http://localhost:3000/login?error=oauth_state_mismatch',
      );
    } finally {
      await harness.app.close();
    }
  });

  test('maps a provider cancellation to oauth_cancelled', async () => {
    const harness = makeHarness();
    try {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/v1/auth/oauth/google/callback?error=access_denied',
      });
      assert.equal(res.headers['location'], 'http://localhost:3000/login?error=oauth_cancelled');
    } finally {
      await harness.app.close();
    }
  });

  test('completes a GitHub flow using the verified primary email', async () => {
    const harness = makeHarness();
    try {
      const { cookie, pending } = await startFlow(harness.app, 'github');
      // GitHub is a confidential client with no PKCE; the state is the only binding.
      assert.equal(pending.verifier, undefined);
      assert.equal(pending.nonce, undefined);

      const res = await withFetch(githubRoute(), () =>
        harness.app.inject({
          method: 'GET',
          url: callbackUrl('github', 'gh-code', pending.state),
          headers: { cookie: cookie.split(';')[0] ?? '' },
        }),
      );

      assert.equal(res.statusCode, 302, res.body);
      assert.equal(res.headers['location'], 'http://localhost:3000/keys');
      // Two cookies ride this redirect: the cleared state cookie, then the session.
      assert.match(String(res.headers['set-cookie']), /jwt=[^;]+; Path=\/; HttpOnly/);
      assert.ok(harness.users.users.get('octocat'));
      assert.equal([...harness.accounts.links.values()][0]?.provider_email, 'octocat@example.com');
    } finally {
      await harness.app.close();
    }
  });

  test('does not create an account when GitHub has no verified email', async () => {
    const route = githubRoute({
      emails: [{ email: 'private@example.com', primary: true, verified: false }],
      user: { id: 43, login: 'privatecat', email: null },
    });
    const harness = makeHarness();
    try {
      const { cookie, pending } = await startFlow(harness.app, 'github');
      const res = await withFetch(route, () =>
        harness.app.inject({
          method: 'GET',
          url: callbackUrl('github', 'gh-code', pending.state),
          headers: { cookie: cookie.split(';')[0] ?? '' },
        }),
      );
      // GitHub only reports a usable address through /user/emails with verified=true.
      assert.equal(res.headers['location'], 'http://localhost:3000/login?error=email_unavailable');
      assert.equal(harness.users.users.size, 0);
    } finally {
      await harness.app.close();
    }
  });
});
