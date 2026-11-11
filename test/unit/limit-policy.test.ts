import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLedger, reservationKey } from '../../src/limits/ledger';
import {
  applicableWindows,
  enforcedWindows,
  resolvePolicy,
  withCeilings,
} from '../../src/limits/policy';
import type { LimitPolicy, Window } from '../../src/limits/policy';
import type { LedgerClient } from '../../src/limits/redis';

const WINDOWS: readonly Window[] = ['rpm', 'rpd', 'rpw'];

test('limit policy: openrouter applies rpd and observes the quota endpoint', () => {
  const policy = resolvePolicy('openrouter', 'openrouter/auto');

  assert.deepEqual(applicableWindows(policy), ['rpd']);
  assert.deepEqual(enforcedWindows(policy), []);
  assert.equal(policy.rpd, null);
  assert.equal(policy.observable, 'quota-endpoint');
});

test("limit policy: tokenharbor ':free' models apply a weekly window inferred from use", () => {
  const policy = resolvePolicy('tokenharbor', 'deepseek-v4.1-flash:free');

  assert.deepEqual(applicableWindows(policy), ['rpw']);
  assert.deepEqual(enforcedWindows(policy), []);
  assert.equal(policy.rpw, null);
  assert.equal(policy.observable, 'inferred');
});

test('limit policy: tokenharbor paid models have no window', () => {
  const policy = resolvePolicy('tokenharbor', 'deepseek-v4.1-flash');

  assert.deepEqual(applicableWindows(policy), []);
  assert.deepEqual(enforcedWindows(policy), []);
  assert.equal(policy.observable, 'inferred');
});

test('limit policy: nvidia has no window and is inferred', () => {
  const policy = resolvePolicy('nvidia', '01-ai/yi-large');

  assert.deepEqual(applicableWindows(policy), []);
  assert.deepEqual(enforcedWindows(policy), []);
  assert.equal(policy.observable, 'inferred');
});

test('limit policy: unknown providers are inferred with no window', () => {
  const policy = resolvePolicy('mystery-provider', 'whatever/model');

  assert.deepEqual(applicableWindows(policy), []);
  assert.deepEqual(enforcedWindows(policy), []);
  assert.equal(policy.observable, 'inferred');
});

test('limit policy: applicableWindows keeps a window whose ceiling is null', () => {
  const policy: LimitPolicy = { rpd: null, rpm: 20, observable: 'inferred' };

  assert.deepEqual(applicableWindows(policy), ['rpm', 'rpd']);
});

test('limit policy: enforcedWindows drops a window whose ceiling is null', () => {
  const policy: LimitPolicy = { rpd: null, rpm: 20, observable: 'inferred' };

  assert.deepEqual(enforcedWindows(policy), ['rpm']);
});

test('limit policy: withCeilings returns a new policy without mutating the input', () => {
  const base = resolvePolicy('openrouter', 'openrouter/auto');
  const next = withCeilings(base, { rpd: 50, rpm: 20 });

  assert.notEqual(next, base);
  assert.equal(base.rpd, null);
  assert.equal(base.rpm, undefined);
  assert.equal(next.rpd, 50);
  assert.equal(next.rpm, 20);
  assert.equal(next.observable, 'quota-endpoint');
  assert.deepEqual(applicableWindows(next), ['rpm', 'rpd']);
  assert.deepEqual(enforcedWindows(next), ['rpm', 'rpd']);
});

test('limit policy: the default table carries no numeric ceilings', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['nvidia', '01-ai/yi-large'],
    ['openrouter', 'openrouter/auto'],
    ['tokenharbor', 'deepseek-v4.1-flash:free'],
    ['tokenharbor', 'deepseek-v4.1-flash'],
    ['mystery-provider', 'whatever/model'],
  ];

  for (const [provider, modelId] of cases) {
    const policy = resolvePolicy(provider, modelId);
    for (const window of WINDOWS) {
      const ceiling = policy[window];
      assert.ok(
        ceiling === null || ceiling === undefined,
        `${provider}:${modelId} ${window} must not have a hardcoded ceiling`,
      );
    }
  }
});

test('limit ledger: reservationKey namespaces by credential, model and window', () => {
  assert.equal(
    reservationKey('cred-1', 'vendor/model:free', 'rpw'),
    'rl:cred-1:vendor/model:free:rpw',
  );
});

test('limit ledger: reserve with no enforced windows never calls the client', async () => {
  const client: LedgerClient = {
    defineCommand() {
      throw new Error('the ledger must not register a script without enforced windows');
    },
    disconnect() {
      throw new Error('the ledger must not disconnect unexpectedly');
    },
  };

  const ledger = createLedger(client);
  const result = await ledger.reserve({
    credentialId: 'cred-1',
    modelId: 'model-1',
    policy: { rpd: null, observable: 'inferred' },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.reservation.reserved, []);
    assert.equal(result.reservation.cost, 1);
  }
});
