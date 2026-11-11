import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Redis from 'ioredis';
import { createExecutor } from '../../src/core/execute';
import { createLedgerClient } from '../../src/limits/redis';
import type { Candidate } from '../../src/core/execute';
import type { CanonicalRequest } from '../../src/core/types';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';
import { createDefaultEvalTable, type LruMap } from '../../src/routing/select';
import { resolvePolicy } from '../../src/limits/policy';
import { createParking } from '../../src/resilience/parking';

/**
 * Real Redis only. `npm test` never sets REDIS_URL, so this suite reports as skipped
 * inside `npm run verify`; `npm run test:int` runs it with Redis up.
 */
const redisUrl = process.env.REDIS_URL?.trim() ?? '';
const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn
  ? 'RUN_INTEGRATION !== 1'
  : redisUrl.length === 0
    ? 'REDIS_URL is not set'
    : false;

const CREDENTIALS = ['cap-k1', 'cap-k2', 'cap-k3'];
const MODEL_ID = 'cap-model';
const RPM_CEILING = 30;
const TOTAL_REQUESTS = 60;

function makeCred(id: string): Credential {
  return { id, provider: 'mock', secret: `secret-${id}` };
}

function makeRequest(model = MODEL_ID): CanonicalRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  };
}

describe(
  'capacity gate: 3 credentials @ 30 RPM serve 60 RPM with zero client 429s (redis)',
  { skip },
  () => {
    let redis: Redis;
    let ledgerClient: ReturnType<typeof createLedgerClient>;
    let breakerClient: ReturnType<typeof createLedgerClient>;
    let executor: ReturnType<typeof createExecutor>;
    let parking: ReturnType<typeof createParking>;
    let adapter: MockProviderAdapter;
    let candidates: Candidate[];
    let lru: LruMap;

    before(async () => {
      redis = new Redis(redisUrl);
      await redis.ping();

      ledgerClient = createLedgerClient(redisUrl);
      breakerClient = createLedgerClient(redisUrl);

      executor = createExecutor(ledgerClient, breakerClient, {
        totalDeadlineMs: 30_000,
        attemptTimeoutMs: 10_000,
        evalTable: createDefaultEvalTable(),
        lru: new Map(),
        clock: Date.now,
      });

      parking = createParking(ledgerClient);

      // Single mock adapter shared across all credentials
      adapter = new MockProviderAdapter({
        id: 'mock',
        model: MODEL_ID,
        rpmCeiling: RPM_CEILING,
        clock: Date.now,
      });

      candidates = CREDENTIALS.map((credential) => ({
        modelId: MODEL_ID,
        credential: makeCred(credential),
        providerId: 'mock',
        adapterId: 'mock',
      }));

      // Pre-resolve policy for the model
      resolvePolicy('mock', MODEL_ID);
    });

    beforeEach(async () => {
      await redis.flushdb();

      // Recreate adapter to reset its internal state
      adapter = new MockProviderAdapter({
        id: 'mock',
        model: MODEL_ID,
        rpmCeiling: RPM_CEILING,
        clock: Date.now,
      });

      lru = new Map();
    });

    after(async () => {
      await redis?.flushdb();
      ledgerClient?.disconnect();
      breakerClient?.disconnect();
      await redis?.quit();
    });

    it('capacity: 3 credentials at 30 RPM each serve 60 requests with zero client-visible 429s', async () => {
      const adapterMap = new Map<string, { adapter: MockProviderAdapter; providerId: string }>([
        ['mock', { adapter, providerId: 'mock' }],
      ]);

      const policies = new Map<string, ReturnType<typeof resolvePolicy>>([
        [MODEL_ID, resolvePolicy('mock', MODEL_ID)],
      ]);

      const responses = [];
      let client429Count = 0;
      let clientErrorCount = 0;

      for (let i = 0; i < TOTAL_REQUESTS; i++) {
        try {
          const res = await executor.execute(makeRequest(), candidates, policies, adapterMap, {
            lru,
            parking,
            clock: Date.now,
            evalTable: createDefaultEvalTable(),
          });
          responses.push(res);
        } catch (err) {
          if (err instanceof Error && 'kind' in err && err.kind === 'rate_limited') {
            client429Count++;
          }
          clientErrorCount++;
        }
      }

      // Verify: all 60 requests succeeded from client perspective
      assert.equal(
        responses.length,
        TOTAL_REQUESTS,
        `Expected ${TOTAL_REQUESTS} successful responses, got ${responses.length}`,
      );
      assert.equal(client429Count, 0, 'Zero client-visible 429s allowed');
      assert.equal(clientErrorCount, 0, 'Zero client errors allowed');

      // Verify: adapter was called exactly 60 times (no retries to same credential within window)
      assert.equal(
        adapter.getCallCount(),
        TOTAL_REQUESTS,
        `Adapter called ${adapter.getCallCount()} times, expected ${TOTAL_REQUESTS}`,
      );

      // Verify: even distribution across 3 credentials (20 each, give or take 1 for LRU)
      const perCredCounts = adapter.getRequestCounts();
      for (const credId of CREDENTIALS) {
        const count = perCredCounts.get(credId) ?? 0;
        assert.ok(
          count >= 19 && count <= 21,
          `Credential ${credId} got ${count} requests, expected ~20`,
        );
      }

      // Verify: total per-credential usage matches ceiling
      const totalUsed = Array.from(perCredCounts.values()).reduce((a, b) => a + b, 0);
      assert.equal(
        totalUsed,
        TOTAL_REQUESTS,
        `Total requests distributed: ${totalUsed}, expected ${TOTAL_REQUESTS}`,
      );
    });
  },
);
