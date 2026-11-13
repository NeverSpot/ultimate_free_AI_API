/** Health status of a provider, tracked by `providers/health`. */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Failure thresholds (within the current process) for downgrading and removing a
 * provider. A provider starts `healthy`, becomes `degraded` after a handful of
 * failures and `unhealthy` — eligible for automatic removal from routing — after a
 * sustained run of failures.
 */
const DEGRADED_THRESHOLD = 2;
const UNHEALTHY_THRESHOLD = 5;

interface HealthEntry {
  failures: number;
  lastFailureAtMs: number;
}

const state = new Map<string, HealthEntry>();

/**
 * Per-provider failure tracker. Failures are never decayed within a process: a
 * provider that keeps failing stays unhealthy until the underlying issue is fixed.
 */
export const healthTracker = {
  recordFailure(provider: string): void {
    const entry = state.get(provider);
    if (entry === undefined) {
      state.set(provider, { failures: 1, lastFailureAtMs: Date.now() });
      return;
    }
    entry.failures += 1;
    entry.lastFailureAtMs = Date.now();
  },

  health(provider: string): HealthStatus {
    const failures = state.get(provider)?.failures ?? 0;
    if (failures >= UNHEALTHY_THRESHOLD) return 'unhealthy';
    if (failures >= DEGRADED_THRESHOLD) return 'degraded';
    return 'healthy';
  },

  all(): Record<string, HealthStatus> {
    const result: Record<string, HealthStatus> = {};
    for (const provider of state.keys()) {
      const failures = state.get(provider)?.failures ?? 0;
      result[provider] =
        failures >= UNHEALTHY_THRESHOLD
          ? 'unhealthy'
          : failures >= DEGRADED_THRESHOLD
            ? 'degraded'
            : 'healthy';
    }
    return result;
  },
};
