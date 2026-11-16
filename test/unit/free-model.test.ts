import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFreeRequest,
  resolveFreeCandidates,
  clearFreeModelCache,
} from '../../src/routing/free-model';
import { createProviderRegistry } from '../../src/providers/registry';
import type { ModelInfo, ProviderAdapter, Credential } from '../../src/providers/types';

/** Minimal adapter that returns a fixed model list. */
class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly supportsStreaming = false;
  private readonly models: ModelInfo[];
  readonly calls: { count: number };

  constructor(id: string, models: ModelInfo[]) {
    this.id = id;
    this.models = models;
    this.calls = { count: 0 };
  }

  async chat(): Promise<never> {
    throw new Error('not used');
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<never> {
    throw new Error('not used');
  }

  async listModels(): Promise<ModelInfo[]> {
    this.calls.count += 1;
    return this.models;
  }
}

const credential = (provider: string): Credential => ({
  id: `${provider}-cred`,
  provider,
  secret: 'secret',
});

// ---------------------------------------------------------------------------
// isFreeRequest
// ---------------------------------------------------------------------------

test('isFreeRequest: true for undefined, empty, free, auto (any case)', () => {
  assert.equal(isFreeRequest(undefined), true);
  assert.equal(isFreeRequest(''), true);
  assert.equal(isFreeRequest('   '), true);
  assert.equal(isFreeRequest('free'), true);
  assert.equal(isFreeRequest('FREE'), true);
  assert.equal(isFreeRequest('Free'), true);
  assert.equal(isFreeRequest('auto'), true);
  assert.equal(isFreeRequest('AUTO'), true);
});

test('isFreeRequest: false for a concrete model id', () => {
  assert.equal(isFreeRequest('openrouter/auto:free'), false);
  assert.equal(isFreeRequest('llama-3.3-70b-versatile'), false);
  assert.equal(isFreeRequest('gpt-5.4'), false);
  assert.equal(isFreeRequest('free-model'), false);
});

// ---------------------------------------------------------------------------
// resolveFreeCandidates — the router still ranks these
// ---------------------------------------------------------------------------

test('resolveFreeCandidates: every free model becomes a candidate', async () => {
  clearFreeModelCache();
  const adapter = new FakeAdapter('p1', [
    { id: 'paid', is_free: false },
    { id: 'free-a', is_free: true },
    { id: 'free-b', is_free: true },
  ]);
  const registry = createProviderRegistry([adapter as unknown as ProviderAdapter]);

  const candidates = await resolveFreeCandidates(registry, [credential('p1')]);

  assert.deepEqual(
    candidates.map((c) => c.modelId),
    ['free-a', 'free-b'],
  );
  assert.ok(candidates.every((c) => c.providerId === 'p1'));
  assert.ok(candidates.every((c) => c.adapterId === 'p1'));
});

test('resolveFreeCandidates: null and missing is_free are not free', async () => {
  clearFreeModelCache();
  const adapter = new FakeAdapter('p1', [
    { id: 'unknown-1', is_free: null },
    { id: 'unknown-2' },
    { id: 'paid', is_free: false },
  ]);
  const registry = createProviderRegistry([adapter as unknown as ProviderAdapter]);

  const candidates = await resolveFreeCandidates(registry, [credential('p1')]);

  assert.equal(candidates.length, 0);
});

test('resolveFreeCandidates: unions free models across providers', async () => {
  clearFreeModelCache();
  const p1 = new FakeAdapter('p1', [{ id: 'a-free', is_free: true }]);
  const p2 = new FakeAdapter('p2', [{ id: 'b-free', is_free: true }]);
  const registry = createProviderRegistry([
    p1 as unknown as ProviderAdapter,
    p2 as unknown as ProviderAdapter,
  ]);

  const candidates = await resolveFreeCandidates(registry, [credential('p1'), credential('p2')]);

  assert.deepEqual(
    candidates.map((c) => `${c.providerId}:${c.modelId}`),
    ['p1:a-free', 'p2:b-free'],
  );
});

test('resolveFreeCandidates: caches per provider (one upstream call)', async () => {
  clearFreeModelCache();
  const adapter = new FakeAdapter('p1', [{ id: 'free-a', is_free: true }]);
  const registry = createProviderRegistry([adapter as unknown as ProviderAdapter]);
  const cred = credential('p1');

  await resolveFreeCandidates(registry, [cred]);
  await resolveFreeCandidates(registry, [cred]);
  await resolveFreeCandidates(registry, [cred]);

  assert.equal(adapter.calls.count, 1, 'listModels called once, then served from cache');
});

test('resolveFreeCandidates: skips a provider that has no free models', async () => {
  clearFreeModelCache();
  const empty = new FakeAdapter('p1', [{ id: 'paid', is_free: false }]);
  const good = new FakeAdapter('p2', [{ id: 'free-b', is_free: true }]);
  const registry = createProviderRegistry([
    empty as unknown as ProviderAdapter,
    good as unknown as ProviderAdapter,
  ]);

  const candidates = await resolveFreeCandidates(registry, [credential('p1'), credential('p2')]);

  assert.deepEqual(
    candidates.map((c) => c.modelId),
    ['free-b'],
  );
});

test('resolveFreeCandidates: empty when the caller has no credentials', async () => {
  clearFreeModelCache();
  const registry = createProviderRegistry([
    new FakeAdapter('p1', []) as unknown as ProviderAdapter,
  ]);

  const candidates = await resolveFreeCandidates(registry, []);

  assert.equal(candidates.length, 0);
});
