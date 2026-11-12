import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createDbClient } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { AccountingStore } from '../../src/telemetry/store';
import { execute, executeStream } from '../../src/core/execute';
import { ProviderError } from '../../src/core/errors';
import type { Candidate, AdapterMapEntry } from '../../src/core/execute';
import type { ProviderAdapter, Credential } from '../../src/providers/types';
import type { CanonicalRequest, CanonicalResponse } from '../../src/core/types';
import type { LimitPolicy } from '../../src/limits/policy';
import { createLedger } from '../../src/limits/ledger';
import { createBreaker } from '../../src/resilience/breaker';
import { createLedgerClient, type LedgerClient } from '../../src/limits/redis';

const REDIS_URL = process.env.REDIS_URL?.trim() ?? '';
const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';

const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn
  ? 'RUN_INTEGRATION !== 1'
  : !REDIS_URL || !DATABASE_URL
    ? 'REDIS_URL and DATABASE_URL required'
    : false;

let dbClient: ReturnType<typeof createDbClient>;
let ledgerClient: LedgerClient;
let accountingStore: AccountingStore;

function makeMockAdapter(response: CanonicalResponse): ProviderAdapter {
  return {
    id: 'mock',
    supportsStreaming: true,
    chat: async () => response,
    stream: async function* () {
      yield {
        id: response.id,
        model: response.model,
        created: response.created,
        delta: { role: 'assistant', content: 'Hello' },
        finish_reason: null,
      };
      yield {
        id: response.id,
        model: response.model,
        created: response.created,
        delta: { role: 'assistant', content: '' },
        finish_reason: 'stop',
        usage: response.usage,
      };
    },
    listModels: async () => [],
  };
}

function makeRequest(model?: string): CanonicalRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  };
}

function makeCandidate(providerId: string, modelId: string): Candidate {
  return {
    modelId,
    providerId,
    adapterId: 'mock',
    credential: {
      id: crypto.randomUUID(),
      provider: providerId,
      secret: 'dummy',
      label: 'test',
    } satisfies Credential,
  };
}

describe('Accounting integration', { skip }, () => {
  before(async () => {
    dbClient = createDbClient(DATABASE_URL!);
    const result = await runMigrations(dbClient);
    console.log(`Migrations: ${result.applied.length} applied, ${result.skipped.length} skipped`);

    await dbClient.query('delete from requests');

    ledgerClient = createLedgerClient(REDIS_URL!);
    accountingStore = new AccountingStore(dbClient, { batchSize: 10, flushIntervalMs: 1000 });
  });

  after(async () => {
    await accountingStore.close();
    await ledgerClient.disconnect();
    await dbClient.close();
  });

  test('success path writes one accounting row', async () => {
    const request = makeRequest('gpt-4o-mini');
    const candidates = [makeCandidate('openrouter', 'gpt-4o-mini')];
    const policies = new Map<string, LimitPolicy>();
    const adapterMap = new Map<string, AdapterMapEntry>([
      [
        'mock',
        {
          adapter: makeMockAdapter({
            id: 'chatcmpl-test',
            model: 'gpt-4o-mini',
            created: Date.now(),
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, estimated: false },
          }),
          providerId: 'openrouter',
        },
      ],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);

    const response = await execute(request, candidates, ledger, policies, adapterMap, breaker, {
      accountingStore,
      requestId: 'test-success-1',
    });

    assert.ok(response.choices.length > 0);
    assert.strictEqual(response.choices[0]!.message.content, 'Hi!');

    await accountingStore.flush();

    const result = await dbClient.query(`select * from requests where request_id = $1`, [
      'test-success-1',
    ]);
    assert.strictEqual(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.strictEqual(row.status, 'success');
    assert.strictEqual(row.provider, 'openrouter');
    assert.strictEqual(row.model, 'gpt-4o-mini');
    assert.strictEqual(row.prompt_tokens, 10);
    assert.strictEqual(row.completion_tokens, 5);
    assert.strictEqual(row.tokens_estimated, false);
    assert.strictEqual(row.attempt_count, 1);
    assert.ok(Number(row.cost_usd) > 0);
    assert.ok(Number(row.latency_ms) >= 0);
  });

  test('upstream failure writes one accounting row with error_kind', async () => {
    const errorAdapter: ProviderAdapter = {
      id: 'mock-error',
      supportsStreaming: false,
      chat: async () => {
        throw new Error('upstream failure');
      },
      stream: async function* () {},
      listModels: async () => [],
    };

    const request = makeRequest('gpt-4o-mini');
    const candidates = [makeCandidate('openrouter', 'gpt-4o-mini')];
    const policies = new Map<string, LimitPolicy>();
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter: errorAdapter, providerId: 'openrouter' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);

    let threw = false;
    try {
      await execute(request, candidates, ledger, policies, adapterMap, breaker, {
        accountingStore,
        requestId: 'test-failure-1',
        maxAttempts: 1,
      });
    } catch {
      threw = true;
    }
    assert.ok(threw);

    await accountingStore.flush();

    const result = await dbClient.query(`select * from requests where request_id = $1`, [
      'test-failure-1',
    ]);
    assert.strictEqual(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error_kind, 'upstream');
    assert.strictEqual(row.http_status, 502);
    assert.strictEqual(row.attempt_count, 1);
    assert.strictEqual(row.provider, 'openrouter');
  });

  test('timeout writes one accounting row with status timeout', async () => {
    const slowAdapter: ProviderAdapter = {
      id: 'mock-slow',
      supportsStreaming: false,
      chat: async (
        _req: CanonicalRequest,
        _cred: Credential,
        signal?: AbortSignal,
      ): Promise<CanonicalResponse> => {
        await new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('timeout')), 100);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
        throw new Error('unreachable');
      },
      stream: async function* () {},
      listModels: async () => [],
    };

    const request = makeRequest('gpt-4o-mini');
    const candidates = [makeCandidate('openrouter', 'gpt-4o-mini')];
    const policies = new Map<string, LimitPolicy>();
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter: slowAdapter, providerId: 'openrouter' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);

    let threw = false;
    try {
      await execute(request, candidates, ledger, policies, adapterMap, breaker, {
        accountingStore,
        requestId: 'test-timeout-1',
        maxAttempts: 1,
        attemptTimeoutMs: 1,
      });
    } catch {
      threw = true;
    }
    assert.ok(threw);

    await accountingStore.flush();

    const result = await dbClient.query(`select * from requests where request_id = $1`, [
      'test-timeout-1',
    ]);
    assert.strictEqual(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.strictEqual(row.status, 'timeout');
    assert.strictEqual(row.error_kind, 'timeout');
    assert.strictEqual(row.provider, 'openrouter');
  });

  test('client abort writes one accounting row with status aborted', async () => {
    const controller = new AbortController();
    const abortAdapter: ProviderAdapter = {
      id: 'mock-abort',
      supportsStreaming: false,
      chat: async (
        _req: CanonicalRequest,
        _cred: Credential,
        signal?: AbortSignal,
      ): Promise<CanonicalResponse> => {
        await new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve(undefined));
        });
        throw new DOMException('Aborted', 'AbortError');
      },
      stream: async function* () {},
      listModels: async () => [],
    };

    const request = makeRequest('gpt-4o-mini');
    const candidates = [makeCandidate('openrouter', 'gpt-4o-mini')];
    const policies = new Map<string, LimitPolicy>();
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter: abortAdapter, providerId: 'openrouter' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);

    let threw = false;
    const abortTimer = setTimeout(() => controller.abort(), 10);
    try {
      await execute(request, candidates, ledger, policies, adapterMap, breaker, {
        accountingStore,
        requestId: 'test-abort-1',
        maxAttempts: 1,
        attemptTimeoutMs: 30_000,
        signal: controller.signal,
      });
    } catch {
      threw = true;
    } finally {
      clearTimeout(abortTimer);
    }
    assert.ok(threw);

    await accountingStore.flush();

    const result = await dbClient.query(`select * from requests where request_id = $1`, [
      'test-abort-1',
    ]);
    assert.strictEqual(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.strictEqual(row.status, 'aborted');
    assert.strictEqual(row.error_kind, 'timeout');
    assert.strictEqual(row.provider, 'openrouter');
  });

  test('failover writes one accounting row for terminal path (final is success)', async () => {
    let attempt = 0;
    const failThenSucceedAdapter: ProviderAdapter = {
      id: 'mock-fail-succeed',
      supportsStreaming: false,
      chat: async () => {
        attempt++;
        if (attempt === 1) {
          throw new ProviderError('rate_limited', 'Rate limited', {
            status: 429,
            retryAfterMs: 1000,
            provider: 'openrouter',
          });
        }
        return {
          id: 'chatcmpl-test',
          model: 'gpt-4o-mini',
          created: Date.now(),
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, estimated: false },
        };
      },
      stream: async function* () {},
      listModels: async () => [],
    };

    const request = makeRequest('gpt-4o-mini');
    const candidates = [
      makeCandidate('openrouter', 'gpt-4o-mini'),
      makeCandidate('nvidia', 'gpt-4o-mini'),
    ];
    const policies = new Map<string, LimitPolicy>();
    const adapterMap = new Map<string, AdapterMapEntry>([
      ['mock', { adapter: failThenSucceedAdapter, providerId: 'openrouter' }],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);

    const response = await execute(request, candidates, ledger, policies, adapterMap, breaker, {
      accountingStore,
      requestId: 'test-failover-1',
      maxAttempts: 2,
    });

    assert.ok(response.choices.length > 0);
    assert.strictEqual(response.choices[0]!.message.content, 'Hi!');
    assert.strictEqual(attempt, 2);

    await accountingStore.flush();

    const result = await dbClient.query(
      `select * from requests where request_id = $1 order by created_at`,
      ['test-failover-1'],
    );
    assert.strictEqual(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.strictEqual(row.status, 'success');
    assert.strictEqual(row.attempt_count, 2);
    assert.strictEqual(row.error_kind, null);
    assert.strictEqual(row.http_status, null);
    assert.strictEqual(row.provider, 'nvidia');
  });

  test('streaming success writes one accounting row with ttft_ms', async () => {
    const request = { ...makeRequest('gpt-4o-mini'), stream: true };
    const candidates = [makeCandidate('openrouter', 'gpt-4o-mini')];
    const policies = new Map<string, LimitPolicy>();
    const adapterMap = new Map<string, AdapterMapEntry>([
      [
        'mock',
        {
          adapter: makeMockAdapter({
            id: 'chatcmpl-stream',
            model: 'gpt-4o-mini',
            created: Date.now(),
            choices: [
              { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, estimated: false },
          }),
          providerId: 'openrouter',
        },
      ],
    ]);

    const ledger = createLedger(ledgerClient);
    const breaker = createBreaker(ledgerClient);

    let chunks = 0;
    for await (const _chunk of executeStream(
      request,
      candidates,
      ledger,
      policies,
      adapterMap,
      breaker,
      {
        accountingStore,
        requestId: 'test-stream-1',
      },
    )) {
      chunks++;
    }
    assert.ok(chunks >= 2);

    await accountingStore.flush();

    const result = await dbClient.query(`select * from requests where request_id = $1`, [
      'test-stream-1',
    ]);
    assert.strictEqual(result.rows.length, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.strictEqual(row.status, 'success');
    assert.ok(row.ttft_ms !== null && Number(row.ttft_ms) > 0);
    assert.strictEqual(row.prompt_tokens, 10);
    assert.strictEqual(row.completion_tokens, 20);
  });
});
