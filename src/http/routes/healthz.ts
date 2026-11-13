import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { HealthResponse } from '../schemas';
import { checkHealth } from '../../telemetry/health';

const VERSION = '0.1.0';

export type CheckStatus = 'ok' | 'degraded' | 'down' | 'unknown';
export type Probe = () => Promise<CheckStatus> | CheckStatus;

export interface HealthProbes {
  redis?: Probe;
  postgres?: Probe;
}

/**
 * An unwired probe reports `unknown`, never `ok`. Claiming a dependency is healthy
 * without asking it is a fabricated operational signal, and the degradation matrix in
 * docs/architecture.md is only useful if this endpoint tells the truth.
 *
 * Each probe declares its own severity:
 *   'down'     -> fatal, the response is 503 (Redis, from Block 6: admitting traffic
 *                 without a ledger over-serves the pool into 429s)
 *   'degraded' -> non-fatal, the response is 200 (Postgres: accounting degrades, traffic
 *                 keeps flowing)
 *   'unknown'  -> probe not wired yet
 * healthz itself stays generic: it never decides which dependency is fatal.
 */
async function runProbe(probe: Probe | undefined): Promise<CheckStatus> {
  if (!probe) {
    return 'unknown';
  }

  try {
    return await probe();
  } catch {
    return 'down';
  }
}

export function registerHealthz(
  app: FastifyInstance,
  probes: HealthProbes = {},
  pgPool: Pool | null = null,
  redisClient: { ping: () => unknown } | null = null,
): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();

  server.get(
    '/healthz',
    { schema: { response: { 200: HealthResponse, 503: HealthResponse } } },
    async (_req, reply) => {
      let redis: CheckStatus = 'unknown';
      let postgres: CheckStatus = 'unknown';

      if (pgPool || redisClient) {
        // Block 27: real dependency probes when pools are wired into the server.
        const result = await checkHealth(pgPool, redisClient);
        redis = toCheckStatus(result.checks.redis);
        postgres = toCheckStatus(result.checks.postgres);
      } else {
        redis = await runProbe(probes.redis);
        postgres = await runProbe(probes.postgres);
      }

      const checks = { redis, postgres };
      const values = [redis, postgres];
      const down = values.includes('down');
      const status = down
        ? ('down' as const)
        : values.includes('degraded')
          ? ('degraded' as const)
          : ('ok' as const);

      return reply.status(down ? 503 : 200).send({
        status,
        checks,
        version: VERSION,
        uptime_s: Math.floor(process.uptime()),
      });
    },
  );
}

/**
 * Map checkHealth vocabulary onto the healthz status vocabulary so the
 * response schema stays faithful: never 'ok' for an unchecked dependency.
 */
function toCheckStatus(v: string): CheckStatus {
  if (v === 'healthy') return 'ok';
  if (v === 'unhealthy') return 'down';
  return 'unknown';
}
