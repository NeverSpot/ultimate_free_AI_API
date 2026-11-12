import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AccountingStore,
  createAccountingStore,
  type AccountingRecord,
} from '../../src/telemetry/store';
import type { DbClient, DbExecutor, DbResult } from '../../src/db/client';

function createFakeDbClient(options: { failQuery?: boolean } = {}): {
  client: DbClient;
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const executor: DbExecutor = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<DbResult<Row>> {
      if (options.failQuery) {
        throw new Error('Database query simulated error');
      }
      queries.push({ sql, params: params ? [...params] : [] });
      return { rows: [], rowCount: 1 };
    },
  };

  const client: DbClient = {
    query: executor.query,
    async transaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return work(executor);
    },
    async close(): Promise<void> {},
  };

  return { client, queries };
}

function sampleRecord(overrides: Partial<AccountingRecord> = {}): AccountingRecord {
  return {
    requestId: 'req-1',
    provider: 'openrouter',
    model: 'gpt-4o-mini',
    status: 'success',
    costUsd: 0.0001,
    latencyMs: 120,
    attemptCount: 1,
    ...overrides,
  };
}

test('accounting store: record queues until batchSize is reached', async () => {
  const { client, queries } = createFakeDbClient();
  const store = new AccountingStore(client, { batchSize: 3, flushIntervalMs: 60_000 });

  store.record(sampleRecord({ requestId: 'r1' }));
  store.record(sampleRecord({ requestId: 'r2' }));
  assert.equal(queries.length, 0);

  store.record(sampleRecord({ requestId: 'r3' }));
  // batchSize 3 reached -> triggers flush
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /insert into requests/);
  assert.equal(queries[0]!.params.length, 3 * 18);

  await store.close();
});

test('accounting store: explicit flush persists queued records', async () => {
  const { client, queries } = createFakeDbClient();
  const store = new AccountingStore(client, { batchSize: 100, flushIntervalMs: 60_000 });

  store.record(sampleRecord({ requestId: 'r1' }));
  store.record(
    sampleRecord({ requestId: 'r2', status: 'failed', errorKind: 'upstream', httpStatus: 502 }),
  );

  const flushed = await store.flush();
  assert.equal(flushed, 2);
  assert.equal(queries.length, 1);

  // Second flush on empty queue returns 0
  const flushedAgain = await store.flush();
  assert.equal(flushedAgain, 0);
  assert.equal(queries.length, 1);

  await store.close();
});

test('accounting store: re-queues records on failure and invokes onError', async () => {
  let errorReported = false;
  let reportedRecordsCount = 0;

  const { client } = createFakeDbClient({ failQuery: true });
  const store = new AccountingStore(client, {
    batchSize: 10,
    onError: (_err, recs) => {
      errorReported = true;
      reportedRecordsCount = recs.length;
    },
  });

  store.record(sampleRecord({ requestId: 'r1' }));
  store.record(sampleRecord({ requestId: 'r2' }));

  const flushed = await store.flush();
  assert.equal(flushed, 0);
  assert.equal(errorReported, true);
  assert.equal(reportedRecordsCount, 2);

  await store.close();
});

test('accounting store: close is idempotent and flushes remaining records', async () => {
  const { client, queries } = createFakeDbClient();
  const store = new AccountingStore(client, { batchSize: 100 });

  store.record(sampleRecord({ requestId: 'r-final' }));
  await store.close();

  assert.equal(queries.length, 1);
  assert.equal(queries[0]!.params[0], 'r-final');

  // Second close does nothing
  await store.close();
  assert.equal(queries.length, 1);
});

test('accounting store: createAccountingStore helper returns store and cleanup', async () => {
  const { client } = createFakeDbClient();
  const { store, cleanup } = createAccountingStore(client, { batchSize: 50 });

  assert.ok(store instanceof AccountingStore);
  assert.equal(typeof cleanup, 'function');

  await cleanup();
});
