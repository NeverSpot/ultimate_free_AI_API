import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ProviderError, type ErrorKind } from '../../src/core/errors';
import { execute, type AdapterMapEntry, type Candidate } from '../../src/core/execute';
import type { CanonicalRequest } from '../../src/core/types';
import { registerChatCompletions } from '../../src/http/routes/chat-completions';
import type { Config } from '../../src/config/env';
import type { Ledger, Reservation, ReserveResult } from '../../src/limits/ledger';
import type { LimitPolicy } from '../../src/limits/policy';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';
import type { AllowResult, Breaker, BreakerTarget } from '../../src/resilience/breaker';
import type { ParkDecision } from '../../src/resilience/park-decision';
import type { Parking, ParkingStatus } from '../../src/resilience/parking';
import {
  createDefaultEvalTable,
  reservationKey,
  type LedgerSnapshot,
  type LruMap,
} from '../../src/routing/select';

const BASE_TIME = 1_731_250_000_000;

function makeCred(id: string, provider = 'mock'): Credential {
  return { id, provider, secret: `secret-${id}` };
}

function makeRequest(model = 'mock-model'): CanonicalRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  };
}

interface FakeLedgerState {
  reserves: Array<{ credentialId: string; modelId: string; cost: number }>;
  commits: Array<{ reservation: Reservation; actualCost: number }>;
  releases: Reservation[];
  ledger: Ledger;
}

function makeFakeLedger(
  options: {
    failKeys?: Set<string>;
    rpmCeiling?: number;
    clock?: () => number;
  } = {},
): FakeLedgerState {
  const reserves: FakeLedgerState['reserves'] = [];
  const commits: FakeLedgerState['commits'] = [];
  const releases: FakeLedgerState['releases'] = [];
  const counts = new Map<string, number>();

  const ledger: Ledger = {
    async reserve({ credentialId, modelId, cost = 1 }): Promise<ReserveResult> {
      reserves.push({ credentialId, modelId, cost });
      const key = `${credentialId}:${modelId}`;
      if (options.failKeys?.has(key)) {
        return { ok: false, retryAfterMs: 30_000, window: 'rpm' };
      }

      if (options.rpmCeiling !== undefined) {
        const used = counts.get(key) ?? 0;
        if (used + cost > options.rpmCeiling) {
          return { ok: false, retryAfterMs: 60_000, window: 'rpm' };
        }
        counts.set(key, used + cost);
      }

      return {
        ok: true,
        reservation: {
          credentialId,
          modelId,
          cost,
          reserved: [{ window: 'rpm', key: `rl:${credentialId}:${modelId}:rpm`, amount: cost }],
        },
      };
    },
    async commit(reservation, actualCost): Promise<void> {
      commits.push({ reservation, actualCost });
    },
    async release(reservation): Promise<void> {
      releases.push(reservation);
      const key = `${reservation.credentialId}:${reservation.modelId}`;
      if (options.rpmCeiling !== undefined) {
        counts.set(key, Math.max(0, (counts.get(key) ?? 0) - reservation.cost));
      }
    },
  };

  return { reserves, commits, releases, ledger };
}

interface FakeBreakerState {
  allows: BreakerTarget[];
  successes: BreakerTarget[];
  failures: BreakerTarget[];
  openTargets: Set<string>;
  breaker: Breaker;
}

function makeFakeBreaker(threshold = 1): FakeBreakerState {
  const allows: BreakerTarget[] = [];
  const successes: BreakerTarget[] = [];
  const failures: BreakerTarget[] = [];
  const failureCounts = new Map<string, number>();
  const openTargets = new Set<string>();

  const keyOf = (t: BreakerTarget): string => `${t.provider}:${t.model}`;

  const breaker: Breaker = {
    async allow(target): Promise<AllowResult> {
      allows.push(target);
      if (openTargets.has(keyOf(target))) {
        return { allowed: false, retryAfterMs: 30_000, state: 'open' };
      }
      return { allowed: true };
    },
    async recordSuccess(target): Promise<void> {
      successes.push(target);
      const key = keyOf(target);
      failureCounts.delete(key);
      openTargets.delete(key);
    },
    async recordFailure(target): Promise<void> {
      failures.push(target);
      const key = keyOf(target);
      const count = (failureCounts.get(key) ?? 0) + 1;
      failureCounts.set(key, count);
      if (count >= threshold) {
        openTargets.add(key);
      }
    },
  };

  return { allows, successes, failures, openTargets, breaker };
}

interface FakeParkingState {
  parked: Map<string, number>;
  parks: Array<{ credentialId: string; untilMs: number }>;
  parking: Parking;
}

function makeFakeParking(clock: () => number): FakeParkingState {
  const parked = new Map<string, number>();
  const parks: FakeParkingState['parks'] = [];

  const parking: Parking = {
    async park(credentialId: string, untilMs: number): Promise<void> {
      parks.push({ credentialId, untilMs });
      parked.set(credentialId, untilMs);
    },
    async isParked(credentialId: string): Promise<ParkingStatus> {
      const until = parked.get(credentialId);
      if (until !== undefined && until > clock()) {
        return { parked: true, retryAfterMs: until - clock() };
      }
      return { parked: false, retryAfterMs: 0 };
    },
    async unpark(credentialId: string): Promise<void> {
      parked.delete(credentialId);
    },
    async applyDecision(credentialId: string, decision: ParkDecision, now: number): Promise<void> {
      if (decision.action === 'park' && decision.waitMs > 0) {
        const until = Number.isFinite(decision.waitMs) ? now + decision.waitMs : now + 604_800_000;
        await parking.park(credentialId, until);
      }
    },
  };

  return { parked, parks, parking };
}

test('execute: succeeds on 1st candidate, commits cost 1, records success and updates LRU', async () => {
  const now = BASE_TIME;
  const c1 = makeCred('cred-1', 'p1');
  const adapter = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    content: 'ok-1',
    now: () => now,
  });
  const candidates: Candidate[] = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([['p1', { adapter, providerId: 'p1' }]]);
  const policies = new Map<string, LimitPolicy>([['m1', { rpm: 10, observable: 'inferred' }]]);
  const fakeLedger = makeFakeLedger();
  const fakeBreaker = makeFakeBreaker();
  const lru: LruMap = new Map();

  const res = await execute(
    makeRequest('m1'),
    candidates,
    fakeLedger.ledger,
    policies,
    adapterMap,
    fakeBreaker.breaker,
    {
      clock: () => now,
      lru,
    },
  );

  assert.equal(res.choices[0]?.message.content, 'ok-1');
  assert.equal(adapter.getCallCount(), 1);
  assert.equal(fakeLedger.reserves.length, 1);
  assert.equal(fakeLedger.commits.length, 1);
  assert.equal(fakeLedger.commits[0]?.actualCost, 1);
  assert.equal(fakeLedger.releases.length, 0);
  assert.equal(fakeBreaker.successes.length, 1);
  assert.equal(fakeBreaker.failures.length, 0);
  assert.equal(lru.get(c1.id), now);
});

test('execute: failover on rate_limited parks credential and succeeds on 2nd without tripping breaker', async () => {
  const now = BASE_TIME;
  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');
  const a1 = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'rate_limited', retryAfterMs: 12_000 }],
    now: () => now,
  });
  const a2 = new MockProviderAdapter({ id: 'p2', model: 'm2', content: 'ok-2', now: () => now });

  const candidates: Candidate[] = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
    { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['p1', { adapter: a1, providerId: 'p1' }],
    ['p2', { adapter: a2, providerId: 'p2' }],
  ]);
  const policies = new Map<string, LimitPolicy>([
    ['m1', { rpm: 10, observable: 'inferred' }],
    ['m2', { rpm: 10, observable: 'inferred' }],
  ]);
  const fakeLedger = makeFakeLedger();
  const fakeBreaker = makeFakeBreaker();
  const fakeParking = makeFakeParking(() => now);

  const res = await execute(
    makeRequest('m1'),
    candidates,
    fakeLedger.ledger,
    policies,
    adapterMap,
    fakeBreaker.breaker,
    {
      clock: () => now,
      parking: fakeParking.parking,
    },
  );

  assert.equal(res.choices[0]?.message.content, 'ok-2');
  assert.equal(a1.getCallCount(), 1);
  assert.equal(a2.getCallCount(), 1);
  assert.equal(fakeLedger.releases.length, 1);
  assert.equal(fakeLedger.commits.length, 1);
  assert.equal(fakeBreaker.failures.length, 0);
  assert.equal(fakeParking.parks.length, 1);
  assert.equal(fakeParking.parks[0]?.credentialId, 'cred-1');
  assert.equal(fakeParking.parks[0]?.untilMs, now + 12_000);
});

test('execute: failover on upstream opens breaker and subsequent calls skip open target with zero network', async () => {
  const now = BASE_TIME;
  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');
  const a1 = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'upstream', status: 502, times: 5 }],
    now: () => now,
  });
  const a2 = new MockProviderAdapter({ id: 'p2', model: 'm2', content: 'ok-2', now: () => now });

  const candidates: Candidate[] = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
    { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['p1', { adapter: a1, providerId: 'p1' }],
    ['p2', { adapter: a2, providerId: 'p2' }],
  ]);
  const policies = new Map<string, LimitPolicy>([
    ['m1', { rpm: 10, observable: 'inferred' }],
    ['m2', { rpm: 10, observable: 'inferred' }],
  ]);
  const fakeLedger = makeFakeLedger();
  const fakeBreaker = makeFakeBreaker(1);

  const first = await execute(
    makeRequest('m1'),
    candidates,
    fakeLedger.ledger,
    policies,
    adapterMap,
    fakeBreaker.breaker,
    {
      clock: () => now,
    },
  );
  assert.equal(first.choices[0]?.message.content, 'ok-2');
  assert.equal(a1.getCallCount(), 1);
  assert.equal(fakeBreaker.failures.length, 1);
  assert.ok(fakeBreaker.openTargets.has('p1:m1'));

  const second = await execute(
    makeRequest('m1'),
    candidates,
    fakeLedger.ledger,
    policies,
    adapterMap,
    fakeBreaker.breaker,
    {
      clock: () => now,
    },
  );
  assert.equal(second.choices[0]?.message.content, 'ok-2');
  // OPEN breaker must make zero network calls to a1
  assert.equal(a1.getCallCount(), 1);
  assert.equal(a2.getCallCount(), 2);
});

test('execute: ledger reserve fail skips to next candidate with zero network calls', async () => {
  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');
  const a1 = new MockProviderAdapter({ id: 'p1', model: 'm1' });
  const a2 = new MockProviderAdapter({ id: 'p2', model: 'm2', content: 'ok-2' });

  const candidates: Candidate[] = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
    { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['p1', { adapter: a1, providerId: 'p1' }],
    ['p2', { adapter: a2, providerId: 'p2' }],
  ]);
  const policies = new Map<string, LimitPolicy>([
    ['m1', { rpm: 1, observable: 'inferred' }],
    ['m2', { rpm: 1, observable: 'inferred' }],
  ]);
  const fakeLedger = makeFakeLedger({ failKeys: new Set(['cred-1:m1']) });
  const fakeBreaker = makeFakeBreaker();

  const res = await execute(
    makeRequest('m1'),
    candidates,
    fakeLedger.ledger,
    policies,
    adapterMap,
    fakeBreaker.breaker,
  );
  assert.equal(res.choices[0]?.message.content, 'ok-2');
  assert.equal(a1.getCallCount(), 0);
  assert.equal(a2.getCallCount(), 1);
  assert.equal(fakeBreaker.failures.length, 0);
});

test('execute: terminal errors abort immediately without failover or breaker failure', async () => {
  const terminalKinds: ErrorKind[] = [
    'auth',
    'model_gone',
    'client',
    'blocked',
    'too_long',
    'unsupported',
  ];

  for (const kind of terminalKinds) {
    const c1 = makeCred('cred-1', 'p1');
    const c2 = makeCred('cred-2', 'p2');
    const a1 = new MockProviderAdapter({ id: 'p1', model: 'm1', failures: [{ kind }] });
    const a2 = new MockProviderAdapter({ id: 'p2', model: 'm2', content: 'should-not-run' });

    const candidates: Candidate[] = [
      { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
      { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
    ];
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['p1', { adapter: a1, providerId: 'p1' }],
      ['p2', { adapter: a2, providerId: 'p2' }],
    ]);
    const policies = new Map<string, LimitPolicy>([['m1', { rpm: 10, observable: 'inferred' }]]);
    const fakeLedger = makeFakeLedger();
    const fakeBreaker = makeFakeBreaker();

    await assert.rejects(
      () =>
        execute(
          makeRequest('m1'),
          candidates,
          fakeLedger.ledger,
          policies,
          adapterMap,
          fakeBreaker.breaker,
        ),
      (err: unknown) => err instanceof ProviderError && err.kind === kind,
    );

    assert.equal(a1.getCallCount(), 1);
    assert.equal(a2.getCallCount(), 0, `${kind} must abort without calling 2nd candidate`);
    assert.equal(fakeLedger.releases.length, 1);
    assert.equal(fakeBreaker.failures.length, 0);
  }
});

test('execute: all fail throws last ProviderError, and empty selection throws exhausted', async () => {
  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');
  const a1 = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'upstream', status: 500 }],
  });
  const a2 = new MockProviderAdapter({
    id: 'p2',
    model: 'm2',
    failures: [{ kind: 'rate_limited', retryAfterMs: 4_000, status: 429 }],
  });

  const candidates: Candidate[] = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
    { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['p1', { adapter: a1, providerId: 'p1' }],
    ['p2', { adapter: a2, providerId: 'p2' }],
  ]);
  const fakeLedger = makeFakeLedger();
  const fakeBreaker = makeFakeBreaker();

  await assert.rejects(
    () =>
      execute(
        makeRequest('m1'),
        candidates,
        fakeLedger.ledger,
        new Map(),
        adapterMap,
        fakeBreaker.breaker,
      ),
    (err: unknown) =>
      err instanceof ProviderError && err.kind === 'rate_limited' && err.retryAfterMs === 4_000,
  );

  const exhaustedSnapshot: LedgerSnapshot = new Map([
    [reservationKey(c1.id, 'm1'), { remaining: 0, ttlMs: 1_000 }],
    [reservationKey(c2.id, 'm2'), { remaining: 0, ttlMs: 1_000 }],
  ]);
  await assert.rejects(
    () =>
      execute(
        makeRequest('m1'),
        candidates,
        fakeLedger.ledger,
        new Map(),
        adapterMap,
        fakeBreaker.breaker,
        {
          ledgerSnapshot: exhaustedSnapshot,
        },
      ),
    (err: unknown) => err instanceof ProviderError && err.kind === 'exhausted',
  );
});

test('execute: respects maxAttempts and totalDeadlineMs caps', async () => {
  let clockMs = BASE_TIME;
  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');
  const c3 = makeCred('cred-3', 'p3');

  const slowTick = () => {
    clockMs += 150;
  };
  const a1 = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'upstream', when: () => (slowTick(), true) }],
  });
  const a2 = new MockProviderAdapter({
    id: 'p2',
    model: 'm2',
    failures: [{ kind: 'upstream' }],
  });
  const a3 = new MockProviderAdapter({ id: 'p3', model: 'm3', content: 'ok-3' });

  const candidates: Candidate[] = [
    { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
    { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
    { modelId: 'm3', credential: c3, providerId: 'p3', adapterId: 'p3' },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['p1', { adapter: a1, providerId: 'p1' }],
    ['p2', { adapter: a2, providerId: 'p2' }],
    ['p3', { adapter: a3, providerId: 'p3' }],
  ]);

  // totalDeadlineMs = 100ms, a1 advances clock by 150ms -> a2 and a3 never called
  await assert.rejects(
    () =>
      execute(
        makeRequest('m1'),
        candidates,
        makeFakeLedger().ledger,
        new Map(),
        adapterMap,
        makeFakeBreaker().breaker,
        { totalDeadlineMs: 100, clock: () => clockMs },
      ),
    (err: unknown) => err instanceof ProviderError && err.kind === 'upstream',
  );
  assert.equal(a1.getCallCount(), 1);
  assert.equal(a2.getCallCount(), 0);
  assert.equal(a3.getCallCount(), 0);

  // maxAttempts = 2 -> stops after a2 without calling a3
  clockMs = BASE_TIME;
  const a1Plain = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'upstream' }],
  });
  const a2Plain = new MockProviderAdapter({
    id: 'p2',
    model: 'm2',
    failures: [{ kind: 'upstream' }],
  });
  adapterMap.set('p1', { adapter: a1Plain, providerId: 'p1' });
  adapterMap.set('p2', { adapter: a2Plain, providerId: 'p2' });

  await assert.rejects(
    () =>
      execute(
        makeRequest('m1'),
        candidates,
        makeFakeLedger().ledger,
        new Map(),
        adapterMap,
        makeFakeBreaker().breaker,
        { maxAttempts: 2, totalDeadlineMs: 30_000, clock: () => clockMs },
      ),
    (err: unknown) => err instanceof ProviderError && err.kind === 'upstream',
  );
  assert.equal(a1Plain.getCallCount(), 1);
  assert.equal(a2Plain.getCallCount(), 1);
  assert.equal(a3.getCallCount(), 0);
});

test('capacity: 3 credentials at 30 RPM serve 60 requests in 1 minute with zero client 429s', async () => {
  const now = BASE_TIME;
  const adapter = new MockProviderAdapter({
    id: 'mock',
    model: 'pooled-model',
    rpmCeiling: 30,
    clock: () => now,
  });
  const creds = [makeCred('k1'), makeCred('k2'), makeCred('k3')];
  const candidates: Candidate[] = creds.map((credential) => ({
    modelId: 'pooled-model',
    credential,
    providerId: 'mock',
    adapterId: 'mock',
  }));
  const adapterMap = new Map<string, AdapterMapEntry>([['mock', { adapter, providerId: 'mock' }]]);
  const policies = new Map<string, LimitPolicy>([
    ['pooled-model', { rpm: 30, observable: 'inferred' }],
  ]);
  const fakeLedger = makeFakeLedger({ rpmCeiling: 30 });
  const fakeBreaker = makeFakeBreaker();
  const lru: LruMap = new Map();

  let tick = now;
  const responses = [];
  for (let i = 0; i < 60; i++) {
    tick += 1;
    const res = await execute(
      makeRequest('pooled-model'),
      candidates,
      fakeLedger.ledger,
      policies,
      adapterMap,
      fakeBreaker.breaker,
      { lru, clock: () => tick },
    );
    responses.push(res);
  }

  assert.equal(responses.length, 60);
  assert.equal(adapter.getCallCount(), 60);
  const perCredCounts = adapter.getRequestCounts();
  assert.equal(perCredCounts.get('k1'), 20);
  assert.equal(perCredCounts.get('k2'), 20);
  assert.equal(perCredCounts.get('k3'), 20);
});

test('failure: injected 30% 429s across pool -> 100% client success', async () => {
  const now = BASE_TIME;
  const adapter = new MockProviderAdapter({
    id: 'mock',
    model: 'resilient-model',
    failures: [
      {
        kind: 'rate_limited',
        retryAfterMs: 5_000,
        times: 100,
        when: (callIndex) => callIndex % 3 === 0,
      },
    ],
    clock: () => now,
  });
  const creds = [makeCred('k1'), makeCred('k2'), makeCred('k3')];
  const candidates: Candidate[] = creds.map((credential) => ({
    modelId: 'resilient-model',
    credential,
    providerId: 'mock',
    adapterId: 'mock',
  }));
  const adapterMap = new Map<string, AdapterMapEntry>([['mock', { adapter, providerId: 'mock' }]]);
  const fakeLedger = makeFakeLedger();
  const fakeBreaker = makeFakeBreaker();
  let tick = now;
  const fakeParking = makeFakeParking(() => tick);
  const evalTable = createDefaultEvalTable();

  for (let i = 0; i < 20; i++) {
    tick += 10_000; // Past any 5s park from earlier iterations
    const res = await execute(
      makeRequest('resilient-model'),
      candidates,
      fakeLedger.ledger,
      new Map(),
      adapterMap,
      fakeBreaker.breaker,
      { evalTable, parking: fakeParking.parking, clock: () => tick },
    );
    assert.ok(res.choices[0]?.message.content);
  }
});

test('http route: chat-completions wires execute() and maps rate_limited to 429 + Retry-After', async (t) => {
  const config: Config = {
    port: 0,
    adminToken: 'test-token',
    maxBodyBytes: 1_048_576,
    attemptTimeoutMs: 5_000,
    requestDeadlineMs: 15_000,
    logLevel: 'silent',
    nodeEnv: 'test',
  };

  const c1 = makeCred('cred-1', 'p1');
  const c2 = makeCred('cred-2', 'p2');
  const failing = new MockProviderAdapter({
    id: 'p1',
    model: 'm1',
    failures: [{ kind: 'rate_limited', retryAfterMs: 7_000, status: 429 }],
  });
  const winning = new MockProviderAdapter({ id: 'p2', model: 'm2', content: 'from-p2' });

  const app = Fastify({ logger: false });
  app.decorateRequest('gatewayRequestId', 'req-test-1');
  registerChatCompletions(app, {
    config,
    provider: failing,
    credential: c1,
    adapters: [failing, winning],
    candidates: [
      { modelId: 'm1', credential: c1, providerId: 'p1', adapterId: 'p1' },
      { modelId: 'm2', credential: c2, providerId: 'p2', adapterId: 'p2' },
    ],
    now: () => BASE_TIME,
  });
  t.after(async () => {
    await app.close();
  });

  // 1st request: p1 fails with 429, p2 succeeds -> 200 with failover headers
  const okRes = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer test-token' },
    payload: { model: 'm1', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.headers['x-gateway-provider'], 'p2');
  assert.equal(okRes.headers['x-gateway-attempts'], '2');

  // 2nd request: all fail with rate_limited -> 429 + Retry-After + OpenAI error envelope
  const rateLimitedAdapter = new MockProviderAdapter({
    id: 'p-rl',
    model: 'm-rl',
    failures: [{ kind: 'rate_limited', retryAfterMs: 4_500, status: 429 }],
  });
  const rlApp = Fastify({ logger: false });
  rlApp.decorateRequest('gatewayRequestId', 'req-test-2');
  registerChatCompletions(rlApp, {
    config,
    provider: rateLimitedAdapter,
    credential: c1,
    now: () => BASE_TIME,
  });
  t.after(async () => {
    await rlApp.close();
  });

  const rlRes = await rlApp.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer test-token' },
    payload: { model: 'm-rl', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(rlRes.statusCode, 429);
  assert.equal(rlRes.headers['retry-after'], '5');
  const rlBody = rlRes.json() as { error: { type: string; code: string } };
  assert.equal(rlBody.error.type, 'rate_limit_error');
  assert.equal(rlBody.error.code, 'rate_limited');
});
