import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import Redis from 'ioredis';
import { LEDGER_WINDOW_MS } from '../../src/limits/policy';
import { createLedgerClient } from '../../src/limits/redis';
import type { LedgerClient } from '../../src/limits/redis';
import {
  applyDecision,
  configureParking,
  isParked,
  park,
  parkingKey,
  unpark,
} from '../../src/resilience/parking';
import type { ParkDecision } from '../../src/resilience/park-decision';

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
// Both credentials share a provider prefix on purpose: parking is per credential, not
// per provider, so a long park on A must leave B serving.
const CREDENTIAL_A = `nvidia-a-${SUFFIX}`;
const CREDENTIAL_B = `nvidia-b-${SUFFIX}`;
const CREDENTIAL_C = `nvidia-c-${SUFFIX}`;
const CREDENTIAL_D = `nvidia-d-${SUFFIX}`;
const KEYS = [
  parkingKey(CREDENTIAL_A),
  parkingKey(CREDENTIAL_B),
  parkingKey(CREDENTIAL_C),
  parkingKey(CREDENTIAL_D),
];

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

describe('credential parking (redis)', { skip }, () => {
  let redis: Redis;
  let client: LedgerClient;

  before(async () => {
    redis = new Redis(testRedisUrl);
    await redis.ping();
    client = createLedgerClient(testRedisUrl);
    configureParking(client);
  });

  beforeEach(async () => {
    await redis.del(...KEYS);
  });

  after(async () => {
    await redis?.del(...KEYS);
    client?.disconnect();
    await redis?.quit();
  });

  it('parking: a parked credential reports a positive retryAfterMs from PTTL', async () => {
    await park(CREDENTIAL_A, Date.now() + 60_000);

    const status = await isParked(CREDENTIAL_A);

    assert.equal(status.parked, true);
    assert.ok(status.retryAfterMs > 0);
    assert.equal(await redis.exists(parkingKey(CREDENTIAL_A)), 1);
  });

  it('parking: a 7-day park of A leaves B on the same provider not parked and serving', async () => {
    await park(CREDENTIAL_A, Date.now() + SEVEN_DAYS_MS);

    const parked = await isParked(CREDENTIAL_A);
    assert.equal(parked.parked, true);
    assert.ok(parked.retryAfterMs > 0);

    const other = await isParked(CREDENTIAL_B);
    assert.equal(other.parked, false);
    assert.equal(other.retryAfterMs, 0);
    assert.equal(await redis.exists(parkingKey(CREDENTIAL_B)), 0);

    let served = 0;
    const serve = async (credentialId: string): Promise<boolean> => {
      const status = await isParked(credentialId);
      if (status.parked) {
        return false;
      }
      served += 1;
      return true;
    };

    assert.equal(await serve(CREDENTIAL_B), true);
    assert.equal(served, 1);
  });

  it('parking: unpark makes isParked false immediately', async () => {
    await park(CREDENTIAL_A, Date.now() + 60_000);
    assert.equal((await isParked(CREDENTIAL_A)).parked, true);

    await unpark(CREDENTIAL_A);

    const status = await isParked(CREDENTIAL_A);
    assert.equal(status.parked, false);
    assert.equal(status.retryAfterMs, 0);
  });

  it('parking: applyDecision with Infinity parks for the bounded weekly horizon', async () => {
    const now = Date.now();
    const decision: ParkDecision = { action: 'park', waitMs: Number.POSITIVE_INFINITY };

    await applyDecision(CREDENTIAL_C, decision, now);

    const status = await isParked(CREDENTIAL_C);
    assert.equal(status.parked, true);
    assert.ok(Number.isFinite(status.retryAfterMs), 'the park must be finite, not Infinity');
    assert.ok(status.retryAfterMs > 0);
    // Redis TIME can sit a few seconds away from the host clock in Docker on Windows,
    // so allow one clock-skew margin around the weekly cap.
    assert.ok(status.retryAfterMs <= LEDGER_WINDOW_MS.rpw + 60_000);

    assert.equal(
      Number(await redis.get(parkingKey(CREDENTIAL_C))),
      now + LEDGER_WINDOW_MS.rpw,
      'the stored expiry must be exactly now + the weekly window',
    );
  });

  it('parking: applyDecision with retry writes nothing', async () => {
    const decision: ParkDecision = { action: 'retry', waitMs: 30_000 };

    await applyDecision(CREDENTIAL_D, decision, Date.now());

    const status = await isParked(CREDENTIAL_D);
    assert.equal(status.parked, false);
    assert.equal(await redis.exists(parkingKey(CREDENTIAL_D)), 0);
  });

  it('parking: applyDecision with a zero-wait park writes nothing', async () => {
    const decision: ParkDecision = { action: 'park', waitMs: 0 };

    await applyDecision(CREDENTIAL_D, decision, Date.now());

    const status = await isParked(CREDENTIAL_D);
    assert.equal(status.parked, false);
    assert.equal(status.retryAfterMs, 0);
    assert.equal(await redis.exists(parkingKey(CREDENTIAL_D)), 0);
  });

  it('parking: keys live in the cd: namespace, never br:', () => {
    assert.equal(parkingKey(CREDENTIAL_A), `cd:${CREDENTIAL_A}`);
    assert.ok(!parkingKey(CREDENTIAL_A).startsWith('br:'));
  });
});
