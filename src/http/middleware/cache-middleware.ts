import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEFAULT_TTL_SECONDS, getCached, setCached } from '../../telemetry/cache';

const CACHE_PATH = '/v1/chat/completions';
const CACHE_HEADER = 'x-gateway-cache';

/**
 * Block 29: semantic response cache for POST /v1/chat/completions.
 *
 * Installs a preHandler hook that serves cached responses on cache hits and
 * captures the response payload on cache misses. It is wired directly on the
 * server instance (not inside an encapsulated plugin) so it wraps every route
 * registered after it, including `/v1/chat/completions`.
 */
export default function cacheMiddleware(app: FastifyInstance): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'POST' || request.url !== CACHE_PATH) {
      return;
    }

    const key = `cache:chat:${request.url}`;
    const cached = await getCached(key);
    if (cached !== null) {
      return reply.status(200).header(CACHE_HEADER, 'hit').send(JSON.parse(cached));
    }

    const originalSend = reply.send.bind(reply);
    reply.send = ((payload: unknown) => {
      void setCached(key, JSON.stringify(payload), DEFAULT_TTL_SECONDS).catch(() => {});
      return originalSend(payload);
    }) as unknown as FastifyReply['send'];
  });
}
