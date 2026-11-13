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

test('healthz: returns 200 when healthy', async (t) => {
  const app = buildServer({ config, provider, credential, logger: false });
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, 'ok');
  assert.equal(body.checks.redis, 'unknown');
  assert.equal(body.checks.postgres, 'unknown');
  assert.equal(body.version, '0.1.0');
  await app.close();
});
