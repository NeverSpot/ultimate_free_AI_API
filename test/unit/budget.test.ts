import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createMemoryBudgetLimiter,
  createBudgetLimiter,
  budgetUserKey,
  budgetReservationKey,
  type BudgetRedisClient,
  type BudgetLimiter,
} from '../../src/budget/limiter';
import {
  execute,
  executeStream,
  estimateWorstCaseCost,
  type AdapterMapEntry,
  type Candidate,
} from '../../src/core/execute';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalRequest } from '../../src/core/types';
import type { LimitPolicy } from '../../src/limits/policy';
import type { Ledger } from '../../src/limits/ledger';
import type { Breaker } from '../../src/resilience/breaker';
import type { ProviderAdapter } from '../../src/providers/types';

function makeRequest(
  messages = [{ role: 'user' as const, content: 'Hello world' }],
): CanonicalRequest {
  return {
    model: 'mock-model',
    messages,
    max_tokens: 1000,
    stream: false,
  };
}

function makeMockAdapter(
  options: {
    onChat?: () => void;
    onStream?: () => void;
    tokens?: number;
    shouldFail?: boolean;
  } = {},
): ProviderAdapter {
  return {
    id: 'mock',
    supportsStreaming: true,
    chat: async () => {
      options.onChat?.();
      if (options.shouldFail) {
        throw new ProviderError('upstream', 'Provider simulated error', {
          status: 502,
          provider: 'mock',
        });
      }
      const tokens = options.tokens ?? 20;
      return {
        id: 'chatcmpl-test',
        model: 'mock-model',
        created: Date.now(),
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Mock response' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: Math.floor(tokens / 2),
          completion_tokens: Math.ceil(tokens / 2),
          total_tokens: tokens,
        },
      };
    },
    stream: async function* () {
      options.onStream?.();
      if (options.shouldFail) {
        throw new ProviderError('upstream', 'Provider stream simulated error', {
          status: 502,
          provider: 'mock',
        });
      }
      yield {
        id: 'chunk-1',
        model: 'mock-model',
        created: Date.now(),
        delta: { role: 'assistant', content: 'chunk' },
        finish_reason: null,
      };
      yield {
        id: 'chunk-2',
        model: 'mock-model',
        created: Date.now(),
        delta: { content: '' },
        finish_reason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    },
    listModels: async () => [],
  };
}

function makeCandidate(): Candidate {
  return {
    modelId: 'mock-model',
    providerId: 'mock-provider',
    adapterId: 'mock-adapter',
    credential: {
      id: 'cred-1',
      provider: 'mock-provider',
      secret: 'secret-1',
      label: 'test',
    },
  };
}

const noopLedger: Ledger = {
  reserve: async () => ({
    ok: true,
    reservation: {
      credentialId: 'cred-1',
      modelId: 'mock-model',
      cost: 1,
      reserved: [],
    },
  }),
  release: async () => {},
  commit: async () => {},
};

const noopBreaker: Breaker = {
  allow: async () => ({ allowed: true }),
  recordSuccess: async () => {},
  recordFailure: async () => {},
};

describe('Budget Limiter: Hermetic unit tests', () => {
  it('estimateWorstCaseCost computes reasonable USD estimate', () => {
    const req = makeRequest();
    const cost = estimateWorstCaseCost(req);
    // 11 chars / 4 = 3 prompt tokens + 1000 max_tokens = 1003 tokens
    // 1003 / 1000 * 0.001 = ~$0.001003
    assert.ok(cost > 0.001);
    assert.ok(cost < 0.002);
  });

  it('key helpers produce correct redis key patterns', () => {
    assert.equal(budgetUserKey('u123'), 'budget:user:u123');
    assert.equal(budgetReservationKey('u123', 'res456'), 'budget:res:u123:res456');
  });

  it('createMemoryBudgetLimiter: reserve, reconcile and release lifecycle', async () => {
    const limiter = createMemoryBudgetLimiter();
    const userId = 'user-1';

    await limiter.setBudget(userId, { capUsd: 1.0 });
    const b0 = await limiter.getBudget(userId);
    assert.ok(b0);
    assert.equal(b0.capUsd, 1.0);
    assert.equal(b0.remainingUsd, 1.0);
    assert.equal(b0.spentUsd, 0);
    assert.equal(b0.reservedUsd, 0);

    // Reserve $0.40
    const res1 = await limiter.reserve(userId, 0.4);
    assert.equal(res1.ok, true);
    if (!res1.ok) return;
    assert.equal(res1.reservedUsd, 0.4);
    assert.equal(res1.remainingUsd, 0.6);

    // Reserve another $0.40 -> remaining $0.20
    const res2 = await limiter.reserve(userId, 0.4);
    assert.equal(res2.ok, true);
    if (!res2.ok) return;
    assert.equal(res2.remainingUsd, 0.2);

    // Attempting to reserve $0.30 should exceed the cap ($0.20 remaining)
    const res3 = await limiter.reserve(userId, 0.3);
    assert.equal(res3.ok, false);
    if (res3.ok) return;
    assert.equal(res3.reason, 'Spend budget cap exceeded');
    assert.equal(res3.remainingUsd, 0.2);

    // Reconcile res1 with actual spend of $0.15 (releasing $0.25 delta)
    const rec1 = await limiter.reconcile(userId, res1.reservationId, 0.15);
    assert.equal(rec1.ok, true);
    assert.equal(rec1.spentUsd, 0.15);
    assert.equal(rec1.reservedUsd, 0.4); // res2 still reserved
    // remaining is now 1.0 - (0.15 + 0.40) = 0.45
    assert.equal(rec1.remainingUsd, 0.45);

    // Now res3's $0.30 can be reserved!
    const res4 = await limiter.reserve(userId, 0.3);
    assert.equal(res4.ok, true);
    if (!res4.ok) return;
    assert.equal(res4.remainingUsd, 0.15);

    // Release res2 (cancelled request)
    const rel2 = await limiter.release(userId, res2.reservationId);
    assert.equal(rel2.ok, true);
    assert.equal(rel2.releasedUsd, 0.4);
    // remaining is now 1.0 - (0.15 spent + 0.30 reserved by res4) = 0.55
    assert.equal(rel2.remainingUsd, 0.55);

    // Idempotent release of res2 does not double-release
    const rel2Dup = await limiter.release(userId, res2.reservationId);
    assert.equal(rel2Dup.ok, true);
    assert.equal(rel2Dup.releasedUsd, 0);
    assert.equal(rel2Dup.remainingUsd, 0.55);

    // Reset budget
    await limiter.resetBudget(userId);
    const bReset = await limiter.getBudget(userId);
    assert.ok(bReset);
    assert.equal(bReset.spentUsd, 0);
    assert.equal(bReset.reservedUsd, 0);
    assert.equal(bReset.remainingUsd, 1.0);
  });

  it('createMemoryBudgetLimiter: returns no_budget when unconfigured without default cap', async () => {
    const limiter = createMemoryBudgetLimiter();
    const res = await limiter.reserve('unconfigured-user', 0.05);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'no_budget');
  });

  it('createMemoryBudgetLimiter: auto-provisions when defaultCapUsd is supplied', async () => {
    const limiter = createMemoryBudgetLimiter({ defaultCapUsd: 5.0 });
    const res = await limiter.reserve('auto-user', 1.0);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.capUsd, 5.0);
    assert.equal(res.remainingUsd, 4.0);
  });
});

describe('Budget Limiter: execute() integration', () => {
  it('over-cap request rejects with 429 before dispatch and makes 0 upstream calls', async () => {
    let upstreamCalled = false;
    const adapter = makeMockAdapter({
      onChat: () => {
        upstreamCalled = true;
      },
    });
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock-adapter', { adapter, providerId: 'mock-provider' }],
    ]);

    const limiter = createMemoryBudgetLimiter();
    const userId = 'capped-user';
    // User has $0.05 cap
    await limiter.setBudget(userId, { capUsd: 0.05 });

    const request = makeRequest();
    const candidates = [makeCandidate()];
    const policies = new Map<string, LimitPolicy>();

    // Worst-case cost $0.10 exceeds the $0.05 cap
    await assert.rejects(
      async () => {
        await execute(request, candidates, noopLedger, policies, adapterMap, noopBreaker, {
          userId,
          budgetLimiter: limiter,
          worstCaseUsd: 0.1,
        });
      },
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 429);
        assert.equal(err.kind, 'rate_limited');
        return true;
      },
    );

    // ZERO upstream calls made!
    assert.equal(upstreamCalled, false);

    // Budget remaining is unchanged
    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.spentUsd, 0);
    assert.equal(b.reservedUsd, 0);
    assert.equal(b.remainingUsd, 0.05);
  });

  it('successful request reserves worst-case and reconciles actual spend releasing delta', async () => {
    let upstreamCalled = false;
    const adapter = makeMockAdapter({
      onChat: () => {
        upstreamCalled = true;
      },
      tokens: 2000, // $0.002 actual cost
    });
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock-adapter', { adapter, providerId: 'mock-provider' }],
    ]);

    const limiter = createMemoryBudgetLimiter();
    const userId = 'user-ok';
    await limiter.setBudget(userId, { capUsd: 1.0 });

    const request = makeRequest();
    const candidates = [makeCandidate()];
    const policies = new Map<string, LimitPolicy>();

    // Worst-case cost $0.05, actual will be $0.002
    const res = await execute(request, candidates, noopLedger, policies, adapterMap, noopBreaker, {
      userId,
      budgetLimiter: limiter,
      worstCaseUsd: 0.05,
    });

    assert.equal(upstreamCalled, true);
    assert.equal(res.id, 'chatcmpl-test');

    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.reservedUsd, 0); // Reservation cleared
    assert.equal(b.spentUsd, 0.002); // Actual cost recorded
    // Delta released: remaining is 1.0 - 0.002 = 0.998
    assert.equal(b.remainingUsd, 0.998);
  });

  it('failed request releases reserved budget without recording spend', async () => {
    const adapter = makeMockAdapter({ shouldFail: true });
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock-adapter', { adapter, providerId: 'mock-provider' }],
    ]);

    const limiter = createMemoryBudgetLimiter();
    const userId = 'user-fail';
    await limiter.setBudget(userId, { capUsd: 0.5 });

    const request = makeRequest();
    const candidates = [makeCandidate()];
    const policies = new Map<string, LimitPolicy>();

    await assert.rejects(
      async () => {
        await execute(request, candidates, noopLedger, policies, adapterMap, noopBreaker, {
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

    // Budget reservation was released: spent is 0, reserved is 0, remaining is 0.50
    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.spentUsd, 0);
    assert.equal(b.reservedUsd, 0);
    assert.equal(b.remainingUsd, 0.5);
  });
});

describe('Budget Limiter: executeStream() integration', () => {
  it('over-cap stream request rejects with 429 before starting stream', async () => {
    let streamCalled = false;
    const adapter = makeMockAdapter({
      onStream: () => {
        streamCalled = true;
      },
    });
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock-adapter', { adapter, providerId: 'mock-provider' }],
    ]);

    const limiter = createMemoryBudgetLimiter();
    const userId = 'stream-user-capped';
    await limiter.setBudget(userId, { capUsd: 0.02 });

    const request = makeRequest();
    const candidates = [makeCandidate()];
    const policies = new Map<string, LimitPolicy>();

    await assert.rejects(
      async () => {
        const stream = executeStream(
          request,
          candidates,
          noopLedger,
          policies,
          adapterMap,
          noopBreaker,
          {
            userId,
            budgetLimiter: limiter,
            worstCaseUsd: 0.05,
          },
        );
        for await (const chunk of stream) {
          void chunk;
        }
      },
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 429);
        assert.equal(err.kind, 'rate_limited');
        return true;
      },
    );

    assert.equal(streamCalled, false);
  });

  it('successful stream reconciles usage tokens', async () => {
    const adapter = makeMockAdapter();
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock-adapter', { adapter, providerId: 'mock-provider' }],
    ]);

    const limiter = createMemoryBudgetLimiter();
    const userId = 'stream-user-ok';
    await limiter.setBudget(userId, { capUsd: 1.0 });

    const request = makeRequest();
    const candidates = [makeCandidate()];
    const policies = new Map<string, LimitPolicy>();

    const stream = executeStream(
      request,
      candidates,
      noopLedger,
      policies,
      adapterMap,
      noopBreaker,
      {
        userId,
        budgetLimiter: limiter,
        worstCaseUsd: 0.05,
      },
    );

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.equal(chunks.length, 2);

    const b = await limiter.getBudget(userId);
    assert.ok(b);
    assert.equal(b.reservedUsd, 0);
    // 20 total tokens / 1000 * 0.001 = $0.000020
    assert.ok(b.spentUsd > 0);
    assert.ok(b.remainingUsd > 0.999);
  });
});

describe('Budget Limiter: Redis script client binding', () => {
  it('createBudgetLimiter registers the command with Redis client and executes correctly', async () => {
    // Simulated Redis client storing state in memory
    const redisStore = new Map<string, Map<string, string>>();
    const redisKeys = new Map<string, string>();

    const fakeClient: BudgetRedisClient = {
      defineCommand(name, _def) {
        assert.equal(name, 'gatewayBudgetScript');
        return async (...args: Array<string | number>) => {
          const numKeys = Number(args[0]);
          const k1 = String(args[1]);
          const k2 = numKeys >= 2 ? String(args[2]) : '';
          const action = String(args[numKeys + 1]);

          if (action === 'set') {
            let hash = redisStore.get(k1);
            if (!hash) {
              hash = new Map();
              redisStore.set(k1, hash);
            }
            hash.set('cap_usd', String(args[numKeys + 2]));
            hash.set('spent_usd', String(args[numKeys + 3] ?? '0'));
            hash.set('reserved_usd', String(args[numKeys + 4] ?? '0'));
            return [1, hash.get('cap_usd'), hash.get('spent_usd'), hash.get('reserved_usd')];
          }

          if (action === 'get') {
            const hash = redisStore.get(k1);
            if (!hash) return [0, '0', '0', '0', 'not_found'];
            const cap = hash.get('cap_usd') ?? '0';
            const spent = hash.get('spent_usd') ?? '0';
            const res = hash.get('reserved_usd') ?? '0';
            const rem = String(Number(cap) - (Number(spent) + Number(res)));
            return [1, rem, cap, spent, res];
          }

          if (action === 'reserve') {
            const hash = redisStore.get(k1);
            if (!hash) return [0, '0', '0', '0', 'no_budget'];
            const cap = Number(hash.get('cap_usd') ?? '0');
            const spent = Number(hash.get('spent_usd') ?? '0');
            const res = Number(hash.get('reserved_usd') ?? '0');
            const worst = Number(args[numKeys + 2]);
            const resId = String(args[numKeys + 3]);

            if (spent + res + worst > cap) {
              return [0, String(cap - (spent + res)), String(cap), String(res), 'budget_exceeded'];
            }

            const newRes = res + worst;
            hash.set('reserved_usd', String(newRes));
            redisKeys.set(k2, String(worst));
            return [1, String(cap - (spent + newRes)), String(cap), String(newRes), resId];
          }

          if (action === 'reconcile') {
            const hash = redisStore.get(k1);
            const reserved = Number(redisKeys.get(k2) ?? '0');
            redisKeys.delete(k2);
            if (!hash) return [1, '0', '0', '0', '0'];
            const cap = Number(hash.get('cap_usd') ?? '0');
            const spent = Number(hash.get('spent_usd') ?? '0');
            const currRes = Number(hash.get('reserved_usd') ?? '0');
            const actual = Number(args[numKeys + 3]);
            const newSpent = spent + actual;
            const newRes = Math.max(0, currRes - reserved);
            hash.set('spent_usd', String(newSpent));
            hash.set('reserved_usd', String(newRes));
            return [
              1,
              String(cap - (newSpent + newRes)),
              String(newSpent),
              String(newRes),
              String(reserved),
            ];
          }

          if (action === 'release') {
            const hash = redisStore.get(k1);
            const reserved = Number(redisKeys.get(k2) ?? '0');
            redisKeys.delete(k2);
            if (!hash) return [1, '0', '0', '0', '0'];
            const cap = Number(hash.get('cap_usd') ?? '0');
            const spent = Number(hash.get('spent_usd') ?? '0');
            const currRes = Number(hash.get('reserved_usd') ?? '0');
            const newRes = Math.max(0, currRes - reserved);
            hash.set('reserved_usd', String(newRes));
            return [
              1,
              String(cap - (spent + newRes)),
              String(spent),
              String(newRes),
              String(reserved),
            ];
          }

          return [0, '0', '0', '0', 'unknown'];
        };
      },
    };

    const redisLimiter: BudgetLimiter = createBudgetLimiter(fakeClient);
    await redisLimiter.setBudget('r-user', { capUsd: 10.0 });
    const b = await redisLimiter.getBudget('r-user');
    assert.ok(b);
    assert.equal(b.capUsd, 10.0);
    assert.equal(b.remainingUsd, 10.0);

    const r = await redisLimiter.reserve('r-user', 2.0);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.remainingUsd, 8.0);

    const rec = await redisLimiter.reconcile('r-user', r.reservationId, 0.5);
    assert.equal(rec.spentUsd, 0.5);
    assert.equal(rec.remainingUsd, 9.5);
  });
});
