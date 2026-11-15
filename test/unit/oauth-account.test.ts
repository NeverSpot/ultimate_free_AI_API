import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthAccountModel } from '../../src/models/oauth-account';
import { encryptAes256Gcm } from '../../src/lib/crypto';

// Test-only fixture, never a real credential.
const MASTER_KEY = 'test-oauth-unit-master-key';

interface FakeQuery {
  sql: string | null;
  params: unknown[] | null;
}

function makeDb(responses: Array<{ rows: unknown[]; rowCount?: number | null }>) {
  const captured: FakeQuery = { sql: null, params: null };
  let index = 0;
  const db = {
    query: async <Row = unknown>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ rows: Row[]; rowCount: number | null }> => {
      captured.sql = sql;
      captured.params = params ? [...params] : [];
      const response = (responses[index] ?? responses[responses.length - 1])!;
      index += 1;
      return { rows: response.rows as Row[], rowCount: response.rowCount ?? null };
    },
  };
  return { db, captured };
}

function fullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acc-1',
    user_id: 'user-1',
    provider: 'google',
    provider_user_id: 'google-user-9',
    provider_email: 'user@example.com',
    access_token_encrypted: '',
    raw_profile: '{}',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function serializedToken(plaintext: string): string {
  const encrypted = encryptAes256Gcm(plaintext, MASTER_KEY);
  return JSON.stringify({
    ciphertext: encrypted.ciphertext.toString('base64'),
    iv: encrypted.iv.toString('base64'),
    authTag: encrypted.authTag.toString('base64'),
  });
}

test('oauth-account: createAccount inserts and encrypts the access token', async () => {
  const token = 'plaintext-access-token';
  const raw_profile = { sub: 'abc-123', email: 'user@example.com' };
  const stored = 'stored-encrypted-access-token';
  const { db, captured } = makeDb([{ rows: [fullRow({ access_token_encrypted: stored, raw_profile: JSON.stringify(raw_profile) })] }]);
  const model = createOAuthAccountModel(db, MASTER_KEY);

  const account = await model.createAccount({
    user_id: 'user-1',
    provider: 'google',
    provider_user_id: 'google-user-9',
    provider_email: 'user@example.com',
    access_token: token,
    raw_profile,
  });

  assert.equal(captured.sql!.includes('insert into oauth_accounts'), true);
  assert.equal(captured.sql!.includes('returning'), true);
  assert.equal(captured.params![0], 'user-1');
  assert.equal(captured.params![1], 'google');
  assert.equal(captured.params![2], 'google-user-9');
  assert.equal(captured.params![3], 'user@example.com');
  const encrypted = captured.params![4] as string;
  assert.notEqual(encrypted, token);
  assert.equal(typeof encrypted, 'string');
  assert.equal(JSON.parse(captured.params![5] as string).sub, 'abc-123');

  assert.equal(account.id, 'acc-1');
  assert.equal(account.access_token_encrypted, stored);
  assert.deepEqual(account.raw_profile, raw_profile);
});

test('oauth-account: findByProviderUserId returns null when no account exists', async () => {
  const { db, captured } = makeDb([{ rows: [] }]);
  const model = createOAuthAccountModel(db, MASTER_KEY);

  const account = await model.findByProviderUserId('google', 'nope');
  assert.equal(account, null);
  assert.equal(captured.sql!.includes('from oauth_accounts'), true);
  assert.equal(
    captured.sql!.includes('where provider = $1 and provider_user_id = $2'),
    true,
  );
});

test('oauth-account: findByProviderUserId maps an existing row', async () => {
  const stored = serializedToken('tok');
  const { db } = makeDb([
    {
      rows: [
        fullRow({
          provider: 'github',
          provider_user_id: 'gh-42',
          access_token_encrypted: stored,
          raw_profile: '{"login":"rise"}',
        }),
      ],
    },
  ]);
  const model = createOAuthAccountModel(db, MASTER_KEY);

  const account = await model.findByProviderUserId('github', 'gh-42');
  assert.ok(account);
  assert.equal(account!.provider_user_id, 'gh-42');
  assert.equal(account!.access_token_encrypted, stored);
  assert.deepEqual(account!.raw_profile, { login: 'rise' });
});

test('oauth-account: getAccessToken round-trips the plaintext token', async () => {
  const plaintext = 'my-secret-token';
  const stored = serializedToken(plaintext);
  const { db } = makeDb([{ rows: [fullRow({ access_token_encrypted: stored })] }]);
  const model = createOAuthAccountModel(db, MASTER_KEY);

  assert.equal(await model.getAccessToken('acc-1'), plaintext);
});

test('oauth-account: getAccessToken returns null for unknown account', async () => {
  const { db } = makeDb([{ rows: [] }]);
  const model = createOAuthAccountModel(db, MASTER_KEY);

  assert.equal(await model.getAccessToken('missing'), null);
});

test('oauth-account: linkAccount creates when absent, updates when present', async () => {
  const token = 'token-v1';
  const { db, captured } = makeDb([
    { rows: [] }, // findByProviderUserId: absent -> create
    { rows: [fullRow({ raw_profile: '{}' })] }, // createAccount insert -> row
  ]);
  const model = createOAuthAccountModel(db, MASTER_KEY);

  const created = await model.linkAccount({
    user_id: 'user-1',
    provider: 'google',
    provider_user_id: 'google-user-9',
    provider_email: 'user@example.com',
    access_token: token,
    raw_profile: { a: 1 },
  });
  assert.equal(created.id, 'acc-1');
  assert.equal(captured.sql!.includes('update oauth_accounts'), false);

  // Second link: present -> update
  const existing = fullRow({
    provider: 'google',
    provider_user_id: 'google-user-9',
    access_token_encrypted: serializedToken('old'),
  });
  const updateDb = makeDb([
    { rows: [existing] }, // findByProviderUserId: present
    { rows: [], rowCount: 1 }, // update
  ]);
  const updateModel = createOAuthAccountModel(updateDb.db, MASTER_KEY);
  const updated = await updateModel.linkAccount({
    user_id: 'user-1',
    provider: 'google',
    provider_user_id: 'google-user-9',
    provider_email: 'user@example.com',
    access_token: token,
    raw_profile: { b: 2 },
  });
  assert.equal(updated.id, 'acc-1');
  assert.deepEqual(updated.raw_profile, { b: 2 });
  const up = updateDb.captured;
  assert.ok(up.sql!.includes('update oauth_accounts'));
  assert.equal(up.params![2], existing.id);
  assert.equal(JSON.parse(up.params![1] as string).b, 2);
  // The stored token must have changed from the old encrypted value.
  assert.notEqual(up.params![0], existing.access_token_encrypted);
});
