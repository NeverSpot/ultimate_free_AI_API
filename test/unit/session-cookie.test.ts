import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookie } from '../../src/http/plugins/session-cookie';

test('serialize: HttpOnly, SameSite=Strict, Path=/, Max-Age, no Secure (non-prod)', () => {
  const c = sessionCookie.serialize('tok', 'test');
  assert.match(c, /^jwt=tok;/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=604800/);
  assert.doesNotMatch(c, /Secure/);
});

test('serialize adds Secure in production', () => {
  assert.match(sessionCookie.serialize('tok', 'production'), /Secure/);
});

test('clear: Max-Age=0 + same attrs', () => {
  const c = sessionCookie.clear('production');
  assert.match(c, /^jwt=;/);
  assert.match(c, /Max-Age=0/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
});
