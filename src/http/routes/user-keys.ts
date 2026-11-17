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
import type { ParkingStatus } from '../../resilience/parking';

const KeySummary = Type.Object({
  id: Type.String(),
  provider: Type.String(),
  label: Type.String(),
  fingerprint: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
  parked: Type.Boolean(),
  retry_after_ms: Type.Number(),
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

// Two segments: `:keyId` alone would collide with the provider names already
// occupying that segment on the sibling delete route.
const KeyParams = Type.Object({
  provider: Type.String(),
  keyId: Type.String(),
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

/** A key with no health reading: not parked, nothing to wait for. */
const UNPARKED: ParkingStatus = { parked: false, retryAfterMs: 0 };

function toKeySummary(key: UserProviderKey, status: ParkingStatus): KeySummaryType {
  return {
    id: key.id,
    provider: key.provider,
    label: key.label,
    fingerprint: key.fingerprint,
    created_at: key.created_at.toISOString(),
    updated_at: key.updated_at.toISOString(),
    parked: status.parked,
    retry_after_ms: status.retryAfterMs,
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
    /**
     * Per-credential park status. Injected rather than imported on purpose: the
     * module-level `isParked` helper throws unless `configureParking` has run, and
     * nothing in this codebase calls it — the real one is the injected `Parking`.
     */
    isParked?: (credentialId: string) => Promise<ParkingStatus>;
  },
): void {
  const server = app.withTypeProvider<TypeBoxTypeProvider>();
  const store = deps.providerKeyStore;
  const encryptionKey = deps.encryptionKey;

  const readHealth = async (credentialId: string): Promise<ParkingStatus> => {
    if (deps.isParked === undefined) {
      return UNPARKED;
    }
    try {
      return await deps.isParked(credentialId);
    } catch {
      // Health is a display field: a Redis blip must not take the keys list down.
      return UNPARKED;
    }
  };

  server.get(
    '/v1/user/keys',
    { schema: { response: { 200: ListResponse } } },
    async (request, reply) => {
      const userId = requireUserId(request, deps.getUserId);
      const keys = await store.listKeys(userId);
      const summaries = await Promise.all(
        keys.map(async (key) => toKeySummary(key, await readHealth(key.id))),
      );
      return reply.status(200).send({ keys: summaries });
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

      // A key that was just created cannot be parked: report it available.
      return reply.status(200).send(toKeySummary(key, UNPARKED));
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

  server.delete(
    '/v1/user/keys/:provider/:keyId',
    { schema: { params: KeyParams, response: { 200: DeleteResponse } } },
    async (request, reply) => {
      const userId = requireUserId(request, deps.getUserId);
      const removed = await store.deleteKeyById(userId, request.params.keyId);
      if (!removed) {
        // 404 rather than 403 when the key belongs to someone else: the caller
        // learns nothing about whether that id exists at all.
        throw new ApiError('not_found', 'no such key');
      }
      return reply.status(200).send({ ok: true });
    },
  );
}
