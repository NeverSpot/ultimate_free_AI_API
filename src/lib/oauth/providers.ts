import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  type JsonWebKey,
} from 'node:crypto';

export type OAuthProviderName = 'google' | 'github';

export interface OAuthProviderConfig {
  name: OAuthProviderName;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  /** PKCE where the provider supports it. GitHub OAuth Apps ignore the challenge. */
  pkce: boolean;
}

export interface OAuthTokens {
  accessToken: string;
  idToken?: string;
  tokenType?: string;
}

export interface OAuthProfile {
  providerUserId: string;
  email: string;
  /** True only when the provider asserts the address is verified. */
  emailVerified: boolean;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  accessToken: string;
  raw: Record<string, unknown>;
}

/** Failure carrying a short machine code; the route maps it to a redirect, never a token leak. */
export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

const HTTP_TIMEOUT_MS = 10_000;
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';

export function googleProvider(input: {
  clientId: string;
  clientSecret: string;
}): OAuthProviderConfig {
  return {
    name: 'google',
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    scopes: ['openid', 'email', 'profile'],
    pkce: true,
  };
}

export function githubProvider(input: {
  clientId: string;
  clientSecret: string;
}): OAuthProviderConfig {
  return {
    name: 'github',
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    // `user:email` is required: GitHub hides the address from `/user` unless it is public.
    scopes: ['read:user', 'user:email'],
    pkce: false,
  };
}

/** 43-char URL-safe verifier (RFC 7636 requires 43..128). */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createState(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time state comparison, so a forged state cannot be discovered byte by byte. */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizationUrl(
  provider: OAuthProviderConfig,
  input: {
    redirectUri: string;
    state: string;
    codeChallenge?: string;
    nonce?: string;
  },
): string {
  if (provider.name === 'google') {
    const url = new URL(GOOGLE_AUTHORIZE_URL);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', provider.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('prompt', 'select_account');
    if (input.codeChallenge) {
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (input.nonce) url.searchParams.set('nonce', input.nonce);
    return url.toString();
  }

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

function assertOk(response: Response, provider: string): void {
  if (!response.ok) {
    throw new OAuthError('token_exchange_failed', `${provider}: HTTP ${response.status}`);
  }
}

export async function exchangeCode(
  provider: OAuthProviderConfig,
  input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<OAuthTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });
  if (input.codeVerifier) body.set('code_verifier', input.codeVerifier);

  const tokenUrl = provider.name === 'google' ? GOOGLE_TOKEN_URL : GITHUB_TOKEN_URL;
  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      // GitHub rejects requests without a User-Agent.
      'user-agent': 'ultimate-free-ai-gateway',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  assertOk(response, provider.name);

  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.error === 'string') {
    throw new OAuthError('token_exchange_failed', `${provider.name}: ${payload.error}`);
  }
  const accessToken = payload.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new OAuthError('token_exchange_failed', `${provider.name}: no access_token`);
  }
  return {
    accessToken,
    ...(typeof payload.id_token === 'string' ? { idToken: payload.id_token } : {}),
    ...(typeof payload.token_type === 'string' ? { tokenType: payload.token_type } : {}),
  };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OAuthError('invalid_id_token', 'malformed JWT segment');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verify a Google ID token: RS256 signature against Google's JWKS, plus issuer,
 * audience, expiry and nonce. A token that only *looks* valid is not enough —
 * the code exchange happens server-side, but the signature is what proves Google
 * minted the claims.
 */
export function verifyGoogleIdToken(
  idToken: string,
  input: {
    clientId: string;
    nonce?: string;
    jwks: JsonWebKey[];
    now?: () => number;
    issuer?: string;
  },
): Record<string, unknown> {
  const segments = idToken.split('.');
  if (segments.length !== 3) {
    throw new OAuthError('invalid_id_token', 'expected three JWT segments');
  }
  const [headerPart, payloadPart, signaturePart] = segments;
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new OAuthError('invalid_id_token', 'empty JWT segment');
  }

  const header = decodeJwtPart(headerPart);
  if (header.alg !== 'RS256') {
    throw new OAuthError('invalid_id_token', 'unexpected signing algorithm');
  }

  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const jwk = kid ? input.jwks.find((candidate) => candidate.kid === kid) : input.jwks[0];
  if (!jwk) {
    throw new OAuthError('invalid_id_token', 'signing key not found');
  }

  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = Buffer.from(`${headerPart}.${payloadPart}`);
  let signatureOk: boolean;
  try {
    signatureOk = verifySignature(
      'RSA-SHA256',
      signed,
      key,
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new OAuthError('invalid_id_token', 'bad signature');
  }

  const claims = decodeJwtPart(payloadPart);
  const issuer = typeof claims.iss === 'string' ? claims.iss : '';
  const allowedIssuers = new Set([
    input.issuer ?? 'https://accounts.google.com',
    'accounts.google.com',
  ]);
  if (!allowedIssuers.has(issuer)) {
    throw new OAuthError('invalid_id_token', 'unexpected issuer');
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(input.clientId)) {
    throw new OAuthError('invalid_id_token', 'unexpected audience');
  }

  const nowSeconds = Math.floor((input.now ?? Date.now)() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    throw new OAuthError('invalid_id_token', 'token expired');
  }
  if (input.nonce !== undefined && claims.nonce !== input.nonce) {
    throw new OAuthError('invalid_id_token', 'nonce mismatch');
  }

  return claims;
}

let googleJwksCache: { keys: JsonWebKey[]; expiresAt: number } | null = null;

export async function loadGoogleJwks(
  input: {
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<JsonWebKey[]> {
  const now = input.now ?? Date.now;
  const cached = googleJwksCache;
  if (cached && cached.expiresAt > now()) {
    return cached.keys;
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(GOOGLE_JWKS_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OAuthError('jwks_unavailable', `google jwks: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { keys?: unknown };
  const keys = Array.isArray(payload.keys) ? (payload.keys as JsonWebKey[]) : [];
  if (keys.length === 0) {
    throw new OAuthError('jwks_unavailable', 'google jwks: empty key set');
  }

  // Cache for an hour: Google rotates keys on a multi-day cadence.
  googleJwksCache = { keys, expiresAt: now() + 60 * 60 * 1000 };
  return keys;
}

/** Test seam: drop the module-level JWKS cache. */
export function resetGoogleJwksCache(): void {
  googleJwksCache = null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function loadGoogleProfile(
  tokens: OAuthTokens,
  input: { clientId: string; nonce?: string; fetchImpl?: typeof fetch; now?: () => number },
): Promise<OAuthProfile> {
  if (tokens.idToken) {
    const claims = verifyGoogleIdToken(tokens.idToken, {
      clientId: input.clientId,
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
      jwks: await loadGoogleJwks({ ...input }),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    const sub = stringOrUndefined(claims.sub);
    const email = stringOrUndefined(claims.email);
    if (!sub || !email) {
      throw new OAuthError('invalid_id_token', 'missing sub or email claim');
    }
    return {
      providerUserId: sub,
      email,
      emailVerified: claims.email_verified === true,
      ...(stringOrUndefined(claims.name) ? { displayName: String(claims.name) } : {}),
      ...(stringOrUndefined(claims.picture) ? { avatarUrl: String(claims.picture) } : {}),
      accessToken: tokens.accessToken,
      raw: claims,
    };
  }

  // Fallback for the (rare) case where Google omits id_token: userinfo over TLS.
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: {
      authorization: `Bearer ${tokens.accessToken}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new OAuthError('profile_unavailable', `google userinfo: HTTP ${response.status}`);
  }
  const profile = (await response.json()) as Record<string, unknown>;
  const sub = stringOrUndefined(profile.sub);
  const email = stringOrUndefined(profile.email);
  if (!sub || !email) {
    throw new OAuthError('profile_unavailable', 'google userinfo missing sub or email');
  }
  return {
    providerUserId: sub,
    email,
    emailVerified: profile.email_verified === true,
    ...(stringOrUndefined(profile.name) ? { displayName: String(profile.name) } : {}),
    ...(stringOrUndefined(profile.picture) ? { avatarUrl: String(profile.picture) } : {}),
    accessToken: tokens.accessToken,
    raw: profile,
  };
}

async function loadGithubProfile(
  tokens: OAuthTokens,
  input: { fetchImpl?: typeof fetch },
): Promise<OAuthProfile> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${tokens.accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'ultimate-free-ai-gateway',
    'x-github-api-version': '2022-11-28',
  };

  const userResponse = await fetchImpl(`${GITHUB_API}/user`, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!userResponse.ok) {
    throw new OAuthError('profile_unavailable', `github user: HTTP ${userResponse.status}`);
  }
  const user = (await userResponse.json()) as Record<string, unknown>;
  const id = user.id;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new OAuthError('profile_unavailable', 'github user missing id');
  }

  // `/user` returns null when the address is private, so ask the email endpoint
  // (requires the user:email scope) and take a verified primary address only.
  let email = stringOrUndefined(user.email);
  let emailVerified = false;

  const emailResponse = await fetchImpl(`${GITHUB_API}/user/emails`, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (emailResponse.ok) {
    const emails = (await emailResponse.json()) as Array<Record<string, unknown>>;
    const verified = emails.filter((entry) => entry.verified === true);
    const primary = verified.find((entry) => entry.primary === true) ?? verified[0];
    const resolved = primary ? stringOrUndefined(primary.email) : undefined;
    if (resolved) {
      email = resolved;
      emailVerified = true;
    }
  }

  if (!email) {
    throw new OAuthError('email_unavailable', 'github account has no usable email');
  }

  return {
    providerUserId: String(id),
    email,
    // An address from `/user` alone is unverified, even if GitHub has verified it.
    emailVerified,
    ...(stringOrUndefined(user.login) ? { handle: String(user.login) } : {}),
    ...(stringOrUndefined(user.name) ? { displayName: String(user.name) } : {}),
    ...(stringOrUndefined(user.avatar_url) ? { avatarUrl: String(user.avatar_url) } : {}),
    accessToken: tokens.accessToken,
    raw: user,
  };
}

export async function loadProfile(
  provider: OAuthProviderConfig,
  tokens: OAuthTokens,
  input: { nonce?: string; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<OAuthProfile> {
  return provider.name === 'google'
    ? loadGoogleProfile(tokens, { clientId: provider.clientId, ...input })
    : loadGithubProfile(tokens, input);
}
