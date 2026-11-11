import { loadCredentialPool } from '../src/credentials/pool';
import type { CredentialPool } from '../src/credentials/pool';
import { createDbClient } from '../src/db/client';
import type { DbClient } from '../src/db/client';
import { defaultAdapters } from '../src/providers/defaults';
import { createProviderRegistry, discoverModels } from '../src/providers/registry';
import type {
  DiscoveryFailure,
  DiscoveryResult,
  ProviderRegistry,
} from '../src/providers/registry';
import type { ProviderId } from '../src/providers/types';
import { deleteMissingModels, upsertModels } from '../src/registry/store';

/** Hourly. Kept as a constant rather than an env var: the plan fixes the cadence. */
export const WATCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SyncReport {
  /** Rows sent to the upsert in this run. */
  upserted: number;
  /** Providers whose catalog was listed and written. */
  refreshed: ProviderId[];
  /** Providers that threw; their existing rows are left untouched. */
  failed: DiscoveryFailure[];
  /** Rows removed because a successful refresh no longer lists them. */
  delisted: number;
  /** Registered providers with no credentials; also left untouched. */
  unconfigured: ProviderId[];
  /** 0 when at least one provider refreshed, 1 when none did. */
  exitCode: 0 | 1;
}

/**
 * Split discovery outcome into the three buckets the report prints.
 *
 * "Refreshed" is decided by *having credentials and not failing*, not by the model
 * count: a provider that legitimately lists zero models was refreshed successfully.
 * Unconfigured is checked first so a missing key is never reported as an error.
 */
export function classifyDiscovery(
  registry: ProviderRegistry,
  result: DiscoveryResult,
  pool: CredentialPool,
): Pick<SyncReport, 'refreshed' | 'failed' | 'unconfigured' | 'exitCode'> {
  const failedProviders = new Set(result.failures.map((failure) => failure.provider));
  const refreshed: ProviderId[] = [];
  const unconfigured: ProviderId[] = [];

  for (const provider of registry.ids()) {
    if (pool.getCandidates(provider).length === 0) {
      unconfigured.push(provider);
      continue;
    }

    if (!failedProviders.has(provider)) {
      refreshed.push(provider);
    }
  }

  return {
    refreshed,
    failed: result.failures,
    unconfigured,
    exitCode: refreshed.length > 0 ? 0 : 1,
  };
}

/** Render the report in the shape the runbook quotes. Pure. */
export function formatSyncReport(report: SyncReport): string[] {
  const lines = [`Upserted: ${report.upserted} models`];

  const refreshedDetail = report.refreshed.length === 0 ? '' : ` (${report.refreshed.join(', ')})`;
  lines.push(`Providers refreshed: ${report.refreshed.length}${refreshedDetail}`);

  for (const failure of report.failed) {
    lines.push(`Skipped (error): ${failure.provider} [${failure.kind}] ${failure.message}`);
  }
  if (report.delisted > 0) {
    lines.push(`Delisted: ${report.delisted} model(s) removed`);
  }
  for (const provider of report.unconfigured) {
    lines.push(`Skipped (no creds): ${provider}`);
  }

  return lines;
}

/**
 * One refresh: discover, classify, upsert.
 *
 * Only `result.models` is written, and `discoverModels` only emits models for
 * providers that answered — so a failed provider is never deleted, never nulled,
 * and keeps its last-known-good rows with a stale `checked_at`.
 */
export async function syncOnce(
  client: DbClient,
  registry: ProviderRegistry,
  pool: CredentialPool,
  now: Date = new Date(),
): Promise<SyncReport> {
  const result = await discoverModels(registry, pool);
  const classified = classifyDiscovery(registry, result, pool);
  const upserted = await upsertModels(client, result.models, now);

  // Reconcile only providers that actually answered: a failed provider keeps its
  // last-known-good rows, which is the whole point of that rule.
  let delisted = 0;
  for (const provider of classified.refreshed) {
    const seen = result.models
      .filter((model) => model.provider === provider)
      .map((model) => model.id);
    delisted += await deleteMissingModels(client, provider, seen);
  }

  return { ...classified, upserted, delisted };
}

function printReport(report: SyncReport, prefix = ''): void {
  for (const line of formatSyncReport(report)) {
    console.log(`${prefix}${line}`);
  }
}

/**
 * Hourly loop that never resolves until SIGINT/SIGTERM.
 *
 * Overlapping ticks are skipped rather than queued: a slow provider list must not
 * build a backlog of refreshes. A tick that throws is logged and the loop survives —
 * a transient database blip must not end the watchdog.
 */
function watch(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    let inFlight: Promise<void> | null = null;

    const tick = (): void => {
      if (inFlight !== null) {
        console.log('registry:sync: previous refresh still running, skipping this tick');
        return;
      }

      const startedAt = new Date().toISOString();
      inFlight = run()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`registry:sync: ${startedAt} refresh failed: ${message}`);
        })
        .finally(() => {
          inFlight = null;
        });
    };

    const timer = setInterval(tick, WATCH_INTERVAL_MS);

    const stop = (signal: NodeJS.Signals): void => {
      clearInterval(timer);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      // Wait out an in-flight refresh so `finally` can close the pool cleanly
      // instead of yanking the connection mid-query.
      const pending = inFlight ?? Promise.resolve();
      void pending.finally(() => {
        console.log(`registry:sync: ${signal} received, stopped`);
        resolve();
      });
    };

    const onSigint = (): void => stop('SIGINT');
    const onSigterm = (): void => stop('SIGTERM');

    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

/** CLI edge. The only place in this file that reads `process.env`. */
async function main(argv: readonly string[]): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (connectionString === undefined || connectionString.length === 0) {
    console.error('registry:sync: DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  let pool: CredentialPool;
  try {
    pool = loadCredentialPool(process.env);
  } catch {
    console.error('registry:sync: failed to load the credential pool');
    process.exitCode = 1;
    return;
  }

  const registry = createProviderRegistry(defaultAdapters());
  const client = createDbClient(connectionString);
  const watchMode = argv.includes('--watch');

  try {
    const first = await syncOnce(client, registry, pool);
    printReport(first);

    if (!watchMode) {
      process.exitCode = first.exitCode;
      return;
    }

    console.log(`registry:sync: watching, next refresh in ${WATCH_INTERVAL_MS / 60_000} minutes`);

    await watch(async () => {
      const at = new Date().toISOString();
      printReport(await syncOnce(client, registry, pool), `[${at}] `);
    });
  } finally {
    // On a watch stop this runs after the in-flight refresh, so no query is cut off.
    await client.close();
  }
}

if (require.main === module) {
  void main(process.argv).catch((error: unknown) => {
    console.error(`registry:sync: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
