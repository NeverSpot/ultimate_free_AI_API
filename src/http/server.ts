import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/env';
import { DEFAULT_CORS_ORIGIN } from '../config/env';
import { newRequestId } from '../core/ids';
import type { Credential, ProviderAdapter } from '../providers/types';
import { ApiError, envelopeOf, headersForError, statusForError, toEnvelope } from './errors';
import type { IdempotencyService } from './middleware/idempotency';
import { registerChatCompletions } from './routes/chat-completions';
import { registerHealthz, type HealthProbes } from './routes/healthz';
import { registerAuthRoutes } from './routes/auth';
import { registerUserKeyRoutes } from './routes/user-keys';
import traceIdPlugin from './middleware/trace-id';
import metricsRoute from './routes/metrics';
import cacheMiddleware from './middleware/cache-middleware';
import { registerProvidersRoute } from './routes/providers';
import organizationsRoute from './routes/organizations';
import { registerSpendCapRoutes } from './routes/spend-caps';
import type { createGatewayKeyAuth } from './middleware/gateway-key-auth';
import type { UserModel } from '../models/user';
import type { UserProviderKeyModel } from '../models/user-provider-key';
import type { OrganizationModel } from '../models/organization';

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
  idempotencyService?: IdempotencyService;
  userStore?: UserModel;
  providerKeyStore?: UserProviderKeyModel;
  gatewayKeyAuth?: ReturnType<typeof createGatewayKeyAuth>;
  orgStore?: OrganizationModel;
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

  // CORS: allow the Next.js frontend at http://localhost:3000 to call this API.
  // OPTIONS preflight is answered here with 204, which short-circuits every
  // later onRequest hook (including gateway-key auth) so preflight never hits auth.
  const corsOrigin = deps.config.corsOrigin ?? DEFAULT_CORS_ORIGIN;
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header('Access-Control-Allow-Origin', corsOrigin);
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Allow-Credentials', 'true');

    if (_request.method === 'OPTIONS') {
      reply.status(204).send();
      return;
    }

    done();
  });

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

  // Block 29: cache middleware wraps POST /v1/chat/completions as a preHandler
  // hook, so it is wired before the routes it intercepts.
  cacheMiddleware(app);

  const gatewayKeyAuth = deps.gatewayKeyAuth;
  if (gatewayKeyAuth) {
    app.addHook('onRequest', async (request, _reply) => {
      const url = request.url;
      if (url === '/healthz' || url.startsWith('/v1/auth/')) return;
      await gatewayKeyAuth.authenticate(request);
    });
  }

  // Block 25: request tracing — every response carries x-request-id.
  app.register(traceIdPlugin);
  // Block 26: Prometheus metrics endpoint at GET /metrics.
  app.register(metricsRoute);

  registerHealthz(app, deps.probes);
  registerChatCompletions(app, deps);

  // Auth is a core route. If production is built without a user store, fail at
  // startup rather than letting every registration request 500 on an undefined store.
  if (deps.userStore) {
    registerAuthRoutes(app, { userStore: deps.userStore });
  } else if (deps.config.nodeEnv === 'production') {
    throw new Error('buildServer: userStore is required when NODE_ENV=production');
  }

  if (deps.providerKeyStore) {
    registerUserKeyRoutes(app, {
      providerKeyStore: deps.providerKeyStore,
      getUserId: (req) => req.user?.id ?? null,
      encryptionKey: deps.config.encryptionKey,
    });
  } else if (deps.config.nodeEnv === 'production') {
    throw new Error('buildServer: providerKeyStore is required when NODE_ENV=production');
  }

  registerSpendCapRoutes(app);

  // Block 28: graceful shutdown — stop accepting requests and close the server
  // on SIGTERM, then exit. `index.ts` installs its own handler for production;
  // this keeps `buildServer` hermetic and testable.
  process.on('SIGTERM', async () => {
    await app.close();
    process.exit(0);
  });

  // Block 30: provider health endpoint at GET /v1/providers/health.
  registerProvidersRoute(app);

  // Block 34: organizations & team key pools — enabled when a db-backed
  // orgStore is provided (index.ts does not wire a database client today).
  if (deps.orgStore) {
    app.register(organizationsRoute, { orgStore: deps.orgStore });
  }

  return app;
}

export { ApiError };
