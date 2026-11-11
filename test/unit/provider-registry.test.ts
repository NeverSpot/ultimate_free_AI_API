import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../src/core/errors';
import type { CanonicalChunk, CanonicalRequest, CanonicalResponse } from '../../src/core/types';
import type { CredentialPool } from '../../src/credentials/pool';
import { createProviderRegistry, discoverModels } from '../../src/providers/registry';
import type { Credential, ModelInfo, ProviderAdapter, ProviderId } from '../../src/providers/types';

/**
 * A hermetic adapter: `listModels` returns fixed data or throws, and chat/stream are
 * never exercised. Declared over an arbitrary id so no env var or real provider is
 * involved — registering a provider must not require editing anything outside this file.
 */
class FakeAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  readonly supportsStreaming = false;
  readonly #models: ModelInfo[];
  readonly #error: Error | undefined;

  constructor(id: ProviderId, models: ModelInfo[], error?: Error) {
    this.id = id;
    this.#models = models;
    this.#error = error;
  }

  chat(
    _req: CanonicalRequest,
    _cred: Credential,
    _signal?: AbortSignal,
  ): Promise<CanonicalResponse> {
    return Promise.reject(new Error('fake adapter: chat is not implemented'));
  }

  stream(
    _req: CanonicalRequest,
    _cred: Credential,
    _signal?: AbortSignal,
  ): AsyncIterable<CanonicalChunk> {
    throw new Error('fake adapter: stream is not implemented');
  }

  async listModels(_cred: Credential): Promise<ModelInfo[]> {
    if (this.#error !== undefined) {
      throw this.#error;
    }
    return this.#models;
  }
}

/** The fourth provider for the gate test: inline, distinct id, zero external edits. */
const fourthAdapter = new FakeAdapter('gate-fourth', [
  { id: 'gate-fourth-a', is_free: true },
  { id: 'gate-fourth-b', is_free: null },
]);

/**
 * Minimal in-memory pool: tests choose exactly which providers hold credentials.
 * A missing provider means "not configured" and must be skipped silently.
 */
function fakePool(counts: ReadonlyArray<[ProviderId, number]>): CredentialPool {
  const byProvider = new Map<ProviderId, Credential[]>(
    counts.map(([provider, count]) => [
      provider,
      Array.from({ length: count }, (_, index): Credential => ({
        id: `${provider}-${index + 1}`,
        provider,
        secret: `test-secret-${index + 1}`,
      })),
    ]),
  );

  const copy = (provider: ProviderId): Credential[] => [...(byProvider.get(provider) ?? [])];

  return {
    getCandidates: copy,
    credentialsFor: copy,
    providers(): ProviderId[] {
      return [...byProvider.keys()];
    },
    size(provider?: ProviderId): number {
      if (provider !== undefined) {
        return byProvider.get(provider)?.length ?? 0;
      }
      let total = 0;
      for (const credentials of byProvider.values()) {
        total += credentials.length;
      }
      return total;
    },
  };
}

test('provider registry: registration and lookup return the adapter that was registered', () => {
  const alpha = new FakeAdapter('alpha', [{ id: 'alpha-1' }]);
  const registry = createProviderRegistry([alpha]);

  assert.equal(registry.get('alpha'), alpha);
});

test('provider registry: a duplicate id throws naming the id and Duplicate', () => {
  assert.throws(
    () =>
      createProviderRegistry([
        new FakeAdapter('dup', [{ id: 'first' }]),
        new FakeAdapter('dup', [{ id: 'second' }]),
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Duplicate/);
      assert.match(error.message, /dup/);
      return true;
    },
  );
});

test('provider registry: an unknown id returns undefined', () => {
  const registry = createProviderRegistry([new FakeAdapter('alpha', [{ id: 'alpha-1' }])]);

  assert.equal(registry.get('nope'), undefined);
});

test('provider registry: ids() preserves registration order, size() counts, ids() is a fresh array', () => {
  const registry = createProviderRegistry([
    new FakeAdapter('third', []),
    new FakeAdapter('first', []),
    new FakeAdapter('second', []),
  ]);

  assert.deepEqual(registry.ids(), ['third', 'first', 'second']);
  assert.equal(registry.size(), 3);

  const ids = registry.ids();
  ids.push('mutated');
  assert.deepEqual(registry.ids(), ['third', 'first', 'second']);
});

test('provider registry: discovery tags every model with its own provider across two providers', async () => {
  const registry = createProviderRegistry([
    new FakeAdapter('alpha', [{ id: 'alpha-1' }, { id: 'alpha-2' }]),
    new FakeAdapter('beta', [{ id: 'beta-1' }]),
  ]);

  const result = await discoverModels(
    registry,
    fakePool([
      ['alpha', 1],
      ['beta', 2],
    ]),
  );

  assert.deepEqual(
    result.models.map((model) => [model.id, model.provider]),
    [
      ['alpha-1', 'alpha'],
      ['alpha-2', 'alpha'],
      ['beta-1', 'beta'],
    ],
  );
  assert.deepEqual(result.failures, []);
});

test('provider registry: a provider with no credentials is skipped and is not a failure', async () => {
  const registry = createProviderRegistry([
    new FakeAdapter('alpha', [{ id: 'alpha-1' }]),
    new FakeAdapter('unconfigured', [{ id: 'unconfigured-1' }]),
  ]);

  const result = await discoverModels(registry, fakePool([['alpha', 1]]));

  assert.deepEqual(
    result.models.map((model) => model.id),
    ['alpha-1'],
  );
  assert.deepEqual(result.failures, []);
});

test('provider registry: one rate_limited provider does not stop the others', async () => {
  const registry = createProviderRegistry([
    new FakeAdapter('throttled', [], new ProviderError('rate_limited', 'too many requests')),
    new FakeAdapter('healthy', [{ id: 'healthy-1' }]),
  ]);

  const result = await discoverModels(
    registry,
    fakePool([
      ['throttled', 1],
      ['healthy', 1],
    ]),
  );

  assert.deepEqual(
    result.models.map((model) => model.id),
    ['healthy-1'],
  );
  assert.deepEqual(result.failures, [
    { provider: 'throttled', kind: 'rate_limited', message: 'too many requests' },
  ]);
});

test('provider registry: a non-ProviderError throw becomes kind unknown', async () => {
  const registry = createProviderRegistry([
    new FakeAdapter('broken', [], new TypeError('socket closed')),
    new FakeAdapter('healthy', [{ id: 'healthy-1' }]),
  ]);

  const result = await discoverModels(
    registry,
    fakePool([
      ['broken', 1],
      ['healthy', 1],
    ]),
  );

  assert.deepEqual(result.failures, [
    { provider: 'broken', kind: 'unknown', message: 'socket closed' },
  ]);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['healthy-1'],
  );
});

test('provider registry: is_free true is preserved, null stays null and is never coerced to false', async () => {
  const registry = createProviderRegistry([
    new FakeAdapter('alpha', [
      { id: 'free', is_free: true },
      { id: 'unknown', is_free: null },
      { id: 'paid', is_free: false },
    ]),
  ]);

  const result = await discoverModels(registry, fakePool([['alpha', 1]]));
  const byId = new Map(result.models.map((model) => [model.id, model]));

  assert.equal(byId.get('free')?.is_free, true);
  assert.equal(byId.get('unknown')?.is_free, null);
  assert.notEqual(byId.get('unknown')?.is_free, false);
  assert.equal(byId.get('paid')?.is_free, false);
});

test('provider registry: a fourth inline adapter registers and is discovered with correct tagging', async () => {
  const registry = createProviderRegistry([
    new FakeAdapter('alpha', [{ id: 'alpha-1' }]),
    new FakeAdapter('beta', [{ id: 'beta-1' }]),
    new FakeAdapter('gamma', [{ id: 'gamma-1' }]),
    fourthAdapter,
  ]);

  assert.equal(registry.size(), 4);
  assert.equal(registry.get('gate-fourth'), fourthAdapter);

  const result = await discoverModels(registry, fakePool([['gate-fourth', 1]]));

  assert.deepEqual(
    result.models.map((model) => [model.id, model.provider]),
    [
      ['gate-fourth-a', 'gate-fourth'],
      ['gate-fourth-b', 'gate-fourth'],
    ],
  );
  assert.deepEqual(result.failures, []);
});
