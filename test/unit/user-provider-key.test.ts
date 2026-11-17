import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createUserProviderKeyModel,
  providerKeyFingerprint,
} from '../../src/models/user-provider-key';
import type { DbExecutor, DbResult } from '../../src/db/client';

const MASTER_KEY = 'test-master-key-32-chars-minimum!';

interface QueryCall {
  sql: string;
  params: readonly unknown[];
}

/**
 * Hermetic fake, following `user-gateway-key.test.ts`: it records every
 * statement so we assert the load-bearing property (the owner predicate)
 * rather than the canned rows it hands back.
 */
function makeFakeDb(options: { rows?: Record<string, unknown>[]; rowCount?: number }): {
  db: DbExecutor;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const rows = options.rows ?? [];
  const db: DbExecutor = {
    async query<Row = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<DbResult<Row>> {
      calls.push({ sql, params });
      return { rows: rows as Row[], rowCount: options.rowCount ?? rows.length } as DbResult<Row>;
    },
  };
  return { db, calls };
}

test('fingerprint: distinct secrets for one provider do not collide', () => {
  const a = providerKeyFingerprint('u1', 'openrouter', 'sk-or-a');
  const b = providerKeyFingerprint('u1', 'openrouter', 'sk-or-b');
  assert.notEqual(a, b);
});

test('fingerprint: is a stable function of (user, provider, secret)', () => {
  assert.equal(
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
  );
});

test('fingerprint: is scoped to the user', () => {
  assert.notEqual(
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
    providerKeyFingerprint('u2', 'openrouter', 'sk-or-a'),
  );
});

test('updateKey scopes its UPDATE by owner as well as key id', async () => {
  const { db, calls } = makeFakeDb({ rowCount: 0 });
  const store = createUserProviderKeyModel(db, MASTER_KEY);

  const changed = await store.updateKey('key-owned-by-u2', 'u1', { fingerprint: 'x' });
  assert.equal(changed, false);

  const update = calls.find((call) => /update user_provider_keys/i.test(call.sql));
  assert.ok(update, 'updateKey must issue an UPDATE');
  assert.match(update.sql, /user_id\s*=\s*\$1/i, 'UPDATE must be owner-scoped');
  assert.match(update.sql, /id\s*=\s*\$2/i, 'UPDATE must target the key id');
  assert.deepEqual(update.params.slice(0, 2), ['u1', 'key-owned-by-u2']);
});

test('deleteKeyById scopes its DELETE by owner as well as key id', async () => {
  const { db, calls } = makeFakeDb({ rowCount: 0 });
  const store = createUserProviderKeyModel(db, MASTER_KEY);

  assert.equal(await store.deleteKeyById('u1', 'key-owned-by-u2'), false);

  const del = calls.find((call) => /delete from user_provider_keys/i.test(call.sql));
  assert.ok(del, 'deleteKeyById must issue a DELETE');
  assert.match(del.sql, /user_id\s*=\s*\$1/i, 'DELETE must be owner-scoped');
  assert.match(del.sql, /id\s*=\s*\$2/i, 'DELETE must target the key id');
  assert.deepEqual(del.params, ['u1', 'key-owned-by-u2']);
});

test('listKeysByProvider filters by user and provider, ordered by created_at', async () => {
  const { db, calls } = makeFakeDb({
    rows: [{ id: 'k1', user_id: 'u1', provider: 'openrouter' }],
  });
  const store = createUserProviderKeyModel(db, MASTER_KEY);

  const rows = await store.listKeysByProvider('u1', 'openrouter');
  assert.equal(rows.length, 1);

  const select = calls.find(
    (call) => /select/i.test(call.sql) && /from user_provider_keys/i.test(call.sql),
  );
  assert.ok(select, 'listKeysByProvider must issue a SELECT');
  assert.match(select.sql, /user_id\s*=\s*\$1/i);
  assert.match(select.sql, /provider\s*=\s*\$2/i);
  assert.match(select.sql, /order by created_at/i);
  assert.deepEqual(select.params, ['u1', 'openrouter']);
});
