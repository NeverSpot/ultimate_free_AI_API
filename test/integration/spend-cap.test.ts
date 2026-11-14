import assert from 'node:assert/strict';
import { describe, test, before, beforeEach, after } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/http/server';
import { createDbClient } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { MockProviderAdapter } from '../../src/providers/mock';
import type { Credential } from '../../src/providers/types';
import type { Config } from '../../src/config/env';

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const optedIn =
  process.env.RUN_INTEGRATION === '1' || process.env.npm_lifecycle_event === 'test:int';
const skip = !optedIn ? 'RUN_INTEGRATION !== 1' : !DATABASE_URL ? 'DATABASE_URL is not set' : false;

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

const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model', content: 'ok' });
const credential: Credential = { id: 'credential-1', provider: 'mock', secret: 'test-secret' };

const ORG_ID = 'org-spend-cap-test';
const USER_ID = 'user-spend-cap-test';

function makeApp(): FastifyInstance {
  return buildServer({ config, provider, credential, logger: false });
}

describe('Team spend caps', { skip }, () => {
  let dbClient!: ReturnType<typeof createDbClient>;
  let app!: FastifyInstance;

  before(async () => {
    dbClient = createDbClient(DATABASE_URL);
    await runMigrations(dbClient);
    app = makeApp();
  });

  beforeEach(async () => {
    await dbClient.query('delete from org_spend_caps');
  });

  after(async () => {
    await dbClient?.close();
    await app?.close();
  });

  test('POST then GET org spend cap round-trips', async () => {
    const postRes = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG_ID}/spend-cap`,
      payload: { userId: USER_ID, capUsd: 123.45, period: 'monthly' },
    });
    assert.equal(postRes.statusCode, 200, String(postRes.body));
    const posted = postRes.json() as { orgId: string; capUsd: number; period: string };
    assert.equal(posted.orgId, ORG_ID);
    assert.equal(posted.capUsd, 123.45);
    assert.equal(posted.period, 'monthly');

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ORG_ID}/spend-cap?userId=${USER_ID}`,
    });
    assert.equal(getRes.statusCode, 200, String(getRes.body));
    const fetched = getRes.json() as { orgId: string; capUsd: number; period: string };
    assert.equal(fetched.orgId, ORG_ID);
    assert.equal(fetched.capUsd, 123.45);
    assert.equal(fetched.period, 'monthly');
  });

  test('GET with no cap configured returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ORG_ID}/spend-cap?userId=${USER_ID}`,
    });
    assert.equal(res.statusCode, 404);
  });

  test('POST missing userId returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${ORG_ID}/spend-cap`,
      payload: { capUsd: 10 },
    });
    assert.equal(res.statusCode, 400);
  });
});
