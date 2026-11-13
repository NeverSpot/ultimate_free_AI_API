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

test('metrics: returns text/plain with p95', async () => {
  const app = makeApp();
  const res = await app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers['content-type']).includes('text/plain'));
  assert.ok(res.body.includes('gateway_latency_p95_ms'));
  assert.ok(res.body.includes('gateway_requests_total'));
  await app.close();
});
