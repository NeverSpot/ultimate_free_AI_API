import type { Pool } from 'pg';

export interface HealthCheckResult {
  ok: boolean;
  checks: { postgres: string; redis: string };
}

/**
 * Block 27: dependency probes for /healthz.
 *
 * Postgres and Redis are optional: an unwired dependency reports `not-configured`
 * and stays green. A failed probe reports `unhealthy` and flips `ok` to false;
 * the caller decides the HTTP status. Never claims a dependency is healthy
 * without asking it.
 */
export async function checkHealth(
  pgPool: Pool | null,
  redisClient: { ping: () => unknown } | null,
): Promise<HealthCheckResult> {
  const checks: { postgres: string; redis: string } = { postgres: 'not-configured', redis: 'not-configured' };
  let ok = true;

  try {
    if (pgPool) {
      await pgPool.query('SELECT 1');
      checks.postgres = 'healthy';
    } else {
      checks.postgres = 'not-configured';
    }
  } catch {
    checks.postgres = 'unhealthy';
    ok = false;
  }

  try {
    if (redisClient) {
      await redisClient.ping();
      checks.redis = 'healthy';
    } else {
      checks.redis = 'not-configured';
    }
  } catch {
    checks.redis = 'unhealthy';
    ok = false;
  }

  return { ok, checks };
}
