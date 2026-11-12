import type { FastifyInstance } from 'fastify';
import {
  createExecutor,
  execute,
  executeStream,
  type AdapterMapEntry,
  type Candidate,
  type ExecuteOptions,
  type ExecuteStreamOptions,
} from '../../core/execute';
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from '../../core/types';
import type { CredentialPool } from '../../credentials/pool';
import { createLedger, type Ledger } from '../../limits/ledger';
import type { LimitPolicy } from '../../limits/policy';
import { createLedgerClient, type LedgerClient } from '../../limits/redis';
import type { ProviderRegistry } from '../../providers/registry';
import type { ProviderAdapter } from '../../providers/types';
import { type Breaker, type BreakerClient } from '../../resilience/breaker';
import { createParking, type Parking } from '../../resilience/parking';
import type { EvalTable, LruMap } from '../../routing/select';
import {
  createMemoryIdempotencyService,
  createRedisIdempotencyService,
  type IdempotencyClient,
  type IdempotencyService,
} from '../middleware/idempotency';
import type { ServerDeps } from '../server';

export interface ChatRouterDeps {
  pool?: CredentialPool;
  registry?: ProviderRegistry;
  adapters?: ProviderAdapter[];
  candidates?: ReadonlyArray<Candidate>;
  policies?: Map<string, LimitPolicy>;
  redisUrl?: string;
  ledgerClient?: LedgerClient;
  breakerClient?: BreakerClient;
  idempotencyService?: IdempotencyService;
  idempotencyClient?: IdempotencyClient;
  ledger?: Ledger;
  breaker?: Breaker;
  parking?: Parking;
  evalTable?: EvalTable;
  lru?: LruMap;
  maxAttempts?: number;
  keepaliveIntervalMs?: number;
}

export class RouterRuntime {
  readonly parking: Parking | undefined;
  readonly idempotencyService: IdempotencyService;
  private readonly ledger: Ledger;
  private readonly breaker: Breaker;
  private readonly executor?: ReturnType<typeof createExecutor>;

  constructor(deps: {
    parking?: Parking;
    ledger: Ledger;
    breaker: Breaker;
    executor?: ReturnType<typeof createExecutor>;
    idempotencyService: IdempotencyService;
  }) {
    this.parking = deps.parking;
    this.ledger = deps.ledger;
    this.breaker = deps.breaker;
    this.executor = deps.executor;
    this.idempotencyService = deps.idempotencyService;
  }

  async run(
    req: CanonicalRequest,
    candidates: ReadonlyArray<Candidate>,
    policies: Map<string, LimitPolicy>,
    adapterMap: Map<string, AdapterMapEntry>,
    options: ExecuteOptions,
  ): Promise<CanonicalResponse> {
    if (this.executor !== undefined) {
      return this.executor.execute(req, candidates, policies, adapterMap, options);
    }
    return execute(req, candidates, this.ledger, policies, adapterMap, this.breaker, options);
  }

  async *runStream(
    req: CanonicalRequest,
    candidates: ReadonlyArray<Candidate>,
    policies: Map<string, LimitPolicy>,
    adapterMap: Map<string, AdapterMapEntry>,
    options: ExecuteStreamOptions,
  ): AsyncIterable<CanonicalChunk> {
    if (this.executor !== undefined) {
      yield* this.executor.executeStream(req, candidates, policies, adapterMap, options);
      return;
    }
    yield* executeStream(req, candidates, this.ledger, policies, adapterMap, this.breaker, options);
  }
}

export function buildRouterRuntime(
  app: FastifyInstance,
  deps: ServerDeps & ChatRouterDeps,
  now: () => number,
  lru: LruMap,
  evalTable: EvalTable,
): RouterRuntime {
  let ownedRedisClient: LedgerClient | undefined;
  let ledgerClient = deps.ledgerClient;
  let breakerClient = deps.breakerClient;

  if (deps.redisUrl !== undefined && (ledgerClient === undefined || breakerClient === undefined)) {
    ownedRedisClient = createLedgerClient(deps.redisUrl);
    ledgerClient ??= ownedRedisClient;
    breakerClient ??= ownedRedisClient;
    app.addHook('onClose', async () => {
      ownedRedisClient?.disconnect();
    });
  }

  let idempotencyService = deps.idempotencyService;
  if (idempotencyService === undefined) {
    const redisClient = deps.idempotencyClient ?? ledgerClient;
    if (redisClient !== undefined) {
      idempotencyService = createRedisIdempotencyService(redisClient);
    } else {
      idempotencyService = createMemoryIdempotencyService({ clock: now });
    }
  }

  if (deps.ledger !== undefined || deps.breaker !== undefined) {
    const ledger = deps.ledger ?? createLedger(noopClient());
    const breaker = deps.breaker ?? passThroughBreaker();
    return new RouterRuntime({
      parking: deps.parking,
      ledger,
      breaker,
      idempotencyService,
    });
  }

  if (ledgerClient !== undefined && breakerClient !== undefined) {
    const executor = createExecutor(ledgerClient, breakerClient, {
      totalDeadlineMs: deps.config.requestDeadlineMs,
      attemptTimeoutMs: deps.config.attemptTimeoutMs,
      evalTable,
      lru,
      clock: now,
    });
    const parking = deps.parking ?? createParking(ledgerClient);
    const ledger = createLedger(ledgerClient);
    const breaker = passThroughBreaker();
    return new RouterRuntime({
      parking,
      ledger,
      breaker,
      executor,
      idempotencyService,
    });
  }

  // Hermetic Phase A fallback when no Redis client is wired (e.g. unit http.test.ts).
  const ledger = createLedger(noopClient());
  const breaker = passThroughBreaker();
  return new RouterRuntime({
    parking: deps.parking,
    ledger,
    breaker,
    idempotencyService,
  });
}

function noopClient(): LedgerClient {
  return {
    defineCommand() {
      throw new Error('chat-completions: Redis LedgerClient is required for enforced limits');
    },
    disconnect() {},
  };
}

function passThroughBreaker(): Breaker {
  return {
    allow: async () => ({ allowed: true }),
    recordSuccess: async () => {},
    recordFailure: async () => {},
  };
}
