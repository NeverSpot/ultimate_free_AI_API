import type { FastifyInstance } from 'fastify';
import { healthTracker } from '../../providers/health';
import { PROVIDER_SPECS } from '../../providers/catalog';

/**
 * The provider surfaces.
 *
 * `GET /v1/providers` is the catalog the keys screen renders: it must describe every
 * provider the gateway knows about, not only the ones configured on this host, because
 * a user adds their own key to whichever row they choose.
 *
 * `GET /v1/providers/health` reports observed health for providers the router has
 * actually exercised. Used by the dashboard and operators to spot sustained failures
 * before customers do.
 */
export function registerProvidersRoute(app: FastifyInstance): void {
  app.get('/v1/providers', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      providers: PROVIDER_SPECS.map((spec) => ({
        id: spec.id,
        name: spec.name,
        tier: spec.tier,
        key_env_var: spec.keyEnvVar,
        free_note: spec.freeNote,
        signup_url: spec.signupUrl,
        docs_url: spec.docsUrl,
        aliases: spec.aliases ?? [],
        requires_env: spec.requiresEnv ?? null,
      })),
    });
  });

  app.get('/v1/providers/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      providers: healthTracker.all(),
    });
  });
}
