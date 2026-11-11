import type { Credential } from '../providers/types';

/** A key identifying one (credential, model) pair for ledger lookups. */
export type ReservationKey = string;

/** A snapshot of remaining budget per reservation key. */
export type LedgerSnapshot = Map<ReservationKey, { remaining: number; ttlMs: number }>;

/** Task buckets the router understands. */
export type TaskBucket = 'code' | 'reasoning' | 'creative' | 'analysis' | 'general';

/** Eval table: taskBucket -> modelId -> 0..1 score. */
export type EvalTable = Map<TaskBucket, Map<string, number>>;

/** One ranked target. */
export interface RankedTarget {
  modelId: string;
  credential: Credential;
  providerId: string;
  adapterId: string;
  score: number;
  /** Remaining budget in the tightest enforced window (for debugging). */
  remaining: number;
}

/** LRU timestamps per credential id. */
export type LruMap = Map<string, number>;

/** Options controlling the selection algorithm. */
export interface SelectOptions {
  /** Map of task bucket to eval scores per model. Higher = better fit. */
  evalTable: EvalTable;
  /** Task bucket this request falls into. */
  taskBucket: TaskBucket;
  /** LRU timestamps; credentials not present are treated as least-recently-used. */
  lru: LruMap;
  /** Maximum number of targets to return. 0 = all. */
  limit?: number;
}

/**
 * Build a reservation key exactly as the ledger does.
 */
export function reservationKey(credentialId: string, modelId: string): ReservationKey {
  return credentialId + ':' + modelId;
}

/**
 * Default eval table (placeholder - replaced by real scores from an eval harness).
 * Returns 0.5 for all models not explicitly listed.
 */
export function createDefaultEvalTable(): EvalTable {
  return new Map<TaskBucket, Map<string, number>>();
}

/**
 * Classify a request into a task bucket based on its content.
 * Heurestic only - a real eval harness would replace this.
 */
export function classifyTaskBucket(request: {
  messages: { role: string; content: string | null }[];
}): TaskBucket {
  const text = request.messages
    .map((m) => m.content ?? '')
    .join(' ')
    .toLowerCase();
  if (/\b(code|program|function|class|debug|refactor|api|endpoint)\b/.test(text)) return 'code';
  if (/\b(prove|reason|deduce|logic|step\.by\.step|chain\.of\.thought)\b/.test(text))
    return 'reasoning';
  if (/\b(story|poem|creative|write.*as.*if|imagine|roleplay)\b/.test(text)) return 'creative';
  if (/\b(analyze|compare|summarize|extract|classify|categorize)\b/.test(text)) return 'analysis';
  return 'general';
}

/**
 * Rank candidate (model, credential) pairs by:
 * 1. CAPACITY - only pairs with remaining > 0 in the tightest enforced window
 * 2. TASK FIT - evalTable[taskBucket][modelId] (0..1), higher first
 * 3. SPREAD - least-recently-used credential first (lower LRU timestamp wins)
 * 4. QUALITY - tie-break by a model quality score in evalTable['general'][modelId]
 *
 * Pure function: no I/O, no clock, no side effects.
 */
export function select(
  candidates: ReadonlyArray<{
    modelId: string;
    credential: Credential;
    providerId: string;
    adapterId: string;
  }>,
  ledgerSnapshot: LedgerSnapshot,
  options: SelectOptions,
): RankedTarget[] {
  const { evalTable, taskBucket, lru, limit = 0 } = options;

  // Build task-fit map for this bucket (missing = 0.5 default)
  const taskFitMap = evalTable.get(taskBucket) ?? new Map<string, number>();
  const qualityMap = evalTable.get('general') ?? new Map<string, number>();

  const DEFAULT_FIT = 0.5;
  const DEFAULT_QUALITY = 0.5;

  // Score each candidate
  const scored: RankedTarget[] = [];

  for (const { modelId, credential, providerId, adapterId } of candidates) {
    const key = reservationKey(credential.id, modelId);
    const budget = ledgerSnapshot.get(key);

    // CAPACITY FIRST: skip if any enforced window is exhausted
    if (budget !== undefined && budget.remaining <= 0) {
      continue;
    }

    const remaining = budget?.remaining ?? Infinity;
    const taskFit = taskFitMap.get(modelId) ?? DEFAULT_FIT;

    scored.push({ modelId, credential, providerId, adapterId, score: taskFit, remaining });
  }

  // Sort by the priority order: capacity > taskFit > spread > quality
  // Since we already filtered exhausted, all have capacity > 0.
  // Sort by tuple: [-taskFit, -spread, -quality]
  // spread: LRU lower wins (older timestamp = smaller number = better spread)
  scored.sort((a, b) => {
    // Task fit (higher wins)
    if (b.score !== a.score) return b.score - a.score;
    // Spread: LRU lower wins (older timestamp = smaller number = better spread)
    const spreadA = lru.get(a.credential.id) ?? 0;
    const spreadB = lru.get(b.credential.id) ?? 0;
    if (spreadA !== spreadB) return spreadA - spreadB;
    // Quality tie-break (higher wins)
    const qA = qualityMap.get(a.modelId) ?? DEFAULT_QUALITY;
    const qB = qualityMap.get(b.modelId) ?? DEFAULT_QUALITY;
    return qB - qA;
  });

  return limit > 0 ? scored.slice(0, limit) : scored;
}

export default { select, reservationKey, classifyTaskBucket, createDefaultEvalTable };
