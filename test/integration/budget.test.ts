import assert from 'node:assert/strict';
import { test, describe, before, beforeEach, after } from 'node:test';
import Redis from 'ioredis';
import { createBudgetLimiter, type BudgetLimiter } from '../../src/budget/limiter';
import { createLedgerClient, type LedgerClient } from '../../src/limits/redis';
import { createLedger } from '../../src/limits/ledger';
import { createBreaker } from '../../src/resilience/breaker';
import { createDbClient } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { execute, type AdapterMapEntry, type Candidate } from '../../src/core/execute';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalRequest, CanonicalResponse } from '../../src/core/types';
import type { LimitPolicy } from '../../src/limits/policy';
import type { ProviderAdapter } from '../../src/providers/types';

function makeAdapter(chatFn: () => Promise<CanonicalResponse>): ProviderAdapter {
  return {
    id: 'mock',
    supportsStreaming: false,
    chat: chatFn,
    stream: async function* () {
      yield* [];
    },
    listModels: async () => [],
  };
}

const REDIS_URL = process.env.REDIS_URL?.trim() ?? '';
const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';

const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn ? 'RUN_INTEGRATION !== 1' : !REDIS_URL ? 'REDIS_URL is not set' : false;

function makeRequest(model = 'mock-model'): CanonicalRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Integration test message' }],
    max_tokens: 500,
    stream: false,
  };
}

function makeCandidate(id: string): Candidate {
  return {
    modelId: 'mock-model',
    providerId: 'mock-provider',
    adapterId: 'mock',
    credential: {
      id,
      provider: 'mock-provider',
      secret: 'secret-key',
      label: 'test-cred',
    },
  };
}

describe('User spend budget (redis integration)', { skip }, () => {
  let redis: Redis;
  let ledgerClient: LedgerClient;
  let dbClient: ReturnType<typeof createDbClient> | undefined;
  let limiter: BudgetLimiter;

  before(async () => {
    redis = new Redis(REDIS_URL);
    await redis.ping();

    ledgerClient = createLedgerClient(REDIS_URL);

    if (DATABASE_URL) {
      dbClient = createDbClient(DATABASE_URL);
      await runMigrations(dbClient);
    }

    limiter = createBudgetLimiter(ledgerClient, { dbClient });
  });

  beforeEach(async () => {
    await redis.flushdb();
    if (dbClient) {
      await dbClient.query('delete from spend_budgets');
    }
  });

  after(async () => {
    await redis?.flushdb();
    redis?.disconnect();
    ledgerClient?.disconnect();
    if (dbClient) {
      await dbClient.close();
    }
  });

  test('request over cap produces 429 before dispatch with zero upstream calls', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    // User has a $0.05 cap
    await limiter.setBudget(userId, { capUsd: 0.05 });

    let upstreamCalls = 0;
    const adapter = makeAdapter(async () => {
      upstreamCalls += 1;
      return {
        id: 'cmpl-1',
        model: 'mock-model',
        created: Date.now(),
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    });

    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter, providerId: 'mock-provider' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);
    const policies = new Map<string, LimitPolicy>();
    const candidates = [makeCandidate('cred-1')];

    // Request with worst-case cost $0.10 > cap $0.05
    await assert.rejects(
      async () => {
        await execute(makeRequest(), candidates, ledger, policies, adapterMap, breaker, {
          userId,
          budgetLimiter: limiter,
          worstCaseUsd: 0.1,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ProviderError, 'must throw ProviderError');
        assert.equal(err.status, 429, 'must be status 429');
        assert.equal(err.kind, 'rate_limited', 'must be kind rate_limited');
        return true;
      },
    );

    // CRITICAL REQUIREMENT: Zero upstream calls made!
    assert.equal(upstreamCalls, 0, 'zero upstream cost incurred on rejection');

    // Budget state in Redis remains at cap
    const budget = await limiter.getBudget(userId);
    assert.ok(budget);
    assert.equal(budget.spentUsd, 0);
    assert.equal(budget.reservedUsd, 0);
    assert.equal(budget.remainingUsd, 0.05);
  });

  test('successful request reserves worst-case, reconciles actual usage, and releases delta', async () => {
    const userId = '22222222-2222-4222-8222-222222222222';
    // User has $1.00 cap
    await limiter.setBudget(userId, { capUsd: 1.0 });

    let upstreamCalls = 0;
    const adapter = makeAdapter(async () => {
      upstreamCalls += 1;
      // 1000 tokens = $0.001 actual cost
      return {
        id: 'cmpl-2',
        model: 'mock-model',
        created: Date.now(),
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 },
      };
    });

    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter, providerId: 'mock-provider' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);
    const policies = new Map<string, LimitPolicy>();
    const candidates = [makeCandidate('cred-1')];

    // Worst-case $0.05
    const res = await execute(makeRequest(), candidates, ledger, policies, adapterMap, breaker, {
      userId,
      budgetLimiter: limiter,
      worstCaseUsd: 0.05,
    });

    assert.equal(upstreamCalls, 1);
    assert.equal(res.id, 'cmpl-2');

    // After reconcile: spent is 0.001, reserved is 0, remaining is 0.999
    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.spentUsd, 0.001);
    assert.equal(b.reservedUsd, 0);
    assert.equal(b.remainingUsd, 0.999);
  });

  test('failed upstream request releases reserved budget without recording spend', async () => {
    const userId = '33333333-3333-4333-8333-333333333333';
    await limiter.setBudget(userId, { capUsd: 0.5 });

    const adapter = makeAdapter(async () => {
      throw new ProviderError('upstream', 'Server crash', { status: 502, provider: 'mock' });
    });

    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter, providerId: 'mock-provider' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);
    const policies = new Map<string, LimitPolicy>();
    const candidates = [makeCandidate('cred-1')];

    await assert.rejects(
      async () => {
        await execute(makeRequest(), candidates, ledger, policies, adapterMap, breaker, {
          userId,
          budgetLimiter: limiter,
          worstCaseUsd: 0.1,
          maxAttempts: 1,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        return true;
      },
    );

    // Reservation was released
    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.spentUsd, 0);
    assert.equal(b.reservedUsd, 0);
    assert.equal(b.remainingUsd, 0.5);
  });

  test('concurrent requests race atomically against budget ceiling in Redis', async () => {
    const userId = '44444444-4444-4444-8444-444444444444';
    // Cap is $0.05
    await limiter.setBudget(userId, { capUsd: 0.05 });

    let upstreamCount = 0;
    const adapter = makeAdapter(async () => {
      upstreamCount += 1;
      return {
        id: 'cmpl-race',
        model: 'mock-model',
        created: Date.now(),
        choices: [
          { index: 0, message: { role: 'assistant', content: 'race' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    });

    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter, providerId: 'mock-provider' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);
    const policies = new Map<string, LimitPolicy>();
    const candidates = [makeCandidate('cred-1')];

    // Launch 10 simultaneous requests each reserving $0.01 against $0.05 cap
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        execute(makeRequest(), candidates, ledger, policies, adapterMap, breaker, {
          userId,
          budgetLimiter: limiter,
          worstCaseUsd: 0.01,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly 5 requests must succeed and 5 must be rejected with 429
    assert.equal(succeeded.length, 5, 'exactly 5 requests fit within $0.05 cap');
    assert.equal(rejected.length, 5, 'exactly 5 requests rejected');
    assert.equal(upstreamCount, 5, 'upstream called exactly 5 times');

    for (const r of rejected) {
      if (r.status === 'rejected') {
        assert.ok(r.reason instanceof ProviderError);
        assert.equal(r.reason.status, 429);
      }
    }
  });

  test('Postgres spend_budgets table persists and hydrates budget if dbClient is provided', async () => {
    if (!dbClient) return;

    const userId = '55555555-5555-4555-8555-555555555555';
    // Insert directly into Postgres
    await dbClient.query(
      `insert into spend_budgets (user_id, cap_usd, period, reserved_usd, spent_usd)
       values ($1, $2, $3, $4, $5)`,
      [userId, 2.5, 'monthly', 0, 0],
    );

    // Redis does not have the key yet! Limiter should hydrate from Postgres on get or reserve
    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.capUsd, 2.5);
    assert.equal(b.remainingUsd, 2.5);

    // Reserve through limiter updates Redis
    const res = await limiter.reserve(userId, 0.5);
    assert.equal(res.ok, true);

    // Reconcile spend
    if (res.ok) {
      await limiter.reconcile(userId, res.reservationId, 0.1);
    }

    // Verify Postgres row was updated
    const pgRow = await dbClient.query<{ spent_usd: string; cap_usd: string }>(
      'select spent_usd, cap_usd from spend_budgets where user_id = $1',
      [userId],
    );
    assert.equal(pgRow.rows.length, 1);
    assert.equal(Number(pgRow.rows[0]!.spent_usd), 0.1);
    assert.equal(Number(pgRow.rows[0]!.cap_usd), 2.5);
  });
});
