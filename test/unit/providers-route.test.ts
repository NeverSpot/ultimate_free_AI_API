import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerProvidersRoute } from '../../src/http/routes/providers';
import { PROVIDER_SPECS } from '../../src/providers/catalog';

interface ProviderRow {
  id: string;
  name: string;
  tier: 'free' | 'credit';
  key_env_var: string;
  free_note: string;
  signup_url: string;
  requires_env: string | null;
}

test('GET /v1/providers serves the whole catalog, not only the configured providers', async () => {
  const app = Fastify();
  registerProvidersRoute(app);

  const response = await app.inject({ method: 'GET', url: '/v1/providers' });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json() as { providers: ProviderRow[] };

  assert.equal(body.providers.length, PROVIDER_SPECS.length);
  assert.equal(
    body.providers.filter((provider) => provider.tier === 'free').length,
    12,
    'the keys screen groups rows by tier, so the split must be stable',
  );
  assert.equal(body.providers.filter((provider) => provider.tier === 'credit').length, 7);

  for (const provider of body.providers) {
    assert.equal(typeof provider.key_env_var, 'string');
    assert.ok(provider.key_env_var.length > 0);
    assert.ok(provider.free_note.length > 0, `${provider.id} needs a free-tier note for the UI`);
  }

  const cloudflare = body.providers.find((provider) => provider.id === 'cloudflare');
  assert.equal(cloudflare?.requires_env, 'CLOUDFLARE_ACCOUNT_ID');
});
