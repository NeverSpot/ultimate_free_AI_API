import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCredentialPool } from '../../src/credentials/pool';
import { NvidiaNimAdapter } from '../../src/providers/nvidia-nim';
import { OpenRouterAdapter } from '../../src/providers/openrouter';
import { TokenHarborAdapter } from '../../src/providers/tokenharbor';

const ENV_VAR: Record<string, string> = {
  nvidia: 'NVIDIA_NIM_KEYS',
  openrouter: 'OPENROUTER_KEYS',
  tokenharbor: 'TOKENHARBOR_KEYS',
};

const adapters = [new NvidiaNimAdapter(), new OpenRouterAdapter(), new TokenHarborAdapter()];

test('provider identity: every adapter id is a key the credential pool understands', () => {
  // A provider id is a three-way contract: adapter.id === pool provider key === env var.
  // When these drift, the pool silently returns [] and every request looks unauthorised.
  for (const adapter of adapters) {
    const envVar = ENV_VAR[adapter.id];
    assert.ok(envVar, `adapter id "${adapter.id}" has no known env variable`);

    const pool = loadCredentialPool({ [envVar]: 'test-key-value' } as NodeJS.ProcessEnv);
    const candidates = pool.getCandidates(adapter.id);

    assert.equal(
      candidates.length,
      1,
      `loadCredentialPool(${envVar}) must yield a candidate for provider "${adapter.id}"`,
    );
    assert.equal(candidates[0]?.provider, adapter.id);
  }
});

test('provider identity: adapter ids are unique', () => {
  const ids = adapters.map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length);
});
