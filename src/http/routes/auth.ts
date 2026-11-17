import type { FastifyInstance, FastifyReply } from 'fastify';
import { ApiError } from '../errors';
import type { UserModel } from '../../models/user';
import type { EmailVerificationModel } from '../../models/email-verification';
import { signJwt } from '../../lib/jwt';
import { sessionCookie } from '../plugins/session-cookie';
import {
  generateOtp,
  hashOtp,
  looksLikeEmail,
  normalizeEmail,
  otpMatches,
  type OtpPolicy,
  DEFAULT_OTP_POLICY,
} from '../../lib/otp';
import { otpMail, type Mailer } from '../../lib/mailer';
import type { RegisterRequestType, LoginRequestType, RegenerateKeyRequestType } from '../schemas';

interface HttpError extends Error {
  statusCode?: number;
}

function conflictError(message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = 409;
  return error;
}

function requireNonEmpty(fields: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ApiError('client', `${name} is required`);
    }
  }
}

/**
 * A JSON body of `null` parses successfully but cannot be destructured.
 * Reject it at the boundary so it becomes a 400, never a 500.
 */
function requireObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('client', 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/;
const MIN_PASSWORD_LENGTH = 8;

export interface AuthRouteDeps {
  userStore: UserModel;
  jwtSecret?: string;
  nodeEnv: string;
  /**
   * Email signup is only possible when both are wired. Absent (tests, minimal
   * builds) the register route reports 503 instead of silently creating an
   * unverified account.
   */
  verificationStore?: EmailVerificationModel;
  mailer?: Mailer;
  otpPolicy?: OtpPolicy;
  /** HMAC pepper for the stored code hash; required with `verificationStore`. */
  otpPepper?: string;
  appName?: string;
  /** Development only: return the code so the flow works without a mail server. */
  devReturnCode?: boolean;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const policy = deps.otpPolicy ?? DEFAULT_OTP_POLICY;

  function requireVerificationDeps(): {
    verificationStore: EmailVerificationModel;
    mailer: Mailer;
    otpPepper: string;
  } {
    const { verificationStore, mailer, otpPepper } = deps;
    if (!verificationStore || !mailer || !otpPepper) {
      // 503, never a silent fallback: an unverified account must not be creatable.
      throw new ApiError('exhausted', 'email verification is not configured');
    }
    return { verificationStore, mailer, otpPepper };
  }

  /**
   * Step 1 of email signup. Stores a pending registration and mails a six-digit
   * code; no `users` row exists yet, so an unverified address cannot reserve a
   * username or an email.
   */
  async function startRegistration(body: unknown, reply: FastifyReply): Promise<unknown> {
    const {
      username,
      email: rawEmail,
      password,
    } = requireObjectBody(body) as unknown as RegisterRequestType;
    requireNonEmpty({ username, email: rawEmail, password });

    const email = normalizeEmail(rawEmail);
    if (!looksLikeEmail(email)) {
      throw new ApiError('client', 'email is not a valid address', { param: 'email' });
    }
    if (!USERNAME_PATTERN.test(username)) {
      throw new ApiError(
        'client',
        'username must be 3-32 characters and start with a letter or digit',
        { param: 'username' },
      );
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new ApiError('client', `password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
        param: 'password',
      });
    }
    if (!deps.jwtSecret) {
      throw new ApiError('auth', 'jwt not configured');
    }

    const { verificationStore, mailer, otpPepper } = requireVerificationDeps();

    // Uniqueness is checked before sending mail so a taken name fails fast. The
    // authoritative guard is still the unique index at account creation, because
    // another request can win this check in between.
    const existing =
      (await deps.userStore.findByUsername(username)) ?? (await deps.userStore.findByEmail(email));
    if (existing !== null) {
      throw conflictError('username or email already exists');
    }

    const code = generateOtp();
    const passwordHash = await hashPasswordForPending(password);
    const started = await verificationStore.start({
      email,
      username,
      passwordHash,
      codeHash: hashOtp(code, email, otpPepper),
      ttlSeconds: policy.ttlSeconds,
      cooldownSeconds: policy.resendCooldownSeconds,
    });

    if (started === null) {
      // Atomic cooldown: another request already sent a code in this window.
      throw new ApiError('rate_limited', 'a verification code was just sent; please wait', {
        headers: { 'retry-after': String(policy.resendCooldownSeconds) },
      });
    }

    try {
      await mailer.send({
        to: email,
        ...otpMail({
          code,
          ttlMinutes: policy.ttlSeconds / 60,
          ...(deps.appName !== undefined ? { appName: deps.appName } : {}),
        }),
      });
    } catch (cause) {
      // Drop the pending row so a failed send does not burn the cooldown window
      // and the user can retry immediately.
      await verificationStore.remove(email).catch(() => undefined);
      throw new ApiError('upstream', 'could not send the verification email', { cause });
    }

    // Opportunistic housekeeping; a failure here must not fail the request.
    void verificationStore.purgeExpired().catch(() => undefined);

    return reply.status(202).send({
      otp_required: true,
      email,
      expires_in_seconds: policy.ttlSeconds,
      ...(deps.devReturnCode === true ? { dev_code: code } : {}),
    });
  }

  app.post('/v1/auth/register', async (request, reply) => startRegistration(request.body, reply));
  // Alias: makes the two-step flow self-documenting for clients.
  app.post('/v1/auth/register/start', async (request, reply) =>
    startRegistration(request.body, reply),
  );

  /**
   * Re-send the code for a pending registration without re-posting the password.
   * Anyone can trigger it for an address they know, which is exactly why the
   * cooldown is enforced in SQL and nothing but the address is echoed back.
   */
  app.post('/v1/auth/register/resend', async (request, reply) => {
    const body = requireObjectBody(request.body) as { email?: unknown };
    if (typeof body.email !== 'string' || body.email.length === 0) {
      throw new ApiError('client', 'email is required', { param: 'email' });
    }
    const email = normalizeEmail(body.email);
    const { verificationStore, mailer, otpPepper } = requireVerificationDeps();

    const pending = await verificationStore.find(email);
    if (pending === null) {
      throw new ApiError('client', 'no pending registration for this email', { param: 'email' });
    }

    const code = generateOtp();
    const refreshed = await verificationStore.resend({
      email,
      codeHash: hashOtp(code, email, otpPepper),
      ttlSeconds: policy.ttlSeconds,
      cooldownSeconds: policy.resendCooldownSeconds,
    });
    if (refreshed === null) {
      throw new ApiError('rate_limited', 'a verification code was just sent; please wait', {
        headers: { 'retry-after': String(policy.resendCooldownSeconds) },
      });
    }

    try {
      await mailer.send({
        to: email,
        ...otpMail({
          code,
          ttlMinutes: policy.ttlSeconds / 60,
          ...(deps.appName !== undefined ? { appName: deps.appName } : {}),
        }),
      });
    } catch (cause) {
      throw new ApiError('upstream', 'could not send the verification email', { cause });
    }

    return reply.status(202).send({
      otp_required: true,
      email,
      expires_in_seconds: policy.ttlSeconds,
      ...(deps.devReturnCode === true ? { dev_code: code } : {}),
    });
  });

  /**
   * Step 2: accept the code, create the account, issue the session and the
   * gateway key. The gateway key is returned exactly once, as at registration.
   */
  app.post('/v1/auth/register/verify', async (request, reply) => {
    const body = requireObjectBody(request.body) as { email?: unknown; code?: unknown };
    if (typeof body.email !== 'string' || body.email.length === 0) {
      throw new ApiError('client', 'email is required', { param: 'email' });
    }
    if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code.trim())) {
      throw new ApiError('client', 'code must be the 6-digit code from the email', {
        param: 'code',
      });
    }
    if (!deps.jwtSecret) {
      throw new ApiError('auth', 'jwt not configured');
    }

    const email = normalizeEmail(body.email);
    const code = body.code.trim();
    const { verificationStore, otpPepper } = requireVerificationDeps();

    const pending = await verificationStore.find(email);
    if (pending === null) {
      throw new ApiError('client', 'no verification is pending for this email; register again');
    }

    if (pending.expires_at.getTime() <= Date.now()) {
      await verificationStore.remove(email);
      throw new ApiError('client', 'verification code expired; register again');
    }

    if (pending.attempts >= policy.maxAttempts) {
      throw new ApiError('rate_limited', 'too many incorrect codes; register again');
    }

    if (!otpMatches(code, email, otpPepper, pending.code_hash)) {
      const attempts = await verificationStore.recordFailure(email);
      const remaining = Math.max(0, policy.maxAttempts - attempts);
      throw new ApiError(
        'client',
        remaining === 0
          ? 'too many incorrect codes; register again'
          : `invalid verification code (${remaining} attempts left)`,
        { param: 'code' },
      );
    }

    let created: Awaited<ReturnType<UserModel['createUserWithHash']>>;
    try {
      created = await deps.userStore.createUserWithHash({
        username: pending.username,
        email,
        passwordHash: pending.password_hash,
        emailVerified: true,
      });
    } catch (error) {
      // A parallel request could have claimed the username/email between the
      // pre-check and now; the row stays so the user can pick another name.
      if (isUniqueViolation(error)) {
        throw conflictError('username or email already exists');
      }
      throw error;
    }

    await verificationStore.remove(email);

    const token = signJwt(
      { userId: created.user.id, username: created.user.username },
      deps.jwtSecret,
    );
    reply.header('Set-Cookie', sessionCookie.serialize(token, deps.nodeEnv));
    return reply.status(201).send({
      user: {
        id: created.user.id,
        username: created.user.username,
        email: created.user.email,
      },
      gateway_api_key: created.gatewayApiKeyPlaintext,
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const { username, password } = requireObjectBody(request.body) as unknown as LoginRequestType;
    requireNonEmpty({ username, password });
    // OAuth-only accounts have no password hash and land here as a plain mismatch.
    const user = await deps.userStore.verifyPassword(username, password);
    if (user === null) {
      throw new ApiError('auth', 'invalid username or password');
    }
    if (!deps.jwtSecret) {
      throw new ApiError('auth', 'jwt not configured');
    }

    // Hand back the same gateway key on every login. The server stores it
    // reversibly (AES-256-GCM), so signing out or switching devices never costs
    // the user their key. Legacy accounts (pre-encryption) have no recoverable
    // copy: the key is omitted, their current key keeps working, and one explicit
    // "Get New" makes persistence permanent.
    const gatewayApiKey = await deps.userStore.getGatewayApiKey(user.id);

    const token = signJwt({ userId: user.id, username: user.username }, deps.jwtSecret);
    reply.header('Set-Cookie', sessionCookie.serialize(token, deps.nodeEnv));
    return reply.send({
      userId: user.id,
      username: user.username,
      ...(gatewayApiKey !== null ? { gateway_api_key: gatewayApiKey } : {}),
    });
  });

  app.post('/v1/auth/regenerate-key', async (request, reply) => {
    const { username, password } = requireObjectBody(
      request.body,
    ) as unknown as RegenerateKeyRequestType;
    requireNonEmpty({ username, password });
    const user = await deps.userStore.verifyPassword(username, password);
    if (user === null) {
      throw new ApiError('auth', 'invalid username or password');
    }
    const gatewayApiKey = await deps.userStore.setGatewayApiKeyHash(user.id);
    return reply.send({ gateway_api_key: gatewayApiKey });
  });

  app.post('/v1/auth/logout', async (_request, reply) => {
    reply.header('Set-Cookie', sessionCookie.clear(deps.nodeEnv));
    return reply.send({ ok: true });
  });
}

/** Local scrypt wrapper so this module does not import the whole crypto surface. */
async function hashPasswordForPending(password: string): Promise<string> {
  const { hashPassword } = await import('../../lib/crypto');
  return hashPassword(password);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
