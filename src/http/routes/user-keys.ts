import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { encryptAes256Gcm } from '../../lib/crypto';
import { ApiError } from '../errors';
import {
  providerKeyFingerprint,
  type UserProviderKey,
  type UserProviderKeyModel,
} from '../../models/user-provider-key';

const KeySummary = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  label: Type.String(),
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
  label: Type.Optional(Type.String()),
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
    id: key.id,
    provider: key.provider,
    label: key.label,
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

      // Derived from the key itself, not from (user, provider): that is what lets
      // one user hold several keys for one provider.
      const fingerprint = providerKeyFingerprint(userId, provider, providerKey);

      // A repeat submission is a conflict, not a silent replace. The previous
      // upsert destroyed whatever key was already sitting on that row.
      const existing = await store.findByFingerprint(fingerprint);
      if (existing !== null) {
        throw new ApiError('conflict', 'this key is already registered');
      }

      const forProvider = await store.listKeysByProvider(userId, provider);
      const label = request.body.label ?? `${provider}-${forProvider.length + 1}`;

      const key = await store.createUserProviderKey({
        user_id: userId,
        provider,
        label,
        ciphertext,
        iv,
        auth_tag: authTag,
        fingerprint,
      });

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
