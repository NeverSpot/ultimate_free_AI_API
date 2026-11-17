import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { buildUserCredentials } from '../../src/http/routes/chat-completions';
import type { ServerDeps } from '../../src/http/server';
import type { ChatRouterDeps } from '../../src/http/routes/router-runtime';
import type { UserProviderKey, UserProviderKeyModel } from '../../src/models/user-provider-key';

type Row = { id: string; provider: string; secret: string };

function fakeKeyStore(rows: Row[]): UserProviderKeyModel {
  const asRow = (row: Row, userId: string): UserProviderKey => ({
    id: row.id,
    user_id: userId,
    provider: row.provider,
    label: row.provider,
    ciphertext: Buffer.alloc(0),
    iv: Buffer.alloc(0),
    auth_tag: Buffer.alloc(0),
    fingerprint: `fp-${row.id}`,
    created_at: new Date(0),
    updated_at: new Date(0),
  });

  return {
    createUserProviderKey: async () => {
      throw new Error('not used');
    },
    findByUserIdAndProvider: async () => null,
    findByFingerprint: async () => null,
    updateKey: async () => false,
    listKeys: async (userId) => rows.map((row) => asRow(row, userId)),
    listKeysByProvider: async () => [],
    deleteKeyById: async () => false,
    getDecryptedKey: async (_userId, keyId) => rows.find((row) => row.id === keyId)?.secret ?? null,
    removeKey: async () => false,
  };
}

function depsWith(store: UserProviderKeyModel): ServerDeps & ChatRouterDeps {
  return { providerKeyStore: store } as unknown as ServerDeps & ChatRouterDeps;
}

const request = { user: { id: 'u1', username: 'alice' } } as unknown as FastifyRequest;

test('buildUserCredentials collapses rows that share one secret', async () => {
  // Two rows, one secret — a legacy duplicate, or the same key submitted twice
  // under different fingerprints. Two credentials would mean two budgets for one
  // account, so the pool would believe in headroom that does not exist.
  const store = fakeKeyStore([
    { id: 'k1', provider: 'openrouter', secret: 'sk-or-same' },
    { id: 'k2', provider: 'openrouter', secret: 'sk-or-same' },
  ]);

  const credentials = await buildUserCredentials(request, depsWith(store));

  assert.equal(credentials?.length, 1, 'one secret must yield one credential, not two budgets');
});

test('buildUserCredentials keeps rows whose secrets differ', async () => {
  // The guard against over-dedupe: two genuinely different keys must both survive,
  // or the feature this plan exists for would collapse to one key.
  const store = fakeKeyStore([
    { id: 'k1', provider: 'openrouter', secret: 'sk-or-a' },
    { id: 'k2', provider: 'openrouter', secret: 'sk-or-b' },
  ]);

  const credentials = await buildUserCredentials(request, depsWith(store));

  assert.equal(credentials?.length, 2);
  assert.notEqual(credentials?.[0]?.secret, credentials?.[1]?.secret);
});
