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
}
