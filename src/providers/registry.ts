import { ProviderError } from '../core/errors';
import type { CredentialPool } from '../credentials/pool';
import type { ModelInfo, ProviderAdapter, ProviderId } from './types';

/**
 * The registered adapters, addressable by provider id.
 *
 * Registration order is preserved because it is also discovery order — mirroring
 * `pool.providers()` keeps the CLI table deterministic from run to run.
 */
export interface ProviderRegistry {
  get(id: ProviderId): ProviderAdapter | undefined;
  ids(): ProviderId[];
  size(): number;
}

/** One provider whose catalog could not be listed. Never carries a credential. */
export interface DiscoveryFailure {
  provider: ProviderId;
  kind: string;
  message: string;
}

export interface DiscoveryResult {
  /** Every model from every reachable provider, tagged with its provider id. */
  models: ModelInfo[];
  /** Providers that threw; empty when every configured provider answered. */
  failures: DiscoveryFailure[];
}

/**
 * Build a registry from adapters, in the order given.
 *
 * A duplicate id throws instead of last-wins/first-wins: either silently hides a
 * wiring bug or the collision, and both end up with the wrong provider answering.
 */
export function createProviderRegistry(adapters: ProviderAdapter[]): ProviderRegistry {
  const byId = new Map<ProviderId, ProviderAdapter>();
  const order: ProviderId[] = [];

  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`Duplicate provider adapter id "${adapter.id}"`);
    }

    byId.set(adapter.id, adapter);
    order.push(adapter.id);
  }

  return {
    get(id: ProviderId): ProviderAdapter | undefined {
      if (id === 'nvidia-nim') return byId.get('nvidia');
      return byId.get(id);
    },
    ids(): ProviderId[] {
      return [...order];
    },
    size(): number {
      return order.length;
    },
  };
}

/**
 * List every registered provider's catalog, sequentially and in registration order.
 *
 * The pool is injected so this module never reads `process.env`. Only the first
 * credential per provider is used: `/models` is account-level, so merging keys would
 * emit each model N times, and silently falling back to key 2 would hide a bad key.
 *
 * One provider failing must not abort the run, so each call is isolated and the
 * failure is reported rather than rethrown. `is_free` is passed through verbatim —
 * the adapters own that signal, and `null` (unknown) is never coerced to `false`.
 */
export async function discoverModels(
  registry: ProviderRegistry,
  pool: CredentialPool,
): Promise<DiscoveryResult> {
  const models: ModelInfo[] = [];
  const failures: DiscoveryFailure[] = [];

  for (const id of registry.ids()) {
    const adapter = registry.get(id);
    if (adapter === undefined) {
      continue;
    }

    const credentials = pool.getCandidates(id);
    if (credentials.length === 0) {
      // Unconfigured is not a fault: no env var for this provider, nothing to list.
      continue;
    }

    const credential = credentials[0];
    if (credential === undefined) {
      continue;
    }

    try {
      const listed = await adapter.listModels(credential);
      for (const model of listed) {
        models.push({ ...model, provider: adapter.id });
      }
    } catch (error) {
      failures.push({
        provider: id,
        kind: error instanceof ProviderError ? error.kind : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { models, failures };
}
