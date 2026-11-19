import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUsageModel, type UsageSummary } from '../../src/models/usage';
import type { DbExecutor, DbResult } from '../../src/db/client';

/**
 * The usage strip is the only place a user sees their own traffic, so the query
 * has to prove its two load-bearing properties: it attributes by the caller's
 * stored provider keys (`credential_id` joins `user_provider_keys.id`) and it
 * never reports a window outside 1–365 days.
 */

interface QueryCall {
  sql: string;
  params: readonly unknown[];
}

function makeDb(rows: Record<string, unknown>[]): { db: DbExecutor; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const db: DbExecutor = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<DbResult<Row>> {
      calls.push({ sql, params: params ?? [] });
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  return { db, calls };
}

const SAMPLE_ROW = {
  requests: 4,
  prompt_tokens: 120,
  completion_tokens: 80,
  cost_usd: 0.0004,
  failovers: 1,
  last_request_at: new Date('2026-01-02T03:04:05.000Z'),
};

test('usage model: attributes traffic through the user provider keys', async () => {
  const { db, calls } = makeDb([SAMPLE_ROW]);
  const usage = createUsageModel(db);

  await usage.getUsage('user-1');

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.match(call.sql, /from requests r/);
  assert.match(call.sql, /join user_provider_keys k on k\.id = r\.credential_id/);
  assert.match(call.sql, /where k\.user_id = \$1/);
  assert.deepEqual(call.params, ['user-1', 30]);
});

test('usage model: rolls token totals and cost into plain numbers', async () => {
  const { db } = makeDb([SAMPLE_ROW]);
  const summary = await createUsageModel(db).getUsage('user-1');

  assert.deepEqual(summary, {
    window_days: 30,
    requests: 4,
    prompt_tokens: 120,
    completion_tokens: 80,
    total_tokens: 200,
    cost_usd: 0.0004,
    failovers: 1,
    last_request_at: '2026-01-02T03:04:05.000Z',
  } satisfies UsageSummary);
});

test('usage model: a user with no requests gets honest zeros, not nulls', async () => {
  const { db } = makeDb([
    {
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      failovers: 0,
      last_request_at: null,
    },
  ]);
  const summary = await createUsageModel(db).getUsage('user-1');

  assert.equal(summary.requests, 0);
  assert.equal(summary.total_tokens, 0);
  assert.equal(summary.cost_usd, 0);
  assert.equal(summary.last_request_at, null);
});

test('usage model: clamps the window to 1–365 days', async () => {
  const { db, calls } = makeDb([]);
  const usage = createUsageModel(db);

  await usage.getUsage('user-1', 0);
  await usage.getUsage('user-1', 999);

  assert.deepEqual(
    calls.map((call) => call.params[1]),
    [1, 365],
  );
});
