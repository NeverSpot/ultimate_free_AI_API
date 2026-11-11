import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/env';
import { newRequestId } from '../core/ids';
import type { Credential, ProviderAdapter } from '../providers/types';
import { ApiError, envelopeOf, headersForError, statusForError, toEnvelope } from './errors';
import { registerChatCompletions } from './routes/chat-completions';
import { registerHealthz, type HealthProbes } from './routes/healthz';

export interface ServerDeps {
  config: Config;
  /** Block 3 swaps the real adapter in; routes never change. */
  provider: ProviderAdapter;
  /** Phase A: one fixed credential. */
  credential: Credential;
  now?: () => number;
  logger?: boolean;
  /** Optional dependency probes for /healthz. Unwired probes report `unknown`. */
  probes?: HealthProbes;
}

declare module 'fastify' {
  interface FastifyRequest {
    gatewayRequestId: string;
  }
}

/**
 * Build a Fastify instance from injected dependencies.
 *
 * Deliberately does not read `process.env` and does not call `listen()`: tests build
 * a server and drive it with `app.inject()`.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({
    bodyLimit: deps.config.maxBodyBytes,
    logger: deps.logger === true ? { level: deps.config.logLevel } : false,
    // TypeBox objects are permissive by default; make that explicit so harmless
    // OpenAI parameters are visible to `assertSupported()` instead of stripped.
    ajv: { customOptions: { removeAdditional: false } },
  });

  app.decorateRequest('gatewayRequestId', '');

  app.addHook('onRequest', (request, reply, done) => {
    const supplied = request.headers['x-request-id'];
    const requestId =
      typeof supplied === 'string' && supplied.trim().length > 0 ? supplied.trim() : newRequestId();

    request.gatewayRequestId = requestId;
    reply.header('x-request-id', requestId);
    done();
  });

  app.setErrorHandler((error, request, reply) => {
    const status = statusForError(error);

    for (const [name, value] of Object.entries(headersForError(error))) {
      reply.header(name, value);
    }

    if (status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.debug({ err: error }, 'request rejected');
    }

    return reply.status(status).send(toEnvelope(error));
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .status(404)
      .send(
        envelopeOf(
          `Route ${request.method} ${request.url} not found`,
          'invalid_request_error',
          'invalid_request',
        ),
      );
  });

  registerHealthz(app, deps.probes);
  registerChatCompletions(app, deps);

  return app;
}

export { ApiError };
