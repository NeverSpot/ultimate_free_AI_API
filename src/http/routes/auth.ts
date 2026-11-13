import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors';
import type { UserModel } from '../../models/user';
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

export function registerAuthRoutes(app: FastifyInstance, deps: { userStore: UserModel }): void {
  app.post('/v1/auth/register', async (request, reply) => {
    const { username, email, password } = request.body as unknown as RegisterRequestType;
    requireNonEmpty({ username, email, password });
    if (password.length < 8) {
      throw new ApiError('client', 'password must be at least 8 characters');
    }

    const existing =
      (await deps.userStore.findByUsername(username)) ?? (await deps.userStore.findByEmail(email));
    if (existing !== null) {
      throw conflictError('username or email already exists');
    }

    const result = await deps.userStore.createUser({ username, email, password });
    return reply.status(200).send({
      userId: result.user.id,
      username: result.user.username,
      gatewayApiKey: result.gatewayApiKeyPlaintext,
    });
  });

  app.post('/v1/auth/login', async (request, reply) => {
    const { username, password } = request.body as unknown as LoginRequestType;
    requireNonEmpty({ username, password });
    const user = await deps.userStore.verifyPassword(username, password);
    if (user === null) {
      throw new ApiError('auth', 'invalid username or password');
    }
    return reply.send({ userId: user.id, username: user.username });
  });

  app.post('/v1/auth/regenerate-key', async (request, reply) => {
    const { username, password } = request.body as unknown as RegenerateKeyRequestType;
    requireNonEmpty({ username, password });
    const user = await deps.userStore.verifyPassword(username, password);
    if (user === null) {
      throw new ApiError('auth', 'invalid username or password');
    }
    const gatewayApiKey = await deps.userStore.setGatewayApiKeyHash(user.id);
    return reply.send({ gatewayApiKey });
  });
}
