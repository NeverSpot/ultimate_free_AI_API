import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BREAKER_DEFAULTS,
  afterFailure,
  afterSuccess,
  decideAllow,
  type BreakerPolicy,
  type BreakerSnapshot,
} from '../../src/resilience/breaker';

const NOW = 1_700_000_000_000;

const POLICY: BreakerPolicy = {
  windowMs: 60_000,
  threshold: 5,
  cooldownMs: 30_000,
  probeLimit: 1,
};

function snapshot(overrides: Partial<BreakerSnapshot> = {}): BreakerSnapshot {
  return { state: 'closed', openedAtMs: 0, probesUsed: 0, probeStartedAtMs: 0, ...overrides };
}

test('breaker rules: defaults are reaction costs, not provider ceilings', () => {
  assert.deepEqual(BREAKER_DEFAULTS, {
    windowMs: 60_000,
    threshold: 5,
    cooldownMs: 30_000,
    probeLimit: 1,
  });
});

test('breaker rules: a closed breaker allows every caller', () => {
  assert.deepEqual(decideAllow(snapshot(), NOW, POLICY), {
    allowed: true,
    state: 'closed',
    probesUsed: 0,
  });
});

test('breaker rules: failures below the threshold keep the breaker closed', () => {
  const closed = snapshot();

  assert.deepEqual(afterFailure(closed, 4, NOW, POLICY), closed);
});

test('breaker rules: the threshold-th failure in the window opens with openedAtMs = now', () => {
  assert.deepEqual(afterFailure(snapshot(), 5, NOW, POLICY), {
    state: 'open',
    openedAtMs: NOW,
    probesUsed: 0,
    probeStartedAtMs: 0,
  });
});

test('breaker rules: an open breaker denies with the remaining cooldown', () => {
  const open = snapshot({ state: 'open', openedAtMs: NOW });

  assert.deepEqual(decideAllow(open, NOW + 10_000, POLICY), {
    allowed: false,
    state: 'open',
    retryAfterMs: 20_000,
  });

  assert.deepEqual(decideAllow(open, NOW + 29_999, POLICY), {
    allowed: false,
    state: 'open',
    retryAfterMs: 1,
  });
});

test('breaker rules: cooldown expiry transitions to half_open and claims the probe slot', () => {
  const open = snapshot({ state: 'open', openedAtMs: NOW });

  assert.deepEqual(decideAllow(open, NOW + POLICY.cooldownMs, POLICY), {
    allowed: true,
    state: 'half_open',
    probesUsed: 1,
  });
});

test('breaker rules: a concurrent caller cannot claim the probe already taken', () => {
  const probing = snapshot({
    state: 'half_open',
    openedAtMs: NOW,
    probesUsed: 1,
    probeStartedAtMs: NOW + POLICY.cooldownMs,
  });

  assert.deepEqual(decideAllow(probing, NOW + POLICY.cooldownMs, POLICY), {
    allowed: false,
    state: 'half_open',
    retryAfterMs: POLICY.cooldownMs,
  });
});

test('breaker rules: probeLimit above one admits exactly that many probes', () => {
  const policy: BreakerPolicy = { ...POLICY, probeLimit: 2 };
  const first = snapshot({
    state: 'half_open',
    openedAtMs: NOW,
    probesUsed: 1,
    probeStartedAtMs: NOW,
  });

  assert.deepEqual(decideAllow(first, NOW, policy), {
    allowed: true,
    state: 'half_open',
    probesUsed: 2,
  });

  const second = snapshot({
    state: 'half_open',
    openedAtMs: NOW,
    probesUsed: 2,
    probeStartedAtMs: NOW,
  });
  assert.deepEqual(decideAllow(second, NOW, policy), {
    allowed: false,
    state: 'half_open',
    retryAfterMs: policy.cooldownMs,
  });
});

test('breaker rules: a success while OPEN is a no-op, only a probe closes', () => {
  const open = snapshot({ state: 'open', openedAtMs: NOW });

  assert.deepEqual(afterSuccess(open, NOW + 1_000, POLICY), open);
});

test('breaker rules: a success while CLOSED never clears the sliding window', () => {
  const closed = snapshot({ openedAtMs: 0, probesUsed: 0 });

  assert.deepEqual(afterSuccess(closed, NOW, POLICY), closed);
});

test('breaker rules: a half-open probe success closes and clears the window', () => {
  const probing = snapshot({ state: 'half_open', openedAtMs: NOW, probesUsed: 1 });

  assert.deepEqual(afterSuccess(probing, NOW + 1_000, POLICY), {
    state: 'closed',
    openedAtMs: 0,
    probesUsed: 0,
    probeStartedAtMs: 0,
  });
});

test('breaker rules: a half-open probe failure reopens with a fresh cooldown', () => {
  const probing = snapshot({ state: 'half_open', openedAtMs: NOW, probesUsed: 1 });

  assert.deepEqual(afterFailure(probing, 1, NOW + 30_001, POLICY), {
    state: 'open',
    openedAtMs: NOW + 30_001,
    probesUsed: 0,
    probeStartedAtMs: 0,
  });
});

test('breaker rules: a leaked half-open probe slot is reclaimed after the cooldown', () => {
  const probing = snapshot({
    state: 'half_open',
    openedAtMs: NOW,
    probesUsed: 1,
    probeStartedAtMs: NOW,
  });

  assert.deepEqual(decideAllow(probing, NOW + POLICY.cooldownMs - 1, POLICY), {
    allowed: false,
    state: 'half_open',
    retryAfterMs: POLICY.cooldownMs,
  });

  assert.deepEqual(decideAllow(probing, NOW + POLICY.cooldownMs, POLICY), {
    allowed: true,
    state: 'half_open',
    probesUsed: 1,
  });
});

test('breaker rules: a failure while OPEN is a no-op, so an in-flight failure cannot extend the trip', () => {
  const open = snapshot({ state: 'open', openedAtMs: NOW });

  assert.deepEqual(afterFailure(open, 99, NOW + 5_000, POLICY), open);
});
