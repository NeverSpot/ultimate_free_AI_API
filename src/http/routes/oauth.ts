import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors';
import type { UserModel } from '../../models/user';
import type { OAuthAccountModel } from '../../models/oauth-account';
import { signJwt } from '../../lib/jwt';
import { sessionCookie } from '../plugins/session-cookie';
import {
  authorizationUrl,
  codeChallengeFor,
  createCodeVerifier,
  createState,
  exchangeCode,
  loadProfile,
  OAuthError,
  stateMatches,
  type OAuthProviderConfig,
  type OAuthProviderName,
} from '../../lib/oauth/providers';

const STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE_SECONDS = 600;

export interface OAuthRouteDeps {
  userStore: UserModel;
  accounts: OAuthAccountModel;
  providers: Partial<Record<OAuthProviderName, OAuthProviderConfig>>;
  /** Public origin of this API, e.g. https://api.example.com — provider consoles must match it. */
  redirectBase: string;
  frontendUrl: string;
  jwtSecret?: string;
  nodeEnv: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface PendingState {
  provider: OAuthProviderName;
  state: string;
  verifier?: string;
  nonce?: string;
}

function encodeStateCookie(pending: PendingState): string {
  return Buffer.from(JSON.stringify(pending), 'utf8').toString('base64url');
}

function decodeStateCookie(value: string): PendingState | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.provider !== 'google' && record.provider !== 'github') return null;
    if (typeof record.state !== 'string') return null;
    return {
      provider: record.provider,
      state: record.state,
      ...(typeof record.verifier === 'string' ? { verifier: record.verifier } : {}),
      ...(typeof record.nonce === 'string' ? { nonce: record.nonce } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * `Path=/v1/auth/oauth` keeps the cookie off every other route, and
 * `SameSite=Lax` is required: the callback is a top-level navigation from the
 * provider, and `Strict` would drop the cookie and fail every login.
 */
function stateCookie(value: string, nodeEnv: string, maxAge = STATE_MAX_AGE_SECONDS): string {
  return `${STATE_COOKIE}=${value}; Path=/v1/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    nodeEnv === 'production' ? '; Secure' : ''
  }`;
}

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function callbackUrl(redirectBase: string, provider: OAuthProviderName): string {
  return `${redirectBase.replace(/\/+$/, '')}/v1/auth/oauth/${provider}/callback`;
}

/** Usernames must satisfy `^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$`; derive one from the profile. */
function baseUsername(candidate: string | undefined, email: string): string {
  const source = candidate ?? email.split('@')[0] ?? 'user';
  const cleaned = source
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 24);
  if (cleaned.length >= 3) return cleaned;
  const padded = `${cleaned}user`.slice(0, 32);
  return padded.length >= 3 ? padded : `user${padded}`;
}

async function allocateUsername(users: UserModel, candidate: string): Promise<string> {
  if ((await users.findByUsername(candidate)) === null) return candidate;
  for (let suffix = 2; suffix <= 9; suffix += 1) {
    const attempt = `${candidate}${suffix}`.slice(0, 32);
    if ((await users.findByUsername(attempt)) === null) return attempt;
  }
  return `user_${randomBytes(4).toString('hex')}`;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRouteDeps): void {
  function fail(reply: FastifyReply, code: string): unknown {
    // Errors land on the login page as a short code. Provider bodies and tokens
    // must never travel in a URL that the browser keeps in history.
    return reply.redirect(
      `${deps.frontendUrl.replace(/\/+$/, '')}/login?error=${encodeURIComponent(code)}`,
    );
  }

  app.get('/v1/auth/providers', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.send({
      providers: Object.keys(deps.providers).sort(),
    });
  });

  app.get('/v1/auth/oauth/:provider/start', async (request, reply) => {
    const { provider: name } = request.params as { provider?: string };
    if (name !== 'google' && name !== 'github') {
      throw new ApiError('not_found', 'unknown oauth provider');
    }
    const provider = deps.providers[name];
    if (!provider) {
      return fail(reply, 'oauth_not_configured');
    }

    const state = createState();
    const verifier = provider.pkce ? createCodeVerifier() : undefined;
    // Google binds the ID token to this request via `nonce`; GitHub has no OIDC.
    const nonce = provider.name === 'google' ? createState() : undefined;

    const pending: PendingState = {
      provider: provider.name,
      state,
      ...(verifier !== undefined ? { verifier } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
    };
    reply.header('Set-Cookie', stateCookie(encodeStateCookie(pending), deps.nodeEnv));

    const url = authorizationUrl(provider, {
      redirectUri: callbackUrl(deps.redirectBase, provider.name),
      state,
      ...(verifier !== undefined ? { codeChallenge: codeChallengeFor(verifier) } : {}),
      ...(nonce !== undefined ? { nonce } : {}),
    });
    return reply.redirect(url);
  });

  app.get('/v1/auth/oauth/:provider/callback', async (request, reply) => {
    const { provider: name } = request.params as { provider?: string };
    if (name !== 'google' && name !== 'github') {
      throw new ApiError('not_found', 'unknown oauth provider');
    }
    const provider = deps.providers[name];
    if (!provider) {
      return fail(reply, 'oauth_not_configured');
    }
    // Always clear the one-shot state cookie, whatever happens next.
    reply.header('Set-Cookie', stateCookie('', deps.nodeEnv, 0));

    const query = request.query as Record<string, string | undefined>;
    if (typeof query.error === 'string') {
      // `access_denied` is the user pressing Cancel; not an error worth alerting on.
      return fail(reply, query.error === 'access_denied' ? 'oauth_cancelled' : 'oauth_failed');
    }
    if (typeof query.code !== 'string' || query.code.length === 0) {
      return fail(reply, 'oauth_failed');
    }

    const rawState = readCookie(request, STATE_COOKIE);
    const pending = rawState ? decodeStateCookie(rawState) : null;
    if (
      pending === null ||
      pending.provider !== provider.name ||
      typeof query.state !== 'string' ||
      !stateMatches(pending.state, query.state)
    ) {
      return fail(reply, 'oauth_state_mismatch');
    }

    try {
      const tokens = await exchangeCode(provider, {
        code: query.code,
        redirectUri: callbackUrl(deps.redirectBase, provider.name),
        ...(pending.verifier !== undefined ? { codeVerifier: pending.verifier } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      });

      const profile = await loadProfile(provider, tokens, {
        ...(pending.nonce !== undefined ? { nonce: pending.nonce } : {}),
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });

      let userId: string;

      const linked = await deps.accounts.findByProviderUserId(
        provider.name,
        profile.providerUserId,
      );
      if (linked !== null) {
        // Known provider identity: sign in and refresh the stored token.
        const user = await deps.userStore.findById(linked.user_id);
        if (user === null) {
          return fail(reply, 'oauth_failed');
        }
        await deps.accounts.linkAccount({
          user_id: user.id,
          provider: provider.name,
          provider_user_id: profile.providerUserId,
          provider_email: profile.email,
          access_token: profile.accessToken,
          raw_profile: profile.raw,
        });
        userId = user.id;
      } else {
        // Linking to an existing account is only safe when the provider vouches
        // for the address; otherwise an attacker could attach their identity to
        // someone else's account by claiming their email.
        if (!profile.emailVerified) {
          return fail(reply, 'email_unverified');
        }

        const existing = await deps.userStore.findByEmail(profile.email);
        if (existing !== null) {
          await deps.userStore.markEmailVerified(existing.id);
          await deps.accounts.linkAccount({
            user_id: existing.id,
            provider: provider.name,
            provider_user_id: profile.providerUserId,
            provider_email: profile.email,
            access_token: profile.accessToken,
            raw_profile: profile.raw,
          });
          userId = existing.id;
        } else {
          const username = await allocateUsername(
            deps.userStore,
            baseUsername(profile.handle ?? profile.displayName, profile.email),
          );
          const created = await deps.userStore.createOAuthUser({
            username,
            email: profile.email,
          });
          await deps.accounts.linkAccount({
            user_id: created.user.id,
            provider: provider.name,
            provider_user_id: profile.providerUserId,
            provider_email: profile.email,
            access_token: profile.accessToken,
            raw_profile: profile.raw,
          });
          userId = created.user.id;
        }
      }

      const user = await deps.userStore.findById(userId);
      if (user === null) {
        return fail(reply, 'oauth_failed');
      }
      if (!deps.jwtSecret) {
        return fail(reply, 'oauth_failed');
      }

      const token = signJwt({ userId: user.id, username: user.username }, deps.jwtSecret);
      reply.header('Set-Cookie', sessionCookie.serialize(token, deps.nodeEnv));
      return reply.redirect(`${deps.frontendUrl.replace(/\/+$/, '')}/keys`);
    } catch (error) {
      if (error instanceof OAuthError) {
        request.log.warn({ code: error.code }, 'oauth callback failed');
        return fail(
          reply,
          error.code === 'email_unavailable' ? 'email_unavailable' : 'oauth_failed',
        );
      }
      request.log.error({ err: error }, 'oauth callback crashed');
      return fail(reply, 'oauth_failed');
    }
  });
}
