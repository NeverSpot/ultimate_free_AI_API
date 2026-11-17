import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors';
import type { UserModel } from '../../models/user';

export function registerUserRoutes(app: FastifyInstance, deps: { userStore: UserModel }): void {
  app.get('/v1/user/me', async (request, reply) => {
    if (!request.user) {
      throw new ApiError('auth', 'authentication required');
    }
    const user = await deps.userStore.findById(request.user.id);
    if (!user) {
      throw new ApiError('auth', 'user not found');
    }
    reply.header('Cache-Control', 'no-store');
    return reply.send({ id: user.id, username: user.username, email: user.email });
  });

  /**
   * Re-issue the caller's gateway key without a password, so the keys page can
   * restore it after localStorage is cleared. Reads the encrypted copy only:
   * legacy hash-only rows return null and keep their current key.
   */
  app.get('/v1/user/gateway-key', async (request, reply) => {
    if (!request.user) {
      throw new ApiError('auth', 'authentication required');
    }
    const gatewayApiKey = await deps.userStore.getGatewayApiKey(request.user.id);
    reply.header('Cache-Control', 'no-store');
    return reply.send({ gateway_api_key: gatewayApiKey });
  });
}
