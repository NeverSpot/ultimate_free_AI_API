import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/env';

const base = { ADMIN_TOKEN: 'a'.repeat(32), MASTER_ENCRYPTION_KEY: 'b'.repeat(32) };

test('JWT_SECRET optional outside production', () => {
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development' }).jwtSecret, undefined);
});

test('JWT_SECRET captured when present', () => {
  assert.equal(
    loadConfig({ ...base, NODE_ENV: 'development', JWT_SECRET: 'x'.repeat(32) }).jwtSecret,
    'x'.repeat(32),
  );
});

test('production without JWT_SECRET is a problem', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), /JWT_SECRET is required/);
});

test('production with a short JWT_SECRET is a problem', () => {
  assert.throws(
    () => loadConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'short' }),
    /at least 32/,
  );
});
