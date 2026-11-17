import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors';
import type { UserModel } from '../../models/user';
import { signJwt } from '../../lib/jwt';
import { sessionCookie } from '../plugins/session-cookie';
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

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: { userStore: UserModel; jwtSecret?: string; nodeEnv: string },
): void {
  app.post('/v1/auth/register', async (request, reply) => {
    const { username, email, password } = requireObjectBody(
      request.body,
    ) as unknown as RegisterRequestType;
    requireNonEmpty({ username, email, password });
    if (password.length < 8) {
      throw new ApiError('client', 'password must be at least 8 characters');
    }
    if (!deps.jwtSecret) {
      throw new ApiError('auth', 'jwt not configured');
    }

    const existing =
      (await deps.userStore.findByUsername(username)) ?? (await deps.userStore.findByEmail(email));
    if (existing !== null) {
      throw conflictError('username or email already exists');
    }

    const result = await deps.userStore.createUser({ username, email, password });
    const token = signJwt(
      { userId: result.user.id, username: result.user.username },
      deps.jwtSecret,
    );
    reply.header('Set-Cookie', sessionCookie.serialize(token, deps.nodeEnv));
    return reply.status(201).send({
      user: { id: result.user.id, username: result.user.username, email: result.user.email },
      gateway_api_key: result.gatewayApiKeyPlaintext,
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const { username, password } = requireObjectBody(request.body) as unknown as LoginRequestType;
    requireNonEmpty({ username, password });
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
