import type { ProviderRegistry } from '../providers/registry';
import type { Credential } from '../providers/types';

/**
 * Expand a request that does not name a concrete model ("free", "auto", or
 * nothing at all) into the full candidate set of free models the caller can
 * reach.
 *
 * Selection is NOT decided here. These candidates flow into the same `select()`
 * the rest of the gateway uses, so the winner is still chosen by the project's
 * routing signal order: capacity -> task fit -> spread -> quality. This module
 * only widens the pool to every free model across every provider the caller has
 * a key for - which is what makes several providers behave like one endpoint.
 */

/** How long a provider's free-model list is trusted before re-fetching. */
const TTL_MS = 60 * 60 * 1000; // 1 hour

/** provider id -> cached free model ids. */
const cache = new Map<string, { ids: string[]; at: number }>();

/** One candidate the router can rank. */
export interface FreeCandidate {
  modelId: string;
  credential: Credential;
  providerId: string;
  adapterId: string;
}

/**
 * True when the caller did not name a usable model, i.e. we should offer free
 * models. `undefined`, empty, `free` and `auto` all qualify (case-insensitive).
 */
export function isFreeRequest(model: string | undefined): boolean {
  if (model === undefined) return true;
  const normalised = model.trim().toLowerCase();
  return normalised === '' || normalised === 'free' || normalised === 'auto';
}

/**
 * Build the candidate set: every free model reachable through any of the
 * caller's credentials.
 *
 * Per-provider results are cached for an hour: `/models` is account-level, so
 * one lookup per provider serves every request that follows. A provider that
 * errors is skipped rather than failing the whole expansion.
 */
export async function resolveFreeCandidates(
  registry: ProviderRegistry,
  credentials: readonly Credential[],
): Promise<FreeCandidate[]> {
  const candidates: FreeCandidate[] = [];

  for (const credential of credentials) {
    const adapter = registry.get(credential.provider);
    if (adapter === undefined) continue;

    const cached = cache.get(credential.provider);
    let ids: string[];

    if (cached !== undefined && Date.now() - cached.at < TTL_MS) {
      ids = cached.ids;
    } else {
      try {
        const listed = await adapter.listModels(credential);
        ids = listed.filter((model) => model.is_free === true).map((model) => model.id);
        cache.set(credential.provider, { ids, at: Date.now() });
      } catch {
        continue; // provider unreachable - try the next credential
      }
    }

    for (const modelId of ids) {
      candidates.push({
        modelId,
        credential,
        providerId: credential.provider,
        adapterId: credential.provider,
      });
    }
  }

  return candidates;
}

/** Test-only: drop the cache so each test starts cold. */
export function clearFreeModelCache(): void {
  cache.clear();
}
