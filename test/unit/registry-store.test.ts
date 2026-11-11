import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CredentialPool } from '../../src/credentials/pool';
import type { DiscoveryResult, ProviderRegistry } from '../../src/providers/registry';
import type { Credential, ProviderId } from '../../src/providers/types';
import { toModelRows } from '../../src/registry/store';
import { classifyDiscovery, formatSyncReport, type SyncReport } from '../../scripts/registry-sync';

/**
 * A registry stub with no adapters: classification only asks which ids are registered,
 * so building real adapters here would add I/O surface for no coverage.
 */
function stubRegistry(ids: readonly ProviderId[]): ProviderRegistry {
  return {
    get: () => undefined,
    ids: () => [...ids],
    size: () => ids.length,
  };
}

/** A pool stub that gives `count` credentials to each named provider and none to others. */
function stubPool(counts: Readonly<Record<ProviderId, number>>): CredentialPool {
  const copy = (provider: ProviderId): Credential[] =>
    Array.from({ length: counts[provider] ?? 0 }, (_, index) => ({
      id: `${provider}-${index + 1}`,
      provider,
      secret: `secret-${index + 1}`,
    }));

  return {
    getCandidates: copy,
    credentialsFor: copy,
    providers: () => Object.keys(counts),
    size(provider?: ProviderId): number {
      if (provider !== undefined) {
        return counts[provider] ?? 0;
      }
      return Object.values(counts).reduce((total, count) => total + count, 0);
    },
  };
}

const checkedAt = new Date('2026-11-11T05:00:00.000Z');

test('registry store: unknown is_free and absent fields map to null, never false', () => {
  const rows = toModelRows([{ id: 'nvidia-model', provider: 'nvidia' }], checkedAt);

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.is_free, null);
  assert.notEqual(row.is_free, false);
  assert.equal(row.context_window, null);
  assert.equal(row.owned_by, null);
  assert.equal(row.rpm_limit, null);
  assert.equal(row.tpm_limit, null);
  assert.equal(row.rpd_limit, null);
  assert.equal(row.healthy, true);
  assert.equal(row.checked_at, checkedAt);
});

test('registry store: an explicit false stays false and an explicit null stays null', () => {
  const rows = toModelRows(
    [
      { id: 'paid', provider: 'openrouter', is_free: false, context_window: 8192 },
      { id: 'unknown', provider: 'openrouter', is_free: null },
      { id: 'free', provider: 'openrouter', is_free: true, owned_by: 'vendor' },
    ],
    checkedAt,
  );

  assert.deepEqual(
    rows.map((row) => [row.model_id, row.is_free]),
    [
      ['paid', false],
      ['unknown', null],
      ['free', true],
    ],
  );
  assert.equal(rows[0]?.context_window, 8192);
  assert.equal(rows[2]?.owned_by, 'vendor');
});

test('registry store: a repeated (provider, model_id) collapses to one row, last one wins', () => {
  const rows = toModelRows(
    [
      { id: 'same', provider: 'alpha', context_window: 1000, is_free: true },
      { id: 'other', provider: 'alpha' },
      { id: 'same', provider: 'alpha', context_window: 2000, is_free: false },
    ],
    checkedAt,
  );

  assert.deepEqual(
    rows.map((row) => [row.model_id, row.context_window, row.is_free]),
    [
      ['same', 2000, false],
      ['other', null, null],
    ],
  );
});

test('registry store: models with no provider are rejected instead of written under a blank key', () => {
  assert.throws(
    () => toModelRows([{ id: 'orphan' }], checkedAt),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /orphan/);
      assert.match(error.message, /provider/);
      return true;
    },
  );
});

test('registry sync: refreshed, failed and unconfigured providers are separated by cause', () => {
  const registry = stubRegistry(['healthy', 'throttled', 'no-keys']);
  const result: DiscoveryResult = {
    models: [{ id: 'healthy-1', provider: 'healthy', is_free: true }],
    failures: [{ provider: 'throttled', kind: 'rate_limited', message: 'too many requests' }],
  };
  const pool = stubPool({ healthy: 1, throttled: 1 });

  const classified = classifyDiscovery(registry, result, pool);

  assert.deepEqual(classified.refreshed, ['healthy']);
  assert.deepEqual(classified.failed, [
    { provider: 'throttled', kind: 'rate_limited', message: 'too many requests' },
  ]);
  assert.deepEqual(classified.unconfigured, ['no-keys']);
  assert.equal(classified.exitCode, 0);
});

test('registry sync: a provider with credentials but zero models still counts as refreshed', () => {
  const registry = stubRegistry(['empty']);
  const classified = classifyDiscovery(
    registry,
    { models: [], failures: [] },
    stubPool({ empty: 1 }),
  );

  assert.deepEqual(classified.refreshed, ['empty']);
  assert.equal(classified.exitCode, 0);
});

test('registry sync: exit code is 1 only when no configured provider refreshed', () => {
  const registry = stubRegistry(['broken', 'no-keys']);
  const classified = classifyDiscovery(
    registry,
    { models: [], failures: [{ provider: 'broken', kind: 'auth', message: 'invalid key' }] },
    stubPool({ broken: 1 }),
  );

  assert.deepEqual(classified.refreshed, []);
  assert.deepEqual(classified.unconfigured, ['no-keys']);
  assert.equal(classified.exitCode, 1);
});

test('registry sync: the report names every skipped provider and its reason', () => {
  const report: SyncReport = {
    upserted: 599,
    delisted: 0,
    refreshed: ['openrouter', 'tokenharbor'],
    failed: [{ provider: 'nvidia', kind: 'auth', message: 'Invalid API key' }],
    unconfigured: ['legacy'],
    exitCode: 0,
  };

  assert.deepEqual(formatSyncReport(report), [
    'Upserted: 599 models',
    'Providers refreshed: 2 (openrouter, tokenharbor)',
    'Skipped (error): nvidia [auth] Invalid API key',
    'Skipped (no creds): legacy',
  ]);
});

test('registry sync: a run where everything was skipped says so without inventing a refresh', () => {
  const lines = formatSyncReport({
    upserted: 0,
    delisted: 0,
    refreshed: [],
    failed: [],
    unconfigured: ['nvidia'],
    exitCode: 1,
  });

  assert.deepEqual(lines, [
    'Upserted: 0 models',
    'Providers refreshed: 0',
    'Skipped (no creds): nvidia',
  ]);
});
