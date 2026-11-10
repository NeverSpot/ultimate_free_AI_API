import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createDbClient } from '../../src/db/client';
import type { DbClient } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { listModels, providersSummary, upsertModels } from '../../src/registry/store';

/**
 * Real Postgres only. `npm test` never points DATABASE_URL at a database, so this
 * whole suite reports as skipped inside `npm run verify`; `npm run test:int` runs it.
 */
const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const skip = databaseUrl.length === 0 ? 'DATABASE_URL is not set' : false;

/** Row prefix owned by this file, so a shared dev database is never damaged. */
const PREFIX = 'it-registry-store';
const provider = (suffix: string): string => `${PREFIX}-${suffix}`;

const t1 = new Date('2026-11-10T00:00:00.000Z');
const t2 = new Date('2026-11-10T01:00:00.000Z');
const t3 = new Date('2026-11-10T02:00:00.000Z');

async function deleteOwnedRows(client: DbClient): Promise<void> {
  await client.query('delete from models where provider like $1', [`${PREFIX}%`]);
}

describe('registry store (postgres)', { skip }, () => {
  let client: DbClient;

  before(async () => {
    client = createDbClient(databaseUrl);
    await runMigrations(client);
    await deleteOwnedRows(client);
  });

  after(async () => {
    await deleteOwnedRows(client);
    await client.close();
  });

  it('migrations: a second run applies nothing and every file is recorded once', async () => {
    const second = await runMigrations(client);

    assert.deepEqual(second.applied, []);
    assert.ok(second.skipped.includes('0001_models.sql'));

    const ledger = await client.query<{ version: string; count: number }>(
      'select version, count(*)::int as count from schema_migrations group by version',
    );
    for (const row of ledger.rows) {
      assert.equal(row.count, 1, `migration ${row.version} must be recorded exactly once`);
    }
  });

  it('upsert: a second refresh updates discovery columns without adding a row', async () => {
    const alpha = provider('alpha');
    const first = await upsertModels(
      client,
      [{ provider: alpha, id: 'model-1', context_window: 8192, is_free: true, owned_by: 'vendor' }],
      t1,
    );
    assert.equal(first, 1);

    const second = await upsertModels(
      client,
      [
        {
          provider: alpha,
          id: 'model-1',
          context_window: 16384,
          is_free: null,
          owned_by: 'vendor',
        },
      ],
      t2,
    );
    assert.equal(second, 1);

    const rows = (await listModels(client)).filter((row) => row.provider === alpha);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.contextWindow, 16384);
    assert.equal(rows[0]?.isFree, null);
    assert.notEqual(rows[0]?.isFree, false);
    assert.equal(rows[0]?.ownedBy, 'vendor');
    assert.equal(rows[0]?.checkedAt.toISOString(), t2.toISOString());
  });

  it('last-known-good: refreshing one provider leaves another provider rows untouched', async () => {
    const alpha = provider('alpha');
    const beta = provider('beta');

    await upsertModels(
      client,
      [
        { provider: alpha, id: 'alpha-model', is_free: false },
        { provider: beta, id: 'beta-model', is_free: true },
        { provider: beta, id: 'beta-model-2', is_free: null },
      ],
      t1,
    );

    // Simulate alpha succeeding while beta throws: discovery only yields alpha models.
    await upsertModels(client, [{ provider: alpha, id: 'alpha-model', is_free: false }], t3);

    const betaRows = (await listModels(client)).filter((row) => row.provider === beta);

    assert.deepEqual(betaRows.map((row) => row.modelId).sort(), ['beta-model', 'beta-model-2']);
    for (const row of betaRows) {
      assert.equal(row.checkedAt.toISOString(), t1.toISOString());
    }
  });

  it('upsert: runtime columns (healthy and the reserved limits) survive a catalog refresh', async () => {
    const gamma = provider('gamma');

    await upsertModels(client, [{ provider: gamma, id: 'gamma-model', is_free: true }], t1);
    await client.query(
      'update models set healthy = false, rpm_limit = 30, tpm_limit = 1000, rpd_limit = 500 where provider = $1',
      [gamma],
    );

    await upsertModels(client, [{ provider: gamma, id: 'gamma-model', is_free: true }], t2);

    const row = (await listModels(client)).find((record) => record.provider === gamma);
    assert.ok(row);
    assert.equal(row.healthy, false);
    assert.equal(row.rpmLimit, 30);
    assert.equal(row.tpmLimit, 1000);
    assert.equal(row.rpdLimit, 500);
    assert.equal(row.checkedAt.toISOString(), t2.toISOString());
  });

  it('summary: counts free, unknown and healthy rows per provider', async () => {
    const delta = provider('delta');

    await upsertModels(
      client,
      [
        { provider: delta, id: 'free', is_free: true },
        { provider: delta, id: 'unknown', is_free: null },
        { provider: delta, id: 'paid', is_free: false },
      ],
      t1,
    );
    await client.query('update models set healthy = false where provider = $1 and model_id = $2', [
      delta,
      'paid',
    ]);

    const summary = (await providersSummary(client)).find((row) => row.provider === delta);

    assert.ok(summary);
    assert.equal(summary.models, 3);
    assert.equal(summary.free, 1);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.healthy, 2);
    assert.equal(summary.checkedAt?.toISOString(), t1.toISOString());
  });
});
