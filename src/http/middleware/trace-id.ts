import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

/**
 * Block 25: request tracing middleware.
 *
 * Every response carries `x-request-id`: the client-supplied value when present,
 * otherwise a fresh random id. The id is also mirrored back onto
 * `request.headers['x-request-id']` so downstream hooks/routes see a normalized
 * value without parsing headers themselves.
 */
export function traceIdPlugin(
  app: FastifyInstance,
  _opts: unknown,
  done: (err?: Error | undefined) => void,
): void {
  app.addHook(
    'onRequest',
    (req: FastifyRequest, reply: FastifyReply, done: (err?: Error | undefined) => void) => {
      const supplied = req.headers['x-request-id'];
      const id =
        typeof supplied === 'string' && supplied.trim().length > 0
          ? supplied.trim()
          : crypto.randomBytes(16).toString('hex');
      req.headers['x-request-id'] = id;
      reply.header('x-request-id', id);
      done();
    },
  );
  done();
}

export default traceIdPlugin;
