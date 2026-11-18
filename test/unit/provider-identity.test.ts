import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCredentialPool } from '../../src/credentials/pool';
import { findProviderSpec } from '../../src/providers/catalog';
import { defaultAdapters } from '../../src/providers/defaults';

const ALL_PROVIDERS_ENV = { ENABLE_CREDIT_PROVIDERS: '1' } as NodeJS.ProcessEnv;

test('provider identity: every adapter id is a key the credential pool understands', () => {
  // A provider id is a three-way contract: adapter.id === pool provider key === catalog id.
  // When these drift, the pool silently returns [] and every request looks unauthorised.
  for (const adapter of defaultAdapters(ALL_PROVIDERS_ENV)) {
    const spec = findProviderSpec(adapter.id);
    assert.ok(spec, `adapter id "${adapter.id}" is not in the provider catalog`);

    const pool = loadCredentialPool({
      ...ALL_PROVIDERS_ENV,
      [spec.keyEnvVar]: 'test-key-value',
    } as NodeJS.ProcessEnv);
    const candidates = pool.getCandidates(adapter.id);

    assert.equal(
      candidates.length,
      1,
      `loadCredentialPool(${spec.keyEnvVar}) must yield a candidate for provider "${adapter.id}"`,
    );
    assert.equal(candidates[0]?.provider, adapter.id);
  }
});

test('provider identity: adapter ids are unique', () => {
  const ids = defaultAdapters(ALL_PROVIDERS_ENV).map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('provider identity: defaultAdapters() is the single composition root', () => {
  // Every CLI builds its adapter set from defaultAdapters(), so adding a provider must be
  // one catalog row — never an edit in scripts/smoke.ts or scripts/registry-list.ts.
  const adapters = defaultAdapters(ALL_PROVIDERS_ENV);
  const ids = adapters.map((adapter) => adapter.id);

  assert.equal(new Set(ids).size, ids.length, 'defaultAdapters() must not register a duplicate id');

  for (const id of ids) {
    assert.ok(findProviderSpec(id), `defaultAdapters() exposes "${id}" with no catalog row`);
  }
});
