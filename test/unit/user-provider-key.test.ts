import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerKeyFingerprint } from '../../src/models/user-provider-key';

test('fingerprint: distinct secrets for one provider do not collide', () => {
  const a = providerKeyFingerprint('u1', 'openrouter', 'sk-or-a');
  const b = providerKeyFingerprint('u1', 'openrouter', 'sk-or-b');
  assert.notEqual(a, b);
});

test('fingerprint: is a stable function of (user, provider, secret)', () => {
  assert.equal(
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
  );
});

test('fingerprint: is scoped to the user', () => {
  assert.notEqual(
    providerKeyFingerprint('u1', 'openrouter', 'sk-or-a'),
    providerKeyFingerprint('u2', 'openrouter', 'sk-or-a'),
  );
});
