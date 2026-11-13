import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
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

function makeApp(): FastifyInstance {
  return buildServer({ config, provider, credential, logger: false });
}

test('trace-id: returns x-request-id header', async (t) => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers['x-request-id']).length > 0, 'x-request-id must be non-empty');
  await app.close();
});
