import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import Redis from 'ioredis';
import { createBreaker, breakerFailureKey, breakerKey } from '../../src/resilience/breaker';
import type { AllowResult, Breaker, BreakerTarget } from '../../src/resilience/breaker';
import { createLedgerClient } from '../../src/limits/redis';
import type { LedgerClient } from '../../src/limits/redis';

/**
 * Real Redis only. `npm test` never sets REDIS_URL, so this suite reports as skipped
 * inside `npm run verify`; `npm run test:int` runs it with Redis up.
 */
const redisUrl = process.env.REDIS_URL?.trim() ?? '';
// Opt-in on purpose, same reason as the ledger suite: an ambient REDIS_URL must not
// pull this into the hermetic gate.
const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn
  ? 'RUN_INTEGRATION !== 1'
  : redisUrl.length === 0
    ? 'REDIS_URL is not set'
    : false;

/**
 * Node runs integration files in parallel, and the existing ledger suite flushes its
 * logical database in beforeEach. Select the next logical database so this suite is
 * isolated from that flush while still using the real Redis behind REDIS_URL.
 */
function isolatedRedisUrl(url: string): string {
  const parsed = new URL(url);
  const current = Number(parsed.pathname.replace(/^\//, '') || '0');
  parsed.pathname = `/${Number.isInteger(current) && current >= 0 ? current + 1 : 1}`;
  return parsed.toString();
}

const testRedisUrl = redisUrl.length === 0 ? redisUrl : isolatedRedisUrl(redisUrl);

const SUFFIX = randomUUID().slice(0, 8);
const PROVIDER = `it-breaker-${SUFFIX}`;
const MODEL = `model-${SUFFIX}`;
const TARGET: BreakerTarget = { provider: PROVIDER, model: MODEL };
const HASH_KEY = breakerKey(TARGET);
const FAILURE_KEY = breakerFailureKey(TARGET);

const THRESHOLD = 3;
const COOLDOWN_MS = 1_000;
const RECLAIM_COOLDOWN_MS = 300;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('circuit breaker (redis)', { skip }, () => {
  let redis: Redis;
  let client: LedgerClient;
  let breaker: Breaker;

  before(async () => {
    redis = new Redis(testRedisUrl);
    await redis.ping();
    client = createLedgerClient(testRedisUrl);
    breaker = createBreaker(client, {
      windowMs: 60_000,
      threshold: THRESHOLD,
      cooldownMs: COOLDOWN_MS,
      probeLimit: 1,
    });
  });

  beforeEach(async () => {
    await redis.del(HASH_KEY, FAILURE_KEY);
  });

  after(async () => {
    await redis?.del(HASH_KEY, FAILURE_KEY);
    client?.disconnect();
    await redis?.quit();
  });

  async function tripWith(breakerToUse: Breaker): Promise<void> {
    for (let index = 0; index < THRESHOLD; index += 1) {
      await breakerToUse.recordFailure(TARGET);
    }
  }

  async function trip(): Promise<void> {
    await tripWith(breaker);
  }

  async function waitForPermitOn(breakerToUse: Breaker): Promise<AllowResult> {
    // Never sleep for a fixed duration here. Redis runs in Docker Desktop on Windows,
    // where the container clock sawtooths against the host clock, and the breaker
    // measures its cooldown with Redis TIME. Poll the gate instead, stopping the moment
    // Redis itself says the cooldown elapsed.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const permit = await breakerToUse.allow(TARGET);
      if (permit.allowed) {
        return permit;
      }
      await sleep(20);
    }
    assert.fail('the cooldown did not elapse within 20 seconds');
  }

  async function waitForPermit(): Promise<AllowResult> {
    return waitForPermitOn(breaker);
  }

  it('breaker: after threshold failures allow() is denied and the state is open', async () => {
    await trip();

    const permit = await breaker.allow(TARGET);

    assert.equal(permit.allowed, false);
    if (!permit.allowed) {
      assert.equal(permit.state, 'open');
      assert.ok(permit.retryAfterMs > 0);
    }
    assert.equal(await redis.hget(HASH_KEY, 'state'), 'open');
  });

  it('breaker: while OPEN, a fake fetch behind the permit is called exactly zero times across 20 calls', async () => {
    let fetchCalls = 0;
    const fakeFetch = async (): Promise<void> => {
      fetchCalls += 1;
    };

    const call = async (): Promise<void> => {
      const permit = await breaker.allow(TARGET);
      if (permit.allowed) {
        await fakeFetch();
      }
    };

    // Positive control: with the breaker CLOSED the same wrapper must reach the spy
    // exactly once. Without this, a wrapper that never calls fetch would also pass the
    // zero count below and prove nothing.
    await call();
    assert.equal(fetchCalls, 1, 'the spy must be wired to the permit');

    await trip();

    for (let index = 0; index < 20; index += 1) {
      await call();
    }

    assert.equal(fetchCalls, 1, 'an OPEN breaker must add zero fetch calls across 20 calls');
  });

  it('breaker: cooldown expiry lets one caller through with state half_open', async () => {
    await trip();

    const denied = await breaker.allow(TARGET);
    assert.equal(denied.allowed, false);

    const permit = await waitForPermit();
    assert.equal(permit.allowed, true);
    assert.equal(await redis.hget(HASH_KEY, 'state'), 'half_open');
    assert.equal(await redis.hget(HASH_KEY, 'probesUsed'), '1');
    const probeStartedAtMs = await redis.hget(HASH_KEY, 'probeStartedAtMs');
    assert.ok(probeStartedAtMs !== null, 'claiming a probe must record probeStartedAtMs');
    assert.ok(Number(probeStartedAtMs) > 0);

    // The probe slot is claimed: a second caller at the same instant is denied with the
    // cooldown as its hint, never a zero that would make it spin.
    const concurrent = await breaker.allow(TARGET);
    assert.equal(concurrent.allowed, false);
    if (!concurrent.allowed) {
      assert.equal(concurrent.retryAfterMs, COOLDOWN_MS);
    }
  });

  it('breaker: a successful probe moves the breaker to closed and clears the failure window', async () => {
    await trip();
    await waitForPermit();

    await breaker.recordSuccess(TARGET);

    assert.equal(await redis.hget(HASH_KEY, 'state'), 'closed');
    assert.equal(await redis.exists(FAILURE_KEY), 0);

    const permit = await breaker.allow(TARGET);
    assert.equal(permit.allowed, true);
  });

  it('breaker: a failed probe moves it back to open with a fresh cooldown', async () => {
    await trip();
    await waitForPermit();

    await breaker.recordFailure(TARGET);

    assert.equal(await redis.hget(HASH_KEY, 'state'), 'open');

    // If the cooldown had not been refreshed, the just-elapsed cooldown would let this
    // call straight back into half_open. A denial proves openedAtMs was reset to now.
    const permit = await breaker.allow(TARGET);
    assert.equal(permit.allowed, false);
    if (!permit.allowed) {
      assert.equal(permit.state, 'open');
      assert.ok(permit.retryAfterMs > 0);
    }
  });

  it('breaker: a leaked probe slot is reclaimed after the cooldown', async () => {
    const reclaimBreaker = createBreaker(client, {
      windowMs: 60_000,
      threshold: THRESHOLD,
      cooldownMs: RECLAIM_COOLDOWN_MS,
      probeLimit: 1,
    });

    await tripWith(reclaimBreaker);
    const first = await waitForPermitOn(reclaimBreaker);
    assert.equal(first.allowed, true);
    assert.equal(await redis.hget(HASH_KEY, 'state'), 'half_open');
    assert.equal(await redis.hget(HASH_KEY, 'probesUsed'), '1');

    // Deliberately record nothing: the probe is leaked. The next permit can only come
    // from the reclaim path, after probeStartedAtMs + cooldown.
    const reclaimed = await waitForPermitOn(reclaimBreaker);
    assert.equal(reclaimed.allowed, true);
    assert.equal(await redis.hget(HASH_KEY, 'state'), 'half_open');
    assert.equal(await redis.hget(HASH_KEY, 'probesUsed'), '1');
  });

  it('breaker: a 429-style credential fault never reaches this breaker', () => {
    // A 429 is a credential fault: classify.ts maps it to rate_limited and parking owns
    // it through cd:{credentialId}. This breaker has no status input at all, so a 429
    // cannot open it. A 5xx/timeout is the only thing that calls recordFailure.
    const surface = createBreaker(client);

    assert.deepEqual(Object.keys(surface).sort(), ['allow', 'recordFailure', 'recordSuccess']);
    // The only argument is the client; every method takes only {provider, model}. No
    // HTTP status or credential id can reach the breaker surface.
    assert.equal(createBreaker.length, 1);
    assert.equal(surface.allow.length, 1);
    assert.equal(surface.recordSuccess.length, 1);
    assert.equal(surface.recordFailure.length, 1);
    assert.equal('recordStatus' in surface, false);
    assert.equal('park' in surface, false);

    const key = breakerKey({ provider: 'nvidia', model: 'llama-3.1-8b-instruct' });
    assert.equal(key, 'br:nvidia:llama-3.1-8b-instruct');
    assert.equal(key.includes('cd:'), false);
  });
});
