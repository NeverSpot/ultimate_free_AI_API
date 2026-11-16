import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDbClient } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createUserModel, type UserModel } from '../../src/models/user';
import { createOrganizationModel, type OrganizationModel } from '../../src/models/organization';
import { createGatewayKeyAuth } from '../../src/http/middleware/gateway-key-auth';
import { buildServer } from '../../src/http/server';
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
  jwtSecret: 'test-secret',
};

const provider = new MockProviderAdapter({ id: 'mock', model: 'mock-model' });
const credential: Credential = {
  id: 'credential-1',
  provider: 'mock',
  secret: 'not-a-real-key',
};

let app!: ReturnType<typeof buildServer>;
let dbClient!: ReturnType<typeof createDbClient>;
let orgStore!: OrganizationModel;
let orgId!: string;
let nonMemberUserId!: string;
let nonMemberGatewayKey!: string;

describe('organizations', { skip }, () => {
  before(async () => {
    dbClient = createDbClient(DATABASE_URL);
    await runMigrations(dbClient);
    const userStore: UserModel = createUserModel(dbClient);
    orgStore = createOrganizationModel(dbClient);
    const gatewayKeyAuth = createGatewayKeyAuth({
      adminToken: config.adminToken,
      findUserByGatewayKey: (hash) => userStore.findByGatewayApiKeyHash(hash),
    });
    app = buildServer({
      config,
      provider,
      credential,
      logger: false,
      userStore,
      orgStore,
      gatewayKeyAuth,
    });
  });

  after(async () => {
    await app.close();
    await dbClient.close();
  });

  async function registerUser(username: string, email: string, password = 'Password1234!') {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { username, email, password },
    });
    assert.equal(res.statusCode, 201, 'register must succeed');
    const body = JSON.parse(res.body);
    return {
      gatewayApiKey: body.gateway_api_key as string,
      userId: body.user.id as string,
    };
  }

  const suffix = String(Date.now());

  test('create org returns 201; listing keys requires membership', async () => {
    const owner = await registerUser(`alice_${suffix}`, `alice_${suffix}@example.com`);
    const nonMember = await registerUser(`bob_${suffix}`, `bob_${suffix}@example.com`);
    nonMemberUserId = nonMember.userId;
    nonMemberGatewayKey = nonMember.gatewayApiKey;

    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: { authorization: `Bearer ${owner.gatewayApiKey}` },
      payload: { name: `Acme_${suffix}` },
    });
    assert.equal(createRes.statusCode, 201);
    const body = JSON.parse(createRes.body);
    assert.equal(body.name, `Acme_${suffix}`);
    assert.ok(typeof body.id === 'string' && body.id.length > 0);
    orgId = body.id as string;

    // Non-member must not be able to list org keys.
    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/keys`,
      headers: { authorization: `Bearer ${nonMember.gatewayApiKey}` },
    });
    assert.equal(listRes.statusCode, 403);
  });

  test('member can list org keys', async () => {
    assert.ok(orgId, 'org must be created by the first test');
    await orgStore.addOrgMember(orgId, nonMemberUserId);

    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/keys`,
      headers: { authorization: `Bearer ${nonMemberGatewayKey}` },
    });
    assert.equal(listRes.statusCode, 200);
    const body = JSON.parse(listRes.body);
    assert.equal(Array.isArray(body.keys), true);
    assert.equal(body.keys.length, 0);
  });
});
