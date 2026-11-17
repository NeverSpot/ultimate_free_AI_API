import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
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
import { registerModelsRoute } from './routes/models';
import { registerProvidersRoute } from './routes/providers';
import organizationsRoute from './routes/organizations';
import { registerSpendCapRoutes } from './routes/spend-caps';
import type { createGatewayKeyAuth } from './middleware/gateway-key-auth';
import { createJwtAuth } from './middleware/jwt-auth';
import { registerUserRoutes } from './routes/user';
import type { UserModel } from '../models/user';
import type { UserProviderKeyModel } from '../models/user-provider-key';
import type { OrganizationModel } from '../models/organization';
import type { Parking, ParkingStatus } from '../resilience/parking';

export interface ServerDeps {
  config: Config;
  /** Block 3 swaps the real adapter in; routes never change. */
  provider: ProviderAdapter;
  /**
   * Real provider adapters (openrouter, nvidia, tokenharbor, …). When omitted the
   * registry contains only `provider`, so BYOK credentials for any other provider
   * are silently skipped and chat fails with "All routing attempts failed".
   */
  adapters?: ProviderAdapter[];
  /** Phase A: one fixed credential. */
  credential: Credential;
  now?: () => number;
  logger?: boolean;
  /** Optional dependency probes for /healthz. Unwired probes report `unknown`. */
  probes?: HealthProbes;
  idempotencyService?: IdempotencyService;
  userStore?: UserModel;
  providerKeyStore?: UserProviderKeyModel;
  /**
   * Force the per-key health reader for `/v1/user/keys`. Normally omitted — the
   * server defaults it to the parking instance the router builds — and it reports
   * "not parked" only when there is no parking at all.
   */
  isParked?: (credentialId: string) => Promise<ParkingStatus>;
  /**
   * Parking for the credential pool. The router builds one when this is omitted;
   * supplying it lets a composition root share one instance with any other route
   * that needs per-credential park state.
   */
  parking?: Parking;
  gatewayKeyAuth?: ReturnType<typeof createGatewayKeyAuth>;
  jwtCookieAuth?: JwtCookieAuth;
  orgStore?: OrganizationModel;
}

/** Structural type so server.ts does not import the JWT middleware implementation. */
export interface JwtCookieAuth {
  tryAuthenticate(req: FastifyRequest): Promise<{ userId: string; username: string } | null>;
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
  const userStore = deps.userStore;
  const jwtCookieAuth =
    deps.jwtCookieAuth ??
    (userStore && deps.config.jwtSecret
      ? createJwtAuth({
          jwtSecret: deps.config.jwtSecret,
          findUserById: (id) => userStore.findById(id),
        })
      : undefined);

  if (gatewayKeyAuth || jwtCookieAuth) {
    app.addHook('onRequest', async (request) => {
      const url = request.url;
      if (url === '/healthz' || url.startsWith('/v1/auth/')) return;

      // The JWT cookie is accepted ONLY on /v1/user/*: chat stays on gateway keys,
      // which keeps the streaming endpoint off the CSRF surface.
      if (url.startsWith('/v1/user/') && jwtCookieAuth) {
        const jwtUser = await jwtCookieAuth.tryAuthenticate(request);
        if (jwtUser) {
          request.user = { id: jwtUser.userId, username: jwtUser.username };
          return;
        }
      }
      if (gatewayKeyAuth && (await gatewayKeyAuth.tryAuthenticate(request))) return;
      throw new ApiError('auth', 'missing or invalid credentials');
    });
  }

  // Block 25: request tracing — every response carries x-request-id.
  app.register(traceIdPlugin);
  // Block 26: Prometheus metrics endpoint at GET /metrics.
  app.register(metricsRoute);

  registerHealthz(app, deps.probes);
  // Keep the runtime: parking is constructed inside it, so its instance is the only
  // real per-credential health reader in the process.
  const chatRuntime = registerChatCompletions(app, deps);
  registerModelsRoute(app);

  // Auth is a core route. If production is built without a user store, fail at
  // startup rather than letting every registration request 500 on an undefined store.
  if (deps.userStore) {
    registerAuthRoutes(app, {
      userStore: deps.userStore,
      jwtSecret: deps.config.jwtSecret,
      nodeEnv: deps.config.nodeEnv,
    });
    registerUserRoutes(app, { userStore: deps.userStore });
  } else if (deps.config.nodeEnv === 'production') {
    throw new Error('buildServer: userStore is required when NODE_ENV=production');
  }

  if (deps.providerKeyStore) {
    const parking = chatRuntime.parking;
    // The module-level `isParked` helper from `resilience/parking` is deliberately
    // NOT used: nothing calls `configureParking`, so it throws on every call. The
    // router's instance is the real reader, which is why per-key health works out
    // of the box rather than needing a composition-root hook.
    const keyHealth =
      deps.isParked ?? (parking === undefined ? undefined : (id: string) => parking.isParked(id));

    registerUserKeyRoutes(app, {
      providerKeyStore: deps.providerKeyStore,
      getUserId: (req) => req.user?.id ?? null,
      encryptionKey: deps.config.encryptionKey,
      isParked: keyHealth,
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
