import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from './types';
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
  signal?: AbortSignal;
}

/** Options passed to executeStream(). */
export interface ExecuteStreamOptions extends ExecuteOptions {
  onFirstChunk?: (meta: ExecuteMeta) => void;
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

/**
 * Execute a streaming request through the capacity-aware failover ladder.
 *
 * Rank -> reserve -> call stream() -> first chunk.
 * Invariant: Failover ONLY before the first chunk is yielded.
 * Once the first chunk is yielded, subsequent failures throw without failover.
 */
export async function* executeStream(
  request: CanonicalRequest,
  candidates: ReadonlyArray<Candidate>,
  ledger: Ledger,
  policies: Map<string, LimitPolicy>,
  adapterMap: Map<string, AdapterMapEntry>,
  breaker: Breaker,
  options: ExecuteStreamOptions = {},
): AsyncIterable<CanonicalChunk> {
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
    onFirstChunk,
    signal,
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

    if (signal?.aborted) {
      if (reservation !== undefined) {
        await ledger.release(reservation);
      }
      throw new ProviderError('timeout', 'Client disconnected', {
        status: 499,
        provider: 'router',
      });
    }

    const attemptController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      attemptController.abort();
    }, callTimeoutMs);

    const onClientAbort = () => {
      attemptController.abort();
    };

    if (signal) {
      signal.addEventListener('abort', onClientAbort, { once: true });
    }

    let upstreamIterator: AsyncIterator<CanonicalChunk>;
    let firstItem: IteratorResult<CanonicalChunk>;

    try {
      const streamIterable = entry.adapter.stream(request, credential, attemptController.signal);
      upstreamIterator = streamIterable[Symbol.asyncIterator]();
      firstItem = await upstreamIterator.next();
    } catch (err) {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onClientAbort);
      }

      let providerErr: ProviderError;
      if (timedOut) {
        providerErr = new ProviderError('timeout', `Provider timeout after ${callTimeoutMs}ms`, {
          status: 504,
          provider: providerId,
        });
      } else if (signal?.aborted) {
        providerErr = new ProviderError('timeout', 'Client disconnected', {
          status: 499,
          provider: providerId,
        });
      } else {
        providerErr = toProviderError(err, providerId);
      }

      lastError = providerErr;

      if (reservation !== undefined) {
        await ledger.release(reservation);
      }

      if (signal?.aborted) {
        throw providerErr;
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
      continue;
    } finally {
      clearTimeout(timer);
    }

    // First chunk successfully obtained!
    await breaker.recordSuccess(bTarget);
    lru.set(credential.id, clock());
    const meta: ExecuteMeta = {
      providerId,
      modelId,
      credentialId: credential.id,
      attempts,
    };
    onFirstChunk?.(meta);

    if (firstItem.done) {
      if (reservation !== undefined) {
        await ledger.commit(reservation, reservation.cost);
      }
      onComplete?.(meta);
      if (signal) {
        signal.removeEventListener('abort', onClientAbort);
      }
      return;
    }

    yield firstItem.value;

    // Remaining chunks: failover is FORBIDDEN after first chunk.
    try {
      while (true) {
        if (signal?.aborted) {
          throw new ProviderError('timeout', 'Client disconnected', {
            status: 499,
            provider: providerId,
          });
        }
        const nextItem = await upstreamIterator.next();
        if (nextItem.done) {
          break;
        }
        yield nextItem.value;
      }

      if (reservation !== undefined) {
        await ledger.commit(reservation, reservation.cost);
      }
      onComplete?.(meta);
      return;
    } catch (err) {
      const providerErr = toProviderError(err, providerId);
      if (reservation !== undefined) {
        await ledger.commit(reservation, reservation.cost);
      }
      await breaker.recordFailure(bTarget);
      throw providerErr;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onClientAbort);
      }
      if (typeof upstreamIterator.return === 'function') {
        try {
          await upstreamIterator.return();
        } catch {
          // ignore cleanup errors
        }
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

/** Build a stateful-client executor bound to Redis-backed ledger and breaker instances. */
export function createExecutor(
  ledgerClient: LedgerClient,
  breakerClient: BreakerClient,
  options: ExecuteStreamOptions = {},
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
    executeStream: (
      request: CanonicalRequest,
      candidates: ReadonlyArray<Candidate>,
      policies: Map<string, LimitPolicy>,
      adapterMap: Map<string, AdapterMapEntry>,
      callOptions?: ExecuteStreamOptions,
    ) =>
      executeStream(request, candidates, ledger, policies, adapterMap, breaker, {
        ...options,
        ...callOptions,
      }),
  };
}
