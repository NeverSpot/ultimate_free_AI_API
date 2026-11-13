import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../../src/config/env';
import { buildServer } from '../../src/http/server';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';

const config: Config = {
  port: 0,
  adminToken: 'test-admin-token',
  encryptionKey: 'test-master-key-32-chars-minimum!',
  maxBodyBytes: 2 * 1024 * 1024,
  attemptTimeoutMs: 10_000,
  requestDeadlineMs: 30_000,
  logLevel: 'silent',
  nodeEnv: 'test',
};

const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model' });
const credential: Credential = { id: 'credential-1', provider: 'mock', secret: 'not-a-real-key' };

test('shutdown: server closes and rejects requests after close', async () => {
  const app = buildServer({ config, provider, credential, logger: false });
  await app.listen({ port: 0 });
  const addr = app.server.address();
  assert.ok(addr !== null, 'server should be listening before close');
  await app.close();
  let closed = false;
  try {
    await app.inject({ method: 'GET', url: '/healthz' });
  } catch {
    closed = true;
  }
  assert.equal(closed, true, 'inject should fail after the server is closed');
});
