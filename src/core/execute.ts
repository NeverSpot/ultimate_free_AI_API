import type { CanonicalRequest, CanonicalResponse } from './types';
import type { Credential, ProviderAdapter } from '../providers/types';
import type { LimitPolicy } from '../limits/policy';
import { ProviderError, type ErrorKind } from './errors';
import { createLedger, type Ledger, type Reservation } from '../limits/ledger';
import {
  createBreaker,
  type Breaker,
  type BreakerClient,
  type BreakerTarget,
} from '../resilience/breaker';
import { parkDecision } from '../resilience/park-decision';
import type { Parking } from '../resilience/parking';
import {
  select,
  type EvalTable,
  type LedgerSnapshot,
  type LruMap,
  type TaskBucket,
  classifyTaskBucket,
  createDefaultEvalTable,
} from '../routing/select';
import type { LedgerClient } from '../limits/redis';

/** A candidate target eligible for selection and execution. */
export interface Candidate {
  modelId: string;
  credential: Credential;
  providerId: string;
  adapterId: string;
}

/** Metadata about the winning attempt, emitted on success. */
export interface ExecuteMeta {
  providerId: string;
  modelId: string;
  credentialId: string;
  attempts: number;
}

/** Options passed to execute(). */
export interface ExecuteOptions {
  maxAttempts?: number;
  totalDeadlineMs?: number;
  attemptTimeoutMs?: number;
  taskBucket?: TaskBucket;
  evalTable?: EvalTable;
  lru?: LruMap;
  ledgerSnapshot?: LedgerSnapshot;
  parking?: Parking;
  clock?: () => number;
  onComplete?: (meta: ExecuteMeta) => void;
}

/** Adapter map including the provider id for breaker keying. */
export interface AdapterMapEntry {
  adapter: ProviderAdapter;
  providerId: string;
}

const TERMINAL_KINDS: ReadonlySet<ErrorKind> = new Set([
  'auth',
  'model_gone',
  'client',
  'too_long',
  'blocked',
  'unsupported',
]);

function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  message: string,
  providerId: string,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError('timeout', message, { status: 504, provider: providerId }));
    }, ms);

    operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

function toProviderError(err: unknown, providerId: string): ProviderError {
  if (err instanceof ProviderError) {
    return err;
  }
  if (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  ) {
    return new ProviderError('timeout', err instanceof Error ? err.message : 'Request aborted', {
      status: 504,
      provider: providerId,
      cause: err,
    });
  }
  return new ProviderError('upstream', err instanceof Error ? err.message : String(err), {
    status: 502,
    provider: providerId,
    cause: err,
  });
}

/**
 * Execute a request through the capacity-aware failover ladder.
 *
 * Rank -> reserve -> call -> classify -> park/break/next.
 * Returns a canonical response or throws the last ProviderError.
 */
export async function execute(
  request: CanonicalRequest,
  candidates: ReadonlyArray<Candidate>,
  ledger: Ledger,
  policies: Map<string, LimitPolicy>,
  adapterMap: Map<string, AdapterMapEntry>,
  breaker: Breaker,
  options: ExecuteOptions = {},
): Promise<CanonicalResponse> {
  const {
    maxAttempts = 3,
    totalDeadlineMs = 30_000,
    attemptTimeoutMs = 10_000,
    taskBucket,
    evalTable = createDefaultEvalTable(),
    lru = new Map<string, number>(),
    ledgerSnapshot = new Map(),
    parking,
    clock = Date.now,
    onComplete,
  } = options;

  const startMs = clock();
  const deadlineMs = startMs + totalDeadlineMs;
  const bucket = taskBucket ?? classifyTaskBucket(request);

  const ranked = select(candidates, ledgerSnapshot, {
    evalTable,
    taskBucket: bucket,
    lru,
    limit: 0,
  });

  if (ranked.length === 0) {
    throw new ProviderError('exhausted', 'No available model with remaining capacity', {
      status: 503,
      provider: 'router',
    });
  }

  let attempts = 0;
  let lastError: ProviderError | undefined;
  const parkedThisCall = new Set<string>();

  for (const target of ranked) {
    if (attempts >= maxAttempts) {
      break;
    }

    const nowMs = clock();
    if (nowMs >= deadlineMs) {
      lastError ??= new ProviderError('timeout', 'Request deadline exceeded', {
        status: 504,
        provider: 'router',
      });
      break;
    }

    const { modelId, credential, providerId, adapterId } = target;

    if (parkedThisCall.has(credential.id)) {
      continue;
    }

    if (parking !== undefined) {
      const parkStatus = await parking.isParked(credential.id);
      if (parkStatus.parked) {
        lastError ??= new ProviderError('rate_limited', 'Credential is parked', {
          status: 429,
          retryAfterMs: parkStatus.retryAfterMs,
          provider: providerId,
        });
        continue;
      }
    }

    // Check breaker before reserving or calling upstream
    const bTarget: BreakerTarget = { provider: providerId, model: modelId };
    const permit = await breaker.allow(bTarget);
    if (!permit.allowed) {
      lastError ??= new ProviderError('upstream', 'Circuit breaker open', {
        status: 503,
        retryAfterMs: permit.retryAfterMs,
        provider: providerId,
      });
      continue;
    }

    const entry = adapterMap.get(adapterId);
    if (entry === undefined) {
      continue;
    }

    const policy = policies.get(modelId);
    let reservation: Reservation | undefined;

    if (policy !== undefined) {
      const reserveResult = await ledger.reserve({
        credentialId: credential.id,
        modelId,
        policy,
        cost: 1,
      });

      if (!reserveResult.ok) {
        lastError ??= new ProviderError('rate_limited', 'Rate limit ledger exhausted', {
          status: 429,
          retryAfterMs: reserveResult.retryAfterMs,
          provider: providerId,
        });
        continue;
      }
      reservation = reserveResult.reservation;
    }

    attempts += 1;
    const remainingBudgetMs = Math.max(1, deadlineMs - clock());
    const callTimeoutMs = Math.min(attemptTimeoutMs, remainingBudgetMs);

    try {
      const response = await withTimeout(
        (signal) => entry.adapter.chat(request, credential, signal),
        callTimeoutMs,
        `Provider timeout after ${callTimeoutMs}ms`,
        providerId,
      );

      await breaker.recordSuccess(bTarget);
      if (reservation !== undefined) {
        await ledger.commit(reservation, reservation.cost);
      }

      lru.set(credential.id, clock());
      onComplete?.({
        providerId,
        modelId,
        credentialId: credential.id,
        attempts,
      });
      return response;
    } catch (err) {
      const providerErr = toProviderError(err, providerId);
      lastError = providerErr;

      if (reservation !== undefined) {
        await ledger.release(reservation);
      }

      if (TERMINAL_KINDS.has(providerErr.kind)) {
        throw providerErr;
      }

      if (providerErr.kind === 'rate_limited') {
        parkedThisCall.add(credential.id);
        if (parking !== undefined) {
          const waitMs = providerErr.retryAfterMs ?? 1_000;
          await parking.park(credential.id, clock() + waitMs);
        }
        continue;
      }

      if (providerErr.kind === 'exhausted') {
        parkedThisCall.add(credential.id);
        if (parking !== undefined) {
          const decision = parkDecision({
            kind: 'exhausted',
            retryAfterMs: providerErr.retryAfterMs,
            now: clock(),
          });
          await parking.applyDecision(credential.id, decision, clock());
        }
        continue;
      }

      // upstream or timeout: trip per-(provider, model) breaker
      await breaker.recordFailure(bTarget);
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

/** Build a stateful-client executor bound to Redis-backed ledger and breaker instances. */
export function createExecutor(
  ledgerClient: LedgerClient,
  breakerClient: BreakerClient,
  options: ExecuteOptions = {},
) {
  const ledger = createLedger(ledgerClient);
  const breaker = createBreaker(breakerClient);

  return {
    execute: (
      request: CanonicalRequest,
      candidates: ReadonlyArray<Candidate>,
      policies: Map<string, LimitPolicy>,
      adapterMap: Map<string, AdapterMapEntry>,
      callOptions?: ExecuteOptions,
    ) =>
      execute(request, candidates, ledger, policies, adapterMap, breaker, {
        ...options,
        ...callOptions,
      }),
  };
}
