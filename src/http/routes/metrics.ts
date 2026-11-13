import type { FastifyInstance } from 'fastify';
import { getMetrics } from '../../telemetry/metrics';

/**
 * Block 26: `GET /metrics` exposing Prometheus text exposition format.
 */
export default async function metricsRoute(app: FastifyInstance): Promise<void> {
  app.get('/metrics', async (_req, reply) => {
    reply.type('text/plain').send(getMetrics());
  });
}
