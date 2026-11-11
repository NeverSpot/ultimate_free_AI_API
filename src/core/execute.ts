import type { CanonicalRequest, CanonicalResponse } from './types';
import type { ProviderAdapter } from '../providers/types';
import type { LimitPolicy } from '../limits/policy';
import { ProviderError } from './errors';
import { createLedger, type Ledger, type Reservation } from '../limits/ledger';
import { parseErrorBody, classifyStatus } from '../resilience/classify';
import { createBreaker, type Breaker, type BreakerTarget } from '../resilience/breaker';
import {
  select,
  type RankedTarget,
  type LedgerSnapshot,
  type TaskBucket,
  classifyTaskBucket,
  createDefaultEvalTable,
} from '../routing/select';
import type { LedgerClient } from '../limits/redis';
import type { BreakerClient } from '../resilience/breaker';

/** Options passed to execute(). */
export interface ExecuteOptions {
  maxAttempts?: number;
  totalDeadlineMs?: number;
  attemptTimeoutMs?: number;
  taskBucket?: TaskBucket;
  evalTable?: Map<TaskBucket, Map<string, number>>;
  lru?: Map<string, number>;
  clock?: () => number;
}

/** Adapter map including the provider id for breaker keying. */
export interface AdapterMapEntry {
  adapter: ProviderAdapter;
  providerId: string;
}

function snapshot(): LedgerSnapshot {
  // The ledger doesn't expose a snapshot method directly.
  // For now return empty map - select() treats missing as unlimited.
  // A real implementation would need Ledger to expose internals.
  return new Map();
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderError('timeout', message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

/**
 * Execute a request through the capacity-aware failover ladder.
 *
 * Returns a canonical response or throws the last ProviderError.
 */
export async function execute(
  request: CanonicalRequest,
  candidates: RankedTarget[],
  ledger: Ledger,
  policies: Map<string, LimitPolicy>,
  adapterMap: Map<string, AdapterMapEntry>,
  breaker: Breaker,
  options: ExecuteOptions = {},
): Promise<CanonicalResponse> {
  const {
    maxAttempts = 3,
    totalDeadlineMs = 30000,
    attemptTimeoutMs = 10000,
    taskBucket,
    evalTable = createDefaultEvalTable(),
    lru = new Map<string, number>(),
    clock = Date.now,
  } = options;

  const startMs = clock();
  let lastError: ProviderError | undefined;

  let ranked = [...candidates];

  for (let attempt = 0; attempt < maxAttempts && clock() < startMs + totalDeadlineMs; attempt++) {
    const snap = snapshot();
    ranked = select(
      ranked.map(({ modelId, credential, providerId, adapterId }) => ({
        modelId,
        credential,
        providerId,
        adapterId,
      })),
      snap,
      {
        evalTable,
        taskBucket: taskBucket ?? classifyTaskBucket(request),
        lru,
        limit: 0,
      },
    );

    if (ranked.length === 0) {
      throw new ProviderError('exhausted', 'No available model with remaining capacity', {
        status: 503,
        provider: 'router',
      });
    }

    for (const target of ranked) {
      const { modelId, credential, providerId, adapterId } = target;

      // Check breaker before attempting
      const bTarget: BreakerTarget = { provider: providerId, model: modelId };
      const { allowed } = await breaker.allow(bTarget);
      if (!allowed) continue;

      const policy = policies.get(modelId);
      let reservation: Reservation | undefined;

      if (policy) {
        const reserveResult = await ledger.reserve({
          credentialId: credential.id,
          modelId,
          policy,
          cost: 1,
        });

        if (!reserveResult.ok) continue;
        reservation = reserveResult.reservation;
      }

      const entry = adapterMap.get(adapterId);
      if (!entry) continue;

      try {
        const response = await withTimeout(
          entry.adapter.chat(request, credential),
          attemptTimeoutMs,
          'Provider timeout after ' + attemptTimeoutMs + 'ms',
        );

        if (reservation) {
          const actualCost = response.usage.prompt_tokens + response.usage.completion_tokens;
          await ledger.commit(reservation, actualCost);
        }

        lru.set(credential.id, clock());
        return response;
      } catch (err) {
        lastError =
          err instanceof ProviderError
            ? err
            : new ProviderError('upstream', String(err), { cause: err });

        if (reservation) {
          await ledger.release(reservation);
        }

        // Classify the error
        const parsed = parseErrorBody(lastError.status ?? 0, lastError.message);
        const classification = classifyStatus(
          lastError.status ?? 0,
          parsed,
          undefined, // headers
          { provider: providerId, now: clock() },
        );

        if (classification.kind === 'rate_limited') {
          continue;
        }
        if (classification.kind === 'upstream' || classification.kind === 'timeout') {
          await breaker.recordFailure(bTarget);
          continue;
        }
        if (
          ['auth', 'model_gone', 'client', 'too_long', 'blocked', 'unsupported'].includes(
            classification.kind,
          )
        ) {
          throw lastError;
        }
        if (classification.kind === 'exhausted') {
          continue;
        }
        continue;
      }
    }
  }

  throw (
    lastError ??
    new ProviderError('upstream', 'All routing attempts failed', {
      status: 503,
      provider: 'router',
    })
  );
}

export function createExecutor(
  ledgerClient: LedgerClient,
  breakerClient: BreakerClient,
  options: ExecuteOptions = {},
) {
  const ledger = createLedger(ledgerClient);
  const breaker = createBreaker(breakerClient);

  return {
    execute: async (
      request: CanonicalRequest,
      candidates: RankedTarget[],
      policies: Map<string, LimitPolicy>,
      adapterMap: Map<string, AdapterMapEntry>,
    ) => execute(request, candidates, ledger, policies, adapterMap, breaker, options),
  };
}
