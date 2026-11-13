import type { FastifyInstance } from 'fastify';
import { healthTracker } from '../../providers/health';

/**
 * Block 30: provider health endpoint.
 *
 * GET /v1/providers/health reports the observed health of every provider tracked
 * by `providers/health`. Used by the dashboard and operators to spot sustained
 * failures before customers do.
 */
export function registerProvidersRoute(app: FastifyInstance): void {
  app.get('/v1/providers/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      providers: healthTracker.all(),
    });
  });
}
