import assert from 'node:assert/strict';
import { test } from 'node:test';
import { healthTracker } from '../../src/providers/health';

test('provider health: unknown provider is healthy', () => {
  assert.equal(healthTracker.health('openrouter'), 'healthy');
});

test('provider health: one failure stays healthy', () => {
  healthTracker.recordFailure('nvidia-nim');
  assert.equal(healthTracker.health('nvidia-nim'), 'healthy');
});

test('provider health: two failures is degraded', () => {
  healthTracker.recordFailure('tokenharbor');
  healthTracker.recordFailure('tokenharbor');
  assert.equal(healthTracker.health('tokenharbor'), 'degraded');
});

test('provider health: four failures stays degraded', () => {
  for (let i = 0; i < 4; i++) {
    healthTracker.recordFailure('cerebras');
  }
  assert.equal(healthTracker.health('cerebras'), 'degraded');
});

test('provider health: five failures is unhealthy', () => {
  for (let i = 0; i < 5; i++) {
    healthTracker.recordFailure('groq');
  }
  assert.equal(healthTracker.health('groq'), 'unhealthy');
});

test('provider health: all() reports every tracked provider', () => {
  healthTracker.recordFailure('provider-a');
  healthTracker.recordFailure('provider-a');
  healthTracker.recordFailure('provider-b');
  healthTracker.recordFailure('provider-b');
  healthTracker.recordFailure('provider-b');
  healthTracker.recordFailure('provider-b');
  healthTracker.recordFailure('provider-b');

  const all = healthTracker.all();
  assert.equal(all['provider-a'], 'degraded');
  assert.equal(all['provider-b'], 'unhealthy');
  assert.equal(Object.prototype.hasOwnProperty.call(all, 'unknown-provider'), false);
});
