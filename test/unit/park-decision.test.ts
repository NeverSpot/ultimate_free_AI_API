import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEDGER_WINDOW_MS } from '../../src/limits/policy';
import { parkDecision } from '../../src/resilience/park-decision';

const NOW = 1_700_000_000_000;

test('park decision: terminal kinds park forever', () => {
  const terminal = ['client', 'auth', 'model_gone', 'too_long', 'blocked', 'unsupported'] as const;

  for (const kind of terminal) {
    const decision = parkDecision({ kind });
    assert.equal(decision.action, 'park');
    assert.equal(decision.waitMs, Number.POSITIVE_INFINITY);
  }
});

test('park decision: exhausted parks for the weekly window, ignoring a 3600s retryAfterMs', () => {
  const decision = parkDecision({
    kind: 'exhausted',
    retryAfterMs: 3_600_000,
    parkUntil: NOW + LEDGER_WINDOW_MS.rpw,
    now: NOW,
  });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, LEDGER_WINDOW_MS.rpw);
  assert.equal(decision.window, 'rpw');
});

test('park decision: exhausted without a reset falls back to the weekly window', () => {
  const decision = parkDecision({ kind: 'exhausted', now: NOW });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, LEDGER_WINDOW_MS.rpw);
  assert.equal(decision.window, 'rpw');
});

test('park decision: a future parkUntil overrides the weekly default', () => {
  const decision = parkDecision({ kind: 'exhausted', parkUntil: NOW + 5_000, now: NOW });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, 5_000);
  assert.equal(decision.window, 'rpw');
});

test('park decision: a past parkUntil falls back to the weekly window', () => {
  const decision = parkDecision({ kind: 'exhausted', parkUntil: NOW - 5_000, now: NOW });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, LEDGER_WINDOW_MS.rpw);
});

test('park decision: a weekly ledger window parks even for a 30s retryAfterMs', () => {
  const decision = parkDecision({ kind: 'rate_limited', window: 'rpw', retryAfterMs: 30_000 });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, LEDGER_WINDOW_MS.rpw);
  assert.equal(decision.window, 'rpw');
});

test('park decision: a daily ledger window parks for the whole day', () => {
  const decision = parkDecision({ kind: 'rate_limited', window: 'rpd' });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, LEDGER_WINDOW_MS.rpd);
  assert.equal(decision.window, 'rpd');
});

test('park decision: a per-minute ledger window retries with its delay', () => {
  const decision = parkDecision({ kind: 'rate_limited', window: 'rpm', retryAfterMs: 30_000 });

  assert.equal(decision.action, 'retry');
  assert.equal(decision.waitMs, 30_000);
  assert.equal(decision.window, 'rpm');
});

test('park decision: a per-minute ledger window with no delay retries immediately', () => {
  const decision = parkDecision({ kind: 'rate_limited', window: 'rpm' });

  assert.equal(decision.action, 'retry');
  assert.equal(decision.waitMs, 0);
  assert.equal(decision.window, 'rpm');
});

test('park decision: rate_limited retries at 30s and parks at one hour', () => {
  const retry = parkDecision({ kind: 'rate_limited', retryAfterMs: 30_000 });
  assert.equal(retry.action, 'retry');
  assert.equal(retry.waitMs, 30_000);

  const park = parkDecision({ kind: 'rate_limited', retryAfterMs: 3_600_000 });
  assert.equal(park.action, 'park');
  assert.equal(park.waitMs, 3_600_000);
});

test('park decision: rate_limited without a delay retries after the default second', () => {
  const decision = parkDecision({ kind: 'rate_limited' });

  assert.equal(decision.action, 'retry');
  assert.equal(decision.waitMs, 1_000);
});

test('park decision: upstream parks the candidate with no cooldown', () => {
  const decision = parkDecision({ kind: 'upstream' });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, 0);
  assert.equal(decision.window, undefined);
});

test('park decision: timeout also parks with no cooldown', () => {
  const decision = parkDecision({ kind: 'timeout', retryAfterMs: 2_000 });

  assert.equal(decision.action, 'park');
  assert.equal(decision.waitMs, 2_000);
});
