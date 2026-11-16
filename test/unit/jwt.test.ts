import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { signJwt, verifyJwt } from '../../src/lib/jwt';

const SECRET = 'test-secret';

test('round-trips userId/username', () => {
  const d = verifyJwt(signJwt({ userId: 'u1', username: 'alice' }, SECRET), SECRET);
  assert.ok(d);
  assert.equal(d!.userId, 'u1');
  assert.equal(d!.username, 'alice');
  assert.equal(typeof d!.exp, 'number');
});

test('tampered token -> null', () => {
  assert.equal(verifyJwt('not.a.jwt', SECRET), null);
});

test('wrong secret -> null', () => {
  assert.equal(verifyJwt(signJwt({ userId: 'u1', username: 'a' }, 'other'), SECRET), null);
});

test('expired token -> null', () => {
  const expired = jwt.sign({ userId: 'u1', username: 'a' }, SECRET, { expiresIn: '-1s' });
  assert.equal(verifyJwt(expired, SECRET), null);
});
