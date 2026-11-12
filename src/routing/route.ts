import type { Credential } from '../providers/types';
import type { RoutingStore } from './store';

/**
 * A candidate target eligible for routing.
 * Compatible with Candidate from src/core/execute and RankedTarget from src/routing/select.
 */
export interface Candidate {
  modelId: string;
  credential: Credential;
  providerId: string;
  adapterId: string;
  score?: number;
  remaining?: number;
}

export interface RouteOptions {
  /** Optional task bucket to select bucket-specific scores ('code', 'math', etc.). */
  bucket?: string;
  /** Fallback score for models not found in the routing table. Defaults to 0.5. */
  defaultScore?: number;
}

const DEFAULT_MODEL_SCORE = 0.5;

function applyRoutingTable<T extends Candidate>(
  rankedCandidates: ReadonlyArray<T>,
  scores: Map<string, number>,
  options?: RouteOptions,
): T[] {
  const defaultScore = options?.defaultScore ?? DEFAULT_MODEL_SCORE;

  const scored = rankedCandidates.map((candidate, originalIndex) => {
    // Model lookup priority: exact modelId -> providerId/modelId -> defaultScore
    const tableScore =
      scores.get(candidate.modelId) ??
      scores.get(`${candidate.providerId}/${candidate.modelId}`) ??
      defaultScore;

    return {
      candidate,
      originalIndex,
      tableScore,
    };
  });

  // Stable sort:
  // 1. Table score descending (higher is better fit / higher quality)
  // 2. Original index ascending (preserves Block 9's capacity and LRU spread order on tie)
  scored.sort((a, b) => {
    if (b.tableScore !== a.tableScore) {
      return b.tableScore - a.tableScore;
    }
    return a.originalIndex - b.originalIndex;
  });

  return scored.map((item) => {
    if ('score' in item.candidate) {
      return { ...item.candidate, score: item.tableScore };
    }
    return item.candidate;
  });
}

/**
 * Pure function: takes ranked candidates from Block 9 and applies the routing table store.
 *
 * Requirements:
 * - Pure function: no I/O, no clock, no network, no Redis.
 * - Does not mutate the input array.
 * - Invariant: preserves credential object references (never spreads or drops credential secrets).
 */
export function route<T extends Candidate = Candidate>(
  rankedCandidates: ReadonlyArray<T>,
  store: RoutingStore | Map<string, number>,
  options?: RouteOptions,
): T[] {
  let scores: Map<string, number>;
  if (store instanceof Map) {
    scores = store;
  } else if (typeof store.getScoresSync === 'function') {
    scores = store.getScoresSync(options?.bucket);
  } else {
    throw new Error(
      'RoutingStore must implement getScoresSync() for synchronous route(). Use routeAsync() if store is async-only.',
    );
  }

  return applyRoutingTable(rankedCandidates, scores, options);
}

/**
 * Async counterpart for stores that only support asynchronous getScores().
 */
export async function routeAsync<T extends Candidate = Candidate>(
  rankedCandidates: ReadonlyArray<T>,
  store: RoutingStore | Map<string, number>,
  options?: RouteOptions,
): Promise<T[]> {
  let scores: Map<string, number>;
  if (store instanceof Map) {
    scores = store;
  } else if (typeof store.getScoresSync === 'function') {
    scores = store.getScoresSync(options?.bucket);
  } else {
    scores = await store.getScores(options?.bucket);
  }

  return applyRoutingTable(rankedCandidates, scores, options);
}

export default { route, routeAsync };
