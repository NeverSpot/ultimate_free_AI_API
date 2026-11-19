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
import { findProviderSpec } from '../../providers/catalog';
import type { KeyTestResult } from '../../providers/test-key';

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

const TestResponse = Type.Object({
  ok: Type.Boolean(),
  provider: Type.String(),
  model: Type.Union([Type.String(), Type.Null()]),
  latency_ms: Type.Number(),
  prompt_tokens: Type.Number(),
  completion_tokens: Type.Number(),
  reply: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  error_kind: Type.Union([Type.String(), Type.Null()]),
  http_status: Type.Union([Type.Number(), Type.Null()]),
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

/** Postgres `unique_violation`. Raised when two submissions race past the pre-check. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

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
    /**
     * Runs a live check against one stored key. Injected by the composition root
     * so the route never imports a provider adapter or reads the environment.
     */
    testProviderKey?: (provider: string, secret: string) => Promise<KeyTestResult>;
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

      let key: UserProviderKey;
      try {
        key = await store.createUserProviderKey({
          user_id: userId,
          provider,
          label,
          ciphertext,
          iv,
          auth_tag: authTag,
          fingerprint,
        });
      } catch (error) {
        // Two submissions can both pass the pre-check above and collide only at the
        // unique index. Postgres reports that as SQLSTATE 23505, which would
        // otherwise escape the error handler as a 500.
        if (isUniqueViolation(error)) {
          throw new ApiError('conflict', 'this key is already registered');
        }
        throw error;
      }

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

  /**
   * Test one stored key against its own provider.
   *
   * Upstream failures are a 200 with `ok: false`: the request succeeded, the key
   * did not. Only auth, an unknown key, or a provider/key mismatch is an HTTP error.
   */
  server.post(
    '/v1/user/keys/:provider/:keyId/test',
    { schema: { params: KeyParams, response: { 200: TestResponse } } },
    async (request, reply) => {
      const userId = requireUserId(request, deps.getUserId);
      const keys = await store.listKeys(userId);
      const key = keys.find((row) => row.id === request.params.keyId);
      if (key === undefined) {
        throw new ApiError('not_found', 'no such key');
      }

      const requested = findProviderSpec(request.params.provider);
      const stored = findProviderSpec(key.provider);
      if (requested === undefined || stored === undefined || requested.id !== stored.id) {
        throw new ApiError('client', 'that key belongs to a different provider');
      }

      if (deps.testProviderKey === undefined) {
        throw new ApiError('unsupported', 'key testing is not configured on this server');
      }

      const secret = await store.getDecryptedKey(userId, key.id);
      if (secret === null) {
        throw new ApiError('conflict', 'this server cannot decrypt the stored key');
      }

      return reply.status(200).send(await deps.testProviderKey(stored.id, secret));
    },
  );
}
