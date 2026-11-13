import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterMapEntry, Candidate } from '../../src/core/execute';
import { execute } from '../../src/core/execute';
import type { CanonicalRequest } from '../../src/core/types';
import type { LimitPolicy } from '../../src/limits/policy';
import type { Ledger, Reservation } from '../../src/limits/ledger';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';
import { healthTracker } from '../../src/providers/health';
import { isUnhealthy } from '../../src/resilience/breaker';
import type { AllowResult, Breaker, BreakerTarget } from '../../src/resilience/breaker';

function makeCred(id: string, provider = 'mock'): Credential {
  return { id, provider, secret: `secret-${id}` };
}

function makeRequest(model = 'm1'): CanonicalRequest {
  return { model, messages: [{ role: 'user', content: 'Hello' }], stream: false };
}

function makeFakeLedger(): Ledger {
  const reservation: Reservation = {
    credentialId: 'c1',
    modelId: 'm1',
    cost: 0,
    reserved: [],
  };
  return {
    reserve: async () => ({ ok: true, reservation }),
    release: async () => {},
    commit: async () => {},
  };
}

function makeFakeBreaker(): Breaker {
  return {
    allow: async (_target: BreakerTarget): Promise<AllowResult> => ({ allowed: true }),
    recordSuccess: async () => {},
    recordFailure: async () => {},
  };
}

function deadCandidate(cred: Credential): Candidate {
  return {
    modelId: 'm1',
    credential: cred,
    providerId: 'dead-provider',
    adapterId: 'dead-provider',
  };
}

test('breaker auto-remove: a healthy provider is not unhealthy', () => {
  assert.equal(healthTracker.health('nvidia-nim'), 'healthy');
  assert.equal(isUnhealthy('nvidia-nim'), false);
});

test('breaker auto-remove: five sustained failures mark a provider unhealthy', () => {
  for (let i = 0; i < 5; i++) {
    healthTracker.recordFailure('dead-provider');
  }
  assert.equal(healthTracker.health('dead-provider'), 'unhealthy');
  assert.equal(isUnhealthy('dead-provider'), true);
  // other providers are unaffected
  assert.equal(healthTracker.health('live-provider'), 'healthy');
});

test('breaker auto-remove: execute returns 503 exhausted when every candidate is unhealthy', async () => {
  for (let i = 0; i < 5; i++) {
    healthTracker.recordFailure('dead-provider');
  }
  const adapter = new MockProviderAdapter({
    id: 'dead-provider',
    model: 'm1',
    content: 'never-used',
  });
  const cred = makeCred('c1', 'dead-provider');
  const candidates: Candidate[] = [deadCandidate(cred)];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['dead-provider', { adapter, providerId: 'dead-provider' }],
  ]);
  await assert.rejects(
    execute(
      makeRequest('m1'),
      candidates,
      makeFakeLedger(),
      new Map<string, LimitPolicy>(),
      adapterMap,
      makeFakeBreaker(),
      {},
    ),
    (err: Error & { status?: number; kind?: string }) =>
      err.status === 503 && err.kind === 'exhausted',
  );
  assert.equal(adapter.getCallCount(), 0);
});

test('breaker auto-remove: execute routes to the healthy provider when another is unhealthy', async () => {
  for (let i = 0; i < 5; i++) {
    healthTracker.recordFailure('dead-provider');
  }
  const live = new MockProviderAdapter({ id: 'live-provider', model: 'm1', content: 'from-live' });
  const dead = new MockProviderAdapter({ id: 'dead-provider', model: 'm1', content: 'never-used' });
  const candidates: Candidate[] = [
    deadCandidate(makeCred('c-dead', 'dead-provider')),
    {
      modelId: 'm1',
      credential: makeCred('c-live', 'live-provider'),
      providerId: 'live-provider',
      adapterId: 'live-provider',
    },
  ];
  const adapterMap = new Map<string, AdapterMapEntry>([
    ['dead-provider', { adapter: dead, providerId: 'dead-provider' }],
    ['live-provider', { adapter: live, providerId: 'live-provider' }],
  ]);
  const res = await execute(
    makeRequest('m1'),
    candidates,
    makeFakeLedger(),
    new Map<string, LimitPolicy>(),
    adapterMap,
    makeFakeBreaker(),
    {},
  );
  assert.equal(res.choices[0]?.message.content, 'from-live');
  assert.equal(live.getCallCount(), 1);
  assert.equal(dead.getCallCount(), 0);
});
