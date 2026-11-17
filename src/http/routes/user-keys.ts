import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { encryptAes256Gcm, sha256Hex } from '../../lib/crypto';
import { ApiError } from '../errors';
import type { UserProviderKey, UserProviderKeyModel } from '../../models/user-provider-key';

const KeySummary = Type.Object({
  provider: Type.String(),
  fingerprint: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

type KeySummaryType = Static<typeof KeySummary>;

const ListResponse = Type.Object({
  keys: Type.Array(KeySummary),
});

const SubmitBody = Type.Object({
  provider: Type.String(),
  providerKey: Type.String(),
});

const Params = Type.Object({
  provider: Type.String(),
});

const DeleteResponse = Type.Object({
  ok: Type.Boolean(),
});

function requireNonEmpty(fields: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new ApiError('client', `${name} is required`);
    }
  }
}

function toKeySummary(key: UserProviderKey): KeySummaryType {
  return {
    provider: key.provider,
    fingerprint: key.fingerprint,
    created_at: key.created_at.toISOString(),
    updated_at: key.updated_at.toISOString(),
  };
}

function requireUserId(
  request: FastifyRequest,
  getUserId: (req: FastifyRequest) => string | null,
): string {
  const userId = getUserId(request);
  if (!userId) {
    throw new ApiError('auth', 'authentication required');
  }
  return userId;
}

export function registerUserKeyRoutes(
  app: FastifyInstance,
  deps: {
    providerKeyStore: UserProviderKeyModel;
    getUserId: (req: FastifyRequest) => string | null;
    encryptionKey: string;
  },
): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();
  const store = deps.providerKeyStore;
  const encryptionKey = deps.encryptionKey;

  server.get(
    '/v1/user/keys',
    { schema: { response: { 200: ListResponse } } },
    async (request, reply) => {
      const userId = requireUserId(request, deps.getUserId);
      const keys = await store.listKeys(userId);
      return reply.status(200).send({ keys: keys.map(toKeySummary) });
    },
  );

  server.post(
    '/v1/user/keys',
    { schema: { body: SubmitBody, response: { 200: KeySummary } } },
    async (request, reply) => {
      const userId = requireUserId(request, deps.getUserId);
      requireNonEmpty({ provider: request.body.provider, providerKey: request.body.providerKey });
      const { provider, providerKey } = request.body;
      const { ciphertext, iv, authTag } = encryptAes256Gcm(providerKey, encryptionKey);
      const fingerprint = sha256Hex(`${userId}:${provider}`);

      const existing = await store.findByUserIdAndProvider(userId, provider);
      let key: UserProviderKey;
      if (existing !== null) {
        await store.updateKey(existing.id, userId, {
          ciphertext,
          iv,
          auth_tag: authTag,
          fingerprint,
        });
        const refreshed = await store.findByUserIdAndProvider(userId, provider);
        if (refreshed === null) {
          throw new Error('registerUserKeyRoutes: upsert row disappeared');
        }
        key = refreshed;
      } else {
        key = await store.createUserProviderKey({
          user_id: userId,
          provider,
          ciphertext,
          iv,
          auth_tag: authTag,
          fingerprint,
        });
      }

      return reply.status(200).send(toKeySummary(key));
    },
  );

  server.delete(
    '/v1/user/keys/:provider',
    { schema: { params: Params, response: { 200: DeleteResponse } } },
    async (request, reply) => {
      const userId = requireUserId(request, deps.getUserId);
      await store.removeKey(userId, request.params.provider);
      return reply.status(200).send({ ok: true });
    },
  );
}
