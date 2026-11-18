import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREDIT_PROVIDERS_ENV,
  PROVIDER_SPECS,
  isProviderEnabled,
} from '../../src/providers/catalog';
import { defaultAdapters } from '../../src/providers/defaults';
import { loadCredentialPool } from '../../src/credentials/pool';

test('catalog: provider ids and env vars are unique', () => {
  const ids = PROVIDER_SPECS.map((spec) => spec.id);
  const envVars = PROVIDER_SPECS.map((spec) => spec.keyEnvVar);

  assert.equal(new Set(ids).size, ids.length, 'duplicate provider id in the catalog');
  assert.equal(new Set(envVars).size, envVars.length, 'two providers share an env var');
});

test('catalog: aliases never shadow a real provider id', () => {
  const ids = new Set(PROVIDER_SPECS.map((spec) => spec.id));
  for (const spec of PROVIDER_SPECS) {
    for (const alias of spec.aliases ?? []) {
      assert.equal(ids.has(alias), false, `alias "${alias}" collides with a provider id`);
    }
  }
});

test('catalog: credit providers stay dark unless explicitly enabled', () => {
  const creditSpecs = PROVIDER_SPECS.filter((spec) => spec.tier === 'credit');
  assert.ok(creditSpecs.length > 0, 'the catalog must carry the credit-backed providers');

  for (const spec of creditSpecs) {
    assert.equal(isProviderEnabled(spec, {} as NodeJS.ProcessEnv), false);

    // Even with a key present, an un-opted-in host must not pool it.
    const pool = loadCredentialPool({ [spec.keyEnvVar]: 'key-value' } as NodeJS.ProcessEnv);
    assert.deepEqual(pool.getCandidates(spec.id), [], `${spec.id} must not be pooled by default`);

    const optedIn = loadCredentialPool({
      [spec.keyEnvVar]: 'key-value',
      [CREDIT_PROVIDERS_ENV]: '1',
    } as NodeJS.ProcessEnv);
    assert.equal(optedIn.getCandidates(spec.id).length, 1);
  }
});

test('catalog: free-tier providers are pooled without any opt-in', () => {
  for (const spec of PROVIDER_SPECS.filter((row) => row.tier === 'free')) {
    const pool = loadCredentialPool({ [spec.keyEnvVar]: 'key-value' } as NodeJS.ProcessEnv);
    assert.equal(pool.getCandidates(spec.id).length, 1, `${spec.id} must be pooled by default`);
  }
});

test('catalog: every enabled row has exactly one adapter', () => {
  const adapters = defaultAdapters({ [CREDIT_PROVIDERS_ENV]: '1' } as NodeJS.ProcessEnv);
  assert.equal(adapters.length, PROVIDER_SPECS.length);

  const disabled = defaultAdapters({} as NodeJS.ProcessEnv);
  assert.equal(
    disabled.length,
    PROVIDER_SPECS.filter((spec) => spec.tier === 'free').length,
    'a host without the opt-in must not build credit adapters',
  );
});

test('catalog: a placeholder base URL without its env var is reported, not silently called', () => {
  const cloudflare = PROVIDER_SPECS.find((spec) => spec.id === 'cloudflare');
  assert.ok(cloudflare);
  assert.equal(cloudflare.requiresEnv, 'CLOUDFLARE_ACCOUNT_ID');

  const [adapter] = defaultAdapters({} as NodeJS.ProcessEnv).filter(
    (candidate) => candidate.id === 'cloudflare',
  );
  assert.ok(adapter);
  return assert.rejects(
    () => adapter.listModels({ id: 'c1', provider: 'cloudflare', secret: 'secret' }),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
});
