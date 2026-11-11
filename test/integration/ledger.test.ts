import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Redis from 'ioredis';
import { createLedger, reservationKey } from '../../src/limits/ledger';
import type { Ledger, ReserveResult } from '../../src/limits/ledger';
import { LEDGER_WINDOW_MS } from '../../src/limits/policy';
import type { LimitPolicy } from '../../src/limits/policy';
import { createLedgerClient } from '../../src/limits/redis';
import type { LedgerClient } from '../../src/limits/redis';

/**
 * Real Redis only. `npm test` never sets REDIS_URL, so this suite reports as skipped
 * inside `npm run verify`; `npm run test:int` runs it with Redis up.
 */
const redisUrl = process.env.REDIS_URL?.trim() ?? '';
// Opt-in on purpose, same reason as the registry suite: an ambient REDIS_URL must not
// pull this into the hermetic gate.
// npm sets npm_lifecycle_event to the running script name on every platform, which is a
// portable opt-in that needs no env-var syntax (RUN_INTEGRATION=1 fails under cmd.exe).
const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn
  ? 'RUN_INTEGRATION !== 1'
  : redisUrl.length === 0
    ? 'REDIS_URL is not set'
    : false;

const CREDENTIAL_ID = 'it-ledger-credential';
const MODEL_ID = 'it-ledger-model';

type Refusal = Extract<ReserveResult, { ok: false }>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function policy(overrides: Omit<LimitPolicy, 'observable'>): LimitPolicy {
  return { ...overrides, observable: 'inferred' };
}

describe('rate-limit ledger (redis)', { skip }, () => {
  let redis: Redis;
  let clientA: LedgerClient;
  let clientB: LedgerClient;
  let ledgerA: Ledger;
  let ledgerB: Ledger;

  before(async () => {
    redis = new Redis(redisUrl);
    await redis.ping();
    clientA = createLedgerClient(redisUrl);
    clientB = createLedgerClient(redisUrl);
    ledgerA = createLedger(clientA);
    ledgerB = createLedger(clientB);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  after(async () => {
    await redis?.flushdb();
    clientA?.disconnect();
    clientB?.disconnect();
    await redis?.quit();
  });

  it('ledger race: two simultaneous reservations against a ceiling of 1 yield exactly one success and one refusal', async () => {
    const limits = policy({ rpd: 1 });

    const results = await Promise.all([
      ledgerA.reserve({ credentialId: CREDENTIAL_ID, modelId: MODEL_ID, policy: limits }),
      ledgerB.reserve({ credentialId: CREDENTIAL_ID, modelId: MODEL_ID, policy: limits }),
    ]);

    assert.equal(results.filter((result) => result.ok).length, 1);

    const refusals = results.filter((result): result is Refusal => !result.ok);
    assert.equal(refusals.length, 1);
    for (const refusal of refusals) {
      assert.equal(refusal.window, 'rpd');
      assert.ok(refusal.retryAfterMs > 0);
    }
  });

  it('ledger: 16 simultaneous reservations from two connections against an rpm ceiling of 3 yield exactly 3 successes', async () => {
    const limits = policy({ rpm: 3 });

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 === 0 ? ledgerA : ledgerB).reserve({
          credentialId: CREDENTIAL_ID,
          modelId: MODEL_ID,
          policy: limits,
        }),
      ),
    );

    assert.equal(results.filter((result) => result.ok).length, 3);
    for (const refusal of results.filter((result): result is Refusal => !result.ok)) {
      assert.equal(refusal.window, 'rpm');
    }
  });

  it('ledger: an exhausted rpw blocks even when rpm is clean', async () => {
    const limits = policy({ rpm: 1000, rpw: 1 });

    const first = await ledgerA.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(first.ok, true);

    const second = await ledgerB.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });

    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.window, 'rpw');
      assert.ok(second.retryAfterMs >= 60_000);
    }

    // All-or-nothing: the refusal above named rpw, so the script must not have incremented
    // a single window. The first reservation legitimately left rpm at 1; a refusal that
    // leaks an rpm unit would surface here as 2 instead, silently burning capacity.
    const rpmKey = reservationKey(CREDENTIAL_ID, MODEL_ID, 'rpm');
    assert.equal(
      await redis.get(rpmKey),
      '1',
      'all-or-nothing: an rpw refusal must leave the rpm window untouched (still the first reservation only, never a leaked extra unit)',
    );
  });

  it('ledger: window TTL expiry frees budget', async () => {
    const windowMs = { rpm: 200 };
    const ledger = createLedger(clientA, { windowMs });
    const limits = policy({ rpm: 1 });
    const key = reservationKey(CREDENTIAL_ID, MODEL_ID, 'rpm');

    const first = await ledger.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(first.ok, true);

    // The key must be self-expiring: a positive TTL that never exceeds the configured
    // window. A missing key (-2) or a missing TTL (-1) would mean the budget is spent
    // forever, which is the actual contract this test exists to defend.
    const ttl = await redis.pttl(key);
    assert.ok(ttl > 0, `the rpm key must carry a positive TTL (got ${ttl})`);
    assert.ok(
      ttl <= windowMs.rpm,
      `the rpm TTL must stay within the ${windowMs.rpm} ms window (got ${ttl})`,
    );

    const second = await ledger.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.window, 'rpm');
    }

    // Never wait for a window with a fixed sleep here. Redis runs in Docker Desktop on
    // Windows, where the container clock sawtooths ~12.5 s against the host clock, and
    // Redis computes every TTL from that clock: PTTL can jump from a few milliseconds to
    // ~12_500 ms mid-window, so no sleep duration can bound the wait. Observe the key
    // instead, stopping the moment Redis itself drops it.
    const deadline = Date.now() + 20_000;
    let remaining = await redis.exists(key);
    while (remaining !== 0 && Date.now() < deadline) {
      await sleep(20);
      remaining = await redis.exists(key);
    }

    assert.equal(
      remaining,
      0,
      'the rpm key still existed 20_000 ms after the reservation, so the window never expired',
    );

    const third = await ledger.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(third.ok, true);
    if (third.ok) {
      assert.equal(third.reservation.reserved.length, 1, 'the third reservation must reserve');
    }
  });

  it('ledger: release returns budget', async () => {
    const limits = policy({ rpd: 1 });
    const input = { credentialId: CREDENTIAL_ID, modelId: MODEL_ID, policy: limits };

    const first = await ledgerA.reserve(input);
    if (!first.ok) {
      assert.fail('the first reservation must succeed');
    }

    const second = await ledgerA.reserve(input);
    assert.equal(second.ok, false);

    await ledgerA.release(first.reservation);

    const third = await ledgerA.reserve(input);
    assert.equal(third.ok, true);
  });

  it('ledger: commit adjusts usage', async () => {
    const limits = policy({ rpd: 2 });
    const input = { credentialId: CREDENTIAL_ID, modelId: MODEL_ID, policy: limits, cost: 1 };

    const first = await ledgerA.reserve(input);
    if (!first.ok) {
      assert.fail('the first reservation must succeed');
    }

    await ledgerA.commit(first.reservation, 2);

    const second = await ledgerA.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.window, 'rpd');
    }
  });

  it('ledger: the maximum wait wins', async () => {
    const limits = policy({ rpd: 1, rpw: 1 });

    const first = await ledgerA.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(first.ok, true);

    const second = await ledgerB.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });

    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.window, 'rpw');
      assert.ok(
        second.retryAfterMs > LEDGER_WINDOW_MS.rpd,
        'the weekly wait must dominate the daily one',
      );
    }
  });

  it('ledger: keys are namespaced and self-expiring', async () => {
    const limits = policy({ rpd: 1 });

    const result = await ledgerA.reserve({
      credentialId: CREDENTIAL_ID,
      modelId: MODEL_ID,
      policy: limits,
    });
    assert.equal(result.ok, true);

    const key = reservationKey(CREDENTIAL_ID, MODEL_ID, 'rpd');
    assert.equal(key, `rl:${CREDENTIAL_ID}:${MODEL_ID}:rpd`);
    assert.equal(await redis.get(key), '1');
    assert.ok((await redis.pttl(key)) > 0);
  });
});
