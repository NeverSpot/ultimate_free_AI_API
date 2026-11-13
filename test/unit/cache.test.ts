import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cacheKey,
  DEFAULT_TTL_SECONDS,
  getCached,
  setCached,
  setCacheClient,
  sha256Hex,
} from '../../src/telemetry/cache';

test('cache: sha256Hex is deterministic and collision-sensitive', () => {
  const a = sha256Hex('hello world');
  const b = sha256Hex('hello world');
  assert.equal(a, b);
  assert.equal(a.length, 64);
  assert.notEqual(a, sha256Hex('hello world!'));
});

test('cache: cacheKey is deterministic and names provider and model', () => {
  const hash = sha256Hex('body');
  const a = cacheKey({ provider: 'openrouter', model: 'm1', bodyHash: hash });
  const b = cacheKey({ provider: 'openrouter', model: 'm1', bodyHash: hash });
  assert.equal(a, b);
  assert.equal(a, `cache:chat:openrouter:m1:${hash}`);
  assert.notEqual(a, cacheKey({ provider: 'openrouter', model: 'm2', bodyHash: hash }));
});

test('cache: setCached then getCached round-trips through a fake client', async () => {
  const store = new Map<string, string>();
  setCacheClient({
    get: async (key) => {
      const value = store.get(key);
      return value === undefined ? null : value;
    },
    setex: async (key, _seconds, value) => {
      store.set(key, value);
      return 'OK';
    },
  });
  await setCached('k1', '{"ok":true}');
  assert.equal(await getCached('k1'), '{"ok":true}');
});

test('cache: getCached returns null on a miss', async () => {
  setCacheClient({
    get: async () => null,
    setex: async () => 'OK',
  });
  assert.equal(await getCached('missing'), null);
});

test('cache: setCached uses DEFAULT_TTL_SECONDS when ttl is omitted', async () => {
  let captured: number | undefined;
  setCacheClient({
    get: async () => null,
    setex: async (_key, seconds) => {
      captured = seconds;
      return 'OK';
    },
  });
  await setCached('k2', '{}');
  assert.equal(captured, DEFAULT_TTL_SECONDS);
});
